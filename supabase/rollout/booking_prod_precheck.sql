-- 本番に予約の仕組みを入れる前の確認（読み取りのみ。何も変えない）
-- 結果は1行の JSON。docs/booking-production-rollout.md の「入れる前の確認」と見比べる。
select jsonb_build_object(
  'migrations', (select coalesce(jsonb_agg(version order by version), '[]')
                 from supabase_migrations.schema_migrations),
  'has_app_private', exists (select 1 from pg_namespace where nspname = 'app_private'),
  'has_assert_staff', to_regprocedure('app_private.assert_staff(text)') is not null,
  'has_staff_sessions', to_regclass('app_private.staff_sessions') is not null,
  'has_customer_sessions', to_regclass('app_private.customer_sessions') is not null,
  'has_customer_notes', to_regclass('public.customer_notes') is not null,
  'has_reservations', to_regclass('public.reservations') is not null,
  'has_clients', to_regclass('public.clients') is not null,
  'has_service_menus', to_regclass('public.service_menus') is not null,
  'has_staff_members', to_regclass('public.staff_members') is not null,
  'customers_contact_columns', (select coalesce(jsonb_agg(column_name order by column_name), '[]')
                                from information_schema.columns
                                where table_schema = 'public' and table_name = 'customers'
                                  and column_name in ('real_name', 'phone', 'contact_name', 'contact_phone')),
  'allow_all_policies', (select count(*) from pg_policies where schemaname = 'public' and policyname = 'allow_all'),
  'rows', jsonb_build_object(
    'customers', (select count(*) from public.customers),
    'tickets', (select count(*) from public.tickets),
    'ticket_usage_logs', (select count(*) from public.ticket_usage_logs),
    'accounting_sessions', (select count(*) from public.accounting_sessions),
    'products', (select count(*) from public.products)),
  'public_functions', (select coalesce(jsonb_agg(p.proname order by p.proname), '[]')
                       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public'
                         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))
) as precheck;
