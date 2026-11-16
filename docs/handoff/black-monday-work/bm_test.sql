-- Black Monday の通しの試験（Staging だけ）。最後に ROLLBACK_OK を投げて、作ったものはすべて巻き戻す
do $$
<<t>>
declare
  mon date := '2026-11-30'; tue date := '2026-12-01';
  s1 uuid; s2 uuid; s3 uuid;
  m jsonb; sess text; u text; cid uuid;
  u2 text; u3 text; u4 text; u5 text; u6 text; u7 text;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid; r8 uuid; r9 uuid; rh uuid; newid uuid;
  x jsonb; q1 jsonb; q2 jsonb; pv jsonb; tk uuid; sale jsonb; ok text := '';
  item jsonb := jsonb_build_object('source', 'reservation', 'ref_id', 'perm-punch', 'name', 'パンチパーマ', 'category', 'menu', 'unit_price', 8000, 'quantity', 1);
  function_ok boolean;
begin
  update public.booking_settings set app_booking_enabled = true, min_lead_minutes = 0 where id = 1;
  insert into public.staff_members(display_name) values ('QA BM 1') returning id into s1;
  insert into public.staff_members(display_name) values ('QA BM 2') returning id into s2;
  insert into public.staff_members(display_name) values ('QA BM 3') returning id into s3;
  insert into public.staff_shift_templates(staff_id, weekday, start_time, end_time)
    select s, d, '08:00', '21:00' from unnest(array[s1, s2, s3]) s cross join unnest(array[1, 2]) d;
  insert into public.staff_menu_capabilities(staff_id, menu_id)
    select s, mm.id from unnest(array[s1, s2, s3]) s cross join public.service_menus mm where mm.code in ('perm-punch', 'perm-pin', 'perm-curl-iper', 'perm-iper');

  -- 会員（試験ごとに別の会員。1人1件の決まりにかからないように）
  m := public.customer_register('QA BM 本人', true); sess := m->>'session'; u := m->>'user_id';
  insert into app_private.customer_store_verifications select c.id, now(), 'qa', 'qa' from public.customers c where c.user_id = u;
  u2 := public.customer_register('QA BM 二', true)->>'user_id';
  u3 := public.customer_register('QA BM 三', true)->>'user_id';
  u4 := public.customer_register('QA BM 四', true)->>'user_id';
  u5 := public.customer_register('QA BM 五', true)->>'user_id';
  u6 := public.customer_register('QA BM 六', true)->>'user_id';
  u7 := public.customer_register('QA BM 七', true)->>'user_id';

  -- 1. 見込み：祝日の月曜（11/23）も対象・日曜は対象外・カールアイパーは対象外・2メニューで 4,000
  if (app_private.black_monday_quote(app_private.jst_ts('2026-11-23', '10:00'), array['perm-punch'])->>'amount')::int is distinct from 2000 then raise exception 'FAIL 1a 祝日の月曜'; end if;
  if app_private.black_monday_quote(app_private.jst_ts('2026-11-29', '10:00'), array['perm-punch']) is not null then raise exception 'FAIL 1b 日曜'; end if;
  if app_private.black_monday_quote(app_private.jst_ts(mon, '10:00'), array['perm-curl-iper']) is not null then raise exception 'FAIL 1c 対象外メニュー'; end if;
  if (app_private.black_monday_quote(app_private.jst_ts(mon, '10:00'), array['perm-punch', 'perm-pin'])->>'amount')::int is distinct from 4000 then raise exception 'FAIL 1d 2メニュー'; end if;
  if public.menu_price_rules()->'black_monday'->>'amount' is distinct from '2000' then raise exception 'FAIL 1e 料金表'; end if;
  ok := ok || '1 見込み OK; ';

  -- 2. 月曜のアプリの予約に印が付く
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 本人', 'user_id', u, 'staff_id', s1,
         'starts_at', app_private.jst_ts(mon, '10:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 2 予約: %', x; end if;
  r1 := (x->>'id')::uuid;
  if (select amount from app_private.black_monday_marks where reservation_id = r1) is distinct from 2000 then raise exception 'FAIL 2a 印'; end if;
  if (app_private.reservation_json_customer(r1)->'black_monday'->>'amount')::int is distinct from 2000 then raise exception 'FAIL 2b お客様の予約: %', app_private.reservation_json_customer(r1); end if;
  if (app_private.sb_reservation(r1)->'black_monday'->>'amount')::int is distinct from 2000 then raise exception 'FAIL 2c SB'; end if;
  if (select (j->'black_monday'->>'amount')::int from jsonb_array_elements(public.customer_list_reservations(sess)::jsonb) j where j->>'id' = r1::text) is distinct from 2000 then raise exception 'FAIL 2d 次回予約の一覧'; end if;
  ok := ok || '2 月曜の予約に印 OK; ';

  -- 3. 店（SB・店舗端末）で火曜に変えると外れる・月曜に戻すと付く
  x := app_private.reschedule_reservation(r1, app_private.jst_ts(tue, '10:00'), s1, 'staff', 'QA');
  if x ? 'error' then raise exception 'FAIL 3 変更: %', x; end if;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r1) then raise exception 'FAIL 3a 火曜でも印'; end if;
  if app_private.reservation_json(r1)->'black_monday' <> 'null'::jsonb then raise exception 'FAIL 3b 火曜の予約に表示'; end if;
  x := app_private.reschedule_reservation(r1, app_private.jst_ts(mon, '10:00'), s1, 'staff', 'QA');
  if x ? 'error' then raise exception 'FAIL 3c 戻す: %', x; end if;
  if (select amount from app_private.black_monday_marks where reservation_id = r1) is distinct from 2000 then raise exception 'FAIL 3d 月曜に戻して印'; end if;
  -- メニューだけ変える（SB のメニューの差し替え）：対象外にすると外れ、2つにすると 4,000
  update public.reservation_items set menu_code = 'perm-curl-iper', name = 'カールアイパー' where reservation_id = r1;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r1) then raise exception 'FAIL 3e 対象外メニューで印'; end if;
  update public.reservation_items set menu_code = 'perm-punch', name = 'パンチパーマ' where reservation_id = r1;
  if not exists (select 1 from app_private.black_monday_marks where reservation_id = r1) then raise exception 'FAIL 3f 対象メニューに戻して印なし'; end if;
  ok := ok || '3 店で火曜→外れる・月曜→付く・メニュー OK; ';

  -- 4. 予約変更の確認（reservation_review）：前後の額。2回作っても同じ（確定の照合が崩れない）
  q1 := app_private.reservation_review(r1, app_private.jst_ts(tue, '12:00'), array['perm-punch']);
  q2 := app_private.reservation_review(r1, app_private.jst_ts(tue, '12:00'), array['perm-punch']);
  if q1->'impact'->'black_monday' is distinct from '{"before": 2000, "after": 0}'::jsonb then raise exception 'FAIL 4a 外れる: %', q1->'impact'; end if;
  if q1 is distinct from q2 then raise exception 'FAIL 4b 同じにならない'; end if;
  q1 := app_private.reservation_review(r1, app_private.jst_ts(mon, '12:00'), array['perm-punch', 'perm-pin']);
  if q1->'impact'->'black_monday'->>'after' is distinct from '4000' then raise exception 'FAIL 4c 2メニュー: %', q1->'impact'; end if;
  ok := ok || '4 変更の確認 OK; ';

  -- 5. アプリで変更（reservation_mutate：古い予約を取り消して新しい予約）。火曜へ→外れる、月曜へ→付く
  pv := public.customer_change_preview(sess, r1, app_private.jst_ts(tue, '12:00'), array['perm-punch'])::jsonb;
  if pv ? 'error' then raise exception 'FAIL 5 確認: %', pv; end if;
  if pv->'black_monday' is distinct from '{"before": 2000, "after": 0}'::jsonb then raise exception 'FAIL 5a 確認の表示: %', pv; end if;
  x := app_private.reservation_mutate(sess, 'change', r1, app_private.jst_ts(tue, '12:00'), array['perm-punch'], 'qa-bm-change-1', pv->'confirmation');
  if x->>'state' is distinct from 'completed' then raise exception 'FAIL 5b 変更: %', x; end if;
  newid := (x->'result'->>'id')::uuid;
  if exists (select 1 from app_private.black_monday_marks where reservation_id in (r1, newid)) then raise exception 'FAIL 5c 火曜へ変えても印'; end if;
  pv := public.customer_change_preview(sess, newid, app_private.jst_ts(mon, '14:00'), array['perm-punch'])::jsonb;
  if pv->'black_monday' is distinct from '{"before": 0, "after": 2000}'::jsonb then raise exception 'FAIL 5d 付く表示: %', pv; end if;
  x := app_private.reservation_mutate(sess, 'change', newid, app_private.jst_ts(mon, '14:00'), array['perm-punch'], 'qa-bm-change-2', pv->'confirmation');
  if x->>'state' is distinct from 'completed' then raise exception 'FAIL 5e 変更: %', x; end if;
  r2 := (x->'result'->>'id')::uuid;
  if (select amount from app_private.black_monday_marks where reservation_id = r2) is distinct from 2000 then raise exception 'FAIL 5f 月曜へ変えて印なし'; end if;
  if (x->'result'->'black_monday'->>'amount')::int is distinct from 2000 then raise exception 'FAIL 5g 変更の結果: %', x->'result'; end if;
  ok := ok || '5 アプリの変更 OK; ';

  -- 6. 取消・無断キャンセルの予約の印は効かない
  x := app_private.set_reservation_status(r2, 'cancelled', 'staff', 'QA', 'QA');
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r2) or app_private.black_monday_json(r2) is not null then raise exception 'FAIL 6a 取消で印'; end if;
  if (app_private.black_monday_checkout_json(r2)->>'eligible')::boolean then raise exception 'FAIL 6b 取消の会計'; end if;
  ok := ok || '6 取消 OK; ';

  -- 7. HOT PEPPER の予約は付かない
  x := app_private.create_reservation(jsonb_build_object('source', 'hotpepper', 'customer_name', 'QA BM HPB', 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '08:00'), 'menu_codes', array['perm-punch']), 'staff', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 7 予約: %', x; end if;
  rh := (x->>'id')::uuid;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = rh) then raise exception 'FAIL 7a HPB に印'; end if;
  ok := ok || '7 HPB OK; ';

  -- 8. 会計で ¥2,000 引く・expected_total がずれたら total_mismatch
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 二', 'user_id', u2, 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '10:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 8 予約: %', x; end if;
  r3 := (x->>'id')::uuid;
  if not (app_private.black_monday_checkout_json(r3)->>'eligible')::boolean then raise exception 'FAIL 8a 会計の情報'; end if;
  if app_private.checkout_context_json(r3, null)->'black_monday'->>'unit' is distinct from '2000' then raise exception 'FAIL 8b checkout_context_json'; end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r3, 'stylist_id', s2, 'items', jsonb_build_array(item),
            'payment_method', 'cash', 'expected_total', 8000), 'staff', 'QA');
  if sale->>'error' is distinct from 'total_mismatch' or (sale->>'total')::int <> 6000 then raise exception 'FAIL 8c 照合: %', sale; end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r3, 'stylist_id', s2, 'items', jsonb_build_array(item),
            'payment_method', 'cash', 'expected_total', 6000), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 6000 then raise exception 'FAIL 8d 会計: %', sale; end if;
  if not exists (select 1 from public.accounting_discounts where session_id = (sale->>'id')::uuid and kind = 'campaign' and label = 'Black Monday' and amount = 2000) then raise exception 'FAIL 8e 値引きの記録'; end if;
  if (select discount_total from public.accounting_sessions where id = (sale->>'id')::uuid) <> 2000 then raise exception 'FAIL 8f 値引きの合計'; end if;
  ok := ok || '8 会計 ¥2,000・照合 OK; ';

  -- 9. Welcome 券を使う会計では引かない（予約に付けたら表示も 0）
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 三', 'user_id', u3, 'staff_id', s3,
         'starts_at', app_private.jst_ts(mon, '10:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r4 := (x->>'id')::uuid;
  insert into public.tickets(user_id, type, title, amount, issued_by, used) values (u3, 'discount', 'パーマ Welcomeクーポン', 2000, 'system-welcome', false) returning id into tk;
  insert into app_private.reservation_ticket_plans(reservation_id, user_id, ticket_ids) values (r4, u3, array[tk]);
  if (app_private.black_monday_json(r4)->>'amount')::int <> 0 or not (app_private.black_monday_json(r4)->>'perm_coupon')::boolean then raise exception 'FAIL 9a 券を付けた予約の表示: %', app_private.black_monday_json(r4); end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r4, 'stylist_id', s3, 'items', jsonb_build_array(item), 'ticket_ids', jsonb_build_array(tk),
            'payment_method', 'cash', 'expected_total', 6000), 'staff', 'QA');
  if sale ? 'error' then raise exception 'FAIL 9b 会計: %', sale; end if;
  if exists (select 1 from public.accounting_discounts where session_id = (sale->>'id')::uuid and kind = 'campaign') then raise exception 'FAIL 9c Welcome と併用された'; end if;
  ok := ok || '9 Welcome は併用なし OK; ';

  -- 10. ガチャの無料券と併用：Black Monday のあと残りを無料券がまかなう（合計 0・負にならない）
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 四', 'user_id', u4, 'staff_id', s1,
         'starts_at', app_private.jst_ts(mon, '12:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r5 := (x->>'id')::uuid;
  insert into app_private.gacha_holdings(user_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes, reservation_id, self_only)
    values (u4, 'free-apachi', 'パンチパーマ無料', null, 'パンチパーマ', false, 'rare', now() + interval '60 days', array['perm-punch'], r5, false);
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r5, 'stylist_id', s1, 'items', jsonb_build_array(item), 'use_gacha', true,
            'payment_method', 'cash', 'expected_total', 0), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 0 then raise exception 'FAIL 10a 無料券と併用: %', sale; end if;
  if (select amount from public.accounting_discounts where session_id = (sale->>'id')::uuid and ticket_type = 'gacha') <> 6000 then raise exception 'FAIL 10b 無料券の額'; end if;
  -- 額の決まったガチャ券（7,000）と併用：料金を超えた分は 0 円（負にならない）
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 五', 'user_id', u5, 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '12:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r6 := (x->>'id')::uuid;
  insert into app_private.gacha_holdings(user_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes, reservation_id, self_only)
    values (u5, 'off500', '7000円引き', 7000, null, false, 'rare', now() + interval '60 days', null, r6, false);
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r6, 'stylist_id', s2, 'items', jsonb_build_array(item), 'use_gacha', true,
            'payment_method', 'cash', 'expected_total', 0), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 0 then raise exception 'FAIL 10c 額の券と併用: %', sale; end if;
  ok := ok || '10 ガチャ券と併用 OK; ';

  -- 11. 対象メニュー2つで ¥4,000
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 六', 'user_id', u6, 'staff_id', s3,
         'starts_at', app_private.jst_ts(mon, '12:00'), 'menu_codes', array['perm-punch', 'perm-pin']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 11 予約: %', x; end if;
  r7 := (x->>'id')::uuid;
  if (select amount from app_private.black_monday_marks where reservation_id = r7) <> 4000 then raise exception 'FAIL 11a 印 4,000'; end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r7, 'stylist_id', s3, 'items', jsonb_build_array(item,
              jsonb_build_object('source', 'reservation', 'ref_id', 'perm-pin', 'name', 'ピンパーマ', 'category', 'menu', 'unit_price', 12000, 'quantity', 1)),
            'payment_method', 'cash', 'expected_total', 16000), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 16000 then raise exception 'FAIL 11b 2メニューの会計: %', sale; end if;
  ok := ok || '11 2メニューで ¥4,000 OK; ';

  -- 12. 予約のない会計では引かない
  select app_private.client_root(client_id) into cid from public.reservations where id = r7;
  sale := app_private.finalize_sale(jsonb_build_object('client_id', cid, 'stylist_id', s3,
            'items', jsonb_build_array(item || jsonb_build_object('source', 'service_menu')), 'payment_method', 'cash', 'expected_total', 8000), 'staff', 'QA');
  if sale ? 'error' then raise exception 'FAIL 12 予約なし: %', sale; end if;
  ok := ok || '12 予約なしは通常 OK; ';

  -- 13. 銀オクの無料券（Staging だけ）と併用：Black Monday のあと残り 6,000 を無料券
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 七', 'user_id', u7, 'staff_id', s1,
         'starts_at', app_private.jst_ts(mon, '15:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r8 := (x->>'id')::uuid;
  insert into public.tickets(user_id, type, title, amount, issued_by, used) values (u7, 'discount', 'パンチパーマ無料券', 0, 'ginoku', false) returning id into tk;
  insert into app_private.ticket_free_menus(ticket_id, free_menu, menu_codes) values (tk, 'パンチパーマ', array['perm-punch']);
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r8, 'stylist_id', s1, 'items', jsonb_build_array(item), 'ticket_ids', jsonb_build_array(tk),
            'payment_method', 'cash', 'expected_total', 0), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 0 then raise exception 'FAIL 13a 銀オクの無料券: %', sale; end if;
  if (select amount from public.accounting_discounts where session_id = (sale->>'id')::uuid and ticket_id = tk) <> 6000 then raise exception 'FAIL 13b 無料券の額'; end if;
  ok := ok || '13 銀オクの無料券と併用 OK; ';

  -- 14. 設定を変える（開始日を先に）と、まだの予約の印が外れ、戻すと付く
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 本人', 'user_id', u, 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '17:00'), 'menu_codes', array['perm-iper', 'perm-punch']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 14 予約: %', x; end if;
  r9 := (x->>'id')::uuid;
  update app_private.black_monday_settings set starts_on = '2027-01-01' where id = 1;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r9) then raise exception 'FAIL 14a 開始日の前で印'; end if;
  update app_private.black_monday_settings set starts_on = '2026-11-02' where id = 1;
  if not exists (select 1 from app_private.black_monday_marks where reservation_id = r9) then raise exception 'FAIL 14b 戻して印なし'; end if;
  ok := ok || '14 設定の変更 OK; ';

  raise exception 'ROLLBACK_OK %', ok;
end $$;
