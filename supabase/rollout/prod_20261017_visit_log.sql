-- 本番に当てる：来店ごとのメニューの記録（20261017000000_visit_log.sql）。1つのトランザクションで当てて、適用の記録も残す
begin;
-- 来店ごとのメニューの記録（JOHNNY の「おかえりなさい」「いつもの」に使う）
--   これまで：QR で来店登録すると maintenance_visits の「最後の来店日」1つだけが上書きされ、メニューは残らなかった
--   これから：来店1回（1人1日）ごとに visit_log へ1行。メニューは
--     1. その日の予約から自動（App 会員の予約・SB に登録した電話予約・HOT PEPPER の取り込みで App 会員と紐付いた顧客）
--     2. 予約が無ければ、スタッフ端末の来店チェックインの画面でスタッフが1つ選ぶ（staff_set_visit_menu）
--   お客様はアプリから最近5回分を読める（customer_recent_visits）。端末を変えて引き継いだ会員は、旧 user_id の分も読める
-- maintenance_visits（14日のメンテナンスカット）の仕組みはそのまま。

create table if not exists public.visit_log (
  user_id         text not null,
  visit_date      date not null,
  menu_code       text,
  menu_name       text check (menu_name is null or length(menu_name) <= 80),
  menu_source     text check (menu_source is null or menu_source in ('reservation', 'staff')),
  reservation_id  uuid references public.reservations(id) on delete set null,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, visit_date)
);
alter table public.visit_log enable row level security;
revoke all on table public.visit_log from public, anon, authenticated;

/** その会員の、その日の予約のメニュー（キャンセル・来店なしは除く。今に近い予約、最初の明細） */
create or replace function app_private.visit_menu_from_reservation(p_user_id text, p_date date)
returns table (reservation_id uuid, menu_code text, menu_name text)
language sql stable
set search_path = public, pg_temp
as $$
  with member as (
    select c.id as customer_id from public.customers c where c.user_id = p_user_id
    union
    select a.customer_id from public.customer_user_aliases a where a.user_id = p_user_id
  ),
  member_clients as (
    -- App 会員に紐付いた顧客（統合されていれば統合先も）
    select ci.client_id from public.client_identifiers ci
    where ci.kind = 'app_member' and ci.removed_at is null and ci.value in (select customer_id::text from member)
    union
    select cl.merged_into from public.clients cl
    join public.client_identifiers ci on ci.client_id = cl.id
    where ci.kind = 'app_member' and ci.removed_at is null and ci.value in (select customer_id::text from member) and cl.merged_into is not null
  )
  -- HOT PEPPER の取り込みはクーポン名（menu_code = 'hotpepper'）：名前に含まれるメニュー（いちばん長いもの）に読み替える
  select r.id, coalesce(m.code, i.menu_code), coalesce(m.name, i.name)
  from public.reservations r
  join lateral (select ri.menu_code, ri.name from public.reservation_items ri where ri.reservation_id = r.id order by ri.sort_order, ri.name limit 1) i on true
  left join lateral (
    select sm.code, sm.name from public.service_menus sm
    where i.menu_code = 'hotpepper' and sm.is_active and length(sm.name) >= 2 and position(sm.name in i.name) > 0
    order by length(sm.name) desc limit 1
  ) m on true
  where (r.starts_at at time zone 'Asia/Tokyo')::date = p_date
    and r.status not in ('cancelled', 'no_show')
    and (r.user_id = p_user_id or r.customer_id in (select customer_id from member) or r.client_id in (select client_id from member_clients))
  order by abs(extract(epoch from (r.starts_at - now())))
  limit 1
$$;

/** 来店日の記録（QR 来店登録・チケット使用・メンテナンスクーポン）。来店ログにも1行（予約があればメニューも） */
create or replace function app_private.touch_visit(p_user_id text)
returns void language plpgsql
set search_path = public, pg_temp
as $$
declare v_today date := app_private.today_jst(); v_r record;
begin
  insert into public.maintenance_visits (user_id, last_visit_date, updated_at)
  values (p_user_id, v_today, now())
  on conflict (user_id) do update
    set last_visit_date = excluded.last_visit_date, updated_at = now();

  select * into v_r from app_private.visit_menu_from_reservation(p_user_id, v_today);
  insert into public.visit_log (user_id, visit_date, menu_code, menu_name, menu_source, reservation_id)
  values (p_user_id, v_today, v_r.menu_code, v_r.menu_name, case when v_r.menu_code is null then null else 'reservation' end, v_r.reservation_id)
  on conflict (user_id, visit_date) do update
    set menu_code = coalesce(public.visit_log.menu_code, excluded.menu_code),
        menu_name = coalesce(public.visit_log.menu_name, excluded.menu_name),
        menu_source = coalesce(public.visit_log.menu_source, excluded.menu_source),
        reservation_id = coalesce(public.visit_log.reservation_id, excluded.reservation_id),
        updated_at = now();
end;
$$;

/** 会員の最近の来店（新しい順）。引き継ぎ前の user_id の分も含める */
create or replace function app_private.recent_visits_json(p_user_id text, p_limit int)
returns json language sql stable
set search_path = public, pg_temp
as $$
  with ids as (
    select p_user_id as user_id
    union
    select a2.user_id from public.customer_user_aliases a1
    join public.customer_user_aliases a2 on a2.customer_id = a1.customer_id
    where a1.user_id = p_user_id
    union
    select a.user_id from public.customers c join public.customer_user_aliases a on a.customer_id = c.id where c.user_id = p_user_id
  )
  select coalesce(json_agg(json_build_object('visit_date', v.visit_date, 'menu_code', v.menu_code, 'menu_name', v.menu_name) order by v.visit_date desc), '[]'::json)
  from (
    select distinct on (visit_date) visit_date, menu_code, menu_name
    from public.visit_log where user_id in (select user_id from ids)
    order by visit_date desc, menu_code nulls last
    limit greatest(1, least(coalesce(p_limit, 5), 10))
  ) v
$$;

/** 来店チェックイン（来店日 = 本日JST）。今日のメニュー（予約から分かれば）と最近の来店も返す */
create or replace function public.staff_check_in(p_staff text, p_user_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_log public.visit_log;
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  perform app_private.touch_visit(p_user_id);
  select * into v_log from public.visit_log where user_id = p_user_id and visit_date = app_private.today_jst();
  return json_build_object(
    'visit_date', app_private.today_jst(),
    'menu_code', v_log.menu_code, 'menu_name', v_log.menu_name, 'menu_source', v_log.menu_source,
    'recent', app_private.recent_visits_json(p_user_id, 6));
end;
$$;

/** 今日の来店のメニューをスタッフが選ぶ（予約が無いとき・違うとき） */
create or replace function public.staff_set_visit_menu(p_staff text, p_user_id text, p_menu_code text, p_staff_name text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_name text;
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  select m.name into v_name from public.service_menus m where m.code = p_menu_code and m.is_active;
  if v_name is null then return json_build_object('error', 'menu_not_found'); end if;
  insert into public.visit_log (user_id, visit_date, menu_code, menu_name, menu_source, updated_by)
  values (p_user_id, app_private.today_jst(), p_menu_code, v_name, 'staff', left(p_staff_name, 40))
  on conflict (user_id, visit_date) do update
    set menu_code = excluded.menu_code, menu_name = excluded.menu_name, menu_source = 'staff',
        updated_by = excluded.updated_by, updated_at = now();
  return json_build_object('visit_date', app_private.today_jst(), 'menu_code', p_menu_code, 'menu_name', v_name, 'menu_source', 'staff');
end;
$$;

/** お客様：最近の来店（最大5回、新しい順） */
create or replace function public.customer_recent_visits(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return app_private.recent_visits_json(v_uid, 5);
end;
$$;

revoke all on function app_private.visit_menu_from_reservation(text, date) from public, anon, authenticated;
revoke all on function app_private.recent_visits_json(text, int) from public, anon, authenticated;
revoke all on function public.staff_set_visit_menu(text, text, text, text) from public, anon, authenticated;
revoke all on function public.customer_recent_visits(text) from public, anon, authenticated;
grant execute on function public.staff_set_visit_menu(text, text, text, text) to anon, authenticated;
grant execute on function public.customer_recent_visits(text) to anon, authenticated;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations(version, name) values ('20261017000000', 'visit_log') on conflict (version) do nothing;
commit;
select 'visit_log applied' as result, (select count(*) from public.visit_log) as rows;
