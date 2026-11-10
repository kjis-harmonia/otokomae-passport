-- メンテナンスカットの対象メニュー（11/7 慶一郎さん）：単品 4,000円から・大人のカットかパーマが入っているもの。金額で自動にせず、メニューごとに持つ
--   対象外：小学生・子供スキンフェード・丸刈り・前髪・顔そり・レディースシェービング・カラーだけ・オプション
--   使う所：登録した直後の「いつもの」の聞き取りで「メンテナンスカットもご希望ですか？」を聞くかどうか
alter table public.service_menus add column if not exists maintenance_eligible boolean not null default false;
update public.service_menus set maintenance_eligible = code in (
  'cut-regular', 'cut-skin-fade', 'cut-skin-fade-plus', 'store-teitei-gari',
  'perm-nurepan', 'perm-curl-iper', 'perm-punch', 'perm-iper', 'perm-spain', 'perm-curly', 'perm-normal', 'perm-negro', 'perm-afro', 'perm-twist', 'perm-ginpara-curly', 'perm-apache',
  'set-cut-color', 'set-fade-color', 'set-punch-color', 'set-punch-gray', 'set-iper-gray', 'set-twist-mesh', 'set-twist-double-mesh', 'set-spain-mesh', 'set-spain-double-mesh'
);

create or replace function public.customer_booking_options(p_session text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
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
