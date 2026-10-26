-- メンテナンスカットを Johnny（アプリ）で予約できるメニューにする
-- ・メニュー「メンテナンスカット」（code: maintenance）30分・3,000円（銀二郎・テイテイ同じ）。来店の記録で使っている code と同じ
-- ・担当できるのは 銀二郎・テイテイ
-- ・表の形は変えない（行を足すだけ）。旧App会員メニューの 銀二郎メンテナンス／テイテイメンテナンス（使っていない行）はそのまま
-- ・14日以内のお客様だけに出すのはアプリ側
begin;
do $$
declare v_menu uuid; n int;
begin
  select count(*) into n from public.staff_members where display_name in ('銀二郎', 'テイテイ');
  if n <> 2 then raise exception '銀二郎・テイテイ が見つかりません（%件）', n; end if;

  insert into public.service_menus (code, name, kind, category, duration_min, buffer_after_min, price, normal_price, price_from, price_tax_included,
                                    is_active, booking_enabled, checkout_enabled, sort_order)
  values ('maintenance', 'メンテナンスカット', 'service', 'カット', 30, 0, 3000, null, false, true, true, true, true, 175)
  on conflict (code) do update set name = excluded.name, duration_min = 30, price = 3000, normal_price = null, price_from = false,
    is_active = true, booking_enabled = true, checkout_enabled = true, updated_at = now()
  returning id into v_menu;

  insert into public.staff_menu_capabilities (staff_id, menu_id)
  select s.id, v_menu from public.staff_members s where s.display_name in ('銀二郎', 'テイテイ')
  on conflict do nothing;
end $$;
commit;

select m.code, m.name, m.duration_min, m.price, m.is_active, m.booking_enabled, m.checkout_enabled,
  (select string_agg(s.display_name, '・' order by s.display_name) from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id where c.menu_id = m.id) as staff
from public.service_menus m where m.code = 'maintenance';
