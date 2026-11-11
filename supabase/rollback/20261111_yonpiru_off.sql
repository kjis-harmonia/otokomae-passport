-- 20261111170000_yonpiru_shaving.sql を戻す。ヨンピルの予約を受けない状態に（入っている予約はそのまま残る）
begin;
update public.staff_members set is_bookable = false, updated_at = now() where display_name = 'ヨンピル';
delete from public.staff_menu_capabilities c using public.staff_members s, public.service_menus m
 where c.staff_id = s.id and c.menu_id = m.id and s.display_name = 'ヨンピル' and m.code in ('shave-men', 'shave-ladies');
delete from public.staff_shift_templates t using public.staff_members s where t.staff_id = s.id and s.display_name = 'ヨンピル';
delete from public.staff_day_offs d using public.staff_members s where d.staff_id = s.id and s.display_name = 'ヨンピル' and d.created_by = 'テイテイと同じ（11/11）';
delete from public.staff_shifts d using public.staff_members s where d.staff_id = s.id and s.display_name = 'ヨンピル' and d.created_by = 'テイテイと同じ（11/11）';
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
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json));
end;
$function$;
commit;
