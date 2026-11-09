-- 基本料金を HOT PEPPER 掲載にそろえる（11/9 慶一郎さん）
--   濡れパン・カールアイパー・パンチパーマ・アイパー 9,000 → 8,000、ギンパラカーリー 16,000 → 15,000。スキンフェードは別に＋1,000円
--   今の 9,000 / 16,000 は、10/19 の「通常／会員」の2段料金のうち、10/26 に会員料金をやめたときに残った「通常料金」の名残（スキンフェード込みではない）
--   ニグロ 9,000・ツイスト 12,000 は HOT PEPPER と同じなので変えない
--   今の値が想定どおりのときだけ変える（本部の画面などで先に変わっていたら触らない）
update public.service_menus set price = 8000, updated_at = now()
  where code in ('perm-nurepan', 'perm-curl-iper', 'perm-punch', 'perm-iper') and price = 9000 and normal_price is null;
update public.service_menus set price = 15000, updated_at = now()
  where code = 'perm-ginpara-curly' and price = 16000 and normal_price is null;

-- クールシャンプー（300円）は HOT PEPPER の通常メニューに無い（夏限定クーポンの中身だった）→ 使わない（11/9 慶一郎さん「なし」）
--   消さずに止める：過去の会計の明細から名前をたどれるように
update public.service_menus set is_active = false, booking_enabled = false, checkout_enabled = false, updated_at = now()
  where code = 'opt-cool-shampoo';

-- スキンフェードの追加（＋1,000円）：お会計でスタッフが足すオプション。アプリの予約には出さない（時間は理容師の確認待ち）
--   二重請求の防止：パーマ・アイパー系のメニューの料金にはスキンフェードを含めない（上で 8,000 / 15,000 にそろえた）
insert into public.service_menus (code, name, duration_min, price, kind, category, is_active, checkout_enabled, booking_enabled, sort_order)
values ('opt-skin-fade', 'スキンフェード追加', null, 1000, 'option', 'オプション', true, true, false, 670)
on conflict (code) do nothing;
