# Kansal Tech Uptime — project memory

Self-hosted uptime monitor for all Kansal Tech client sites. Own Supabase project (NOT Prestige's). Deployed to Netlify at `uptime.kansaltech.ca`.

## Files
- `Uptime.dc.html` — staff dashboard. Login = Supabase Auth email+password, then 6-digit emailed code (1-day device memory in localStorage `uptime-otp-<uid>`). Demo data shows while `uptime-client.js` is unconfigured.
- `Status.dc.html?p=<slug>` — public status page (reads `public_status(slug)` RPC; anon has no table access).
- `uptime-client.js` — re-exports SUPABASE_URL / ANON_KEY from `env.js`, FUNCTION_URL + `demoData()`.
- `env.js` — generated on Netlify by `build-env.mjs` (build command) from env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY` (also accepts VITE_/NEXT_PUBLIC_ prefixes). Committed copy is empty = demo mode. Resend key never goes here.
- `netlify.toml` — `/` → dashboard, `/status/:slug` → status page.
- `deploy/schema.sql` — tables (projects, monitors, checks, incidents, alert_channels, alert_log, settings), RLS (authenticated full access), RPCs `uptime_summary(days)`, `recent_checks(limit)`, `public_status(slug)`, `prune_checks()`, pg_cron `uptime-run-checks` (every minute → edge fn with `x-cron-secret`) and `uptime-prune` (4:15 daily). Seeds 8 projects + homepage monitors + Prestige extras.
- `deploy/edge-function-run-checks.ts` — edge fn `run-checks`: runs due monitors (HTTP status/keyword/timeout or heartbeat lateness), fail-threshold → incident + alerts (email via Resend, Slack webhook, WhatsApp Cloud API template `uptime_alert`), escalation channels, recovery alerts, `?hb=<token>` heartbeat receiver, `{action:'test_channel'}`.
- `deploy/email-login-code.html` — Supabase Magic Link email body (dark Kansal theme, `{{ .Token }}` only, no link). Alert emails in the edge fn use the same table-based dark theme. `Email Templates.dc.html` previews all three (not deployed).

## Conventions
- Inline styles only; dark UI: bg `#0f1115`, card `#171a21`, border `#262b36`, accent `#4f8cff`, up `#3ddc97`, down `#ff5c5c`, muted `#8b93a5`. Fonts Space Grotesk + JetBrains Mono.
- Edge fn secrets: `CRON_SECRET RESEND_API_KEY ALERT_FROM DASHBOARD_URL SUPABASE_ANON_KEY` (+ optional `WHATSAPP_TOKEN WHATSAPP_PHONE_ID WHATSAPP_TEMPLATE`).
- After changes: give plain-word deploy steps (SQL to run, files to upload to Netlify, `supabase functions deploy run-checks --no-verify-jwt`).

- Monitor modal: headers are key/value rows (`f.headerList` → `headers` jsonb on save); key names matching key/token/secret render as password fields.

- Supabase API checks must target a table (`/rest/v1/<table>?select=*&limit=1` + anon `apikey`); the `/rest/v1/` root is service_role-only → 401. Checker records a 140-char body snippet on non-OK responses.

## Change log
- 2026-10-09 v1 built (moved out of the Prestige Eyewear project).
