# smash-proxy

Read-only window for the NanoClaw agents on Smash, Rodger Studio's ad tool on
Render. Agents use it through the `smash-render` skill
(`container/skills/smash-render/SKILL.md`).

- `GET /render/v1/...` → Render API, **GET only**, allowlisted endpoints
  (logs, deploys, events, instances, metrics, the Postgres instance) and query
  params, Smash resources only. Env vars, secret files, DB connection info and
  every other service are refused. Redirects are not followed.
- `POST /sql` → smash-db as a Postgres role that can only `SELECT`, with
  credential columns hidden, one statement per request, 15 s timeout,
  1000 rows max.
- Bearer token (`PROXY_TOKEN`, constant-time check), 60 requests per minute.

## Where the secrets live

Nothing secret or internal (keys, URLs, Render ids) is in this repository.
Everything is in one file **outside the NanoClaw project root** (the main
agent mounts the project root read-only):

`~/.config/smash-proxy/smash-proxy.env` (dir `700`, file `600`):

```
RENDER_API_KEY=rnd_...           # dedicated "Rafa" key on Render
RENDER_OWNER_ID=tea-...          # Render workspace id
SMASH_RESOURCES=smash-web=srv-...,smash-worker=srv-...,smash-agent=srv-...,smash-db=dpg-...
SMASH_DB_READONLY_URL=postgresql://rafa_readonly:...@...render.com/...
PROXY_TOKEN=...                  # 48 hex chars; also RAFA_SMASH_PROXY_TOKEN in NanoClaw's .env
```

## Deploy

```bash
cd ~/nanoclaw/services/smash-proxy
sg docker -c 'docker compose up -d --build'
sudo ufw allow in on docker0 to any port 3003 proto tcp comment "smash-proxy"
```

The container runs as uid 1000 with a read-only root filesystem, no Linux
capabilities, `no-new-privileges`, and CPU / memory / pid limits.

## The Postgres role

`rafa_readonly` on smash-db: `LOGIN NOINHERIT CONNECTION LIMIT 5`,
`default_transaction_read_only = on`, `statement_timeout = 15s`,
`SELECT` on `public` (default privileges for tables created by `smash`), no
other privilege. Column grants hide: `account` tokens and password,
`session.token`, `verification.value`, `oauth_states.code_verifier`,
`smash_broll_jobs.webhook_token`, `smash_social_accounts` OAuth tokens,
`smash_ad_accounts.access_token`. **A new table or column holding a secret must
be hidden the same way** (revoke the table, grant the other columns).

## Revoke

1. Delete the "Rafa" API key in Render (Account Settings → API Keys).
2. On smash-db: `DROP OWNED BY rafa_readonly; DROP ROLE rafa_readonly;`
3. `sg docker -c 'docker compose down'`, `sudo ufw delete allow in on docker0 to any port 3003 proto tcp`.
