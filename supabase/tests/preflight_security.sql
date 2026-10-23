-- Staging preflight: RLS, grants, and public RPC security checks.

do $$
declare
  v_count integer;
  v_detail text;
begin
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname not like 'pg_%'
    and c.relname not like '__preflight_%'
    and c.relname not like '__ginpay_%'
    and not c.relrowsecurity;
  if v_count > 0 then
    select string_agg(c.relname, ', ' order by c.relname) into v_detail
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
    raise exception 'rls_disabled_tables: %', v_detail;
  end if;

  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_count > 0 then
    select string_agg(distinct table_name || ':' || grantee || ':' || privilege_type, ', ' order by table_name || ':' || grantee || ':' || privilege_type)
      into v_detail
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
    raise exception 'direct_table_grants_to_client_roles: %', v_detail;
  end if;

  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app_private'
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (
        select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      ));
  if v_count > 0 then raise exception 'app_private_function_grants_visible_to_client_roles'; end if;

  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    and not p.prosecdef;
  if v_count > 0 then
    select string_agg(p.proname, ', ' order by p.proname) into v_detail
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      and not p.prosecdef;
    raise exception 'client_executable_rpc_not_security_definer: %', v_detail;
  end if;

  -- クライアント（anon / authenticated）が実行できる SECURITY DEFINER は search_path の固定が必須
  select string_agg(p.proname, ', ' order by p.proname) into v_detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
  if v_detail is not null then raise exception 'security_definer_rpc_missing_search_path: %', v_detail; end if;
  -- クライアントから実行できないもの（旧 RPC。新しい RPC の内部からだけ呼ばれる）は警告として表示する
  select string_agg(p.proname, ', ' order by p.proname) into v_detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
  if v_detail is not null then raise warning 'security definer without fixed search_path (not executable by anon/authenticated): %', v_detail; end if;
end $$;
