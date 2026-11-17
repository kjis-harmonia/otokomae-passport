-- テイテイ刈りをアプリで予約できるように（11/18 慶一郎さん「テイテイ刈り予約できんぞ？」「90分で」）
--   10/6 にお店の会計だけのメニューとして作ったまま、予約できる設定がオフ・施術時間なし・担当なしだった。
--   ガチャの景品（テイテイ刈り 1,000円引き）もアプリの予約で使えなかった。担当はテイテイさんだけ
insert into public.staff_menu_capabilities (staff_id, menu_id)
select s.id, m.id
from public.staff_members s
cross join public.service_menus m
where s.display_name = 'テイテイ' and s.is_active and m.code = 'store-teitei-gari'
  and not exists (select 1 from public.staff_menu_capabilities c where c.staff_id = s.id and c.menu_id = m.id);

update public.service_menus
set duration_min = 90, booking_enabled = true, updated_at = now()
where code = 'store-teitei-gari';
