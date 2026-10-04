-- GINJIRO POS Phase 0 / P0-4: Server-side Pricing / Quote Engine Preflight Tests
-- (begin … rollback。テストデータは残さない)
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_staff text := 'preflight-pos-pricing-staff-0123456789abcdef';
  v_staff_mem uuid;
  v_stylist uuid;
  v_op_res jsonb;
  v_op_token text;

  v_customer_id uuid;
  v_client_id uuid;
  v_user_id text := 'preflight-pricing-user';

  v_service_code text := 'p04-service-cut';
  v_service_from_code text := 'p04-service-perm';
  v_product_id uuid;

  v_res_id uuid;
  v_ticket_1 uuid;
  v_ticket_2 uuid;

  v_quote jsonb;
  v_sale jsonb;
  v_sale2 jsonb;
  v_sale_conflict jsonb;
  v_qhash text;

  v_r jsonb;
  v_account_id uuid;
  v_presence_raw text;
  v_scan_res jsonb;
  v_scan_id uuid;
begin
  -- ── 0. セットアップ ──────────────────────────────────────────────────────────
  -- スタッフ端末セッション
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '2 hours');

  -- スタッフメンバー (スタイリスト & オペレーター)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P04_スタイリスト', true, true, 201) returning id into v_stylist;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P04_オペレーター', true, true, 202) returning id into v_staff_mem;

  -- オペレーター資格情報 (PIN: '1234')
  perform app_private.set_staff_operator_credentials(v_staff_mem, '1234', 'staff');
  v_op_res := public.staff_operator_verify(v_staff, v_staff_mem, '1234')::jsonb;
  if v_op_res ? 'error' then raise exception 'operator verify failed: %', v_op_res; end if;
  v_op_token := v_op_res->>'operator_token';

  -- 顧客の作成
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_id, 'P04価格テスト顧客', '4444', 'P04-PRICE', app_private.norm_name('P04価格テスト顧客'))
  returning id into v_customer_id;
  v_client_id := app_private.member_client(v_customer_id);

  -- サービスマスターの準備 (通常メニュー: 5,000円、price_from メニュー: 10,000円〜)
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_service_code, 'P04テストカット', 5000, true, true, false, 60);

  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_service_from_code, 'P04テストパーマ（〜円）', 10000, true, true, true, 120);

  -- 店販商品の準備 (商品マスター: 2,500円)
  insert into public.products (name, price, is_active, category, current_stock)
  values ('P04テストワックス', 2500, true, '店販', 10)
  returning id into v_product_id;

  -- ── 1. Check 1 & Check 12: 予約 snapshot 価格の維持 (マスター変更後も維持) ──
  -- 予約を作成 (メニュー価格 snapshot: 5,000円)
  insert into public.reservations (client_id, staff_id, starts_at, ends_at, occupied_until, customer_name, status, source)
  values (v_client_id, v_stylist, now() + interval '1 hour', now() + interval '2 hours', now() + interval '2 hours', 'P04価格テスト顧客', 'confirmed', 'staff')
  returning id into v_res_id;

  insert into public.reservation_items (reservation_id, menu_code, name, duration_min, price, sort_order)
  values (v_res_id, v_service_code, 'P04テストカット', 60, 5000, 1);

  -- マスター価格を 5,000円 -> 6,000円 に変更
  update public.service_menus set price = 6000 where code = v_service_code;

  -- 予約の quote を取得: snapshot 価格 5,000円 が採用されていること
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'reservation_id', v_res_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', v_service_code))
  ))::jsonb;

  if (v_quote->>'total')::int <> 5000 then
    raise exception 'Check 1/12 failed: reservation snapshot price not used (expected 5000, got %)', v_quote;
  end if;
  if v_quote->'items'->0->>'price_source' <> 'reservation_snapshot' then
    raise exception 'Check 1/12 failed: price_source not reservation_snapshot: %', v_quote;
  end if;

  -- ── 2. Check 2 & Check 13: Walk-in / 追加施術で service master 価格が使われる ─
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;

  -- 変更後のマスター価格 6,000円 が使われること
  if (v_quote->>'total')::int <> 6000 then
    raise exception 'Check 2/13 failed: service master price not used (expected 6000, got %)', v_quote;
  end if;
  if v_quote->'items'->0->>'price_source' <> 'service_master' then
    raise exception 'Check 2/13 failed: price_source not service_master: %', v_quote;
  end if;

  -- ── 3. Check 3: product master price が使われる ───────────────────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'product', 'ref_id', v_product_id::text))
  ))::jsonb;

  if (v_quote->>'total')::int <> 2500 then
    raise exception 'Check 3 failed: product price not used (expected 2500, got %)', v_quote;
  end if;
  if v_quote->'items'->0->>'price_source' <> 'product_master' then
    raise exception 'Check 3 failed: price_source not product_master: %', v_quote;
  end if;

  -- ── 4. Check 4: frontend から price=1円 等を送っても無視される ────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'unit_price', 1),
      jsonb_build_object('source', 'product', 'ref_id', v_product_id::text, 'unit_price', 1)
    )
  ))::jsonb;

  -- 6000 + 2500 = 8500
  if (v_quote->>'total')::int <> 8500 then
    raise exception 'Check 4 failed: frontend price=1 was accepted (expected 8500, got %)', v_quote;
  end if;

  -- ── 5. Check 5: frontend total 改ざんは total_mismatch で拒否される ─────────
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 1,
    'idempotency_key', 'p04-tamper-total-1'
  ), 'staff', 'P04_オペレーター');

  if v_sale->>'error' <> 'total_mismatch' then
    raise exception 'Check 5 failed: frontend total tampering was not rejected with total_mismatch: %', v_sale;
  end if;

  -- ── 6. Check 6: frontend line discount 改ざんは採用されない ───────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'discount', 5900)
    )
  ))::jsonb;

  -- discount_total が 0 であること
  if (v_quote->>'discount_total')::int <> 0 or (v_quote->>'total')::int <> 6000 then
    raise exception 'Check 6 failed: frontend line discount was accepted: %', v_quote;
  end if;

  -- ── 7. Check 7: quote と finalize で同じ pricing engine が使われる ─────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 2),
      jsonb_build_object('source', 'product', 'ref_id', v_product_id::text, 'quantity', 1)
    )
  ))::jsonb;
  -- 6000*2 + 2500 = 14500
  if (v_quote->>'total')::int <> 14500 or v_quote->>'quote_hash' is null then
    raise exception 'Check 7 failed: quote calculation error: %', v_quote;
  end if;
  v_qhash := v_quote->>'quote_hash';

  -- quote_hash を付けて確定
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'operator_token', v_op_token,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 2),
      jsonb_build_object('source', 'product', 'ref_id', v_product_id::text, 'quantity', 1)
    ),
    'payment_method', 'cash',
    'expected_total', 14500,
    'quote_hash', v_qhash,
    'idempotency_key', 'p04-sale-check-7'
  ), 'staff', 'P04_オペレーター');

  if v_sale ? 'error' or (v_sale->>'total')::int <> 14500 then
    raise exception 'Check 7 failed: finalize with quote_hash failed: %', v_sale;
  end if;
  if v_sale->>'quote_hash' <> v_qhash then
    raise exception 'Check 7 failed: stored quote_hash mismatch: %', v_sale;
  end if;

  -- ── 8. Check 8: quote 後に master price が変わったら quote_mismatch ───────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  v_qhash := v_quote->>'quote_hash';

  -- マスター価格を変更 (6,000 -> 6,500)
  update public.service_menus set price = 6500 where code = v_service_code;

  -- 古い quote_hash で確定しようとする -> quote_mismatch
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'operator_token', v_op_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 6000,
    'quote_hash', v_qhash,
    'idempotency_key', 'p04-stale-quote-master'
  ), 'staff', 'P04_オペレーター');

  if v_sale->>'error' <> 'quote_mismatch' then
    raise exception 'Check 8 failed: stale master quote not rejected with quote_mismatch: %', v_sale;
  end if;

  -- 元に戻す (6,500 -> 6,000)
  update public.service_menus set price = 6000 where code = v_service_code;

  -- ── 9. Check 9: quote 後に ticket 状態が変わったら quote_mismatch ──────────
  -- クーポン発行 (300円引)
  insert into public.tickets (user_id, type, title, amount, used, issued_by)
  values (v_user_id, 'discount', 'P04テスト割引券', 300, false, 'system')
  returning id into v_ticket_1;

  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_1)
  ))::jsonb;
  -- 6000 - 300 = 5700
  if (v_quote->>'total')::int <> 5700 then
    raise exception 'Check 9 setup failed: quote total != 5700: %', v_quote;
  end if;
  v_qhash := v_quote->>'quote_hash';

  -- チケットを使用済みに変える (他の端末や顧客が消費)
  update public.tickets set used = true where id = v_ticket_1;

  -- 古い quote_hash で確定しようとする -> quote_mismatch または invalid_tickets
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'operator_token', v_op_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_1),
    'payment_method', 'cash',
    'expected_total', 5700,
    'quote_hash', v_qhash,
    'idempotency_key', 'p04-stale-quote-ticket'
  ), 'staff', 'P04_オペレーター');

  if v_sale->>'error' not in ('quote_mismatch', 'invalid_tickets') then
    raise exception 'Check 9 failed: stale ticket quote not rejected: %', v_sale;
  end if;

  -- ── 10. Check 10 & Check 11: Idempotency 修正 (同一request / 異なるrequest) ──
  -- 初回会計確定
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 6000,
    'idempotency_key', 'p04-idem-test-key'
  ), 'staff', 'P04_オペレーター');
  if v_sale ? 'error' then raise exception 'Check 10 setup failed: %', v_sale; end if;

  -- Check 10: 同じキー＋同じリクエストの再送 -> 既存 sale を返す (idempotent: true)
  v_sale2 := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 6000,
    'idempotency_key', 'p04-idem-test-key'
  ), 'staff', 'P04_オペレーター');

  if (v_sale2->>'idempotent')::boolean is not true or v_sale2->>'id' <> v_sale->>'id' then
    raise exception 'Check 10 failed: idempotency replay did not return same sale: %', v_sale2;
  end if;

  -- Check 11: 同じキー＋異なるリクエスト (品目や金額が違う) -> idempotency_conflict
  v_sale_conflict := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'product', 'ref_id', v_product_id::text)),
    'payment_method', 'cash',
    'expected_total', 2500,
    'idempotency_key', 'p04-idem-test-key'
  ), 'staff', 'P04_オペレーター');

  if v_sale_conflict->>'error' <> 'idempotency_conflict' then
    raise exception 'Check 11 failed: different request with same idempotency_key did not return idempotency_conflict: %', v_sale_conflict;
  end if;

  -- 元の会計が変更されていないことを確認
  if (select total from public.accounting_sessions where id = (v_sale->>'id')::uuid) <> 6000 then
    raise exception 'Check 11 failed: existing completed sale was modified!';
  end if;

  -- ── 14. Check 14: price_from 基準価格未満の拒否 ─────────────────────────────
  -- v_service_from_code の基準価格は 10,000円。8,000円を指定した場合は below_base_price
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu',
      'ref_id', v_service_from_code,
      'price_override', jsonb_build_object('price', 8000, 'reason', '割引希望')
    ))
  ))::jsonb;

  if v_quote->>'error' <> 'below_base_price' or (v_quote->>'base_price')::int <> 10000 then
    raise exception 'Check 14 failed: price_from below base price not rejected with below_base_price: %', v_quote;
  end if;

  -- 基準価格以上 (12,000円) で理由ありの場合は成功すること
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu',
      'ref_id', v_service_from_code,
      'price_override', jsonb_build_object('price', 12000, 'reason', '特殊巻き追加')
    ))
  ))::jsonb;

  if (v_quote->>'total')::int <> 12000 then
    raise exception 'Check 14 failed: valid price_from custom price rejected: %', v_quote;
  end if;

  -- ── 15. Check 15: manual item / price override contract 確認 ────────────────
  -- 理由なしの price_override は reason_required
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu',
      'ref_id', v_service_code,
      'price_override', jsonb_build_object('price', 7000, 'reason', '')
    ))
  ))::jsonb;
  if v_quote->>'error' <> 'reason_required' then
    raise exception 'Check 15 failed: override without reason not rejected: %', v_quote;
  end if;

  -- operator 未ログイン (L0) での price_override は operator_required_for_override
  v_quote := public.staff_pos_quote(v_staff, null, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu',
      'ref_id', v_service_code,
      'price_override', jsonb_build_object('price', 7000, 'reason', '特別対応')
    ))
  ))::jsonb;
  if v_quote->>'error' <> 'operator_required_for_override' then
    raise exception 'Check 15 failed: L0 override not rejected: %', v_quote;
  end if;

  -- 手入力商品 (manual item) で operator あり・理由ありは計算可能
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'manual',
      'name', '手入力特殊トリートメント',
      'category', 'menu',
      'unit_price', 4000,
      'reason', '裏メニュー対応'
    ))
  ))::jsonb;
  if (v_quote->>'total')::int <> 4000 or v_quote->'items'->0->>'price_source' <> 'manual_item' then
    raise exception 'Check 15 failed: manual item contract failed: %', v_quote;
  end if;

  -- ── 16. Check 16: チケットルール regression ─────────────────────────────────
  -- 異なる種類のチケット併用拒否 (mixed_types)
  insert into public.tickets (user_id, type, title, amount, used, issued_by)
  values (v_user_id, 'coupon', 'P04テストメンテナンス券', 500, false, 'system')
  returning id into v_ticket_2;

  insert into public.tickets (user_id, type, title, amount, used, issued_by)
  values (v_user_id, 'discount', 'P04テスト割引券2', 300, false, 'system')
  returning id into v_ticket_1;

  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_1, v_ticket_2)
  ))::jsonb;

  if v_quote->>'error' <> 'mixed_types' then
    raise exception 'Check 16 failed: mixed ticket types not rejected: %', v_quote;
  end if;

  -- ── 17. Check 17: GINPay P0-1 regression ───────────────────────────────────
  -- 口座開設 & チャージ
  v_r := public.staff_ginpay_charge_store(v_staff, v_client_id, 10000, 'cash', 'P04テストチャージ', null, 'p04-test-charge')::jsonb;
  if v_r ? 'error' then raise exception 'Check 17 setup charge failed: %', v_r; end if;
  v_account_id := (v_r->>'account_id')::uuid;

  -- GINPay 払いでの quote & finalize
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  v_qhash := v_quote->>'quote_hash';

  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'ginpay',
    'ginpay_account_id', v_account_id,
    'expected_total', 6000,
    'operator_token', v_op_token,
    'quote_hash', v_qhash,
    'idempotency_key', 'p04-sale-ginpay-1'
  ), 'staff', 'P04_オペレーター');

  if v_sale ? 'error' then raise exception 'Check 17 failed: GINPay sale failed: %', v_sale; end if;
  if (select balance_cached from public.ginpay_accounts where id = v_account_id) <> 4000 then
    raise exception 'Check 17 failed: GINPay balance after payment != 4000';
  end if;

  -- ── 18. Check 18: Customer Presence P0-2 regression ────────────────────────
  -- お客様提示トークン発行 & スキャン
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex('p04-cust-session-0123456789abcdef0123'), v_user_id, 'register');

  v_presence_raw := (public.customer_issue_presence_token('p04-cust-session-0123456789abcdef0123')->>'token');
  v_scan_res := public.staff_resolve_presence_token(v_staff, v_presence_raw)::jsonb;
  if v_scan_res ? 'error' then raise exception 'Check 18 failed: presence token scan failed: %', v_scan_res; end if;
  v_scan_id := (v_scan_res->>'scan_session_id')::uuid;

  -- scan_session を quote に渡して顧客が特定されること
  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;

  if (v_quote->'facts'->>'client_id')::uuid <> v_client_id then
    raise exception 'Check 18 failed: scan_session did not resolve client_id in quote: %', v_quote;
  end if;

  -- ── 19. Check 19: Operator P0-3 regression ─────────────────────────────────
  -- 不正な operator_token は拒否されること
  v_quote := public.staff_pos_quote(v_staff, 'OPS1.invalidtoken000000000000000000000000000000', null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;

  if v_quote->>'error' <> 'invalid_operator_session' then
    raise exception 'Check 19 failed: invalid operator token not rejected: %', v_quote;
  end if;

end;
$$;
rollback;
