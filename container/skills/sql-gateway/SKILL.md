---
name: sql-gateway
description: Query production databases (All Is Good, Date Reminder, Sleep Tracker, Smash) with read-only SQL. Use when the user asks about app data, metrics, users, entries, or anything that requires looking at production data.
allowed-tools: Bash(curl:*)
---

# SQL Gateway — Read-only Database Access

Query production PostgreSQL databases via the SQL gateway API.

## Available Databases

| Database | App | Description |
|----------|-----|-------------|
| `all-is-good` | All Is Good | Gratitude journaling app |
| `date-reminder` | Date Reminder | Important dates tracker |
| `sleep-tracker` | Sleep Tracker | Sleep tracking and coaching app |
| `smash` | Smash | Ad creation and publishing (Agent Runs, Generations, social accounts) — see below |

## Smash

`smash` is read through a role that can only `SELECT`:
- Credential columns are hidden (OAuth tokens, sessions, passwords): `select *` on `account`, `session`, `verification`, `oauth_states`, `smash_social_accounts`, `smash_ad_accounts`, `smash_broll_jobs` fails; list the columns you need.
- A table added after 2026-11-10 may not be readable yet (`permission denied for table`): say so and ask Guillaume to grant it.
- Schema: repo `rodger-studio/smash`, `src/server/db/schema.ts` (Drizzle). Domain terms: `src/server/smash/GLOSSARY.md`. Agent Runs: `agent_runs` (`status`, `error`, `created_at`, `updated_at`, `conversation_id`); the agent's history (`agent_log_*`) is reached through `agent_conversations.id`.
- Smash's logs and deploys are not available here (Render); work from the data and the code.

## How to Query

```bash
curl -s -X POST https://sql-gateway-api.onrender.com/api/v1/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RODGER_SQL_GATEWAY__API_TOKEN" \
  -d '{"database": "sleep-tracker", "sql": "SELECT count(*) FROM \"User\""}'
```

## Cold Start

The API runs on a free Render instance. The first request may take up to 50 seconds due to cold start. If you get a timeout or connection error, retry once after waiting.

## SQL Rules

- **Read-only**: Only `SELECT`, `WITH`, `EXPLAIN`, and `SHOW` queries allowed
- **Single statement only** — no `;` separating multiple queries
- **Max query length**: 10,000 characters
- **Case-sensitive**: PostgreSQL table/column names need double quotes (e.g. `"User"`, `"createdAt"`)
- **Timeout**: Queries time out after 10 seconds — use `LIMIT` and indexed columns for large tables
- **Row cap**: Results capped at 1,000 rows (`truncated: true` in response). Add `LIMIT` or narrow `WHERE` to avoid truncation.

## Workflow

1. **Start by discovering tables**:
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
   ```

2. **Inspect columns before querying**:
   ```sql
   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'User' AND table_schema = 'public'
   ```

3. **Always use LIMIT** when exploring unknown tables

4. **Use EXPLAIN** to check query plans before running expensive queries

## Response Format

```json
{
  "columns": [
    { "name": "id", "dataTypeID": 23 },
    { "name": "email", "dataTypeID": 1043 }
  ],
  "rows": [{ "id": 1, "email": "user@example.com" }],
  "rowCount": 1,
  "truncated": false
}
```

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Invalid SQL, write attempt, or query execution error |
| 401 | Missing or invalid API token |
| 429 | Rate limited (max 30 requests/minute) |
