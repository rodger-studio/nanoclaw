// Read-only window for the agents on Smash (Render API + smash-db).
//
// Runs on the VPS next to NanoClaw, outside the agent containers: the Render
// API key and the database URL stay here, agents only hold PROXY_TOKEN.
//   GET  /                → help (resource names, endpoints)
//   GET  /render/v1/...   → api.render.com, GET only, allowlisted endpoints
//                           and query params, Smash resources only
//   POST /sql {"sql"}     → smash-db as a read-only Postgres role
//
// Resource ids, the workspace id and every secret come from the secrets file
// (never from this repository): see README.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';

// ---------- Config ----------

const SECRETS_FILE = process.env.SECRETS_FILE || '/run/secrets/smash-proxy.env';
const BIND_HOST = process.env.BIND_HOST || '172.17.0.1';
const PORT = Number(process.env.PORT || 3003);

const config = parseEnvFile(fs.readFileSync(SECRETS_FILE, 'utf8'));
for (const key of [
  'RENDER_API_KEY',
  'RENDER_OWNER_ID',
  'SMASH_RESOURCES',
  'SMASH_DB_READONLY_URL',
  'PROXY_TOKEN',
]) {
  if (!config[key]) fail(`Missing ${key} in ${SECRETS_FILE}`);
}
if (config.PROXY_TOKEN.length < 32) fail('PROXY_TOKEN must be 32+ chars');

// "smash-web=srv-xxx,smash-agent=srv-yyy,smash-db=dpg-zzz"
const RESOURCE_IDS = new Map(
  config.SMASH_RESOURCES.split(',').map((pair) => {
    const [name, id] = pair.split('=').map((s) => s.trim());
    if (!name || !/^(srv|dpg)-[a-z0-9-]+$/.test(id ?? '')) fail(`Bad SMASH_RESOURCES entry: ${pair}`);
    return [name, id];
  }),
);
const ALLOWED_IDS = new Set(RESOURCE_IDS.values());

const SQL_MAX_ROWS = 1000;
const SQL_MAX_LENGTH = 20_000;
const SQL_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;

// ---------- Render allowlist ----------

const RES = '([a-z0-9-]+)';
const ID = '[A-Za-z0-9_-]+';
// Path rules: the captured group must be a Smash resource. Everything else
// (env-vars, secret-files, connection-info, other services, jobs, shells,
// any non-GET) is refused.
const PATH_RULES = [
  new RegExp(`^/v1/services/${RES}$`),
  new RegExp(`^/v1/services/${RES}/deploys$`),
  new RegExp(`^/v1/services/${RES}/deploys/${ID}$`),
  new RegExp(`^/v1/services/${RES}/events$`),
  new RegExp(`^/v1/services/${RES}/instances$`),
  new RegExp(`^/v1/postgres/${RES}$`),
];
// Endpoints scoped by `resource` query params instead of the path.
const METRICS = [
  'cpu', 'memory', 'instance-count', 'http-requests', 'http-latency',
  'bandwidth', 'active-connections', 'disk-usage', 'disk-capacity',
  'cpu-limit', 'cpu-target', 'memory-limit', 'memory-target',
];
const RESOURCE_QUERY_PATHS = new Set([
  '/v1/logs',
  '/v1/logs/values',
  ...METRICS.map((m) => `/v1/metrics/${m}`),
]);
// Query params forwarded to Render; anything else is refused.
const ALLOWED_PARAMS = new Set([
  'resource', 'instance', 'host', 'statusCode', 'method', 'path', 'level',
  'type', 'text', 'label', 'startTime', 'endTime', 'direction', 'limit',
  'cursor', 'status', 'createdBefore', 'createdAfter', 'updatedBefore',
  'updatedAfter', 'finishedBefore', 'finishedAfter', 'resolutionSeconds',
  'aggregationMethod', 'aggregateHttpRequestsBy', 'quantile',
]);

const resolveId = (nameOrId) => RESOURCE_IDS.get(nameOrId) ?? nameOrId;

/** Builds the upstream URL, or returns { error } when the request is refused. */
function renderTarget(url) {
  const path = url.pathname.slice('/render'.length);
  const target = new URL('https://api.render.com');

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return { error: `paramètre non autorisé : ${key}` };
  }

  for (const rule of PATH_RULES) {
    const match = path.match(rule);
    if (!match) continue;
    const id = resolveId(match[1]);
    if (!ALLOWED_IDS.has(id)) return { error: `${match[1]} n'est pas une ressource Smash` };
    // Every rule has the resource as the 4th segment: /v1/<kind>/<resource>/...
    const segments = path.split('/');
    segments[3] = id;
    target.pathname = segments.join('/');
    url.searchParams.forEach((value, key) => target.searchParams.append(key, value));
    return { target };
  }

  if (RESOURCE_QUERY_PATHS.has(path)) {
    const resources = url.searchParams
      .getAll('resource')
      .flatMap((r) => r.split(','))
      .map((r) => resolveId(r.trim()));
    if (resources.length === 0) return { error: 'paramètre `resource` obligatoire (ressource Smash)' };
    const foreign = resources.filter((r) => !ALLOWED_IDS.has(r));
    if (foreign.length) return { error: `ressources hors Smash refusées : ${foreign.join(', ')}` };
    target.pathname = path;
    url.searchParams.forEach((value, key) => {
      if (key !== 'resource') target.searchParams.append(key, value);
    });
    for (const id of resources) target.searchParams.append('resource', id);
    if (path.startsWith('/v1/logs')) target.searchParams.set('ownerId', config.RENDER_OWNER_ID);
    return { target };
  }

  return { error: 'endpoint non autorisé (voir GET /)' };
}

async function proxyRender(req, res, url) {
  if (req.method !== 'GET') return send(res, 405, { error: 'lecture seule : GET uniquement' });
  const { target, error } = renderTarget(url);
  if (error) return send(res, 403, { error });
  const upstream = await fetch(target, {
    headers: { Authorization: `Bearer ${config.RENDER_API_KEY}`, Accept: 'application/json' },
    redirect: 'manual', // never replay the key on a redirect
    signal: AbortSignal.timeout(30_000),
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    return send(res, 502, { error: `redirection Render refusée (${upstream.status})` });
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) {
    return send(res, 413, { error: 'réponse trop grosse, réduis `limit` ou la plage' });
  }
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// ---------- SQL ----------

const pool = new pg.Pool({
  connectionString: config.SMASH_DB_READONLY_URL.replace(/[?&]sslmode=[^&]*/, ''),
  ssl: { rejectUnauthorized: true }, // verified TLS (public CA on Render)
  max: 2,
  idleTimeoutMillis: 60_000,
  statement_timeout: SQL_TIMEOUT_MS,
  query_timeout: SQL_TIMEOUT_MS + 5_000,
  application_name: 'smash-proxy',
});
pool.on('error', (error) => console.error('pg pool error:', error.message));

async function runSql(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST {"sql": "..."}' });
  let sql;
  try {
    ({ sql } = JSON.parse((await readBody(req)) || '{}'));
  } catch {
    return send(res, 400, { error: 'JSON invalide' });
  }
  if (typeof sql !== 'string' || !sql.trim()) return send(res, 400, { error: 'champ `sql` manquant' });
  if (sql.length > SQL_MAX_LENGTH) return send(res, 400, { error: 'requête trop longue' });
  const refusal = sqlRefusal(sql);
  if (refusal) return send(res, 400, { error: refusal });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    // Extended protocol: Postgres rejects more than one statement.
    const result = await client.query({ text: sql, queryMode: 'extended' });
    const rows = result.rows ?? [];
    send(res, 200, {
      columns: (result.fields ?? []).map((f) => f.name),
      rows: rows.slice(0, SQL_MAX_ROWS),
      rowCount: rows.length,
      truncated: rows.length > SQL_MAX_ROWS,
    });
  } catch (error) {
    send(res, 400, { error: error.message });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    // Destroy the connection instead of returning it to the pool: nothing a
    // statement left on the session (e.g. a session advisory lock, which
    // survives ROLLBACK and would block Smash's job loops) outlives the request.
    client.release(true);
  }
}

// The Postgres role is the real barrier (SELECT only). This is defense in
// depth against what a SELECT-only role can still do: take advisory locks
// (Smash's worker relies on them), NOTIFY, sleep, or run dynamic SQL via DO.
const SQL_FIRST_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'table', 'values']);
const SQL_DENIED = /\b(pg_(try_)?advisory\w*|pg_notify|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|dblink\w*|lo_\w+|set_config|pg_read_\w+|pg_ls_\w+|pg_stat_file)\b|\bU&|\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i;

function sqlRefusal(sql) {
  const withoutComments = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const firstKeyword = withoutComments.trim().split(/[\s(]+/, 1)[0].toLowerCase();
  if (!SQL_FIRST_KEYWORDS.has(firstKeyword)) {
    return 'seules les requêtes SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES sont acceptées';
  }
  const denied = withoutComments.match(SQL_DENIED);
  if (denied) return `fonction ou clause refusée : ${denied[0]}`;
  return null;
}

// ---------- HTTP ----------

const expectedAuth = Buffer.from(`Bearer ${config.PROXY_TOKEN}`);
function isAuthorized(req) {
  const given = Buffer.from(req.headers.authorization ?? '');
  return given.length === expectedAuth.length && crypto.timingSafeEqual(given, expectedAuth);
}

// One window for every caller: the proxy has a single client (the agents).
let windowStart = Date.now();
let windowCount = 0;
function rateLimited() {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  return ++windowCount > RATE_LIMIT_PER_MINUTE;
}

const HELP = {
  ressources: [...RESOURCE_IDS.keys()],
  render: [
    'GET /render/v1/logs?resource=<nom>&startTime=<iso>&endTime=<iso>&text=<mot>&level=error&limit=100&direction=backward',
    'GET /render/v1/logs/values?resource=<nom>&label=<label>',
    'GET /render/v1/services/<nom>',
    'GET /render/v1/services/<nom>/deploys?limit=20',
    'GET /render/v1/services/<nom>/deploys/<deployId>',
    'GET /render/v1/services/<nom>/events?limit=50',
    'GET /render/v1/services/<nom>/instances',
    `GET /render/v1/metrics/<${METRICS.join('|')}>?resource=<nom>`,
    'GET /render/v1/postgres/<nom de la base>',
  ],
  sql: `POST /sql {"sql": "select ..."} (lecture seule, 1 requête, ${SQL_TIMEOUT_MS / 1000} s max, ${SQL_MAX_ROWS} lignes max)`,
  limite: `${RATE_LIMIT_PER_MINUTE} requêtes par minute`,
};

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > SQL_MAX_LENGTH * 2) {
        reject(new Error('corps trop gros'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseEnvFile(content) {
  const values = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://proxy');
  const started = Date.now();
  try {
    if (url.pathname === '/health') send(res, 200, { ok: true });
    else if (!isAuthorized(req)) send(res, 401, { error: 'token manquant ou invalide' });
    else if (rateLimited()) send(res, 429, { error: `limite de ${RATE_LIMIT_PER_MINUTE} requêtes par minute` });
    else if (url.pathname === '/') send(res, 200, HELP);
    else if (url.pathname.startsWith('/render/')) await proxyRender(req, res, url);
    else if (url.pathname === '/sql') await runSql(req, res);
    else send(res, 404, { error: 'inconnu (voir GET /)' });
  } catch (error) {
    if (!res.headersSent) send(res, 502, { error: error.message });
  }
  // Path only: query strings and SQL are not logged.
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
});
server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.listen(PORT, BIND_HOST, () => console.log(`smash-proxy on ${BIND_HOST}:${PORT}`));
