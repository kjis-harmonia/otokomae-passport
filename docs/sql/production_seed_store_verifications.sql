-- PREPARED ONLY: do not execute until Keichiro has reviewed the candidate count.
-- Intended project: ufyzynpmkxytnhebombq. Operator must specify --project-ref explicitly.
-- Run after steps 01-14 AND production_lock_legacy_record_writes.sql, BEFORE step 15.
-- Snapshot reviewed here: 2026-10-19 14:13:00 JST, 30 candidates out of 59 customers.
-- This is a one-off data rollout, not the full customer_store_access migration.
-- Do NOT mark version 20261018040349 applied here; step 15 records its own history.
-- No booking setting, customer, ticket, checkout, or existing approval is updated.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

-- Briefly stabilize the evidence and the current customer-ID mapping.
lock table public.customers, public.maintenance_visits, public.visit_log,
  public.accounting_sessions, public.ticket_usage_logs, public.tickets in share mode;

do $prerequisites$
declare missing_versions text; record_table text; relation regclass; api_role text;
begin
  if exists (select 1 from supabase_migrations.schema_migrations
             where version = '20261018040349') then
    raise exception 'customer_store_access is already applied: stop; this file is for before step 15 only';
  end if;
  select string_agg(required.version, ', ' order by required.version)
  into missing_versions
  from unnest(array[
    '20261004000000','20261005000000','20261006000000','20261007000000',
    '20261016091916','20261016095032','20261016234902','20261017030847',
    '20261017040000','20261017050000','20261017202804','20261018000010',
    '20261018000100','20261018000200'
  ]::text[]) as required(version)
  where not exists (select 1 from supabase_migrations.schema_migrations applied
                    where applied.version = required.version);
  if missing_versions is not null then
    raise exception 'release steps 01-14 are not complete: %', missing_versions;
  end if;
  foreach record_table in array array[
    'visit_log','maintenance_visits','ticket_usage_logs','tickets',
    'accounting_sessions','accounting_session_items','accounting_items',
    'ticket_issue_logs','ticket_transfers','maintenance_coupon_tokens',
    'customers','customer_user_aliases','customer_recovery_logs'
  ] loop
    relation := to_regclass(format('public.%I',record_table));
    if relation is null then raise exception 'required record table is missing: %', record_table; end if;
    foreach api_role in array array['anon','authenticated'] loop
      if has_table_privilege(api_role,relation,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(api_role,relation,'INSERT,UPDATE,REFERENCES') then
        raise exception 'run production_lock_legacy_record_writes.sql first: %.% is still writable',
          api_role,record_table;
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname in
               ('complete_customer_onboarding','recover_member','claim_ticket_transfer')
               and (has_function_privilege('anon',p.oid,'EXECUTE')
                    or has_function_privilege('authenticated',p.oid,'EXECUTE'))) then
    raise exception 'run production_lock_legacy_record_writes.sql first: a legacy mutator is still executable';
  end if;
end;
$prerequisites$;

create temporary table ginjiro_store_seed_candidates on commit drop as
with evidence as (
  select user_id, 'checkin_visit_log'::text as source
  from public.visit_log
  where visit_date is not null
    and visit_date <= (now() at time zone 'Asia/Tokyo')::date
  union all
  select user_id, 'checkin_legacy'
  from public.maintenance_visits
  where last_visit_date is not null
    and last_visit_date <= (now() at time zone 'Asia/Tokyo')::date
  union all
  select user_id, 'completed_checkout'
  from public.accounting_sessions
  where status = 'completed' and created_at <= now()
  union all
  select user_id, 'ticket_usage_log'
  from public.ticket_usage_logs
  where status = 'used' and used_at is not null and used_at <= now()
    and usage_date <= (now() at time zone 'Asia/Tokyo')::date
  union all
  select user_id, 'used_ticket'
  from public.tickets
  where used is true and used_at is not null and used_at <= now()
)
select c.id as customer_id, c.user_id,
  bool_or(e.source in ('checkin_visit_log', 'checkin_legacy')) as checkin,
  bool_or(e.source = 'completed_checkout') as checkout,
  bool_or(e.source in ('ticket_usage_log', 'used_ticket')) as ticket_usage
from public.customers c
join evidence e on e.user_id = c.user_id
where nullif(btrim(c.user_id), '') is not null
group by c.id, c.user_id;

do $review_guard$
declare actual_count bigint; actual_fingerprint text;
begin
  select count(*), md5(coalesce(string_agg(customer_id::text || ':' || user_id,
    E'\n' order by customer_id, user_id), ''))
  into actual_count, actual_fingerprint
  from pg_temp.ginjiro_store_seed_candidates;
  if actual_count <> 30
     or actual_fingerprint is distinct from 'c4824d0dc827cb5ab3f9979455ccede8' then
    raise exception 'reviewed candidate set changed: expected 30 / c4824d0dc827cb5ab3f9979455ccede8, got % / %; stop and preview again',
      actual_count, actual_fingerprint;
  end if;
end;
$review_guard$;

-- Exact table definition from step 15 (staging ca4c923). Step 15 uses IF NOT EXISTS.
-- Preparing it first avoids a period where booking is gated but the old members lack approvals.
create table if not exists app_private.customer_store_verifications (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  verified_at timestamptz not null default now(), verified_by text not null,
  staff_session_hash text not null
);
alter table app_private.customer_store_verifications enable row level security;
revoke all on app_private.customer_store_verifications from public, anon, authenticated;
lock table app_private.customer_store_verifications in share row exclusive mode;

do $seed$
declare missing_count bigint; inserted_count bigint;
begin
  select count(*) into missing_count
  from pg_temp.ginjiro_store_seed_candidates candidate
  where not exists (select 1 from app_private.customer_store_verifications existing
                    where existing.customer_id = candidate.customer_id);

  with inserted as (
    insert into app_private.customer_store_verifications
      (customer_id, verified_by, staff_session_hash)
    select candidate.customer_id, '一括（店の記録あり）',
      -- Auditable one-off marker, deliberately NOT a live staff-session token/hash.
      'bulk-store-records:ufyzynpmkxytnhebombq:c4824d0dc827cb5ab3f9979455ccede8'
    from pg_temp.ginjiro_store_seed_candidates candidate
    on conflict (customer_id) do nothing
    returning customer_id
  ) select count(*) into inserted_count from inserted;

  if inserted_count <> missing_count then
    raise exception 'insert count mismatch: expected %, got %', missing_count, inserted_count;
  end if;
  if exists (select 1 from pg_temp.ginjiro_store_seed_candidates candidate
             where not exists (select 1 from app_private.customer_store_verifications verified
                               where verified.customer_id = candidate.customer_id)) then
    raise exception 'a reviewed candidate is still unverified';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'app_private' and c.relname = 'customer_store_verifications'
               and not c.relrowsecurity)
     or has_table_privilege('anon', 'app_private.customer_store_verifications', 'SELECT')
     or has_table_privilege('anon', 'app_private.customer_store_verifications', 'INSERT')
     or has_table_privilege('anon', 'app_private.customer_store_verifications', 'UPDATE')
     or has_table_privilege('anon', 'app_private.customer_store_verifications', 'DELETE')
     or has_table_privilege('authenticated', 'app_private.customer_store_verifications', 'SELECT')
     or has_table_privilege('authenticated', 'app_private.customer_store_verifications', 'INSERT')
     or has_table_privilege('authenticated', 'app_private.customer_store_verifications', 'UPDATE')
     or has_table_privilege('authenticated', 'app_private.customer_store_verifications', 'DELETE') then
    raise exception 'verification table is not private';
  end if;
  raise notice 'store records bulk verification ok: targets=30, inserted=%, preserved=%',
    inserted_count, 30 - inserted_count;
end;
$seed$;

select count(*) as reviewed_candidates,
  count(verified.customer_id) as verified_candidates,
  count(*) filter (where verified.verified_by = '一括（店の記録あり）') as with_bulk_label
from pg_temp.ginjiro_store_seed_candidates candidate
left join app_private.customer_store_verifications verified
  on verified.customer_id = candidate.customer_id;

commit;
