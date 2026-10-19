-- キャンセル待ち（JOHNNY）。埋まっている日・時間に「キャンセル待ち」を入れておくと、空きが出たときに
-- 先に入れた人から順に、その枠を 10 分間「仮予約」（booking_holds）で押さえて、スマホにお知らせする。
--   押して確定 → いつもの予約になる。10 分たっても確定しなければ押さえを外して、次の人へ。
--   お知らせは 8:00〜21:00（日本時間）だけ。1人が入れられるのは同時に 3 件まで。
--   流れ：pg_cron（毎分）→ johnny-notify（waitlist）→ waitlist_offers_for_sender → Web Push → waitlist_record_for_sender

create table if not exists public.booking_waitlist (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  wanted_date date not null,
  from_time time not null default '00:00',
  to_time time not null default '23:59',
  menu_codes text[] not null check (cardinality(menu_codes) between 1 and 5),
  staff_id uuid,
  status text not null default 'waiting' check (status in ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  offer_hold_id uuid,
  offered_at timestamptz,
  offer_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_time < to_time)
);
create index if not exists booking_waitlist_open_idx on public.booking_waitlist (status, wanted_date, created_at);
create index if not exists booking_waitlist_user_idx on public.booking_waitlist (user_id, status);
alter table public.booking_waitlist enable row level security;
revoke all on public.booking_waitlist from anon, authenticated;

/** お店の「来店時の本人確認」がある環境では、それも通す（無い環境では何もしない） */
create or replace function app_private.waitlist_gate(p_session text)
returns text language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  if to_regprocedure('app_private.require_store_verified(text)') is not null then
    execute 'select app_private.require_store_verified($1)' using p_session;
  end if;
  return v_uid;
end $$;

create or replace function app_private.waitlist_json(w public.booking_waitlist)
returns json language sql stable security definer set search_path = public, pg_temp as $$
  select json_build_object('id', w.id, 'date', w.wanted_date, 'from', to_char(w.from_time, 'HH24:MI'), 'to', to_char(w.to_time, 'HH24:MI'),
    'menu_codes', w.menu_codes, 'staff_id', w.staff_id, 'status', w.status, 'offer_hold_id', w.offer_hold_id, 'created_at', w.created_at,
    'menu_names', (select string_agg(m.name, '＋' order by array_position(w.menu_codes, m.code)) from public.service_menus m where m.code = any(w.menu_codes)))
$$;

-- ── お客様 ─────────────────────────────────────────────────────────────

create or replace function public.customer_join_waitlist(p_session text, p_date date, p_from time, p_to time, p_menu_codes text[], p_staff_id uuid default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid text := app_private.waitlist_gate(p_session); w public.booking_waitlist; v_days int;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select booking_window_days into v_days from public.booking_settings where id = 1;
  if p_date is null or p_date < app_private.today_jst() or p_date > app_private.today_jst() + coalesce(v_days, 60) then return json_build_object('error', 'date_not_open'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or exists (select 1 from unnest(p_menu_codes) c where not exists (select 1 from public.service_menus m where m.code = c and m.is_active and m.booking_enabled)) then
    return json_build_object('error', 'menu_not_available');
  end if;
  -- 同じ日・同じメニューなら時間だけ入れ替える
  select * into w from public.booking_waitlist where user_id = v_uid and wanted_date = p_date and menu_codes = p_menu_codes and status in ('waiting', 'offered') limit 1;
  if w.id is not null then
    update public.booking_waitlist set from_time = coalesce(p_from, '00:00'), to_time = coalesce(p_to, '23:59'), staff_id = p_staff_id, updated_at = now() where id = w.id returning * into w;
  else
    if (select count(*) from public.booking_waitlist where user_id = v_uid and status in ('waiting', 'offered')) >= 3 then return json_build_object('error', 'waitlist_full'); end if;
    insert into public.booking_waitlist (user_id, wanted_date, from_time, to_time, menu_codes, staff_id)
    values (v_uid, p_date, coalesce(p_from, '00:00'), coalesce(p_to, '23:59'), p_menu_codes, p_staff_id) returning * into w;
  end if;
  return json_build_object('entry', app_private.waitlist_json(w),
    'has_push', exists (select 1 from public.push_subscriptions s where s.user_id = v_uid and s.disabled_at is null));
end $$;

create or replace function public.customer_waitlist(p_session text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return coalesce((select json_agg(app_private.waitlist_json(w) order by w.wanted_date, w.from_time)
    from public.booking_waitlist w where w.user_id = v_uid and w.status in ('waiting', 'offered')), '[]'::json);
end $$;

create or replace function public.customer_leave_waitlist(p_session text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid text := app_private.session_user_id(p_session); w public.booking_waitlist;
begin
  update public.booking_waitlist set status = 'cancelled', updated_at = now() where id = p_id and user_id = v_uid and status in ('waiting', 'offered') returning * into w;
  if w.id is null then return json_build_object('error', 'not_found'); end if;
  if w.offer_hold_id is not null then
    update public.booking_holds set released_at = now() where id = w.offer_hold_id and converted_reservation_id is null and released_at is null;
  end if;
  return json_build_object('ok', true);
end $$;

/** お知らせから開いたとき：押さえている枠の中身（自分の・まだ有効なものだけ） */
create or replace function public.customer_get_hold(p_session text, p_hold_id uuid)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid text := app_private.session_user_id(p_session); h public.booking_holds;
begin
  select * into h from public.booking_holds where id = p_hold_id and holder_user_id = v_uid;
  if h.id is null then return json_build_object('error', 'hold_not_found'); end if;
  if h.converted_reservation_id is not null then return json_build_object('error', 'already_booked', 'reservation_id', h.converted_reservation_id); end if;
  if h.released_at is not null or h.expires_at <= now() then return json_build_object('error', 'hold_expired'); end if;
  return json_build_object('hold_id', h.id, 'starts_at', h.starts_at, 'ends_at', h.ends_at, 'expires_at', h.expires_at, 'menu_codes', h.menu_codes,
    'staff_id', h.staff_id, 'staff_name', (select display_name from public.staff_members where id = h.staff_id),
    'menu_names', (select string_agg(m.name, '＋' order by array_position(h.menu_codes, m.code)) from public.service_menus m where m.code = any(h.menu_codes)),
    'total_price', (select sum(m.price) from public.service_menus m where m.code = any(h.menu_codes)),
    'waitlist_id', (select id from public.booking_waitlist where offer_hold_id = h.id limit 1));
end $$;

-- ── 空きが出たら順番に押さえる（毎分） ───────────────────────────────────

create or replace function app_private.waitlist_offers()
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  w public.booking_waitlist; v_slot record; v_hold jsonb; v_hold_id uuid; v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
  v_min_lead int := (select min_lead_minutes from public.booking_settings where id = 1);
  v_offers jsonb := '[]'::jsonb;
begin
  -- 1) 確定した・時間切れになった押さえを片づける
  update public.booking_waitlist w2 set status = 'booked', updated_at = now()
    from public.booking_holds h where w2.status = 'offered' and h.id = w2.offer_hold_id and h.converted_reservation_id is not null;
  update public.booking_waitlist w2 set status = case when w2.offer_count >= 2 then 'expired' else 'waiting' end, offer_hold_id = null, updated_at = now()
    from public.booking_holds h where w2.status = 'offered' and h.id = w2.offer_hold_id and h.converted_reservation_id is null and (h.released_at is not null or h.expires_at <= now());
  -- 待つ時間が過ぎたもの
  update public.booking_waitlist set status = 'expired', updated_at = now()
    where status in ('waiting', 'offered') and (wanted_date < v_now_jst::date or (wanted_date = v_now_jst::date and to_time <= v_now_jst::time));

  -- 2) お知らせしてよい時間だけ（8:00〜21:00）
  if v_now_jst::time < '08:00' or v_now_jst::time >= '21:00' then return '[]'::json; end if;
  if not app_private.assert_app_booking() then return '[]'::json; end if;

  for w in select * from public.booking_waitlist where status = 'waiting' order by created_at limit 50 loop
    -- お知らせを受け取れない人は飛ばす（スマホを登録していない）
    continue when not exists (select 1 from public.push_subscriptions s where s.user_id = w.user_id and s.disabled_at is null);
    select a.starts_at, a.staff_id into v_slot from app_private.available_slots(w.wanted_date, w.menu_codes, w.staff_id, v_min_lead) a
      where (a.starts_at at time zone 'Asia/Tokyo')::time >= w.from_time and (a.starts_at at time zone 'Asia/Tokyo')::time < w.to_time
      order by a.starts_at limit 1;
    continue when v_slot.starts_at is null;
    v_hold := app_private.create_hold(v_slot.starts_at, w.menu_codes, coalesce(w.staff_id, v_slot.staff_id), 'app', w.user_id, v_min_lead)::jsonb;
    continue when v_hold ? 'error' or (v_hold->>'hold_id') is null;
    v_hold_id := (v_hold->>'hold_id')::uuid;
    update public.booking_holds set expires_at = now() + interval '10 minutes' where id = v_hold_id;
    update public.booking_waitlist set status = 'offered', offer_hold_id = v_hold_id, offered_at = now(), offer_count = offer_count + 1, updated_at = now() where id = w.id;
    v_offers := v_offers || jsonb_build_object('user_id', w.user_id, 'waitlist_id', w.id, 'hold_id', v_hold_id,
      'starts_at', v_slot.starts_at, 'date', w.wanted_date,
      'time', to_char(v_slot.starts_at at time zone 'Asia/Tokyo', 'FMHH24:MI'),
      'menu_names', (select string_agg(m.name, '＋') from public.service_menus m where m.code = any(w.menu_codes)),
      'subs', (select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)) from public.push_subscriptions s where s.user_id = w.user_id and s.disabled_at is null));
  end loop;
  return v_offers::json;
end $$;

create or replace function public.waitlist_offers_for_sender(p_secret text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  return app_private.waitlist_offers();
end $$;

create or replace function public.waitlist_record_for_sender(p_secret text, p_user_id text, p_title text, p_body text, p_delivered int, p_gone text[])
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  perform app_private.notify_record(p_user_id, 'waitlist', p_title, p_body, p_delivered, p_gone);
end $$;

-- 本部 JOHNNY：キャンセル待ちの様子
create or replace function public.hq_waitlist(p_hq text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return coalesce((select json_agg(json_build_object('date', w.wanted_date, 'from', to_char(w.from_time, 'HH24:MI'), 'to', to_char(w.to_time, 'HH24:MI'),
      'status', w.status, 'menu', (select string_agg(m.name, '＋') from public.service_menus m where m.code = any(w.menu_codes)),
      'customer', (select c.name from public.customers c where c.user_id = w.user_id limit 1)) order by w.wanted_date, w.created_at)
    from public.booking_waitlist w where w.status in ('waiting', 'offered') and w.wanted_date >= app_private.today_jst()), '[]'::json);
end $$;

revoke all on function app_private.waitlist_offers(), app_private.waitlist_gate(text) from public;
revoke all on function public.customer_join_waitlist(text, date, time, time, text[], uuid), public.customer_waitlist(text), public.customer_leave_waitlist(text, uuid),
  public.customer_get_hold(text, uuid), public.waitlist_offers_for_sender(text), public.waitlist_record_for_sender(text, text, text, text, int, text[]), public.hq_waitlist(text)
  from public, anon, authenticated;
grant execute on function public.customer_join_waitlist(text, date, time, time, text[], uuid), public.customer_waitlist(text), public.customer_leave_waitlist(text, uuid),
  public.customer_get_hold(text, uuid), public.waitlist_offers_for_sender(text), public.waitlist_record_for_sender(text, text, text, text, int, text[]), public.hq_waitlist(text)
  to anon, authenticated;
