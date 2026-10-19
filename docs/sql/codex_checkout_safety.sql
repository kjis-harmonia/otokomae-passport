-- Claudeへ：migration/rolloutはClaude管理。このSQL案をレビューして、一意のversionでStagingへ適用する。
-- 本番にはこの作業では適用しない。既存の会計・価格計算エンジンは置き換えない。

create or replace function public.staff_finalize_sale(p_staff text, p jsonb, p_staff_name text)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), '');
begin
  perform app_private.assert_staff(p_staff);
  if v_key is null or length(v_key) > 100 then
    return json_build_object('error', 'idempotency_key_required');
  end if;
  -- 同じ取引キーの照合と確定を直列化。最初のHTTP応答が失われても新しい売上を作らない。
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout:' || v_key, 0));
  return app_private.finalize_sale(p, 'staff', p_staff_name)::json;
end;
$function$;

create or replace function public.staff_checkout_result(p_staff text, p_idempotency_key text)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_id uuid;
begin
  perform app_private.assert_staff(p_staff);
  if v_key is null or length(v_key) > 100 then
    return json_build_object('error', 'invalid_idempotency_key');
  end if;
  -- 確定処理と同じロック。処理中の取引を未確定と読み違えない。
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout:' || v_key, 0));
  select id into v_id from public.accounting_sessions
  where idempotency_key = v_key and status in ('completed', 'voided');
  if v_id is null then return null; end if;
  return app_private.sale_json(v_id)::json;
end;
$function$;

-- 既存会員の氏名はQRの内容で変更しない。新規の初回登録だけ名前を受け取る。
create or replace function public.staff_register_customer(p_staff text, p_user_id text, p_name text)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_c public.customers; v_code text; i int;
begin
  perform app_private.assert_staff(p_staff);
  select * into v_c from public.customers where user_id = p_user_id;
  if not found then
    for i in 1..5 loop
      v_code := 'GIN-' || upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 4)) || '-' || upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 4));
      exit when not exists (select 1 from public.customers where recovery_code = v_code);
    end loop;
    insert into public.customers(user_id, name, recovery_code, normalized_name)
    values(p_user_id, coalesce(nullif(btrim(p_name), ''), '名前未設定'), v_code,
      lower(regexp_replace(replace(coalesce(p_name, ''), '　', ''), '\s+', '', 'g')))
    on conflict(user_id) do nothing;
    -- 同じQRを別端末が同時に初回登録しても、先に保存された氏名をそのまま使う。
    select * into v_c from public.customers where user_id = p_user_id;
    insert into public.customer_user_aliases(customer_id, user_id, is_current)
    values(v_c.id, p_user_id, true) on conflict(user_id) do nothing;
  end if;
  return public.staff_customer_context(p_staff, p_user_id);
end;
$function$;

revoke all on function public.staff_checkout_result(text, text) from public;
grant execute on function public.staff_checkout_result(text, text) to anon, authenticated, service_role;
-- 置換した既存2関数の実行権限は維持。認証は全経路でassert_staffが必須。

notify pgrst, 'reload schema';
