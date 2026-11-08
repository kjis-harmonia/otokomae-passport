-- メンテナンスの14日は「受ける人ごとの QR チェックイン日」から（11/8 慶一郎さん）
--   本番の直近30日：QR の来店 206件のうち、店舗端末で会計まで済んだのは 30件（15%）。会計の完了を起点にすると多くの方が使えなくなる
--   ・その日のメニューは：お店で登録したもの（staff）・会計の明細（sale）・その日の予約（reservation）・お客様が銀ちゃんに答えたもの（customer）
--     メニューが分からない来店は数えない（次にアプリを開いたとき銀ちゃんが聞く）。以前の「いつもの」は今回のメニューにしない
--   ・対象メニュー（service_menus.maintenance_eligible）の来店だけが起点。メンテナンスカットの来店は起点にならない（期限は延びない）
--   ・お連れ様の来店は app_private.companion_visits に人ごと。お連れ様を消しても（removed_at）来店の記録は残る
--   ・maintenance_visits（会員本人）と customer_companions.last_eligible_date（お連れ様）は「起点の日」の写し。来店・メニューが変わるたびに付け直す

alter table public.visit_log drop constraint if exists visit_log_menu_source_check;
alter table public.visit_log add constraint visit_log_menu_source_check
  check (menu_source is null or menu_source in ('reservation', 'staff', 'sale', 'customer'));
-- 銀ちゃんがお客様に確かめた（または聞かなくてよくなった）日時
alter table public.visit_log add column if not exists gin_ack_at timestamptz;

create table if not exists app_private.companion_visits (
  companion_id   uuid not null references app_private.customer_companions(id),
  visit_date     date not null,
  menu_code      text,
  menu_name      text check (menu_name is null or length(menu_name) <= 80),
  menu_source    text check (menu_source is null or menu_source in ('reservation', 'staff', 'sale', 'customer')),
  reservation_id uuid references public.reservations(id) on delete set null,
  gin_ack_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (companion_id, visit_date)
);
revoke all on table app_private.companion_visits from public, anon, authenticated;

create or replace function app_private.menu_eligible(p_code text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select m.maintenance_eligible from public.service_menus m where m.code = p_code), false)
$$;
revoke all on function app_private.menu_eligible(text) from public, anon, authenticated;

/** 会員本人の起点：対象メニューの来店でいちばん新しい日（今日まで）。無ければ記録を消す */
create or replace function app_private.refresh_owner_base(p_user text)
returns void language plpgsql set search_path = '' as $$
declare v date;
begin
  if p_user is null then return; end if;
  select max(l.visit_date) into v from public.visit_log l
  where l.user_id = p_user and l.visit_date <= app_private.today_jst() and app_private.menu_eligible(l.menu_code);
  if v is null then
    delete from public.maintenance_visits where user_id = p_user;
  else
    insert into public.maintenance_visits (user_id, last_visit_date, updated_at) values (p_user, v, now())
    on conflict (user_id) do update set last_visit_date = excluded.last_visit_date, updated_at = now();
  end if;
end;
$$;
revoke all on function app_private.refresh_owner_base(text) from public, anon, authenticated;

/** お連れ様の起点 */
create or replace function app_private.refresh_companion_base(p_companion uuid)
returns void language sql set search_path = '' as $$
  update app_private.customer_companions c
  set last_eligible_date = (select max(v.visit_date) from app_private.companion_visits v
                            where v.companion_id = c.id and v.visit_date <= app_private.today_jst() and app_private.menu_eligible(v.menu_code)),
      updated_at = now()
  where c.id = p_companion
$$;
revoke all on function app_private.refresh_companion_base(uuid) from public, anon, authenticated;

/** 予約のメニュー（HOT PEPPER の取り込みは名前から読み替える） */
create or replace function app_private.reservation_menu(p_reservation uuid)
returns table(menu_code text, menu_name text) language sql stable set search_path = '' as $$
  select case when i.menu_code = 'hotpepper' and i.name like '%メンテナンス%' then 'maintenance' else coalesce(app_private.item_menu_code(i.menu_code, i.name), i.menu_code) end,
         case when i.menu_code = 'hotpepper' and i.name like '%メンテナンス%' then 'メンテナンスカット'
              else coalesce((select m.name from public.service_menus m where m.code = app_private.item_menu_code(i.menu_code, i.name)), i.name) end
  from (select ri.menu_code, ri.name from public.reservation_items ri where ri.reservation_id = p_reservation order by ri.sort_order, ri.name limit 1) i
$$;
revoke all on function app_private.reservation_menu(uuid) from public, anon, authenticated;

/** お連れ様の予約の受付：その方の来店にする（メニューは予約から）。番号の分からない前からの予約は付けない */
create or replace function app_private.touch_companion_visit(p_reservation uuid)
returns void language plpgsql set search_path = '' as $$
declare v_c uuid := app_private.res_companion(p_reservation); v_m record; v_day date;
begin
  if v_c is null then return; end if;
  select (r.starts_at at time zone 'Asia/Tokyo')::date into v_day from public.reservations r where r.id = p_reservation;
  if v_day is distinct from app_private.today_jst() then return; end if;
  select * into v_m from app_private.reservation_menu(p_reservation);
  insert into app_private.companion_visits (companion_id, visit_date, menu_code, menu_name, menu_source, reservation_id)
  values (v_c, v_day, v_m.menu_code, v_m.menu_name, case when v_m.menu_code is null then null else 'reservation' end, p_reservation)
  on conflict (companion_id, visit_date) do update
    set menu_code = coalesce(app_private.companion_visits.menu_code, excluded.menu_code),
        menu_name = coalesce(app_private.companion_visits.menu_name, excluded.menu_name),
        menu_source = coalesce(app_private.companion_visits.menu_source, excluded.menu_source),
        reservation_id = coalesce(app_private.companion_visits.reservation_id, excluded.reservation_id),
        updated_at = now();
  perform app_private.refresh_companion_base(v_c);
end;
$$;
revoke all on function app_private.touch_companion_visit(uuid) from public, anon, authenticated;

-- 会員本人の来店（QR・予約の受付・会計）。来店を付けたら起点も付け直す
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
  perform app_private.refresh_owner_base(p_user_id);
end;
$$;

-- 会計の完了：明細のメニューを、受ける人のその日の来店のメニューにする（お店が登録したメニューは変えない）
create or replace function app_private.record_treatment(p_sale uuid, p_user text, p_companion uuid, p_is_companion boolean)
returns void language plpgsql set search_path = '' as $$
declare v_today date := app_private.today_jst(); v_code text; v_name text;
begin
  if p_user is null then return; end if;
  -- 明細のメニュー：対象メニューがあればそれ、無ければ最初のメニュー
  select c.code, c.name into v_code, v_name from (
    select m.code, m.name, m.maintenance_eligible as e, i.sort_order
    from public.accounting_session_items i join public.service_menus m on m.code = app_private.item_menu_code(i.ref_id, i.item_name)
    where i.session_id = p_sale and i.source in ('reservation', 'service_menu')
  ) c order by c.e desc, c.sort_order limit 1;
  if v_code is null then return; end if;
  if not p_is_companion then
    insert into public.visit_log (user_id, visit_date, menu_code, menu_name, menu_source)
    values (p_user, v_today, v_code, v_name, 'sale')
    on conflict (user_id, visit_date) do update
      set menu_code = excluded.menu_code, menu_name = excluded.menu_name, menu_source = 'sale', updated_at = now()
      where public.visit_log.menu_source is distinct from 'staff';
    perform app_private.refresh_owner_base(p_user);
  elsif p_companion is not null then
    insert into app_private.companion_visits (companion_id, visit_date, menu_code, menu_name, menu_source)
    values (p_companion, v_today, v_code, v_name, 'sale')
    on conflict (companion_id, visit_date) do update
      set menu_code = excluded.menu_code, menu_name = excluded.menu_name, menu_source = 'sale', updated_at = now()
      where app_private.companion_visits.menu_source is distinct from 'staff';
    perform app_private.refresh_companion_base(p_companion);
  end if;
end;
$$;
revoke all on function app_private.record_treatment(uuid, text, uuid, boolean) from public, anon, authenticated;

-- 店舗端末の「本日のメニュー」（会員本人）：登録したら起点も付け直す
create or replace function public.staff_set_visit_menu(p_staff text, p_user_id text, p_menu_code text, p_staff_name text default null)
returns json language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_name text;
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  if p_menu_code = 'maintenance' then v_name := 'メンテナンスカット';
  else select m.name into v_name from public.service_menus m where m.code = p_menu_code and m.is_active;
  end if;
  if v_name is null then return json_build_object('error', 'menu_not_found'); end if;
  insert into public.visit_log (user_id, visit_date, menu_code, menu_name, menu_source, updated_by)
  values (p_user_id, app_private.today_jst(), p_menu_code, v_name, 'staff', left(p_staff_name, 40))
  on conflict (user_id, visit_date) do update
    set menu_code = excluded.menu_code, menu_name = excluded.menu_name, menu_source = 'staff',
        updated_by = excluded.updated_by, updated_at = now();
  perform app_private.refresh_owner_base(p_user_id);
  return json_build_object('visit_date', app_private.today_jst(), 'menu_code', p_menu_code, 'menu_name', v_name, 'menu_source', 'staff');
end;
$$;

-- ── お客様：銀ちゃんが確かめる来店（QR のあと、次にアプリを開いたとき） ──
/** まだ銀ちゃんが確かめていない来店（30日以内）。本人のいちばん新しい1件と、お連れ様それぞれのいちばん新しい1件 */
create or replace function app_private.visits_to_confirm_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'owner', (select json_build_object('date', l.visit_date, 'menu_code', l.menu_code, 'menu_name', l.menu_name, 'menu_source', l.menu_source,
                'maintenance', app_private.menu_eligible(l.menu_code))
              from public.visit_log l
              where l.user_id = p_user and l.gin_ack_at is null and l.visit_date between app_private.today_jst() - 30 and app_private.today_jst()
              order by l.visit_date desc limit 1),
    'companions', coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name, 'date', v.visit_date, 'menu_code', v.menu_code, 'menu_name', v.menu_name,
                  'menu_source', v.menu_source, 'maintenance', app_private.menu_eligible(v.menu_code)) order by v.visit_date desc)
              from app_private.customer_companions c
              join lateral (select * from app_private.companion_visits x where x.companion_id = c.id and x.gin_ack_at is null
                            and x.visit_date between app_private.today_jst() - 30 and app_private.today_jst() order by x.visit_date desc limit 1) v on true
              where c.customer_id = app_private.customer_of_user(p_user)), '[]'::json))
$$;
revoke all on function app_private.visits_to_confirm_json(text) from public, anon, authenticated;

create or replace function public.customer_visits_to_confirm(p_session text)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  return app_private.visits_to_confirm_json(app_private.session_user_id(p_session));
end;
$$;

/** お客様：その日のメニューを銀ちゃんに答えた（p_menu_code が null なら「確かめた」だけ）。
 *  お店（staff）・会計（sale）が付けたメニューはお客様の答えで変えない。30日より前の来店は変えない */
create or replace function public.customer_confirm_visit(p_session text, p_date date, p_companion uuid, p_menu_code text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_name text;
begin
  if p_date is null or p_date > app_private.today_jst() or p_date < app_private.today_jst() - 30 then return json_build_object('error', 'bad_date'); end if;
  if p_menu_code is not null then
    if p_menu_code = 'maintenance' then v_name := 'メンテナンスカット';
    else select m.name into v_name from public.service_menus m where m.code = p_menu_code and m.is_active; end if;
    if v_name is null then return json_build_object('error', 'bad_menu'); end if;
  end if;
  if p_companion is null then
    update public.visit_log
    set menu_code = case when p_menu_code is not null and menu_source is distinct from 'staff' and menu_source is distinct from 'sale' then p_menu_code else menu_code end,
        menu_name = case when p_menu_code is not null and menu_source is distinct from 'staff' and menu_source is distinct from 'sale' then v_name else menu_name end,
        menu_source = case when p_menu_code is not null and menu_source is distinct from 'staff' and menu_source is distinct from 'sale' then 'customer' else menu_source end,
        gin_ack_at = now(), updated_at = now()
    where user_id = v_user and visit_date = p_date;
    if not found then return json_build_object('error', 'not_found'); end if;
    perform app_private.refresh_owner_base(v_user);
  else
    if (app_private.own_companion(v_user, p_companion)).id is null
       and not exists (select 1 from app_private.customer_companions c where c.id = p_companion and c.customer_id = app_private.customer_of_user(v_user)) then
      return json_build_object('error', 'companion_not_found');
    end if;
    update app_private.companion_visits
    set menu_code = case when p_menu_code is not null and menu_source is distinct from 'staff' and menu_source is distinct from 'sale' then p_menu_code else menu_code end,
        menu_name = case when p_menu_code is not null and menu_source is distinct from 'staff' and menu_source is distinct from 'sale' then v_name else menu_name end,
        menu_source = case when p_menu_code is not null and menu_source is distinct from 'staff' and menu_source is distinct from 'sale' then 'customer' else menu_source end,
        gin_ack_at = now(), updated_at = now()
    where companion_id = p_companion and visit_date = p_date;
    if not found then return json_build_object('error', 'not_found'); end if;
    perform app_private.refresh_companion_base(p_companion);
  end if;
  return json_build_object('ok', true, 'people', app_private.people_json(v_user), 'pending', app_private.visits_to_confirm_json(v_user));
end;
$$;

revoke all on function public.customer_visits_to_confirm(text), public.customer_confirm_visit(text, date, uuid, text) from public;
grant execute on function public.customer_visits_to_confirm(text), public.customer_confirm_visit(text, date, uuid, text) to anon, authenticated, service_role;

-- 予約の受付：お連れ様の予約はその方の来店に（会員本人の来店にはしない・11/8 と同じ）
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
  elsif p_status = 'checked_in' and app_private.res_is_companion(r.companion_id, r.companion_of, r.note) then
    -- お連れ様の予約の受付は、その方の来店（11/8：14日は受ける人ごとの QR チェックイン日から）
    perform app_private.touch_companion_visit(r.id);
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
  if not app_private.res_is_companion(r.companion_id, r.companion_of, r.note) then perform app_private.touch_visit(p_user_id);
  else perform app_private.touch_companion_visit(r.id); end if;
  return app_private.reservation_json(r.id);
end $function$;
