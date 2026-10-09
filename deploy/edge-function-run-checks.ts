// Kansal Tech Uptime — edge function `run-checks`
// Deploy: supabase functions deploy run-checks --no-verify-jwt
// Secrets: CRON_SECRET RESEND_API_KEY ALERT_FROM DASHBOARD_URL SUPABASE_ANON_KEY
//          (optional) WHATSAPP_TOKEN WHATSAPP_PHONE_ID WHATSAPP_TEMPLATE
// Routes:
//   POST /run-checks                 x-cron-secret OR a signed-in user's JWT → run due checks ({"force":true} = all)
//   GET  /run-checks?hb=<token>      heartbeat ping from a cron job / script
//   POST /run-checks {"action":"test_channel","channel_id":"…"}  send a test alert
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  const url = new URL(req.url);
  const hb = url.searchParams.get("hb");
  if (hb) return await heartbeat(hb);

  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch (_) { /* empty */ }
  if (body.action === "test_channel") return json(await testChannel(body.channel_id));
  return json(await runDue(!!body.force));
});

async function authorized(req: Request) {
  const secret = env("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) return true;
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const anon = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY", ""), { global: { headers: { Authorization: auth } } });
  const { data } = await anon.auth.getUser(auth.slice(7));
  return !!data?.user;
}

async function heartbeat(token: string) {
  const { data: m } = await sb.from("monitors").select("id,status").eq("heartbeat_token", token).maybeSingle();
  if (!m) return json({ error: "unknown token" }, 404);
  await sb.from("monitors").update({ last_ping_at: new Date().toISOString() }).eq("id", m.id);
  await sb.from("checks").insert({ monitor_id: m.id, ok: true, latency_ms: 0 });
  if (m.status === "down") await transition(m.id, true, null);
  else if (m.status !== "up") await sb.from("monitors").update({ status: "up", consecutive_fails: 0 }).eq("id", m.id);
  return json({ ok: true });
}

async function runDue(force: boolean) {
  const { data: monitors, error } = await sb.from("monitors").select("*").eq("enabled", true);
  if (error) return { error: error.message };
  const now = Date.now();
  const due = (monitors || []).filter((m) => force || !m.last_checked_at || now - Date.parse(m.last_checked_at) >= (m.interval_min * 60 - 20) * 1000);
  const results = await Promise.all(due.map((m) => m.kind === "heartbeat" ? checkHeartbeat(m) : checkHttp(m)));
  return { checked: results.length, down: results.filter((r) => !r.ok).length, results };
}

async function checkHttp(m: any) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), m.timeout_ms || 10000);
  const started = performance.now();
  let ok = false, code: number | null = null, err: string | null = null;
  try {
    const res = await fetch(m.url, { method: m.method || "GET", headers: { "User-Agent": "KansalTech-Uptime/1.0", ...(m.headers || {}) }, body: m.method && m.method !== "GET" && m.body ? m.body : undefined, signal: ctrl.signal, redirect: "follow" });
    code = res.status;
    ok = code === (m.expected_status || 200);
    if (!ok) err = `HTTP ${code}`;
    if (ok && m.keyword) {
      const text = await res.text();
      if (!text.toLowerCase().includes(String(m.keyword).toLowerCase())) { ok = false; err = `Keyword "${m.keyword}" not found`; }
    } else { try { await res.body?.cancel(); } catch (_) { /* ignore */ } }
  } catch (e: any) {
    err = e?.name === "AbortError" ? `Timeout after ${m.timeout_ms}ms` : (e?.message || "Fetch failed");
  } finally { clearTimeout(t); }
  const latency = Math.round(performance.now() - started);
  await record(m, ok, code, latency, err);
  return { monitor: m.name, ok, code, latency, err };
}

async function checkHeartbeat(m: any) {
  const late = !m.last_ping_at || Date.now() - Date.parse(m.last_ping_at) > (m.interval_min + m.grace_min) * 60 * 1000;
  const err = late ? `No ping since ${m.last_ping_at ? new Date(m.last_ping_at).toUTCString() : "ever"}` : null;
  await record(m, !late, null, null, err, true);
  return { monitor: m.name, ok: !late, err };
}

async function record(m: any, ok: boolean, code: number | null, latency: number | null, err: string | null, skipCheckRow = false) {
  if (!skipCheckRow) await sb.from("checks").insert({ monitor_id: m.id, ok, status_code: code, latency_ms: latency, error: err });
  const fails = ok ? 0 : (m.consecutive_fails || 0) + 1;
  const patch: any = { last_checked_at: new Date().toISOString(), last_status_code: code, last_latency_ms: latency, last_error: err, consecutive_fails: fails };
  if (ok && m.status !== "up") { patch.status = "up"; if (m.status === "down") await transition(m.id, true, null, m); }
  else if (!ok && m.status !== "down" && fails >= (m.fail_threshold || 2)) { patch.status = "down"; await transition(m.id, false, err, m); }
  await sb.from("monitors").update(patch).eq("id", m.id);
}

// Open/close incident + alert all channels for the project (and global ones)
async function transition(monitorId: string, up: boolean, cause: string | null, m?: any) {
  if (!m) { const { data } = await sb.from("monitors").select("*").eq("id", monitorId).single(); m = data; }
  const { data: project } = await sb.from("projects").select("*").eq("id", m.project_id).single();
  let incident: any;
  if (up) {
    const { data } = await sb.from("incidents").select("*").eq("monitor_id", monitorId).is("resolved_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle();
    incident = data;
    if (incident) await sb.from("incidents").update({ resolved_at: new Date().toISOString() }).eq("id", incident.id);
  } else {
    const { data } = await sb.from("incidents").insert({ monitor_id: monitorId, cause }).select().single();
    incident = data;
  }
  const { data: channels } = await sb.from("alert_channels").select("*").eq("enabled", true).or(`project_id.is.null,project_id.eq.${m.project_id}`);
  const duration = incident?.started_at ? fmtDur(Date.now() - Date.parse(incident.started_at)) : "";
  const msg = {
    title: up ? `✅ RECOVERED: ${project.name} — ${m.name}` : `🔴 DOWN: ${project.name} — ${m.name}`,
    lines: up ? [`${m.name} is back up.`, `Downtime: ${duration}`, m.url ? `URL: ${m.url}` : ""] : [`${m.name} is not responding.`, `Cause: ${cause || "unknown"}`, m.url ? `URL: ${m.url}` : "", `Checked ${m.fail_threshold || 2}× in a row.`],
    up, project: project.name, monitor: m.name, cause: cause || "", duration,
  };
  for (const ch of channels || []) {
    if (!up && ch.escalate_after_min > 0) continue; // escalation channels handled by escalateLater on later ticks
    const r = await send(ch, msg);
    await sb.from("alert_log").insert({ incident_id: incident?.id || null, channel_id: ch.id, kind: up ? "up" : "down", ok: r.ok, error: r.error || null });
  }
  if (!up) await escalateLater();
}

// Escalation: for open incidents older than channel.escalate_after_min that haven't been alerted on that channel yet
async function escalateLater() {
  const { data: open } = await sb.from("incidents").select("*, monitors(*, projects(*))").is("resolved_at", null);
  const { data: channels } = await sb.from("alert_channels").select("*").eq("enabled", true).gt("escalate_after_min", 0);
  for (const inc of open || []) for (const ch of channels || []) {
    if (ch.project_id && ch.project_id !== inc.monitors.project_id) continue;
    if (Date.now() - Date.parse(inc.started_at) < ch.escalate_after_min * 60000) continue;
    const { data: already } = await sb.from("alert_log").select("id").eq("incident_id", inc.id).eq("channel_id", ch.id).limit(1);
    if (already && already.length) continue;
    const m = inc.monitors, p = m.projects;
    const r = await send(ch, { title: `🔴 STILL DOWN (${ch.escalate_after_min} min): ${p.name} — ${m.name}`, lines: [`Cause: ${inc.cause || "unknown"}`, m.url ? `URL: ${m.url}` : ""], up: false, project: p.name, monitor: m.name, cause: inc.cause || "", duration: fmtDur(Date.now() - Date.parse(inc.started_at)) });
    await sb.from("alert_log").insert({ incident_id: inc.id, channel_id: ch.id, kind: "down", ok: r.ok, error: r.error || null });
  }
}

async function testChannel(id: string) {
  const { data: ch } = await sb.from("alert_channels").select("*").eq("id", id).single();
  if (!ch) return { ok: false, error: "channel not found" };
  const r = await send(ch, { title: "🔔 Test alert from Kansal Tech Uptime", lines: ["If you can read this, alerts for this channel work."], up: true, project: "Uptime", monitor: "Test", cause: "", duration: "" });
  await sb.from("alert_log").insert({ channel_id: ch.id, kind: "test", ok: r.ok, error: r.error || null });
  return r;
}

type Msg = { title: string; lines: string[]; up: boolean; project: string; monitor: string; cause: string; duration: string };
async function send(ch: any, msg: Msg): Promise<{ ok: boolean; error?: string }> {
  const plain = msg.title.replace(/[✅🔴🔔]\s*/g, "");
  try {
    if (ch.type === "slack") {
      const r = await fetch(ch.target, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${msg.title}*\n${msg.lines.filter(Boolean).join("\n")}\n<${env("DASHBOARD_URL")}|Open dashboard>` }) });
      return r.ok ? { ok: true } : { ok: false, error: `Slack ${r.status}` };
    }
    if (ch.type === "whatsapp") {
      // Meta WhatsApp Cloud API with an approved template (default name uptime_alert): {{1}} title, {{2}} details, {{3}} dashboard URL
      const r = await fetch(`https://graph.facebook.com/v20.0/${env("WHATSAPP_PHONE_ID")}/messages`, { method: "POST", headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: ch.target.replace(/\D/g, ""), type: "template", template: { name: env("WHATSAPP_TEMPLATE", "uptime_alert"), language: { code: "en" }, components: [{ type: "body", parameters: [
          { type: "text", text: plain }, { type: "text", text: msg.lines.filter(Boolean).join(" · ") }, { type: "text", text: env("DASHBOARD_URL") }] }] } }) });
      if (r.ok) return { ok: true };
      return { ok: false, error: `WhatsApp ${r.status}: ${(await r.text()).slice(0, 200)}` };
    }
    // email (Resend)
    const color = msg.up ? "#1f9d6b" : "#c43d3d";
    const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden">
      <div style="background:${color};color:#fff;padding:18px 22px;font-size:17px;font-weight:600">${plain}</div>
      <div style="padding:20px 22px;color:#2b3036;font-size:14px;line-height:1.6">${msg.lines.filter(Boolean).map((l) => `<div>${l}</div>`).join("")}
        <div style="margin-top:18px"><a href="${env("DASHBOARD_URL")}" style="background:#24282c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:13px">Open dashboard</a></div></div>
      <div style="padding:12px 22px;color:#8b93a5;font-size:11px;border-top:1px solid #eef0f3">Kansal Tech Uptime · ${new Date().toUTCString()}</div></div>`;
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env("ALERT_FROM", "Kansal Tech Uptime <uptime@kansaltech.ca>"), to: ch.target.split(",").map((s: string) => s.trim()), subject: plain, html }) });
    if (r.ok) return { ok: true };
    return { ok: false, error: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

function fmtDur(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); return `${h} h ${m % 60} min`;
}
