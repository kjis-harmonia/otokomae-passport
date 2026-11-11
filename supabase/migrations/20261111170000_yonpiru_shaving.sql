-- 11/11 慶一郎さん：ヨンピル（お店の顔剃り担当）を、顔そり男性・レディースシェービングだけ予約できるように。
--   出勤日・時間・休みはテイテイと同じ（テイテイの出勤表と休みを写す）。同時1人（booking_capacity=1 のまま）。
--   お客様の予約の選択肢は、メニューごとに担当できる人だけ（customer_booking_options の staff に menus を足す）
-- 戻し方：supabase/rollback/20261111_yonpiru_off.sql
do $$
declare v_y uuid; v_t uuid;
begin
  select id into v_y from public.staff_members where display_name = 'ヨンピル';
  select id into v_t from public.staff_members where display_name = 'テイテイ';
  if v_y is null or v_t is null then raise exception 'staff_not_found'; end if;

  -- 顔そり2つだけ担当できる（ほかのメニューは今まで通り担当しない）
  insert into public.staff_menu_capabilities (staff_id, menu_id)
  select v_y, m.id from public.service_menus m where m.code in ('shave-men', 'shave-ladies')
  on conflict do nothing;

  -- 出勤表・休み：テイテイと同じ
  delete from public.staff_shift_templates where staff_id = v_y;
  insert into public.staff_shift_templates (staff_id, weekday, start_time, end_time)
  select v_y, weekday, start_time, end_time from public.staff_shift_templates where staff_id = v_t;
  insert into public.staff_day_offs (staff_id, off_date, created_by)
  select v_y, off_date, 'テイテイと同じ（11/11）' from public.staff_day_offs where staff_id = v_t
  on conflict do nothing;
  insert into public.staff_shifts (staff_id, work_date, start_time, end_time, created_by)
  select v_y, work_date, start_time, end_time, 'テイテイと同じ（11/11）' from public.staff_shifts where staff_id = v_t and work_date >= app_private.today_jst();

  update public.staff_members set is_bookable = true, booking_capacity = 1, updated_at = now() where id = v_y;
end $$;

CREATE OR REPLACE FUNCTION public.customer_booking_options(p_session text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_client uuid := app_private.user_client(app_private.session_user_id(p_session));
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  return json_build_object(
    'settings', (select json_build_object('slot_minutes', slot_minutes, 'booking_window_days', booking_window_days,
                   'min_lead_minutes', min_lead_minutes, 'hold_minutes', hold_minutes) from public.booking_settings where id = 1),
    'menus', coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'duration_min', m.duration_min,
                         'price', coalesce(p.price, m.price), 'normal_price', case when p.price is null then m.normal_price end,
                         'price_from', m.price_from and p.price is null, 'maintenance', m.maintenance_eligible) order by m.sort_order)
                       from public.service_menus m
                       cross join lateral (select app_private.client_menu_price(v_client, m.code) as price) p
                       where m.is_active and m.booking_enabled and m.duration_min is not null
                         and exists (select 1 from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id
                                     where c.menu_id = m.id and s.is_active and s.is_bookable)), '[]'::json),
    -- menus：その担当ができるメニュー（11/11：ヨンピルは顔そりだけ。銀ちゃんがメニューごとに担当の選択肢を出す）
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name,
                         'menus', coalesce((select json_agg(m2.code order by m2.sort_order) from public.staff_menu_capabilities c2 join public.service_menus m2 on m2.id = c2.menu_id where c2.staff_id = s.id), '[]'::json)) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json));
end;
$function$;
