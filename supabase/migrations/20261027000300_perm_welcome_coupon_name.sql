-- Welcomeクーポンの名前を「特殊パーマ Welcomeクーポン」→「パーマ Welcomeクーポン」に（10/27 慶一郎さん：パーマ全種類で使えるようにしたため）
--   1) これから配る券は新しい名前・説明  2) 古い名前の券も Welcomeクーポンとして見分ける  3) 配ってある券（system-welcome）の名前・説明を書き換える
--   関数は本番の定義の文字だけを置き換える

CREATE OR REPLACE FUNCTION app_private.is_welcome(t tickets)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$ select t.issued_by = 'system-welcome' or (t.title in ('特殊パーマ Welcomeクーポン', 'パーマ Welcomeクーポン') and t.amount = 2000) $function$;

CREATE OR REPLACE FUNCTION public.customer_register(p_name text, p_has_visited_before boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_uid     text;
  v_code    text;
  v_c       public.customers;
  v_ticket  public.tickets;
  v_session text;
  i int;
begin
  if v_name = '' or length(v_name) > 40 then
    return json_build_object('error', 'invalid_name');
  end if;
  if (select count(*) from app_private.auth_attempts
      where kind = 'register' and attempted_at > now() - interval '10 minutes') >= 100 then
    return json_build_object('error', 'rate_limited');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('register', true, 'unregistered');

  v_uid := 'u-' || encode(gen_random_bytes(12), 'hex');
  for i in 1..5 loop
    v_code := 'GIN-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 4)) || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 4));
    exit when not exists (select 1 from public.customers where recovery_code = v_code);
  end loop;

  insert into public.customers (user_id, name, recovery_code, normalized_name,
                                first_visit_answered_at, first_visit_has_visited_before)
  values (v_uid, v_name, v_code, lower(regexp_replace(replace(v_name, '　', ''), '\s+', '', 'g')),
          now(), coalesce(p_has_visited_before, true))
  returning * into v_c;
  insert into public.customer_user_aliases (customer_id, user_id, is_current)
  values (v_c.id, v_uid, true) on conflict (user_id) do nothing;

  if p_has_visited_before is false then
    insert into public.tickets (user_id, type, title, amount, memo, issued_by, used)
    values (v_uid, 'discount', 'パーマ Welcomeクーポン', 2000,
            '対象: パーマ全種類（パーマのセットを含む） / 平日のみ（土日利用不可） / 新規のお客様限定', 'system-welcome', false)
    returning * into v_ticket;
    update public.customers set welcome_coupon_issued_at = now() where id = v_c.id;
  end if;

  v_session := app_private.new_customer_session(v_uid, 'register');
  return json_build_object(
    'user_id', v_uid,
    'session', v_session,
    'ticket', case when v_ticket.id is null then null else row_to_json(v_ticket) end,
    'welcome_coupon_issued', v_ticket.id is not null
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_customer_onboarding(p_user_id text, p_name text, p_has_visited_before boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_customer public.customers;
  v_ticket public.tickets;
  v_existing_customer boolean := false;
  v_same_name_exists boolean := false;
  v_recovery_code text;
  v_normalized_name text;
  i integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'user_id_required';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;

  v_normalized_name := lower(regexp_replace(replace(btrim(p_name), '　', ''), '\s+', '', 'g'));

  select * into v_customer
  from public.customers
  where user_id = p_user_id
  for update;

  if found then
    v_existing_customer := true;

    update public.customers
    set name = btrim(p_name),
        normalized_name = v_normalized_name,
        first_visit_answered_at = coalesce(first_visit_answered_at, now()),
        first_visit_has_visited_before = coalesce(first_visit_has_visited_before, p_has_visited_before),
        updated_at = now()
    where id = v_customer.id
      returning * into v_customer;
  else
    select exists (
      select 1
      from public.customers
      where normalized_name = v_normalized_name
    ) into v_same_name_exists;

    -- Same normalized name is not strong enough to recover the customer,
    -- but it is enough ambiguity to avoid issuing a new-customer Welcome coupon.
    v_existing_customer := v_same_name_exists;

    for i in 1..5 loop
      v_recovery_code :=
        'GIN-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) ||
        '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));

      exit when not exists (
        select 1 from public.customers where recovery_code = v_recovery_code
      );
    end loop;

    insert into public.customers (
      user_id,
      name,
      recovery_code,
      normalized_name,
      first_visit_answered_at,
      first_visit_has_visited_before
    )
    values (
      p_user_id,
      btrim(p_name),
      v_recovery_code,
      v_normalized_name,
      now(),
      p_has_visited_before
    )
    returning * into v_customer;

    insert into public.customer_user_aliases (customer_id, user_id, is_current)
    values (v_customer.id, p_user_id, true)
    on conflict (user_id) do nothing;
  end if;

  select * into v_ticket
  from public.tickets
  where user_id = p_user_id
    and issued_by = 'system-welcome'
    and title in ('特殊パーマ Welcomeクーポン', 'パーマ Welcomeクーポン')
  limit 1;

  if not p_has_visited_before and not v_existing_customer and v_ticket.id is null then
    insert into public.tickets (
      user_id,
      type,
      title,
      amount,
      memo,
      issued_by,
      used
    )
    values (
      p_user_id,
      'discount',
      'パーマ Welcomeクーポン',
      2000,
      '対象: パーマ全種類（パーマのセットを含む） / 平日のみ（土日利用不可） / 新規のお客様限定',
      'system-welcome',
      false
    )
    on conflict do nothing
    returning * into v_ticket;

    if v_ticket.id is not null then
      update public.customers
      set welcome_coupon_issued_at = now(),
          updated_at = now()
      where id = v_customer.id
      returning * into v_customer;

      return json_build_object(
        'customer', row_to_json(v_customer),
        'ticket', row_to_json(v_ticket),
        'welcome_coupon_issued', true,
        'existing_customer', false
      );
    end if;

    select * into v_ticket
    from public.tickets
    where user_id = p_user_id
      and issued_by = 'system-welcome'
      and title in ('特殊パーマ Welcomeクーポン', 'パーマ Welcomeクーポン')
    limit 1;
  end if;

  if v_ticket.id is not null then
    update public.customers
    set welcome_coupon_issued_at = coalesce(welcome_coupon_issued_at, v_ticket.created_at),
        updated_at = now()
    where id = v_customer.id
    returning * into v_customer;
  end if;

  return json_build_object(
    'customer', row_to_json(v_customer),
    'ticket', case when v_ticket.id is null then null else row_to_json(v_ticket) end,
    'welcome_coupon_issued', false,
    'existing_customer', v_existing_customer
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_use_tickets(p_staff text, p_user_id text, p_ticket_ids uuid[], p_staff_name text, p_customer_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_types text[]; v_count int; v_used_type text; v_rows json; v_t text;
begin
  perform app_private.assert_staff(p_staff);
  if p_ticket_ids is null or cardinality(p_ticket_ids) = 0 then raise exception 'no_tickets'; end if;
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;

  -- 対象行をロック
  perform 1 from public.tickets where id = any(p_ticket_ids) for update;

  select count(*), array_agg(distinct type) into v_count, v_types
  from public.tickets
  where id = any(p_ticket_ids) and user_id = p_user_id and used = false
    and (expires_at is null or expires_at > now());
  if v_count <> cardinality(p_ticket_ids) then
    return json_build_object('error', 'invalid_tickets');   -- 他人の券・使用済み・期限切れ・存在しない
  end if;
  -- メンテナンスクーポンは、ほかの券と一緒には使えない
  if 'coupon' = any(v_types) and cardinality(v_types) > 1 then
    return json_build_object('error', 'mixed_types');
  end if;
  if exists (select 1 from public.ticket_transfers where ticket_id = any(p_ticket_ids) and status = 'pending' and expires_at > now()) then
    return json_build_object('error', 'transfer_pending');
  end if;
  -- Welcomeクーポン（パーマ ¥2,000）は平日のみ
  if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7) and exists (
    select 1 from public.tickets
    where id = any(p_ticket_ids)
      and (issued_by = 'system-welcome' or (title in ('特殊パーマ Welcomeクーポン', 'パーマ Welcomeクーポン') and amount = 2000))
  ) then
    return json_build_object('error', 'welcome_weekend');
  end if;
  v_used_type := app_private.today_used_type(p_user_id);
  foreach v_t in array v_types loop
    if not app_private.can_use_type(v_used_type, v_t) then
      return json_build_object('error', 'daily_rule', 'used_type', v_used_type);
    end if;
  end loop;

  with upd as (
    update public.tickets set used = true, used_at = now()
    where id = any(p_ticket_ids) returning *
  ), logs as (
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
    select app_private.today_jst(), p_staff_name, coalesce(p_customer_name, ''), p_user_id, upd.id::text, upd.type, upd.amount, 'staff-terminal', 'used'
    from upd returning 1
  )
  select json_agg(row_to_json(upd)) into v_rows from upd;

  perform app_private.touch_visit(p_user_id);
  return json_build_object('tickets', v_rows, 'visit_date', app_private.today_jst());
end;
$function$;

update public.tickets set title = 'パーマ Welcomeクーポン', memo = '対象: パーマ全種類（パーマのセットを含む） / 平日のみ（土日利用不可） / 新規のお客様限定'
where issued_by = 'system-welcome' and title = '特殊パーマ Welcomeクーポン';
