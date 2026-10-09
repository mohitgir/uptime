-- Kansal Tech Uptime — run once in a NEW Supabase project (SQL editor).
-- Tables → RLS → RPCs → cron. Safe to re-run (idempotent).
create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- tables ----------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  website text,
  public_status boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists monitors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  kind text not null default 'http' check (kind in ('http','heartbeat')),
  url text,
  method text not null default 'GET',
  headers jsonb not null default '{}'::jsonb,
  body text,
  expected_status int not null default 200,
  keyword text,
  interval_min int not null default 5,
  timeout_ms int not null default 10000,
  fail_threshold int not null default 2,
  grace_min int not null default 10,            -- heartbeat: allowed lateness
  heartbeat_token text unique default encode(gen_random_bytes(12),'hex'),
  enabled boolean not null default true,
  status text not null default 'pending' check (status in ('pending','up','down','paused')),
  consecutive_fails int not null default 0,
  last_checked_at timestamptz,
  last_ping_at timestamptz,
  last_status_code int,
  last_latency_ms int,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists monitors_project_idx on monitors(project_id);

create table if not exists checks (
  id bigserial primary key,
  monitor_id uuid not null references monitors(id) on delete cascade,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  status_code int,
  latency_ms int,
  error text
);
create index if not exists checks_monitor_time_idx on checks(monitor_id, checked_at desc);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references monitors(id) on delete cascade,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  cause text,
  acknowledged_by text,
  note text
);
create index if not exists incidents_monitor_idx on incidents(monitor_id, started_at desc);

create table if not exists alert_channels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,   -- null = every project
  type text not null check (type in ('email','slack','whatsapp')),
  label text,
  target text not null,                                        -- email address / webhook URL / E.164 phone
  escalate_after_min int not null default 0,                   -- 0 = alert immediately
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists alert_log (
  id bigserial primary key,
  incident_id uuid references incidents(id) on delete cascade,
  channel_id uuid references alert_channels(id) on delete set null,
  kind text not null check (kind in ('down','up','test')),
  sent_at timestamptz not null default now(),
  ok boolean not null,
  error text
);

create table if not exists settings (
  key text primary key,
  value text
);
insert into settings(key,value) values ('retention_days','90') on conflict do nothing;

-- ---------- RLS ----------
alter table projects enable row level security;
alter table monitors enable row level security;
alter table checks enable row level security;
alter table incidents enable row level security;
alter table alert_channels enable row level security;
alter table alert_log enable row level security;
alter table settings enable row level security;

do $$ declare t text; begin
  foreach t in array array['projects','monitors','checks','incidents','alert_channels','alert_log','settings'] loop
    execute format('drop policy if exists %I_auth_all on %I', t, t);
    execute format('create policy %I_auth_all on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
-- Public status page reads go through the public_status() RPC (security definer) — no anon table access.

-- ---------- RPCs ----------
-- Uptime % + avg latency per monitor for the last N days (dashboard)
create or replace function uptime_summary(p_days int default 30)
returns table(monitor_id uuid, total bigint, ok_count bigint, uptime numeric, avg_latency numeric, p95_latency numeric)
language sql stable security definer set search_path = public as $$
  select monitor_id, count(*) total, count(*) filter (where ok) ok_count,
         round(100.0 * count(*) filter (where ok) / greatest(count(*),1), 3) uptime,
         round(avg(latency_ms) filter (where ok)) avg_latency,
         percentile_cont(0.95) within group (order by latency_ms) filter (where ok) p95_latency
  from checks where checked_at > now() - make_interval(days => p_days)
  group by monitor_id
$$;
grant execute on function uptime_summary(int) to authenticated;

-- Last N checks per monitor (sparklines)
create or replace function recent_checks(p_limit int default 48)
returns table(monitor_id uuid, checked_at timestamptz, ok boolean, latency_ms int)
language sql stable security definer set search_path = public as $$
  select monitor_id, checked_at, ok, latency_ms from (
    select c.*, row_number() over (partition by monitor_id order by checked_at desc) rn from checks c
    where checked_at > now() - interval '3 days') x
  where rn <= p_limit order by monitor_id, checked_at
$$;
grant execute on function recent_checks(int) to authenticated;

-- Public status page payload: project, monitors (name + status only), 90 daily uptime bars, open + recent incidents
create or replace function public_status(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p projects; out jsonb;
begin
  select * into p from projects where slug = p_slug and public_status;
  if p.id is null then return null; end if;
  select jsonb_build_object(
    'project', jsonb_build_object('name', p.name, 'slug', p.slug, 'website', p.website),
    'generated_at', now(),
    'monitors', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'status', m.status, 'kind', m.kind, 'last_checked_at', m.last_checked_at,
        'latency', m.last_latency_ms,
        'days', (select coalesce(jsonb_agg(jsonb_build_object('d', d.dday, 'u', d.pct_up) order by d.dday), '[]'::jsonb) from (
            select date_trunc('day', checked_at)::date as dday,
                   round(100.0 * count(*) filter (where ok) / greatest(count(*),1), 2) as pct_up
            from checks where monitor_id = m.id and checked_at > now() - interval '90 days' group by 1) d),
        'uptime30', (select round(100.0 * count(*) filter (where ok) / greatest(count(*),1), 2) from checks where monitor_id = m.id and checked_at > now() - interval '30 days')
      ) order by m.name) from monitors m where m.project_id = p.id and m.enabled), '[]'::jsonb),
    'incidents', coalesce((select jsonb_agg(jsonb_build_object(
        'monitor', m.name, 'started_at', i.started_at, 'resolved_at', i.resolved_at, 'cause', i.cause) order by i.started_at desc)
      from incidents i join monitors m on m.id = i.monitor_id
      where m.project_id = p.id and i.started_at > now() - interval '30 days'), '[]'::jsonb)
  ) into out;
  return out;
end $$;
grant execute on function public_status(text) to anon, authenticated;

-- Retention
create or replace function prune_checks() returns void language sql security definer set search_path = public as $$
  delete from checks where checked_at < now() - make_interval(days => coalesce((select value::int from settings where key='retention_days'), 90));
  delete from alert_log where sent_at < now() - interval '180 days';
$$;

-- ---------- cron ----------
-- Replace <PROJECT_REF> and <CRON_SECRET> (same value as the edge function secret CRON_SECRET).
do $$ begin
  perform cron.unschedule('uptime-run-checks');
exception when others then null; end $$;
select cron.schedule('uptime-run-checks', '* * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/run-checks',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb, timeout_milliseconds := 50000);
$$);
-- The function itself only checks monitors whose own interval has elapsed, so a 1-minute tick
-- supports 1/5/15-minute monitors.
do $$ begin
  perform cron.unschedule('uptime-prune');
exception when others then null; end $$;
select cron.schedule('uptime-prune', '15 4 * * *', $$ select prune_checks(); $$);

-- ---------- seed: Kansal Tech projects ----------
insert into projects(slug, name, website, sort) values
  ('kansal-tech','Kansal Tech','https://kansaltech.ca',0),
  ('prestige-eyewear','Prestige Eyewear','https://prestigeeyewear.ca',1),
  ('family-forever','Family Forever Inc.','https://familyforever.ca',2),
  ('golden-era-custom-homes','Golden Era Custom Homes','https://goldeneracustomhomes.com',3),
  ('smart-steps-daycare','Smart Steps Daycare','https://smartstepsdaycare.ca',4),
  ('perfect-safety-solutions','Perfect Safety Solutions','https://perfectsafetysolutions.com',5),
  ('north-signal-mobile','North Signal Mobile','https://www.northsignalmobile.ca',6),
  ('riar-residential','Riar Residential','https://riarresidential.com',7)
on conflict (slug) do nothing;

-- One homepage monitor per project
insert into monitors(project_id, name, url, keyword)
select id, 'Homepage', website, null from projects p
where not exists (select 1 from monitors m where m.project_id = p.id and m.name = 'Homepage');

-- Prestige extras (admin, booking page keyword, Supabase REST)
insert into monitors(project_id, name, url, keyword, expected_status)
select id, 'Booking page', 'https://prestigeeyewear.ca/book', 'Book', 200 from projects where slug='prestige-eyewear'
  and not exists (select 1 from monitors where name='Booking page' and project_id=(select id from projects where slug='prestige-eyewear'));
insert into monitors(project_id, name, url, expected_status)
select id, 'Admin', 'https://prestigeeyewear.ca/admin', 200 from projects where slug='prestige-eyewear'
  and not exists (select 1 from monitors where name='Admin' and project_id=(select id from projects where slug='prestige-eyewear'));
insert into monitors(project_id, name, url, expected_status, keyword, headers)
select id, 'Supabase API', 'https://lflthgvccminphwfxnmr.supabase.co/rest/v1/', 200, 'openapi',
  '{"apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmbHRoZ3ZjY21pbnBod2Z4bm1yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTI1MzEsImV4cCI6MjEwMTQyODUzMX0.7zpoeTVyMl4msdSt60e3p6pWF0WyFcfW-HqY0JSS8DQ"}'::jsonb
from projects where slug='prestige-eyewear'
  and not exists (select 1 from monitors where name='Supabase API' and project_id=(select id from projects where slug='prestige-eyewear'));
-- Existing installs: make sure the Supabase API check verifies the database answers, not just that the host is up
update monitors set keyword='openapi' where name='Supabase API' and url like '%/rest/v1/' and (keyword is null or keyword='');

-- Global alert channel (edit the address)
insert into alert_channels(project_id, type, label, target)
select null, 'email', 'Kansal Tech ops', 'ops@kansaltech.ca'
where not exists (select 1 from alert_channels where target='ops@kansaltech.ca');
