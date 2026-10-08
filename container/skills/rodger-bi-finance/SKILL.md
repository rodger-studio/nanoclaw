---
name: rodger-bi-finance
description: Fetch Rodger Studio's company revenue and user-acquisition spend from the Rodger BI public API — totals, per-period series and per-app breakdowns, split by revenue source (IAP, ads, offerwall, web) and spend source (Adjust). Use when asked about revenue, spend, net, ROAS, profitability, how an app is doing financially, or comparisons between periods or apps.
---

# Rodger BI finance API

Rodger Studio runs a portfolio of subscription mobile apps. Rodger BI exposes their finance data through a read-only JSON API. Use it to answer questions about revenue, spend, net and ROAS. Don't guess or estimate figures it can provide.

## Setup

- Base URL: `https://rodger-bi.onrender.com/api/public/v1`
- Auth: every request needs `Authorization: Bearer $RODGER_BI_API_KEY`. The key starts with `rbi_live_`. Never print it, log it, or paste it into a message.
- Rate limit: 30 requests/minute. On `429`, wait the `Retry-After` seconds, then retry once.

```bash
curl -s -H "Authorization: Bearer $RODGER_BI_API_KEY" \
  "https://rodger-bi.onrender.com/api/public/v1/finance?granularity=month&from=2026-01-01"
```

## Endpoints

| Endpoint | Use it for |
| --- | --- |
| `GET /` | The self-describing index: params, field meanings, the current source list. Read it once if anything below seems out of date. It is authoritative. |
| `GET /apps` | App ids, names, lifecycle phase (`soft-launch`, `launch-scale`, `running`, …), platforms, and which sources apply to each app. Call it to map an app name a user mentions to its `id`. |
| `GET /finance` | The numbers. |

### `/finance` query params

| Param | Default | Rules |
| --- | --- | --- |
| `from` | 30 days before `to` | `YYYY-MM-DD`, inclusive |
| `to` | yesterday (UTC) | `YYYY-MM-DD`, inclusive. Data ends yesterday, and later dates are clamped |
| `granularity` | `day` | `day` and `week` (ISO, Monday start) allow up to 366 days; `month` allows up to 730 days |
| `apps` | all apps | Comma-separated ids from `/apps` |

Pick the granularity from the question:
- "this month" or "last 30 days" → `day`
- a quarter → `week`
- "this year", year-over-year, trends → `month`

### `/finance` response

```jsonc
{
  "meta": { "from", "to", "granularity", "appIds", "currency": "USD", "revenueBasis": "gross", "generatedAt", "toClampedToYesterday" },
  "sources": [ { "key": "iap", "kind": "revenue", "label": "IAP" }, …, { "key": "adjust", "kind": "spend", "label": "Adjust" } ],
  "totals": {
    "revenue": { "iap": 0, "ad": 0, "offerwall": 0, "web": 0, "total": 0 },
    "spend":   { "adjust": 0, "total": 0 },
    "net": 0,        // revenue.total − spend.total
    "roas": 1.4      // revenue.total / spend.total; null when there is no spend
  },
  "series": [ { "period": "2026-09-01", "start": "2026-09-01", "end": "2026-09-30", "partial": false, "revenue": {…}, "spend": {…}, "net": 0, "roas": 0 } ],
  "apps":   [ { "id", "name", "phase", "totals": {…}, "series": [ … ] } ],   // sorted by revenue, largest first
  "errors": [ { "appId", "source", "message" } ]
}
```

- The keys inside `revenue` and `spend` follow `sources`. New sources can appear at any time. Iterate over `sources`; don't hardcode `iap`, `ad`, and so on.
- `period` is the period's first day. `start` and `end` are clipped to the requested window.

## Reading the numbers correctly

- **Currency** is USD. Format amounts as `$12.3k` or `$1.2M`.
- **Revenue is gross.** RevenueCat revenue is counted before Apple/Google fees and taxes. Web (Chargebee) revenue is paid invoices including tax, net of refunds. If someone asks about profit or margin, say the store fees (~15–30%) aren't deducted.
- **Spend is Adjust-tracked user-acquisition cost only.** It doesn't include salaries, tools or other opex. So `net` means "revenue minus ad spend". It isn't profit; never call it that.
- **`iap`** is subscriptions and in-app purchases (RevenueCat revenue minus ad revenue). An app can legitimately have `iap: 0` and only ad revenue (e.g. Clutch).
- **`partial: true`** means the window cuts that period short, for example the running month. Never present a partial period as a drop. Compare like with like, or say it's partial.
- **`errors` non-empty** means some upstream calls failed, and the totals leave them out. Tell the user which app and source are missing, e.g. "Debatium's Adjust spend is missing". Re-query once after ~30 seconds, because failures are usually transient timeouts. Don't silently present incomplete totals as complete.
- **Freshness:** data is cached for up to 30 minutes, and today is never included.

## Recipes

- **Company snapshot:** call `/finance` with the defaults, then report `totals.revenue.total`, the split by source, `totals.spend.total`, `net` and `roas`.
- **Month over month:** use `granularity=month&from=<first day of the month 12 months ago>`. Compare the last two **non-partial** periods.
- **One app:** resolve the id via `/apps`, then use `apps=<id>`. The top level then reflects that app only.
- **Top apps:** read `apps[]` (already sorted by revenue), showing `totals.revenue.total`, `totals.spend.total` and `totals.roas`.
- **Is UA profitable for app X:** use the app's `roas` over a meaningful window (≥ 30 days). Below 1 means ad spend exceeds gross revenue in that window. Note that subscription revenue lags spend.

## Errors

| Status | Meaning | What to do |
| --- | --- | --- |
| `400` | Bad params (`{"error": "…"}` explains) | Fix the params (date format, span limits, unknown app id) and retry |
| `401` | Missing or invalid key | Stop and tell the user the API key is missing or revoked |
| `429` | Rate limited | Wait `Retry-After` seconds |
| `503` | API not configured on the server | Stop and tell the user |
| `500` | Server error | Retry once, then report |
