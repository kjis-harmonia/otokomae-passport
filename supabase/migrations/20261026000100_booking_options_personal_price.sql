-- 予約できるメニューの一覧（アプリの JOHNNY と AI の JOHNNY が読む）の料金を、そのお客様の「いつもの」料金にする（10/26）
--   20261026000000_client_menu_prices の続き。AI の JOHNNY が声で言う料金もその人の料金になる（関数のデプロイは要らない）
--   払ったことのないメニューは今までどおりのメニューの料金。それ以外の中身は 20261006000000_service_master と同じ

create or replace function public.customer_booking_options(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_client uuid := app_private.user_client(app_private.session_user_id(p_session));
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  return json_build_object(
    'settings', (select json_build_object('slot_minutes', slot_minutes, 'booking_window_days', booking_window_days,
                   'min_lead_minutes', min_lead_minutes, 'hold_minutes', hold_minutes) from public.booking_settings where id = 1),
    'menus', coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'duration_min', m.duration_min,
                         'price', coalesce(p.price, m.price), 'normal_price', case when p.price is null then m.normal_price end,
                         'price_from', m.price_from and p.price is null) order by m.sort_order)
                       from public.service_menus m
                       cross join lateral (select app_private.client_menu_price(v_client, m.code) as price) p
                       where m.is_active and m.booking_enabled and m.duration_min is not null
                         and exists (select 1 from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id
                                     where c.menu_id = m.id and s.is_active and s.is_bookable)), '[]'::json),
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json));
end;
$$;
