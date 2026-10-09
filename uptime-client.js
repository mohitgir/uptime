// Kansal Tech Uptime — Supabase bridge. Keys come from env.js, which Netlify generates at deploy from
// the site's env vars (SUPABASE_URL, SUPABASE_ANON_KEY) via build-env.mjs.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './env.js';
export { SUPABASE_URL, SUPABASE_ANON_KEY };
export const FUNCTION_URL = SUPABASE_URL ? SUPABASE_URL + '/functions/v1/run-checks' : '';

let _c = null;
export async function client() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (_c) return _c;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  _c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _c;
}
export const configured = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// Calls the edge function with the signed-in user's token
export async function callFunction(body) {
  const c = await client(); if (!c) return { demo: true };
  const { data: { session } } = await c.auth.getSession();
  const r = await fetch(FUNCTION_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session ? session.access_token : '') }, body: JSON.stringify(body || {}) });
  return await r.json();
}

// Demo data so the dashboard renders before the backend is connected
export function demoData() {
  const names = [['kansal-tech', 'Kansal Tech', 'https://kansaltech.ca'], ['prestige-eyewear', 'Prestige Eyewear', 'https://prestigeeyewear.ca'], ['family-forever', 'Family Forever Inc.', 'https://familyforever.ca'], ['golden-era-custom-homes', 'Golden Era Custom Homes', 'https://goldeneracustomhomes.com'], ['smart-steps-daycare', 'Smart Steps Daycare', 'https://smartstepsdaycare.ca'], ['perfect-safety-solutions', 'Perfect Safety Solutions', 'https://perfectsafetysolutions.com'], ['north-signal-mobile', 'North Signal Mobile', 'https://www.northsignalmobile.ca'], ['riar-residential', 'Riar Residential', 'https://riarresidential.com']];
  const projects = names.map((n, i) => ({ id: 'p' + i, slug: n[0], name: n[1], website: n[2], public_status: true, sort: i }));
  const monitors = []; const checks = {}; const summary = {};
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  projects.forEach((p, i) => {
    const list = [['Homepage', p.website, 'http']];
    if (p.slug === 'prestige-eyewear') list.push(['Booking page', p.website + '/book', 'http'], ['Admin', p.website + '/admin', 'http'], ['Supabase API', 'https://lflthgvccminphwfxnmr.supabase.co/rest/v1/settings?select=*&limit=1', 'http'], ['Nightly sign-out job', null, 'heartbeat']);
    list.forEach((l, j) => {
      const id = 'm' + i + j; const down = p.slug === 'riar-residential';
      const base = 120 + Math.round(rnd() * 500);
      monitors.push({ id, project_id: p.id, name: l[0], url: l[1], kind: l[2], status: down ? 'down' : 'up', interval_min: 5, expected_status: 200, keyword: '', headers: l[0] === 'Supabase API' ? { apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo' } : {}, fail_threshold: 2, enabled: true, timeout_ms: 10000, last_latency_ms: down ? null : base, last_status_code: down ? 522 : 200, last_checked_at: new Date(Date.now() - 60000).toISOString(), last_error: down ? 'HTTP 522' : null, heartbeat_token: 'demo' + id, consecutive_fails: down ? 3 : 0 });
      checks[id] = Array.from({ length: 48 }, (_, k) => ({ ok: !(down && k > 42) && rnd() > 0.01, latency_ms: Math.round(base * (0.7 + rnd() * 0.8)) }));
      summary[id] = { uptime: down ? 97.91 : 99.5 + rnd() * 0.5, avg_latency: base, p95_latency: Math.round(base * 1.6) };
    });
  });
  const incidents = [
    { id: 'i1', monitor_id: 'm70', started_at: new Date(Date.now() - 26 * 60000).toISOString(), resolved_at: null, cause: 'HTTP 522' },
    { id: 'i2', monitor_id: 'm10', started_at: new Date(Date.now() - 3 * 86400000).toISOString(), resolved_at: new Date(Date.now() - 3 * 86400000 + 11 * 60000).toISOString(), cause: 'Timeout after 10000ms' },
    { id: 'i3', monitor_id: 'm40', started_at: new Date(Date.now() - 9 * 86400000).toISOString(), resolved_at: new Date(Date.now() - 9 * 86400000 + 4 * 60000).toISOString(), cause: 'HTTP 503' }
  ];
  const channels = [
    { id: 'c1', project_id: null, type: 'email', label: 'Kansal Tech ops', target: 'ops@kansaltech.ca', escalate_after_min: 0, enabled: true },
    { id: 'c2', project_id: null, type: 'slack', label: '#alerts', target: 'https://hooks.slack.com/services/…', escalate_after_min: 0, enabled: true },
    { id: 'c3', project_id: 'p1', type: 'whatsapp', label: 'Prestige owner', target: '+1 905 555 0100', escalate_after_min: 10, enabled: true }
  ];
  return { projects, monitors, checks, summary, incidents, channels };
}
