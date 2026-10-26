-- Human-run only, AFTER DB steps 01-21. Creates a paused job; does not send.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- 10/26 修正: postgres は cron.job の UPDATE 権限がなく LOCK TABLE が 42501 になるため、この3本どうしを勧告ロックで直列化する
do $lk$ begin perform pg_advisory_xact_lock(hashtext('ginjiro:johnny-waitlist-cron')); end $lk$;
do $$
declare
  d record;
  c text;
  body_pattern constant text := 'body\s*:=\s*''([^'']*)''::jsonb';
  n bigint;
  j bigint;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 47
     or not exists (select 1 from supabase_migrations.schema_migrations where version='20261023000000' and name='ai_booking_penalty')
     or not exists (select 1 from supabase_migrations.schema_migrations where version='20261019000000' and name='waitlist')
     or not exists (select 1 from supabase_migrations.schema_migrations where version='20261018040349' and name='customer_store_access') then
    raise exception 'release_db_not_ready';
  end if;
  if to_regprocedure('public.waitlist_offers_for_sender(text)') is null
     or to_regprocedure('public.customer_store_access_status(text)') is null then raise exception 'required_rpc_missing'; end if;
  if to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then raise exception 'cron_alter_job_missing'; end if;
  if (select count(*) from cron.job where jobname='johnny-notify-daily') <> 1 then raise exception 'daily_job_count_mismatch'; end if;
  if exists (select 1 from cron.job where jobname='johnny-waitlist-minutely') then raise exception 'waitlist_job_already_exists_stop'; end if;
  select * into strict d from cron.job where jobname='johnny-notify-daily';
  if d.database <> current_database() or d.username <> current_user then raise exception 'daily_job_owner_or_database_mismatch'; end if;
  if position('https://ufyzynpmkxytnhebombq.supabase.co/functions/v1/johnny-notify' in d.command)=0
     or position('net.http_post' in d.command)=0
     or position('x-notify-secret' in lower(d.command))=0
     or position('authorization' in lower(d.command))=0 then raise exception 'daily_job_template_mismatch'; end if;
  select count(*) into n from regexp_matches(d.command, body_pattern, 'gi');
  if n <> 1 then raise exception 'daily_body_count_mismatch'; end if;
  if ((regexp_match(d.command, body_pattern, 'i'))[1])::jsonb <> '{}'::jsonb then raise exception 'daily_body_not_empty'; end if;
  -- Copy existing authentication in DB memory only. Never print/save the command.
  c := regexp_replace(d.command, body_pattern, 'body := ''{"waitlist":true}''::jsonb', 'i');
  if c=d.command then raise exception 'waitlist_body_not_replaced'; end if;
  j := cron.schedule('johnny-waitlist-minutely', '* * * * *', c);
  -- Same transaction: no other session can see the temporary active=true state.
  perform cron.alter_job(j, active := false);
  if not exists (select 1 from cron.job where jobid=j and active=false and schedule='* * * * *' and command=c
                  and database=d.database and username=d.username) then raise exception 'paused_job_check_failed'; end if;
  if not exists (select 1 from cron.job where jobid=d.jobid and command=d.command and schedule=d.schedule
                  and active=d.active and database=d.database and username=d.username) then raise exception 'daily_job_changed'; end if;
end $$;
select jobname, schedule, active from cron.job where jobname in ('johnny-notify-daily','johnny-waitlist-minutely') order by jobname;
commit;
