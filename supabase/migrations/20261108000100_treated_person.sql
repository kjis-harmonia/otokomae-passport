-- 施術を受ける人を分ける（11/8 慶一郎さん）
--   ・アプリの持ち主（会員）と、実際に施術を受ける人（本人・お連れ様）を分ける
--   ・お連れ様は会員にひもづけてサーバーに登録（お名前・いつものメニュー・メンテナンス希望）。番号（id）で見分ける
--   ・予約に「受ける人」（companion_id。null＝会員本人）を持たせる。お店の表示は今までどおり「お連れ様：〇〇様」
--   ・メンテナンスの14日は、受ける人ごとに「対象メニュー（service_menus.maintenance_eligible）の施術を完了（会計）した日」から数える
--     受付（QR・来店）だけでは始めない。メンテナンスカットそのものでは更新しない
--   ・QR を読んでも、今日の予約がお連れ様だけなら、会員本人の来店にしない
--   ・Welcome クーポンは会員本人の施術だけ。ガチャ券は今までどおり（本人だけの券はお連れ様に使えない）。割引券はお連れ様にも使える
--   ・券を使ったら、誰の施術に使ったかを残す

-- ── お連れ様 ──
create table if not exists app_private.customer_companions (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers(id) on delete cascade,
  name               text not null check (char_length(btrim(name)) between 1 and 20),
  menu_code          text references public.service_menus(code),
  wants_maintenance  boolean not null default false,
  last_eligible_date date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  removed_at         timestamptz
);
create unique index if not exists customer_companions_name_uq on app_private.customer_companions (customer_id, btrim(name)) where removed_at is null;
create index if not exists customer_companions_customer_idx on app_private.customer_companions (customer_id) where removed_at is null;
revoke all on table app_private.customer_companions from public, anon, authenticated;

alter table public.reservations  add column if not exists companion_id uuid references app_private.customer_companions(id);
alter table public.booking_holds add column if not exists companion_id uuid references app_private.customer_companions(id);
alter table public.ticket_usage_logs add column if not exists treated_companion_id uuid;
alter table public.ticket_usage_logs add column if not exists treated_name text;
alter table app_private.customer_usual_menus add column if not exists wants_maintenance boolean not null default false;

-- 会員（customers.id）：今の user_id から
create or replace function app_private.customer_of_user(p_user text)
returns uuid language sql stable set search_path = '' as $$
  select c.id from public.customers c where c.user_id = p_user
$$;
revoke all on function app_private.customer_of_user(text) from public, anon, authenticated;

-- 予約が「お連れ様の施術」か（新しい予約は companion_id。前からの予約はメモ・つながりで見る）
create or replace function app_private.res_is_companion(p_companion uuid, p_companion_of uuid, p_note text)
returns boolean language sql immutable set search_path = '' as $$
  select p_companion is not null or p_companion_of is not null or coalesce(p_note, '') like 'お連れ様：%'
$$;
revoke all on function app_private.res_is_companion(uuid, uuid, text) from public, anon, authenticated;

-- お連れ様の予約の受ける人（id。前からの予約はメモのお名前で探す。見つからなければ null）
create or replace function app_private.res_companion(p_reservation uuid)
returns uuid language sql stable set search_path = '' as $$
  select coalesce(r.companion_id, (
    select c.id from app_private.customer_companions c
    where c.customer_id = app_private.customer_of_user(r.user_id) and c.removed_at is null
      and btrim(c.name) = nullif(btrim(substring(split_part(r.note, E'\n', 1) from '^お連れ様：(.*?)様?$')), '')
    limit 1))
  from public.reservations r
  where r.id = p_reservation and app_private.res_is_companion(r.companion_id, r.companion_of, r.note)
$$;
revoke all on function app_private.res_companion(uuid) from public, anon, authenticated;

-- 予約のお連れ様のお名前（表示・券の記録用）
create or replace function app_private.res_companion_name(p_reservation uuid)
returns text language sql stable set search_path = '' as $$
  select coalesce((select c.name from app_private.customer_companions c where c.id = r.companion_id),
                  nullif(btrim(substring(split_part(r.note, E'\n', 1) from '^お連れ様：(.*?)様?$')), ''))
  from public.reservations r
  where r.id = p_reservation and app_private.res_is_companion(r.companion_id, r.companion_of, r.note)
$$;
revoke all on function app_private.res_companion_name(uuid) from public, anon, authenticated;

-- 明細のメニュー（HOT PEPPER の取り込みは名前から読み替える。visit_menu_from_reservation と同じ考え方）
create or replace function app_private.item_menu_code(p_ref text, p_name text)
returns text language sql stable set search_path = '' as $$
  select case
    when p_ref = 'hotpepper' and p_name like '%メンテナンス%' then 'maintenance'
    when p_ref = 'hotpepper' then (select sm.code from public.service_menus sm
                                   where sm.is_active and length(sm.name) >= 2 and position(sm.name in p_name) > 0
                                   order by length(sm.name) desc limit 1)
    else p_ref end
$$;
revoke all on function app_private.item_menu_code(text, text) from public, anon, authenticated;

-- 会計の完了：対象メニューの施術なら、受ける人の14日を今日から始める（メンテナンスカットだけでは始めない）
create or replace function app_private.record_treatment(p_sale uuid, p_user text, p_companion uuid, p_is_companion boolean)
returns void language plpgsql set search_path = '' as $$
declare v_today date := app_private.today_jst();
begin
  if p_user is null then return; end if;
  if not exists (
    select 1 from public.accounting_session_items i
    join public.service_menus m on m.code = app_private.item_menu_code(i.ref_id, i.item_name)
    where i.session_id = p_sale and i.source in ('reservation', 'service_menu') and m.maintenance_eligible
  ) then return; end if;
  if not p_is_companion then
    insert into public.maintenance_visits (user_id, last_visit_date, updated_at) values (p_user, v_today, now())
    on conflict (user_id) do update set last_visit_date = greatest(public.maintenance_visits.last_visit_date, excluded.last_visit_date), updated_at = now();
  elsif p_companion is not null then
    update app_private.customer_companions
    set last_eligible_date = greatest(coalesce(last_eligible_date, v_today), v_today), updated_at = now()
    where id = p_companion;
  end if;
end;
$$;
revoke all on function app_private.record_treatment(uuid, text, uuid, boolean) from public, anon, authenticated;

-- 会員本人：最後に対象メニューの施術を完了した日から14日以内か（受付だけの日は数えない）
create or replace function app_private.maintenance_ok(p_user_id text)
returns boolean language sql stable set search_path to '' as $$
  select coalesce(app_private.today_jst() - (
    select v.last_visit_date from public.maintenance_visits v where v.user_id = p_user_id and v.last_visit_date <= app_private.today_jst()
  ) <= 14, false)
$$;
revoke all on function app_private.maintenance_ok(text) from public, anon, authenticated;

-- 受ける人ごと（null＝会員本人）
create or replace function app_private.person_maintenance_ok(p_user text, p_companion uuid)
returns boolean language sql stable set search_path = '' as $$
  select case when p_companion is null then app_private.maintenance_ok(p_user)
    else coalesce((select app_private.today_jst() - c.last_eligible_date <= 14 and c.last_eligible_date <= app_private.today_jst()
                   from app_private.customer_companions c where c.id = p_companion), false) end
$$;
revoke all on function app_private.person_maintenance_ok(text, uuid) from public, anon, authenticated;

create or replace function app_private.person_days_left(p_user text, p_companion uuid)
returns integer language sql stable set search_path = '' as $$
  select 14 - (app_private.today_jst() - case when p_companion is null
    then (select v.last_visit_date from public.maintenance_visits v where v.user_id = p_user)
    else (select c.last_eligible_date from app_private.customer_companions c where c.id = p_companion) end)
$$;
revoke all on function app_private.person_days_left(text, uuid) from public, anon, authenticated;

-- その日の会員の予約（会員の user_id・前の user_id・顧客台帳のつながりから）
create or replace function app_private.member_reservations_on(p_user_id text, p_date date)
returns setof public.reservations language sql stable set search_path = 'public', 'pg_temp' as $$
  with member as (
    select c.id as customer_id from public.customers c where c.user_id = p_user_id
    union
    select a.customer_id from public.customer_user_aliases a where a.user_id = p_user_id
  ),
  member_clients as (
    select ci.client_id from public.client_identifiers ci
    where ci.kind = 'app_member' and ci.removed_at is null and ci.value in (select customer_id::text from member)
    union
    select cl.merged_into from public.clients cl
    join public.client_identifiers ci on ci.client_id = cl.id
    where ci.kind = 'app_member' and ci.removed_at is null and ci.value in (select customer_id::text from member) and cl.merged_into is not null
  )
  select r.* from public.reservations r
  where (r.starts_at at time zone 'Asia/Tokyo')::date = p_date
    and r.status not in ('cancelled', 'no_show')
    and (r.user_id = p_user_id or r.customer_id in (select customer_id from member) or r.client_id in (select client_id from member_clients))
$$;
revoke all on function app_private.member_reservations_on(text, date) from public, anon, authenticated;

-- 来店の記録のメニュー：会員本人の予約だけから（お連れ様の予約のメニューを本人の来店にしない）
create or replace function app_private.visit_menu_from_reservation(p_user_id text, p_date date)
returns table(reservation_id uuid, menu_code text, menu_name text) language sql stable set search_path to 'public', 'pg_temp' as $$
  -- HOT PEPPER の取り込みはクーポン名（menu_code = 'hotpepper'）：メンテナンスならメンテナンスカット、
  -- それ以外は名前に含まれるメニュー（いちばん長いもの）に読み替える
  select r.id,
         case when i.menu_code = 'hotpepper' and i.name like '%メンテナンス%' then 'maintenance' else coalesce(m.code, i.menu_code) end,
         case when i.menu_code = 'hotpepper' and i.name like '%メンテナンス%' then 'メンテナンスカット' else coalesce(m.name, i.name) end
  from app_private.member_reservations_on(p_user_id, p_date) r
  join lateral (select ri.menu_code, ri.name from public.reservation_items ri where ri.reservation_id = r.id order by ri.sort_order, ri.name limit 1) i on true
  left join lateral (
    select sm.code, sm.name from public.service_menus sm
    where i.menu_code = 'hotpepper' and sm.is_active and length(sm.name) >= 2 and position(sm.name in i.name) > 0
    order by length(sm.name) desc limit 1
  ) m on true
  where not app_private.res_is_companion(r.companion_id, r.companion_of, r.note)
  order by abs(extract(epoch from (r.starts_at - now())))
  limit 1
$$;

-- 来店の記録（会員本人）。14日はここでは始めない（会計の完了で始める）。
-- 今日の予約がお連れ様の分だけなら、会員本人は来店にしない
-- p_walk_in：予約なしの会計（会員本人の施術）。お連れ様の予約があっても本人の来店にする
create or replace function app_private.touch_visit(p_user_id text, p_walk_in boolean)
returns void language plpgsql set search_path to 'public', 'pg_temp' as $$
declare v_today date := app_private.today_jst(); v_r record;
begin
  select * into v_r from app_private.visit_menu_from_reservation(p_user_id, v_today);
  if not p_walk_in and v_r.reservation_id is null and exists (select 1 from app_private.member_reservations_on(p_user_id, v_today)) then
    return;
  end if;
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
revoke all on function app_private.touch_visit(text, boolean) from public, anon, authenticated;

create or replace function app_private.touch_visit(p_user_id text)
returns void language sql set search_path to '' as $$ select app_private.touch_visit(p_user_id, false) $$;

-- お客様に返す予約：受ける人（companion_id）も
create or replace function app_private.reservation_json_customer(p_id uuid)
returns jsonb language sql stable set search_path to 'public', 'extensions', 'pg_temp' as $$
  select (app_private.reservation_json(p_id) - 'customer_phone' - 'note' - 'created_by' - 'customer_id' - 'client_id' - 'external_ref' - 'occupied_until')
    || (select jsonb_build_object('companion_of', r.companion_of, 'companion_id', r.companion_id,
          'companion_name', app_private.res_companion_name(r.id))
        from public.reservations r where r.id = p_id)
$$;

-- ── お客様：いつもの（本人＋お連れ様） ──
create or replace function app_private.person_json(p_user text, p_companion uuid, p_name text, p_menu text, p_wants boolean)
returns json language sql stable set search_path = '' as $$
  select json_build_object('id', p_companion, 'name', p_name, 'is_owner', p_companion is null,
    'menu_code', m.code, 'menu_name', m.name, 'menu_maintenance', coalesce(m.maintenance_eligible, false),
    'wants_maintenance', coalesce(p_wants, false) and coalesce(m.maintenance_eligible, false),
    'maintenance_ok', app_private.person_maintenance_ok(p_user, p_companion),
    'days_left', case when app_private.person_maintenance_ok(p_user, p_companion) then app_private.person_days_left(p_user, p_companion) end)
  from (select 1) x left join public.service_menus m on m.code = p_menu and m.is_active
$$;
revoke all on function app_private.person_json(text, uuid, text, text, boolean) from public, anon, authenticated;

create or replace function app_private.people_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'owner', (select app_private.person_json(p_user, null, c.name, u.menu_code, u.wants_maintenance)
              from public.customers c left join app_private.customer_usual_menus u on u.user_id = p_user where c.user_id = p_user),
    'companions', coalesce((select json_agg(app_private.person_json(p_user, x.id, x.name, x.menu_code, x.wants_maintenance) order by x.created_at)
                            from app_private.customer_companions x
                            where x.customer_id = app_private.customer_of_user(p_user) and x.removed_at is null), '[]'::json))
$$;
revoke all on function app_private.people_json(text) from public, anon, authenticated;

/** お客様：いつもの人たち（本人・お連れ様。それぞれのいつものメニューとメンテナンスの可否） */
create or replace function public.customer_people(p_session text)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  return app_private.people_json(app_private.session_user_id(p_session));
end;
$$;

/** お客様：お連れ様を登録・変更する（p_id が null なら追加。3名まで） */
create or replace function public.customer_save_companion(p_session text, p_id uuid, p_name text, p_menu_code text, p_wants_maintenance boolean)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_customer uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  v_customer := app_private.customer_of_user(v_user);
  if v_customer is null then return json_build_object('error', 'customer_not_found'); end if;
  if char_length(v_name) < 1 or char_length(v_name) > 20 then return json_build_object('error', 'bad_name'); end if;
  if p_menu_code is not null and not exists (select 1 from public.service_menus where code = p_menu_code and is_active) then
    return json_build_object('error', 'bad_menu');
  end if;
  perform 1 from public.customers where id = v_customer for update;
  if exists (select 1 from app_private.customer_companions where customer_id = v_customer and removed_at is null
             and btrim(name) = v_name and id is distinct from p_id) then
    return json_build_object('error', 'name_exists');
  end if;
  if p_id is null then
    if (select count(*) from app_private.customer_companions where customer_id = v_customer and removed_at is null) >= 3 then
      return json_build_object('error', 'too_many');
    end if;
    insert into app_private.customer_companions (customer_id, name, menu_code, wants_maintenance)
    values (v_customer, v_name, p_menu_code, coalesce(p_wants_maintenance, false));
  else
    update app_private.customer_companions
    set name = v_name, menu_code = p_menu_code, wants_maintenance = coalesce(p_wants_maintenance, false), updated_at = now()
    where id = p_id and customer_id = v_customer and removed_at is null;
    if not found then return json_build_object('error', 'not_found'); end if;
  end if;
  return json_build_object('ok', true, 'people', app_private.people_json(v_user));
end;
$$;

/** お客様：お連れ様を消す（予約済みの予約はそのまま残る） */
create or replace function public.customer_remove_companion(p_session text, p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  update app_private.customer_companions set removed_at = now(), updated_at = now()
  where id = p_id and customer_id = app_private.customer_of_user(v_user) and removed_at is null;
  if not found then return json_build_object('error', 'not_found'); end if;
  return json_build_object('ok', true, 'people', app_private.people_json(v_user));
end;
$$;

/** お客様：本人のいつものにメンテナンスカットを足す・外す */
create or replace function public.customer_set_usual_maintenance(p_session text, p_wants boolean)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  update app_private.customer_usual_menus set wants_maintenance = coalesce(p_wants, false) where user_id = v_user;
  if not found then return json_build_object('error', 'no_usual'); end if;
  return json_build_object('ok', true, 'people', app_private.people_json(v_user));
end;
$$;

-- 受ける人が会員のお連れ様か（消したお連れ様では新しく予約できない）
create or replace function app_private.own_companion(p_user text, p_companion uuid)
returns app_private.customer_companions language sql stable set search_path = '' as $$
  select c.* from app_private.customer_companions c
  where c.id = p_companion and c.customer_id = app_private.customer_of_user(p_user) and c.removed_at is null
$$;
revoke all on function app_private.own_companion(text, uuid) from public, anon, authenticated;

/** お客様：受ける人を決めて仮押さえ（p_companion が null なら会員本人）。メンテナンスカットは受ける人の14日で判定 */
create or replace function public.customer_create_hold_for(p_session text, p_starts_at timestamptz, p_menu_codes text[], p_staff_id uuid, p_companion uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text; v_res json;
begin
  perform app_private.require_store_verified(p_session);
  if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if;
  v_user := app_private.session_user_id(p_session);
  if p_companion is not null and (app_private.own_companion(v_user, p_companion)).id is null then
    return json_build_object('error', 'companion_not_found');
  end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.person_maintenance_ok(v_user, p_companion) then
    return json_build_object('error', 'menu_not_available');
  end if;
  v_res := app_private.store_original_customer_create_hold(p_session, p_starts_at, p_menu_codes, p_staff_id);
  if (v_res->>'hold_id') is not null then
    update public.booking_holds set companion_id = p_companion where id = (v_res->>'hold_id')::uuid and holder_user_id = v_user;
  end if;
  return v_res;
end;
$$;

/** お客様：受ける人を決めた仮押さえを確定（お連れ様ならお店の表示は「お連れ様：〇〇様」） */
create or replace function public.customer_confirm_for(p_session text, p_hold_id uuid, p_companion uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text; v_hold public.booking_holds; v_c app_private.customer_companions; v_res json;
begin
  v_user := app_private.session_user_id(p_session);
  select * into v_hold from public.booking_holds where id = p_hold_id and holder_user_id = v_user;
  if v_hold.id is null then return json_build_object('error', 'hold_expired'); end if;
  if v_hold.companion_id is distinct from p_companion then return json_build_object('error', 'companion_mismatch'); end if;
  if p_companion is not null then
    v_c := app_private.own_companion(v_user, p_companion);
    if v_c.id is null then return json_build_object('error', 'companion_not_found'); end if;
  end if;
  -- メンテナンスカットは確定の時にもう一度（仮押さえのあと日をまたいだときなど）
  if 'maintenance' = any(v_hold.menu_codes) and not app_private.person_maintenance_ok(v_user, p_companion) then
    return json_build_object('error', 'menu_not_available');
  end if;
  v_res := public.customer_confirm_reservation(p_session, p_hold_id, case when v_c.id is not null then 'お連れ様：' || btrim(v_c.name) || '様' end);
  if (v_res->>'id') is not null and p_companion is not null then
    update public.reservations set companion_id = p_companion where id = (v_res->>'id')::uuid and user_id = v_user;
    v_res := app_private.reservation_json_customer((v_res->>'id')::uuid)::json;
  end if;
  return v_res;
end;
$$;

-- ── 店舗端末：会員QR を読んだら、今日のご予約（何名様か・受ける人）を出して、来た人だけ受付 ──
create or replace function app_private.party_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select coalesce(json_agg(json_build_object(
      'id', r.id, 'starts_at', r.starts_at, 'status', r.status,
      'is_owner', not app_private.res_is_companion(r.companion_id, r.companion_of, r.note),
      'name', case when app_private.res_is_companion(r.companion_id, r.companion_of, r.note)
                   then coalesce(app_private.res_companion_name(r.id), 'お連れ様') else c.name end,
      'menu', (select string_agg(ri.name, '・' order by ri.sort_order, ri.name) from public.reservation_items ri where ri.reservation_id = r.id),
      'staff_name', (select s.display_name from public.staff_members s where s.id = r.staff_id))
    order by app_private.res_is_companion(r.companion_id, r.companion_of, r.note), r.starts_at), '[]'::json)
  from app_private.member_reservations_on(p_user, app_private.today_jst()) r
  left join public.customers c on c.user_id = p_user
$$;
revoke all on function app_private.party_json(text) from public, anon, authenticated;

/** 店舗端末：この会員の今日のご予約（本人・お連れ様） */
create or replace function public.staff_today_party(p_staff text, p_user_id text)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.party_json(p_user_id);
end;
$$;

/** 店舗端末：来た人の予約だけ受付（来ていない人は受付しない） */
create or replace function public.staff_check_in_party(p_staff text, p_user_id text, p_reservation_ids uuid[], p_staff_name text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_id uuid; r public.reservations; v_res jsonb;
begin
  perform app_private.assert_staff(p_staff);
  perform app_private.require_actor(p_staff_name);
  if p_reservation_ids is null or cardinality(p_reservation_ids) = 0 or cardinality(p_reservation_ids) > 10 then
    return json_build_object('error', 'no_reservations');
  end if;
  foreach v_id in array p_reservation_ids loop
    select * into r from public.reservations where id = v_id for update;
    if r.id is null or not exists (select 1 from app_private.member_reservations_on(p_user_id, app_private.today_jst()) m where m.id = v_id) then
      return json_build_object('error', 'reservation_mismatch');
    end if;
    if r.status = 'confirmed' then
      v_res := app_private.set_reservation_status(r.id, 'checked_in', 'staff', btrim(p_staff_name));
      if v_res ? 'error' then raise exception '%', v_res->>'error'; end if;
    elsif r.status not in ('checked_in', 'in_service', 'awaiting_payment', 'completed') then
      return json_build_object('error', 'invalid_status');
    end if;
  end loop;
  return json_build_object('ok', true, 'party', app_private.party_json(p_user_id));
end;
$$;

revoke all on function public.customer_people(text), public.customer_save_companion(text, uuid, text, text, boolean),
  public.customer_remove_companion(text, uuid), public.customer_set_usual_maintenance(text, boolean),
  public.customer_create_hold_for(text, timestamptz, text[], uuid, uuid), public.customer_confirm_for(text, uuid, uuid),
  public.staff_today_party(text, text), public.staff_check_in_party(text, text, uuid[], text) from public;
grant execute on function public.customer_people(text), public.customer_save_companion(text, uuid, text, text, boolean),
  public.customer_remove_companion(text, uuid), public.customer_set_usual_maintenance(text, boolean),
  public.customer_create_hold_for(text, timestamptz, text[], uuid, uuid), public.customer_confirm_for(text, uuid, uuid),
  public.staff_today_party(text, text), public.staff_check_in_party(text, text, uuid[], text) to anon, authenticated, service_role;

-- ── 前からある関数の手直し（受ける人ごと） ──
CREATE OR REPLACE FUNCTION app_private.finalize_sale(p jsonb, p_actor_type text, p_actor_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_client uuid; v_member uuid; v_user text; v_name text; v_stylist public.staff_members;
        v_item jsonb; v_items jsonb := coalesce(p->'items', '[]'::jsonb); v_n int; v_qty int; v_price int; v_disc int; v_list int;
        v_subtotal bigint := 0; v_line_disc bigint := 0; v_ticket_disc bigint := 0; v_manual int := 0; v_total bigint;
        v_tids uuid[]; v_tcount int; v_types text[]; v_tuser text; v_method text := p->>'payment_method'; v_legacy text;
        v_tax public.accounting_settings; v_id uuid; v_i int := 0; v_uids text[]; t record;
        v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), ''); v_existing uuid; v_gp jsonb; v_account public.ginpay_accounts;
        h app_private.gacha_holdings; v_gacha int := 0; v_gitem jsonb;
        v_is_comp boolean := false; v_comp uuid; v_comp_name text; v_owner text;
begin
  if p_actor_name is null or btrim(p_actor_name) = '' then return jsonb_build_object('error', 'operator_required'); end if;
  if v_method is null or v_method not in ('cash', 'card', 'qr', 'ginpay', 'other') then return jsonb_build_object('error', 'invalid_payment_method'); end if;
  if v_key is not null and length(v_key) > 100 then return jsonb_build_object('error', 'invalid_idempotency_key'); end if;
  if v_method = 'ginpay' and v_key is null then return jsonb_build_object('error', 'idempotency_key_required'); end if;
  -- 同じキーの再送（通信の再試行・二重タップ）：確定済みの会計をそのまま返す
  if v_key is not null then
    select id into v_existing from public.accounting_sessions where idempotency_key = v_key and status in ('completed', 'voided');
    if v_existing is not null then return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true); end if;
  end if;
  v_legacy := case v_method when 'card' then 'credit' else v_method end;

  -- 予約（行ロックで同じ予約の同時会計を直列化）
  if nullif(p->>'reservation_id', '') is not null then
    select * into r from public.reservations where id = (p->>'reservation_id')::uuid for update;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if r.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
    if exists (select 1 from public.accounting_sessions where reservation_id = r.id and status = 'completed') then
      return jsonb_build_object('error', 'already_paid');
    end if;
    v_client := app_private.client_root(r.client_id);
    -- 受ける人（11/8）：お連れ様の予約か
    v_is_comp := app_private.res_is_companion(r.companion_id, r.companion_of, r.note);
    if v_is_comp then v_comp := app_private.res_companion(r.id); v_comp_name := app_private.res_companion_name(r.id); end if;
  elsif nullif(p->>'client_id', '') is not null then
    v_client := app_private.client_root((p->>'client_id')::uuid);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;
  if v_client is not null then
    select display_name into v_name from public.clients where id = v_client;
    v_member := (app_private.client_members(app_private.client_family(v_client)))[1];
    if v_member is not null then select user_id into v_user from public.customers where id = v_member; end if;
  end if;

  -- 担当
  select * into v_stylist from public.staff_members where id = nullif(p->>'stylist_id', '')::uuid;
  if v_stylist.id is null then return jsonb_build_object('error', 'stylist_required'); end if;

  -- 明細
  v_n := jsonb_array_length(v_items);
  if v_n = 0 or v_n > 50 then return jsonb_build_object('error', 'invalid_items'); end if;
  for v_item in select * from jsonb_array_elements(v_items) loop
    begin
      v_price := (v_item->>'unit_price')::int; v_qty := coalesce((v_item->>'quantity')::int, 1); v_disc := coalesce((v_item->>'discount')::int, 0);
    exception when others then return jsonb_build_object('error', 'invalid_items'); end;
    if btrim(coalesce(v_item->>'name', '')) = '' or length(v_item->>'name') > 80
       or coalesce(v_item->>'category', '') not in ('menu', 'option', 'retail')
       or v_price is null or v_price < 0 or v_price > 1000000 or v_qty < 1 or v_qty > 99 or v_disc < 0 or v_disc > v_price * v_qty
       or coalesce(v_item->>'source', 'manual') not in ('reservation', 'service_menu', 'accounting_item', 'product', 'manual') then
      return jsonb_build_object('error', 'invalid_items');
    end if;
    v_subtotal := v_subtotal + v_price * v_qty;
    v_line_disc := v_line_disc + v_disc;
  end loop;

  -- 手入力の値引き
  if p ? 'manual_discount' and p->'manual_discount' is not null and jsonb_typeof(p->'manual_discount') = 'object' then
    begin v_manual := coalesce((p->'manual_discount'->>'amount')::int, 0); exception when others then return jsonb_build_object('error', 'invalid_discount'); end;
    if v_manual < 0 or (v_manual > 0 and btrim(coalesce(p->'manual_discount'->>'label', '')) = '') then return jsonb_build_object('error', 'invalid_discount'); end if;
  end if;

  -- チケット（App 会員の顧客だけ。既存の staff_use_tickets と同じ規則で、行ロックしてから検証）
  select coalesce(array_agg(distinct x::uuid), '{}') into v_tids from jsonb_array_elements_text(coalesce(p->'ticket_ids', '[]'::jsonb)) x;
  if cardinality(v_tids) > 0 then
    if v_member is null then return jsonb_build_object('error', 'invalid_tickets'); end if;
    v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
    perform 1 from public.tickets where id = any(v_tids) order by id for update;
    select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1], coalesce(sum(amount), 0) into v_tcount, v_types, v_tuser, v_ticket_disc
    from public.tickets where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());
    if v_tcount <> cardinality(v_tids) then return jsonb_build_object('error', 'invalid_tickets'); end if;
    -- 割引券・漢トク券は何枚でも種類をまたいでも使える。メンテナンスクーポンだけはほかの券と一緒に使えない（2026-10-17 お店の決定）
    if 'coupon' = any(v_types) and cardinality(v_types) > 1 then return jsonb_build_object('error', 'mixed_types'); end if;
    if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
      return jsonb_build_object('error', 'transfer_pending');
    end if;
    if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
       and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
      return jsonb_build_object('error', 'welcome_weekend');
    end if;
    -- Welcomeクーポン（初回パーマ 2,000円引き）はパーマ（セットを含む）のメニューがある会計だけ（10/27 慶一郎さん：カットでも使えていた）
    if exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2))
       and not exists (select 1 from jsonb_array_elements(v_items) i
                       where i->>'source' in ('reservation', 'service_menu') and coalesce(i->>'ref_id', '') ~ '^(perm|set)-') then
      return jsonb_build_object('error', 'welcome_perm_only');
    end if;
    -- Welcome クーポンは発行された会員本人の施術だけ（お連れ様の会計では使えない・11/8）
    if v_is_comp and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
      return jsonb_build_object('error', 'welcome_owner_only');
    end if;
    -- 監査 10/28 要対応3：同じお客様・同じ日の券の使用は順番に（ほかの使用が終わってから、今日の使用を読み直す）
    perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_tuser))[1] || ':' || app_private.today_jst()::text, 0));
    if exists (select 1 from unnest(v_types) as ticket_type(value) where not app_private.can_use_type(app_private.today_used_type(v_tuser), ticket_type.value)) then
      return jsonb_build_object('error', 'daily_rule');
    end if;
  end if;

  -- ガチャ券（予約に付いた券。11/4 工程②）。店舗端末が use_gacha を付けたときだけ使う
  if coalesce(p->>'use_gacha', '') = 'true' then
    if r.id is null then return jsonb_build_object('error', 'gacha_invalid'); end if;
    select * into h from app_private.gacha_holdings where reservation_id = r.id and used_at is null for update;
    if h.user_id is null then return jsonb_build_object('error', 'gacha_invalid'); end if;
    if h.weekday_only and app_private.gacha_offday(now()) then return jsonb_build_object('error', 'gacha_weekday'); end if;
    -- 本人だけの券（無料券以外・本人限定）はお連れ様の会計では使えない（予約に付けるときと同じ）
    if v_is_comp and (h.free_menu is null or h.self_only) then return jsonb_build_object('error', 'gacha_companion'); end if;
    if h.menu_codes is not null then
      select i into v_gitem from jsonb_array_elements(v_items) i
       where i->>'source' in ('reservation', 'service_menu') and i->>'ref_id' = any(h.menu_codes) limit 1;
      if v_gitem is null then return jsonb_build_object('error', 'gacha_menu'); end if;
    end if;
    -- 無料券はそのメニュー1つ分の料金（明細の値引き後）
    v_gacha := coalesce(h.amount, least((v_gitem->>'unit_price')::int,
      (v_gitem->>'unit_price')::int * coalesce((v_gitem->>'quantity')::int, 1) - coalesce((v_gitem->>'discount')::int, 0)));
    -- 値引き額が決まらない券（額もメニューも無い）は使わない（11/4 守り）
    if v_gacha is null or v_gacha < 0 then return jsonb_build_object('error', 'gacha_invalid'); end if;
    v_ticket_disc := v_ticket_disc + v_gacha;
  end if;

  v_total := v_subtotal - v_line_disc - v_ticket_disc - v_manual;
  -- 券が料金を超えたときは 0円（超えた分はおつりにしない＝お店の従来どおり・10/28 慶一郎さん）。券以外の値引きが料金を超えるのは今までどおり不可
  if v_total < 0 and v_ticket_disc > 0 and v_subtotal - v_line_disc - v_manual >= 0 then v_total := 0; end if;
  if v_total < 0 then return jsonb_build_object('error', 'discount_exceeds'); end if;
  if nullif(p->>'expected_total', '') is null or (p->>'expected_total')::bigint <> v_total then
    return jsonb_build_object('error', 'total_mismatch', 'total', v_total);
  end if;
  select * into v_tax from public.accounting_settings where id = 1;

  -- GINPay 払い：顧客が必要（匿名は不可）。口座を決め（複数なら明示）、行ロックして残高を確認する
  if v_method = 'ginpay' then
    if v_client is null then return jsonb_build_object('error', 'ginpay_requires_client'); end if;
    if v_total <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
    v_gp := app_private.ginpay_resolve_account(v_client, nullif(p->>'ginpay_account_id', '')::uuid, false, p_actor_type, btrim(p_actor_name));
    if v_gp ? 'error' then
      if v_gp->>'error' = 'account_not_found' and exists (select 1 from public.ginpay_accounts a
           where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended') then
        return jsonb_build_object('error', 'ginpay_account_suspended');
      end if;
      return jsonb_build_object('error', case v_gp->>'error' when 'account_not_found' then 'ginpay_account_not_found' else v_gp->>'error' end);
    end if;
    select * into v_account from public.ginpay_accounts where id = (v_gp->>'account_id')::uuid for update;
    if v_account.status <> 'active' then return jsonb_build_object('error', 'ginpay_account_suspended'); end if;
    -- 予約の仮支払い（銀Pay の押さえ）の分は使えない。この会計の予約の押さえは、この会計で閉じるので数えない（10/27：押さえた分まで払えていた）
    if v_account.balance_cached - app_private.ginpay_held_sum(v_account.id, r.id) < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached - app_private.ginpay_held_sum(v_account.id, r.id));
    end if;
  end if;

  -- ── ここから書き込み（以後の失敗は例外で全体を取り消す） ──
  begin
    insert into public.accounting_sessions (user_id, customer_name, staff_name, stylist_name, stylist_id, payment_method, status,
      subtotal, discount_total, total, used_ticket_ids, client_id, reservation_id, tax_mode, tax_rate, idempotency_key)
    values (v_user, coalesce(v_name, r.customer_name, ''), btrim(p_actor_name), v_stylist.display_name, v_stylist.id, v_legacy, 'pending',
      v_subtotal, v_line_disc + v_ticket_disc + v_manual, v_total, (select array_agg(x::text) from unnest(v_tids) x),
      v_client, r.id, v_tax.tax_mode, v_tax.tax_rate, v_key)
    returning id into v_id;
  exception when unique_violation then
    -- 同じキーの同時送信は、先に確定した会計を返す。それ以外は同じ予約の二重会計
    if v_key is not null then
      select id into v_existing from public.accounting_sessions where idempotency_key = v_key and status in ('completed', 'voided');
      if v_existing is not null then return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true); end if;
    end if;
    return jsonb_build_object('error', 'already_paid');
  end;
  for v_item in select * from jsonb_array_elements(v_items) loop
    v_i := v_i + 1;
    v_price := (v_item->>'unit_price')::int; v_qty := coalesce((v_item->>'quantity')::int, 1); v_disc := coalesce((v_item->>'discount')::int, 0);
    v_list := case v_item->>'source'
      when 'service_menu' then (select price from public.service_menus where code = v_item->>'ref_id')
      when 'reservation' then (select ri.price from public.reservation_items ri where ri.reservation_id = r.id and ri.menu_code = v_item->>'ref_id' limit 1)
      when 'accounting_item' then (select price from public.accounting_items where id::text = v_item->>'ref_id')
      when 'product' then (select price from public.products where id::text = v_item->>'ref_id')
      else null end;
    insert into public.accounting_session_items (session_id, item_id, item_name, category, price, quantity, source, ref_id, list_price,
      line_discount, line_total, tax_mode, tax_rate, sort_order)
    values (v_id, case when v_item->>'source' in ('accounting_item', 'product') then nullif(v_item->>'ref_id', '')::uuid end,
      btrim(v_item->>'name'), v_item->>'category', v_price, v_qty, coalesce(v_item->>'source', 'manual'), nullif(v_item->>'ref_id', ''), v_list,
      v_disc, v_price * v_qty - v_disc, v_tax.tax_mode, v_tax.tax_rate, v_i);
  end loop;
  for t in select * from public.tickets where id = any(v_tids) order by id loop
    insert into public.accounting_discounts (session_id, kind, ticket_id, ticket_type, label, amount)
    values (v_id, 'ticket', t.id, t.type, t.title, t.amount);
  end loop;
  if h.user_id is not null then
    insert into public.accounting_discounts (session_id, kind, ticket_type, label, amount) values (v_id, 'ticket', 'gacha', 'ガチャ券 ' || h.title, v_gacha);
    update app_private.gacha_holdings set used_at = now(), used_sale_id = v_id where user_id = h.user_id;
  end if;
  if v_manual > 0 then
    insert into public.accounting_discounts (session_id, kind, label, amount) values (v_id, 'manual', btrim(p->'manual_discount'->>'label'), v_manual);
  end if;
  insert into public.accounting_payments (session_id, method, amount) values (v_id, v_method, v_total);

  -- GINPay 支払い（同じトランザクション。会計1件につき1件。失敗すれば会計ごと取り消す）
  if v_method = 'ginpay' then
    v_gp := app_private.ginpay_pay(v_client, v_account.id, v_total::int, v_id, p_actor_type, btrim(p_actor_name), 'sale:' || v_key);
    if v_gp ? 'error' then raise exception '%', v_gp->>'error'; end if;
  end if;

  -- チケットの消費（既存と同じ使用ログ・来店日）
  if cardinality(v_tids) > 0 then
    update public.tickets set used = true, used_at = now() where id = any(v_tids);
    -- 誰の施術に使ったか（お連れ様ならお名前と番号）も残す
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status, treated_companion_id, treated_name)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used', v_comp, v_comp_name
    from public.tickets t2 where t2.id = any(v_tids);
  end if;
  -- 来店の記録は会員本人の施術だけ。対象メニューの施術なら、受ける人の14日をここ（会計の完了）から始める
  v_owner := coalesce(r.user_id, v_user);
  if v_owner is not null and not v_is_comp then perform app_private.touch_visit(v_owner, r.id is null); end if;
  perform app_private.record_treatment(v_id, v_owner, v_comp, v_is_comp);

  update public.accounting_sessions set status = 'completed', completed_at = now() where id = v_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, detail)
  values (v_id, 'completed', p_actor_type, btrim(p_actor_name), jsonb_build_object('total', v_total, 'payment_method', v_method));

  -- 予約の完了（会計と同じトランザクション。完了にできなければ全体を取り消す）
  if r.id is not null and r.status <> 'completed' then
    if (app_private.set_reservation_status(r.id, 'completed', p_actor_type, btrim(p_actor_name), null)) ? 'error' then
      raise exception 'reservation_not_completed';
    end if;
  end if;
  return app_private.sale_json(v_id);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.set_reservation_status(p_id uuid, p_status text, p_actor_type text, p_actor_name text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_ok boolean;
begin
  select * into r from public.reservations where id = p_id for update;
  if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_ok := (r.status = 'confirmed' and p_status in ('checked_in', 'no_show', 'cancelled', 'completed'))
       or (r.status = 'checked_in' and p_status in ('in_service', 'awaiting_payment', 'completed'))
       or (r.status = 'in_service' and p_status in ('awaiting_payment', 'completed'))
       or (r.status = 'awaiting_payment' and p_status = 'completed');
  if not v_ok then return jsonb_build_object('error', 'invalid_status'); end if;
  if p_status = 'no_show' and r.starts_at > now() then return jsonb_build_object('error', 'not_started'); end if;
  update public.reservations
  set status = p_status, updated_at = now(),
      -- 施術を始めた時点で担当は確定（フリー予約の仮の担当のまま完了させない）
      staff_confirmed = staff_confirmed or p_status in ('in_service', 'awaiting_payment', 'completed'),
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
      cancel_reason = case when p_status = 'cancelled' then nullif(btrim(coalesce(p_reason, '')), '') else cancel_reason end
  where id = p_id;
  -- お連れ様の予約の受付は、会員本人の来店にしない（11/8）
  if p_status = 'checked_in' and r.user_id is not null and not app_private.res_is_companion(r.companion_id, r.companion_of, r.note) then
    perform app_private.touch_visit(r.user_id);
  end if;
  perform app_private.log_reservation_event(p_id, p_status, p_actor_type, p_actor_name,
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status), nullif(btrim(coalesce(p_reason, '')), ''));
  return app_private.reservation_json(p_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_check_in_reservation(p_staff text, p_user_id text, p_reservation_id uuid, p_staff_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
declare v_context jsonb; r public.reservations; v_result jsonb;
begin
  perform app_private.assert_staff(p_staff);
  perform app_private.require_actor(p_staff_name);
  v_context:=public.staff_member_booking_context(p_staff,p_user_id);
  if v_context ? 'error' then return v_context; end if;
  select * into r from public.reservations where id=p_reservation_id for update;
  if r.id is null or app_private.client_root(r.client_id)::text is distinct from v_context->>'client_id'
     or (r.starts_at at time zone 'Asia/Tokyo')::date<>app_private.today_jst() then
    return jsonb_build_object('error','reservation_mismatch');
  end if;
  if r.status='confirmed' then
    v_result:=app_private.set_reservation_status(r.id,'checked_in','staff',btrim(p_staff_name));
    if v_result ? 'error' then return v_result; end if;
  elsif r.status not in ('checked_in','in_service','awaiting_payment') then
    return jsonb_build_object('error','invalid_status');
  end if;
  if not app_private.res_is_companion(r.companion_id, r.companion_of, r.note) then perform app_private.touch_visit(p_user_id); end if;
  return app_private.reservation_json(r.id);
end $function$;

CREATE OR REPLACE FUNCTION app_private.gacha_unfit(p_user text, p_reservation uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare h app_private.gacha_holdings; r public.reservations; v_codes text[];
begin
  select * into h from app_private.gacha_holdings where user_id = p_user and used_at is null and expires_at > now();
  if h.user_id is null then return 'no_ticket'; end if;
  r := app_private.gacha_active_reservation(p_reservation);
  if r.id is null or r.user_id is distinct from p_user then return 'not_found'; end if;
  if app_private.res_is_companion(r.companion_id, r.companion_of, r.note) and (h.free_menu is null or h.self_only) then return 'companion'; end if;
  if h.expires_at <= r.starts_at then return 'expired'; end if;
  if h.weekday_only and app_private.gacha_offday(r.starts_at) then return 'weekday'; end if;
  select coalesce(array_agg(menu_code), '{}') into v_codes from public.reservation_items where reservation_id = r.id;
  if h.menu_codes is not null and not (v_codes && h.menu_codes) then return 'menu'; end if;
  if h.menu_codes is null and not exists (select 1 from unnest(v_codes) c where c <> 'maintenance') then return 'menu'; end if;
  return null;
end;
$function$;
