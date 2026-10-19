-- Read-only. Never expose cron.command, headers, tokens, payloads or error text.
begin read only;
select jsonb_build_object(
  'jobs',(select coalesce(jsonb_agg(jsonb_build_object('jobname',j.jobname,'schedule',j.schedule,'active',j.active,'database_matches',j.database=current_database(),'owner_matches',j.username=current_user,
     'production_notify_url',position('https://ufyzynpmkxytnhebombq.supabase.co/functions/v1/johnny-notify' in j.command)>0,
     'command_md5',md5(j.command),
     'body_is_waitlist',coalesce(((regexp_match(j.command,'body\s*:=\s*''([^'']*)''::jsonb','i'))[1])::jsonb='{"waitlist":true}'::jsonb,false)) order by j.jobname),'[]'::jsonb)
     from cron.job j where j.jobname in ('johnny-notify-daily','johnny-waitlist-minutely')),
  'recent_waitlist_runs',(select coalesce(jsonb_agg(r order by r.start_time desc),'[]'::jsonb) from
     (select d.status,d.start_time,d.end_time from cron.job_run_details d join cron.job j using(jobid)
      where j.jobname='johnny-waitlist-minutely' order by d.start_time desc limit 5) r),
  'notify_enabled',(select enabled from app_private.notify_settings where id=1)
) as waitlist_status;
commit;
