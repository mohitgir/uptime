# Kansal Tech Uptime — setup (one-time, ~45 minutes)

A self-hosted uptime monitor for all Kansal Tech client sites. Checks run from a Supabase edge function every minute (each monitor on its own 1/5/15-min interval), alerts go out by email, Slack, and WhatsApp, and every project gets a public status page.

## Files
- `deploy/schema.sql` — tables, security, RPCs, cron jobs, seed of the 8 projects.
- `deploy/edge-function-run-checks.ts` — the checker + alert sender + heartbeat receiver.
- `uptime-client.js` — put the Supabase URL + anon key here.
- `Uptime.dc.html` — staff dashboard (login with email + password + emailed code).
- `Status.dc.html?p=<slug>` — public status page (e.g. `/status/prestige-eyewear`).
- `netlify.toml` — clean URLs (`/` dashboard, `/status/<slug>`).

## Steps
1. **Supabase → New project** (name it `kansal-uptime`, a North America region). Free plan works because the cron keeps it active; Pro ($25) if you want guarantees.
2. **SQL editor** → paste `deploy/schema.sql`. Before running, replace `<PROJECT_REF>` (from the project URL) and `<CRON_SECRET>` (any long random string — keep it for step 4). Run.
3. **Settings → API** → copy Project URL and anon key into `uptime-client.js`.
4. **Edge function** (terminal, Supabase CLI installed):
   ```
   supabase link --project-ref <PROJECT_REF>
   mkdir -p supabase/functions/run-checks && cp deploy/edge-function-run-checks.ts supabase/functions/run-checks/index.ts
   supabase secrets set CRON_SECRET=<same as step 2> RESEND_API_KEY=re_… ALERT_FROM="Kansal Tech Uptime <uptime@kansaltech.ca>" DASHBOARD_URL=https://uptime.kansaltech.ca SUPABASE_ANON_KEY=<anon key>
   supabase functions deploy run-checks --no-verify-jwt
   ```
   Verify the `kansaltech.ca` sending domain in Resend.
5. **Auth**: Authentication → Users → Add user (email + password) for each staff member. Authentication → Email → custom SMTP = Resend; Email Templates → Magic Link body must contain `{{ .Token }}` (the 6-digit code).
6. **Deploy the dashboard** to Netlify: drag this folder into a new site; custom domain `uptime.kansaltech.ca`.
7. Open the dashboard → **Alerts** → add email / Slack webhook / WhatsApp → **Test**.
8. Keep ONE free UptimeRobot monitor pointed at `https://uptime.kansaltech.ca` — the monitor can't watch itself.

## Optional: WhatsApp
Needs a Meta WhatsApp Business (Cloud API) account. Create a template named `uptime_alert` with body `{{1}} — {{2}} — {{3}}`, get it approved, then `supabase secrets set WHATSAPP_TOKEN=… WHATSAPP_PHONE_ID=…` and redeploy.

## Heartbeats (watch cron jobs)
Add a monitor of type "Heartbeat"; copy its ping URL; have the job call it when done (e.g. in Prestige's nightly sign-out SQL: `select net.http_get('<ping url>')`). No ping within interval + grace → DOWN alert.

## Alert behaviour
- DOWN only after `fail_threshold` consecutive failures (default 2 → ~10 min at a 5-min interval).
- "All projects" channels get everything; per-project channels only that project.
- Escalation channels fire only if the incident is still open after N minutes.
- Recovery message includes outage length. All sends logged in `alert_log`. Checks kept 90 days.

## Costs
Supabase free/Pro, Resend free (3k emails/mo), Netlify free, WhatsApp ~$0.01–0.05 per alert.
