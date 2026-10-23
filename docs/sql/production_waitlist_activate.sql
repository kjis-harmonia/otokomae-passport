-- Human-run only AFTER new Web, actual-device handover and closure B checks.
-- This starts real waitlist holds/notifications; HQ maintenance-notify OFF does not block it.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table cron.job in share row exclusive mode;
do $$
declare d record; w record; expected text;
  body_pattern constant text := 'body\s*:=\s*''([^'']*)''::jsonb';
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 45
     or not exists (select 1 from supabase_migrations.schema_migrations where version='20261001000400' and name='security_hardening_b_lockdown')
     or not exists (select 1 from supabase_migrations.schema_migrations where version='20261018040349' and name='customer_store_access')
     or not exists (select 1 from supabase_migrations.schema_migrations where version='20261019000000' and name='waitlist') then raise exception 'closure_b_or_release_db_not_ready'; end if;
  if (select count(*) from cron.job where jobname='johnny-notify-daily') <> 1
     or (select count(*) from cron.job where jobname='johnny-waitlist-minutely') <> 1 then raise exception 'job_count_mismatch'; end if;
  select * into strict d from cron.job where jobname='johnny-notify-daily';
  select * into strict w from cron.job where jobname='johnny-waitlist-minutely';
  if d.database <> current_database() or d.username <> current_user or w.database <> d.database or w.username <> d.username then raise exception 'job_owner_or_database_mismatch'; end if;
  if position('https://ufyzynpmkxytnhebombq.supabase.co/functions/v1/johnny-notify' in d.command)=0
     or position('net.http_post' in d.command)=0
     or position('x-notify-secret' in lower(d.command))=0
     or position('authorization' in lower(d.command))=0
     or (select count(*) from regexp_matches(d.command,body_pattern,'gi'))<>1 then raise exception 'daily_job_template_mismatch'; end if;
  if ((regexp_match(d.command,body_pattern,'i'))[1])::jsonb <> '{}'::jsonb then raise exception 'daily_body_not_empty'; end if;
  expected := regexp_replace(d.command,body_pattern,'body := ''{"waitlist":true}''::jsonb','i');
  if w.command <> expected or w.schedule <> '* * * * *' or w.active then raise exception 'waitlist_job_not_expected_paused_job'; end if;
  if (select app_booking_enabled from public.booking_settings where id=1) is distinct from true then raise exception 'app_booking_not_enabled'; end if;
  perform cron.alter_job(w.jobid, active := true);
end $$;
select jobname, schedule, active from cron.job where jobname='johnny-waitlist-minutely';
commit;
