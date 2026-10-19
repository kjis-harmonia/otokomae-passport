-- JOHNNY（お客様アプリの予約アシスタント）が、聞かれた時点で空き状況を先に見て提案するための関数。
--   customer_day_overview(日付)：その日の受付時間と、メニューごとの空き時間（空きのあるメニューだけ）
--   customer_next_slots(メニュー, 開始日)：近い日から空きを探して、早い順に数件
-- 空きの計算は今までと同じ予約エンジン（available_slots）。新しい規則は作らない。
-- 同じ担当・同じ所要時間・同じ片付け時間のメニューは空きも同じなので、まとめて1回だけ計算する。

create or replace function app_private.day_overview(p_date date, p_lead integer)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
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
    from (select distinct a.starts_at from app_private.available_slots(p_date, array[g.codes[1]], null, p_lead) a) t;
    if jsonb_array_length(v_slots) > 0 then
      v_groups := v_groups || jsonb_build_object('codes', to_jsonb(g.codes), 'slots', v_slots);
    end if;
  end loop;
  return jsonb_build_object('date', p_date, 'open', true, 'hours', v_hours, 'groups', v_groups);
end;
$$;

create or replace function public.customer_day_overview(p_session text, p_date date)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if p_date is null then return json_build_object('error', 'invalid_date'); end if;
  return app_private.day_overview(p_date, (select min_lead_minutes from public.booking_settings where id = 1))::json;
end;
$$;

/** 近い日から空きを探す。p_from から受付期間の終わりまで、早い順に p_limit 件（指名なし・時刻だけ） */
create or replace function public.customer_next_slots(p_session text, p_menu_codes text[], p_from date, p_limit integer default 5)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_lead int; v_last date; v_d date; v_out jsonb := '[]'; v_limit int := least(greatest(coalesce(p_limit, 5), 1), 10); r record;
begin
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 then return json_build_object('error', 'invalid_menu'); end if;
  select min_lead_minutes, app_private.today_jst() + booking_window_days into v_lead, v_last from public.booking_settings where id = 1;
  v_d := greatest(coalesce(p_from, app_private.today_jst()), app_private.today_jst());
  while v_d <= v_last and jsonb_array_length(v_out) < v_limit loop
    for r in select distinct a.starts_at from app_private.available_slots(v_d, p_menu_codes, null, v_lead) a order by a.starts_at loop
      exit when jsonb_array_length(v_out) >= v_limit;
      v_out := v_out || jsonb_build_object('starts_at', r.starts_at);
    end loop;
    v_d := v_d + 1;
  end loop;
  return v_out::json;
end;
$$;

revoke all on function app_private.day_overview(date, integer) from public, anon, authenticated, service_role;
revoke all on function public.customer_day_overview(text, date) from public, anon, authenticated, service_role;
revoke all on function public.customer_next_slots(text, text[], date, integer) from public, anon, authenticated, service_role;
grant execute on function public.customer_day_overview(text, date) to anon, authenticated;
grant execute on function public.customer_next_slots(text, text[], date, integer) to anon, authenticated;
