-- 10本目（20261109120000_hpb_base_prices）を戻すとき
begin;
update public.service_menus set price = 9000, updated_at = now() where code in ('perm-nurepan','perm-curl-iper','perm-punch','perm-iper') and price = 8000;
update public.service_menus set price = 16000, updated_at = now() where code = 'perm-ginpara-curly' and price = 15000;
update public.service_menus set normal_price = 4500, updated_at = now() where code = 'special-ginjiro' and normal_price = 5000;
update public.service_menus set is_active = true, booking_enabled = true, checkout_enabled = true, updated_at = now() where code = 'opt-cool-shampoo';
-- スキンフェード追加は、会計で使われていなければ止めるだけ（消さない）
update public.service_menus set is_active = false, checkout_enabled = false, updated_at = now() where code = 'opt-skin-fade';
commit;
