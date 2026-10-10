-- Kansal Tech Uptime — RESET. Wipes all monitoring data and re-seeds the 8 projects.
-- Run in the UPTIME project's SQL editor (not a client's). Tables, RPCs, cron and users are kept.
-- Staff logins are untouched (Authentication → Users). Alert channels are wiped too — re-add them in the dashboard.

truncate table alert_log, incidents, checks, alert_channels, monitors, projects restart identity cascade;

-- Re-seed projects
insert into projects(slug, name, website, sort) values
  ('kansal-tech','Kansal Tech','https://kansaltech.ca',0),
  ('prestige-eyewear','Prestige Eyewear','https://prestigeeyewear.ca',1),
  ('family-forever','Family Forever Inc.','https://familyforever.ca',2),
  ('golden-era-custom-homes','Golden Era Custom Homes','https://goldeneracustomhomes.com',3),
  ('smart-steps-daycare','Smart Steps Daycare','https://smartstepsdaycare.ca',4),
  ('perfect-safety-solutions','Perfect Safety Solutions','https://perfectsafetysolutions.com',5),
  ('north-signal-mobile','North Signal Mobile','https://www.northsignalmobile.ca',6),
  ('riar-residential','Riar Residential','https://riarresidential.com',7);

-- One homepage monitor per project
insert into monitors(project_id, name, url) select id, 'Homepage', website from projects;

-- Prestige extras
insert into monitors(project_id, name, url, keyword) select id, 'Booking page', 'https://prestigeeyewear.ca/book', 'Book' from projects where slug='prestige-eyewear';
insert into monitors(project_id, name, url) select id, 'Admin', 'https://prestigeeyewear.ca/admin' from projects where slug='prestige-eyewear';
insert into monitors(project_id, name, url, headers)
select id, 'Supabase API', 'https://lflthgvccminphwfxnmr.supabase.co/rest/v1/settings?select=*&limit=1',
  '{"apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmbHRoZ3ZjY21pbnBod2Z4bm1yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTI1MzEsImV4cCI6MjEwMTQyODUzMX0.7zpoeTVyMl4msdSt60e3p6pWF0WyFcfW-HqY0JSS8DQ"}'::jsonb
from projects where slug='prestige-eyewear';

-- Global alert channel (edit the address)
insert into alert_channels(project_id, type, label, target) values (null, 'email', 'Kansal Tech ops', 'ops@kansaltech.ca');

select (select count(*) from projects) as projects, (select count(*) from monitors) as monitors, (select count(*) from checks) as checks;
