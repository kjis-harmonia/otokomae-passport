-- お客様の予約（AI予約・JOHNNY・キャンセル待ち）の時間は30分ごと（10/29 慶一郎さん：15分刻みになっていた）
--   店の予約の枠（booking_settings.slot_minutes＝15）は変えない：SB・本部の入力、ホットペッパーの :15 の予約、予約の移動はこれまでどおり
--   お客様に出す空き（日の空き・時刻・近い空き・キャンセル待ちの枠）を :00 と :30 だけにし、お客様の仮押さえも :00・:30 以外は受けない

create or replace function app_private.customer_slot_ok(p_starts_at timestamptz)
returns boolean language sql immutable set search_path = 'pg_catalog' as $$
  select extract(epoch from (p_starts_at at time zone 'Asia/Tokyo')::time)::bigint % 1800 = 0
$$;
revoke all on function app_private.customer_slot_ok(timestamptz) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.store_original_customer_available_slots(p_session text, p_date date, p_menu_codes text[], p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
begin
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if p_staff_id is null then
    -- 指名なし：時刻だけ（担当は確定時に決める）
    return coalesce((select json_agg(json_build_object('starts_at', t.starts_at) order by t.starts_at)
                     from (select distinct a.starts_at from app_private.available_slots(p_date, p_menu_codes, null,
                             (select min_lead_minutes from public.booking_settings where id = 1)) a where app_private.customer_slot_ok(a.starts_at)) t), '[]'::json);
  end if;
  return coalesce((select json_agg(json_build_object('starts_at', a.starts_at, 'staff_id', a.staff_id, 'staff_name', a.staff_name) order by a.starts_at)
                   from app_private.available_slots(p_date, p_menu_codes, p_staff_id,
                     (select min_lead_minutes from public.booking_settings where id = 1)) a where app_private.customer_slot_ok(a.starts_at)), '[]'::json);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.store_original_customer_next_slots(p_session text, p_menu_codes text[], p_from date, p_limit integer DEFAULT 5)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_lead int; v_last date; v_d date; v_out jsonb := '[]'; v_limit int := least(greatest(coalesce(p_limit, 5), 1), 10); r record;
begin
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 then return json_build_object('error', 'invalid_menu'); end if;
  select min_lead_minutes, app_private.today_jst() + booking_window_days into v_lead, v_last from public.booking_settings where id = 1;
  v_d := greatest(coalesce(p_from, app_private.today_jst()), app_private.today_jst());
  while v_d <= v_last and jsonb_array_length(v_out) < v_limit loop
    for r in select distinct a.starts_at from app_private.available_slots(v_d, p_menu_codes, null, v_lead) a where app_private.customer_slot_ok(a.starts_at) order by a.starts_at loop
      exit when jsonb_array_length(v_out) >= v_limit;
      v_out := v_out || jsonb_build_object('starts_at', r.starts_at);
    end loop;
    v_d := v_d + 1;
  end loop;
  return v_out::json;
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.day_overview(p_date date, p_lead integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_hours jsonb; g record; v_slots jsonb; v_groups jsonb := '[]';
begin
  if not app_private.booking_date_open(p_date) then
    return jsonb_build_object('date', p_date, 'open', false, 'hours', null, 'groups', '[]'::jsonb);
  end if;
  -- その日の受付時間：予約を受けるスタッフの勤務の、いちばん早い始まりと遅い終わり
  select case when min(e.st) is null then null else jsonb_build_object(
           'start', to_char(min(e.st) at time zone 'Asia/Tokyo', 'HH24:MI'),
           'end', to_char(max(e.en) at time zone 'Asia/Tokyo', 'HH24:MI')) end
  into v_hours
  from public.staff_members s cross join lateral app_private.effective_shifts(s.id, p_date) e
  where s.is_active and s.is_bookable;
  if v_hours is null then
    return jsonb_build_object('date', p_date, 'open', false, 'hours', null, 'groups', '[]'::jsonb);
  end if;
  for g in
    select x.key, array_agg(x.code order by x.sort_order, x.name) as codes
    from (
      select m.code, m.name, m.sort_order,
             (select string_agg(c.staff_id::text || ':' || coalesce(c.duration_override_min, m.duration_min)::text, ',' order by c.staff_id)
              from public.staff_menu_capabilities c
              join public.staff_members s on s.id = c.staff_id and s.is_active and s.is_bookable
              where c.menu_id = m.id) || '|' || m.buffer_after_min as key
      from public.service_menus m
      where m.is_active and m.booking_enabled and m.duration_min is not null
    ) x
    where x.key is not null
    group by x.key
  loop
    select coalesce(jsonb_agg(to_jsonb(t.starts_at) order by t.starts_at), '[]'::jsonb) into v_slots
    from (select distinct a.starts_at from app_private.available_slots(p_date, array[g.codes[1]], null, p_lead) a where app_private.customer_slot_ok(a.starts_at)) t;
    if jsonb_array_length(v_slots) > 0 then
      v_groups := v_groups || jsonb_build_object('codes', to_jsonb(g.codes), 'slots', v_slots);
    end if;
  end loop;
  return jsonb_build_object('date', p_date, 'open', true, 'hours', v_hours, 'groups', v_groups);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.store_original_customer_create_hold(p_session text, p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_uid text := app_private.session_user_id(p_session);
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if not app_private.customer_slot_ok(p_starts_at) then return json_build_object('error', 'slot_unavailable'); end if;  -- お客様は30分ごと
  return app_private.create_hold(p_starts_at, p_menu_codes, p_staff_id, 'app', v_uid,
    (select min_lead_minutes from public.booking_settings where id = 1))::json;
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.waitlist_offers()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
      where app_private.customer_slot_ok(a.starts_at) and (a.starts_at at time zone 'Asia/Tokyo')::time >= w.from_time and (a.starts_at at time zone 'Asia/Tokyo')::time < w.to_time
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
end $function$;
