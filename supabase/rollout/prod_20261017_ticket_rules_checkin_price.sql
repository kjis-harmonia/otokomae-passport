-- 本番に当てる：割引券・漢トク券を種類をまたいで使えるようにする＋来店チェックインで予約の料金を返す（20261017000200）。関数の入れ替えだけ
begin;
-- 割引の使い方の決まりを変える（お店の決定 2026-10-17）＋ 来店チェックインで予約の料金も返す
--   これまで：1日に使える券は1種類だけ（割引券と漢トク券は一緒に使えない）
--   これから：割引券・漢トク券は種類をまたいで何枚でも一緒に使える
--             メンテナンスクーポン（coupon）だけは今までどおり、その日はほかの券と一緒に使えない・1日1回
--   来店チェックイン：その日の予約の開始時刻と料金（予約の明細）を返す。スタッフ端末で「お会計」を出すのに使う

/** その日すでに使った種類（p_used）があるときに、p_attempted を使えるか */
create or replace function app_private.can_use_type(p_used text, p_attempted text)
returns boolean language sql immutable
set search_path = pg_catalog
as $$
  select case
    when p_used is null then true
    when p_used = 'coupon' then false        -- メンテナンスクーポンを使った日は、ほかの券は使えない
    when p_attempted = 'coupon' then false   -- ほかの券を使った日は、メンテナンスクーポンは使えない（1日1回）
    else true                                -- 割引券・漢トク券は何枚でも、種類をまたいでも使える
  end
$$;

create or replace function public.staff_use_tickets(
  p_staff text, p_user_id text, p_ticket_ids uuid[], p_staff_name text, p_customer_name text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
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
  -- Welcomeクーポン（特殊パーマ ¥2,000）は平日のみ
  if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7) and exists (
    select 1 from public.tickets
    where id = any(p_ticket_ids)
      and (issued_by = 'system-welcome' or (title = '特殊パーマ Welcomeクーポン' and amount = 2000))
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
$$;

/** 来店チェックイン（来店日 = 本日JST）。今日のメニュー（予約から分かれば）・予約の開始時刻と料金・最近の来店も返す */
create or replace function public.staff_check_in(p_staff text, p_user_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_log public.visit_log; v_starts timestamptz; v_price int;
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  perform app_private.touch_visit(p_user_id);
  select * into v_log from public.visit_log where user_id = p_user_id and visit_date = app_private.today_jst();
  if v_log.reservation_id is not null then
    select r.starts_at, coalesce(r.total_price, (select sum(i.price) from public.reservation_items i where i.reservation_id = r.id)::int)
      into v_starts, v_price
    from public.reservations r where r.id = v_log.reservation_id;
  end if;
  return json_build_object(
    'visit_date', app_private.today_jst(),
    'menu_code', v_log.menu_code, 'menu_name', v_log.menu_name, 'menu_source', v_log.menu_source,
    'reservation_starts_at', v_starts, 'reservation_price', v_price,
    'recent', app_private.recent_visits_json(p_user_id, 6));
end;
$$;
insert into supabase_migrations.schema_migrations(version, name) values ('20261017000200', 'ticket_rules_checkin_price') on conflict (version) do nothing;
commit;
select 'ticket_rules applied' as result, app_private.can_use_type('discount', 'otoku') as discount_and_otoku, app_private.can_use_type('coupon', 'discount') as after_maintenance;
