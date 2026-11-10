---
name: smash-render
description: Read Smash's production state on Render, read-only - logs, deploys, events, instances and metrics of smash-web / smash-worker / smash-agent, and SQL on smash-db. Use when diagnosing a Smash bug, a failed or orphaned Agent Run, a deploy, or when a Smash answer needs the real data instead of the code.
allowed-tools: Bash(curl:*)
---

# Smash on Render (read-only)

A proxy on the host (`services/smash-proxy`) gives read-only access to Smash.
Writes are impossible: it only forwards GET requests to Render, for the Smash
resources only, and SQL runs as a Postgres role that can only SELECT. Never
try to deploy, restart or change anything; if an action is needed, say what to
do and let Guillaume do it. Never paste `$RAFA_SMASH_PROXY_TOKEN` in a message.

```bash
B=http://host.docker.internal:3003
H="Authorization: Bearer $RAFA_SMASH_PROXY_TOKEN"
curl -s -H "$H" $B/          # help: resource names, endpoints, limits
```

## Resources (use the names, the proxy maps them to Render ids)

| Name | What |
|------|------|
| `smash-web` | UI, server functions, OAuth callbacks, webhooks |
| `smash-worker` | loops: render scheduler, cron, token refresh, metrics poll |
| `smash-agent` | Smash V2 Agent Runs |
| `smash-db` | Postgres |

## Logs

```bash
# Last 100 lines of smash-agent, newest first
curl -s -H "$H" "$B/render/v1/logs?resource=smash-agent&limit=100&direction=backward"
# A time window (ISO 8601, UTC), a text search, errors only
curl -s -H "$H" "$B/render/v1/logs?resource=smash-agent&startTime=2026-11-10T17:20:00Z&endTime=2026-11-10T17:40:00Z&text=aba33476&level=error&limit=100"
```

- `resource` is required (several: `resource=smash-web&resource=smash-worker`). Other filters: `instance`, `level`, `type` (`app`, `request`, `build`), `text`, `host`, `path`, `statusCode`, `method`.
- Paginate with `hasMore` + `nextStartTime` / `nextEndTime` from the response.
- Times are UTC; Paris is UTC+1 in winter (18:30 Paris = 17:30Z).

## Deploys, events, instances, metrics

```bash
curl -s -H "$H" "$B/render/v1/services/smash-agent/deploys?limit=20"
curl -s -H "$H" "$B/render/v1/services/smash-agent/deploys/<deployId>"
curl -s -H "$H" "$B/render/v1/services/smash-agent/events?limit=50"   # deploy started/ended, restarts, OOM...
curl -s -H "$H" "$B/render/v1/services/smash-agent/instances"
curl -s -H "$H" "$B/render/v1/metrics/memory?resource=smash-agent&startTime=...&endTime=..."  # also cpu, instance-count, http-requests, http-latency
```

## SQL on smash-db

```bash
curl -s -H "$H" -H "Content-Type: application/json" \
  -d '{"sql": "select id, status, error, created_at, updated_at from agent_runs order by created_at desc limit 20"}' \
  $B/sql
```

- One statement per request (SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES), 15 s timeout, 1000 rows max (`truncated: true` beyond). Locks (`FOR UPDATE`, advisory locks), `pg_sleep` and `set_config` are refused.
- Credential columns are hidden (OAuth tokens, sessions, passwords): `select *` on `account`, `session`, `verification`, `oauth_states`, `smash_social_accounts`, `smash_ad_accounts`, `smash_broll_jobs` fails; list the columns you need.
- Schema: repo `rodger-studio/smash`, `src/server/db/schema.ts` (Drizzle). Domain terms: `src/server/smash/GLOSSARY.md`. Start with `select table_name from information_schema.tables where table_schema = 'public'`.
- Every Smash table has `organization_id`; the agent harness log tables (`agent_log_*`) are reached through `agent_conversations.id`.

## Errors

| Status | Meaning |
|--------|---------|
| 401 | Missing or wrong `$RAFA_SMASH_PROXY_TOKEN` |
| 403 | Endpoint, query param or resource outside the allowlist (env vars, connection info and other services are never available) |
| 429 | More than 60 requests in a minute: wait, then batch your questions |
| 400 | SQL error; permission denied on a hidden column; or a table added after 2026-11-10 that is not granted yet (say so and ask Guillaume to grant it) |
| 502 | Render or the database did not answer; retry once |
