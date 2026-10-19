-- PREPARED ONLY. Production: ufyzynpmkxytnhebombq. Operator runs with explicit project-ref.
-- Release order: steps 01-14 -> this file -> reviewed bulk approvals -> step 15.
-- Preserve current SELECT grants and policies; only direct write privileges are removed.
-- Close the three old public mutators too; authenticated customer/staff RPCs stay callable.
-- No customer/business rows, settings, passwords, or migration-history rows are written here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $prerequisites$
declare missing_versions text; required_name text;
begin
  if exists (select 1 from supabase_migrations.schema_migrations
             where version = '20261018040349') then
    raise exception 'step 15 is already applied; stop and review the release state';
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

  -- These are the live app's authenticated business routes. Do not remove/replace them.
  foreach required_name in array array[
    'customer_register','customer_claim_transfer','customer_create_transfer','customer_cancel_transfer',
    'staff_register_customer','staff_customer_context','staff_check_in','staff_issue_tickets_once',
    'staff_use_tickets','staff_recover_member','staff_redeem_maintenance_coupon','staff_finalize_sale'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles owner_role on owner_role.oid = p.proowner
      where n.nspname = 'public' and p.proname = required_name and p.prosecdef
        and (owner_role.rolsuper or owner_role.rolbypassrls)
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'authenticated SECURITY DEFINER route missing or changed: %', required_name;
    end if;
  end loop;
end;
$prerequisites$;

create temporary table ginjiro_record_write_targets on commit drop as
select c.oid as table_oid, c.relname as table_name, c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
  and c.relname = any(array[
    'visit_log','maintenance_visits','ticket_usage_logs','tickets',
    'accounting_sessions','accounting_session_items','accounting_items',
    'ticket_issue_logs','ticket_transfers','maintenance_coupon_tokens',
    'customers','customer_user_aliases','customer_recovery_logs'
  ]::text[]);

do $table_guard$
begin
  if (select count(*) from pg_temp.ginjiro_record_write_targets) <> 13 then
    raise exception 'expected all 13 record/identity tables; stop rather than skip a missing table';
  end if;
  if exists (select 1 from pg_temp.ginjiro_record_write_targets where not rls) then
    raise exception 'a record table has unexpected RLS state; stop rather than change its read behavior';
  end if;
end;
$table_guard$;

-- Preserve both table-level and column-level read permissions exactly.
create temporary table ginjiro_record_read_grants on commit drop as
select t.table_oid, r.role_name, a.attnum, a.attname,
  has_table_privilege(r.role_name, t.table_oid, 'SELECT') as table_select,
  has_column_privilege(r.role_name, t.table_oid, a.attnum, 'SELECT') as column_select
from pg_temp.ginjiro_record_write_targets t
cross join (values ('anon'::text), ('authenticated'::text)) r(role_name)
join pg_attribute a on a.attrelid = t.table_oid and a.attnum > 0 and not a.attisdropped;

-- Snapshot all surviving public authenticated routes' callability; function bodies stay unchanged.
create temporary table ginjiro_record_rpc_grants on commit drop as
select p.oid as function_oid, p.proowner as owner_oid, r.role_name,
  has_function_privilege(r.role_name, p.oid, 'EXECUTE') as can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'::text), ('authenticated'::text)) r(role_name)
where n.nspname = 'public' and
  (left(p.proname,6) = 'staff_' or left(p.proname,9) = 'customer_' or left(p.proname,3) = 'hq_');

do $close_writes$
declare target record; column_list text; old_function record;
begin
  for target in select * from pg_temp.ginjiro_record_write_targets order by table_name loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on table public.%I from public, anon, authenticated',
      target.table_name
    );
    -- Table REVOKE alone does not remove independently granted column privileges.
    select string_agg(format('%I', a.attname), ', ' order by a.attnum) into column_list
    from pg_attribute a where a.attrelid = target.table_oid and a.attnum > 0 and not a.attisdropped;
    execute format(
      'revoke insert (%s), update (%s), references (%s) on table public.%I from public, anon, authenticated',
      column_list, column_list, column_list, target.table_name
    );
  end loop;

  -- Clients know display IDs; those IDs must never authorize a write.
  -- The authenticated wrappers can still invoke these internal implementations as their owner.
  for old_function in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('complete_customer_onboarding','recover_member','claim_ticket_transfer')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated',
      old_function.oid::regprocedure);
  end loop;
end;
$close_writes$;

do $verify$
declare target record; api_role text;
begin
  for target in select * from pg_temp.ginjiro_record_write_targets loop
    foreach api_role in array array['anon','authenticated'] loop
      if has_table_privilege(api_role, target.table_oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(api_role, target.table_oid, 'INSERT,UPDATE,REFERENCES') then
        raise exception 'direct record write privilege remains: %.% (possibly an inherited role grant)',
          api_role, target.table_name;
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_temp.ginjiro_record_read_grants previous
             where has_table_privilege(previous.role_name, previous.table_oid, 'SELECT')
                       is distinct from previous.table_select
                or has_column_privilege(previous.role_name, previous.table_oid, previous.attnum, 'SELECT')
                       is distinct from previous.column_select) then
    raise exception 'existing record read privileges changed';
  end if;
  if exists (select 1 from pg_temp.ginjiro_record_rpc_grants previous
             join pg_proc p on p.oid = previous.function_oid
             where p.proowner is distinct from previous.owner_oid
                or has_function_privilege(previous.role_name, previous.function_oid, 'EXECUTE')
                       is distinct from previous.can_execute) then
    raise exception 'authenticated business RPC privileges changed';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in
               ('complete_customer_onboarding','recover_member','claim_ticket_transfer')
               and (has_function_privilege('anon',p.oid,'EXECUTE')
                    or has_function_privilege('authenticated',p.oid,'EXECUTE'))) then
    raise exception 'an unauthenticated legacy mutator is still executable';
  end if;
  raise notice 'legacy record writes locked ok: 13 tables; authenticated RPC and SELECT grants preserved';
end;
$verify$;

commit;
