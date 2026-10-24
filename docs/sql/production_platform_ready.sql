-- Read-only release prerequisites. All *_ready must be true BEFORE any deploy.
begin read only;
select jsonb_build_object(
  'history_count',(select count(*) from supabase_migrations.schema_migrations),
  'history_ready',(select count(*)=47 from supabase_migrations.schema_migrations),
  'store_ready',to_regprocedure('public.customer_store_access_status(text)') is not null and to_regprocedure('app_private.require_store_verified(text)') is not null,
  'waitlist_ready',to_regprocedure('public.waitlist_offers_for_sender(text)') is not null,
  'passkeys_ready',to_regprocedure('public.customer_passkey_service(text,jsonb)') is not null,
  'cron_ready',to_regprocedure('cron.schedule(text,text,text)') is not null and to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is not null,
  'net_ready',exists(select 1 from pg_extension where extname='pg_net'),
  'notify_secret_ready',exists(select 1 from app_private.notify_secret where id=1 and length(secret_hash)>0),
  'notify_enabled',(select enabled from app_private.notify_settings where id=1),
  'app_booking_enabled',(select app_booking_enabled from public.booking_settings where id=1),
  'daily_job_count',(select count(*) from cron.job where jobname='johnny-notify-daily'),
  'waitlist_job_count',(select count(*) from cron.job where jobname='johnny-waitlist-minutely')
) as platform_ready;
commit;
