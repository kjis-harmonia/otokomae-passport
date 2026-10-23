-- Human-run emergency stop. Does not cancel a request already queued/in progress.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table cron.job in share row exclusive mode;
do $$
declare j bigint;
begin
  if (select count(*) from cron.job where jobname='johnny-waitlist-minutely') <> 1 then raise exception 'waitlist_job_count_mismatch'; end if;
  select jobid into strict j from cron.job where jobname='johnny-waitlist-minutely' and database=current_database() and username=current_user;
  perform cron.alter_job(j, active := false);
end $$;
select jobname, schedule, active from cron.job where jobname='johnny-waitlist-minutely';
commit;
