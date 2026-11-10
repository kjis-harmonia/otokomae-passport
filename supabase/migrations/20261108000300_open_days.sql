-- 銀ちゃんの予約（LINE 型）のカレンダー：空きのある日だけ押せるように（11/8 慶一郎さん「空いてない日は選択できんように」）
--   空きは今の予約エンジン（app_private.available_slots：担当の出勤・休み・施術の時間・入っている予約）と、お客様の30分刻み（customer_slot_ok）で判定
--   p_weekend：土日だけ（「土日希望」）。p_staff：担当を決めているときはその担当の空きだけ
-- その日に予約できる枠が1つでもあるか（available_slots と同じ判定・同じ道具。最初の空きで止めるので速い）
create or replace function app_private.day_has_slot(p_date date, p_menu_codes text[], p_staff_id uuid, p_min_lead_minutes integer)
returns boolean language plpgsql stable set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_slot int; v_plan jsonb; v_dur interval; v_occ interval; v_earliest timestamptz; s record; sh record;
        v_first timestamptz; v_day_start timestamptz; v_t timestamptz;
begin
  if not app_private.booking_date_open(p_date) then return false; end if;
  select slot_minutes into v_slot from public.booking_settings where id = 1;
  v_earliest := now() + make_interval(mins => greatest(p_min_lead_minutes, 0));
  v_day_start := app_private.jst_ts(p_date, '00:00');
  for s in
    select m.id from public.staff_members m
    where m.is_active and m.is_bookable and (p_staff_id is null or m.id = p_staff_id)
    order by m.sort_order, m.display_name
  loop
    v_plan := app_private.booking_plan(s.id, p_menu_codes);
    continue when v_plan is null;
    v_dur := make_interval(mins => (v_plan->>'duration_min')::int);
    v_occ := make_interval(mins => (v_plan->>'duration_min')::int + (v_plan->>'buffer_min')::int);
    for sh in select e.st, e.en from app_private.effective_shifts(s.id, p_date) e loop
      v_first := greatest(sh.st, v_earliest);
      v_first := v_day_start + make_interval(mins => (ceil(extract(epoch from (v_first - v_day_start)) / 60.0 / v_slot) * v_slot)::int);
      v_t := v_first;
      while v_t + v_occ <= sh.en loop
        if app_private.customer_slot_ok(v_t) and app_private.slot_is_free(s.id, v_t, v_t + v_dur, v_t + v_occ, null, null) then
          return true;
        end if;
        v_t := v_t + make_interval(mins => v_slot);
      end loop;
    end loop;
  end loop;
  return false;
end;
$$;
revoke all on function app_private.day_has_slot(date, text[], uuid, integer) from public, anon, authenticated;

create or replace function public.customer_open_days(p_session text, p_menu_codes text[], p_from date, p_to date, p_staff_id uuid default null, p_weekend boolean default false)
returns json language plpgsql stable security definer set search_path = 'public', 'extensions', 'pg_temp' as $$
declare v_lead int; v_last date; v_d date; v_to date; v_out jsonb := '[]';
begin
  perform app_private.require_store_verified(p_session);
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 5 then return json_build_object('error', 'invalid_menu'); end if;
  select min_lead_minutes, app_private.today_jst() + booking_window_days into v_lead, v_last from public.booking_settings where id = 1;
  v_d := greatest(coalesce(p_from, app_private.today_jst()), app_private.today_jst());
  -- 1回で調べるのは1か月ほどまで（アプリは1週間ずつ並べて呼ぶ）
  v_to := least(coalesce(p_to, v_last), v_last, v_d + 31);
  while v_d <= v_to loop
    if (not p_weekend or extract(isodow from v_d) in (6, 7)) and app_private.day_has_slot(v_d, p_menu_codes, p_staff_id, v_lead) then
      v_out := v_out || to_jsonb(v_d::text);
    end if;
    v_d := v_d + 1;
  end loop;
  return v_out::json;
end;
$$;
revoke all on function public.customer_open_days(text, text[], date, date, uuid, boolean) from public;
grant execute on function public.customer_open_days(text, text[], date, date, uuid, boolean) to anon, authenticated, service_role;
