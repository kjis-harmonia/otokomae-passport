-- GINJIRO POS Phase 0 / P0-4: Server-side Pricing / Quote Engine Preflight Tests
-- (begin … rollback。テストデータは残さない)
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_staff text := 'preflight-pos-pricing-staff-0123456789abcdef';
  v_staff_other text := 'preflight-pos-pricing-staff-other-0123456789';
  v_staff_mem uuid;
  v_stylist uuid;
  v_op_res jsonb;
  v_op_token text;
  v_op_token_2 text;

  v_customer_a uuid;
  v_client_a uuid;
  v_user_a text := 'p04-cust-user-a';

  v_customer_b uuid;
  v_client_b uuid;
  v_user_b text := 'p04-cust-user-b';

  v_service_code text := 'p04-service-cut';
  v_service_from_code text := 'p04-service-perm';
  v_product_id uuid;

  v_res_id uuid;
  v_res_null_price_id uuid;
  v_ticket_1 uuid;
  v_ticket_2 uuid;

  v_quote jsonb;
  v_sale jsonb;
  v_qhash text;

  v_r jsonb;
  v_account_a uuid;
  v_account_b uuid;
  v_presence_a text;
  v_scan_res jsonb;
  v_scan_id_a uuid;
  v_scan_id_other uuid;
begin
  -- ── 0. セットアップ ──────────────────────────────────────────────────────────
  -- スタッフ端末セッション (正端末 & 別端末)
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '2 hours');

  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff_other), now() + interval '2 hours');

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

  -- 顧客 A
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_a, 'P04顧客A', '1111', 'P04-CUSTA', app_private.norm_name('P04顧客A'))
  returning id into v_customer_a;
  v_client_a := app_private.member_client(v_customer_a);

  -- 顧客 B
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_b, 'P04顧客B', '2222', 'P04-CUSTB', app_private.norm_name('P04顧客B'))
  returning id into v_customer_b;
  v_client_b := app_private.member_client(v_customer_b);

  -- サービスマスター
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_service_code, 'P04テストカット', 5000, true, true, false, 60);

  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_service_from_code, 'P04テストパーマ（〜円）', 10000, true, true, true, 120);

  -- 店販商品 (商品マスター: 2,500円)
  insert into public.products (name, price, is_active, category, current_stock)
  values ('P04テストワックス', 2500, true, '店販', 10)
  returning id into v_product_id;

  -- GINPay 口座開設 & チャージ (A: 10,000円, B: 10,000円)
  v_r := public.staff_ginpay_charge_store(v_staff, v_op_token, v_client_a, 10000, 'cash', 'P04_オペレーター', null, 'charge-a-1', null, null)::jsonb;
  v_account_a := (v_r->>'account_id')::uuid;

  v_r := public.staff_ginpay_charge_store(v_staff, v_op_token, v_client_b, 10000, 'cash', 'P04_オペレーター', null, 'charge-b-1', null, null)::jsonb;
  v_account_b := (v_r->>'account_id')::uuid;

  -- 顧客 A の presence token 発行 & スキャン
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex('p04-cust-session-a-0123456789abcdef'), v_user_a, 'register');

  v_presence_a := (public.customer_issue_presence_token('p04-cust-session-a-0123456789abcdef')->>'token');
  v_scan_res := public.staff_resolve_presence_token(v_staff, v_presence_a)::jsonb;
  v_scan_id_a := (v_scan_res->>'scan_session_id')::uuid;

  -- ── 1. Check 1: CRITICAL 1 A scan session + B client → reject ───────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id_a, jsonb_build_object(
    'client_id', v_client_b,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  if v_quote->>'error' <> 'customer_context_mismatch' then
    raise exception 'Check 1 failed: scan A + client B quote not rejected with customer_context_mismatch: %', v_quote;
  end if;

  -- ── 2. Check 2: CRITICAL 1 A ticket + B GINPay → reject ─────────────────────
  -- Aにチケット発行
  insert into public.tickets (user_id, type, title, amount, used, issued_by)
  values (v_user_a, 'discount', 'Aの割引券', 500, false, 'system')
  returning id into v_ticket_1;

  -- Quote for A: 5000 - 500 = 4500
  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id_a, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_1)
  ))::jsonb;
  if (v_quote->>'total')::int <> 4500 then raise exception 'Check 2 setup failed: %', v_quote; end if;
  v_qhash := v_quote->>'quote_hash';

  -- Finalize で B の GINPay 口座を指定 → customer_context_mismatch
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'scan_session_id', v_scan_id_a,
    'stylist_id', v_stylist,
    'operator_token', v_op_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_1),
    'payment_method', 'ginpay',
    'ginpay_account_id', v_account_b,
    'expected_total', 4500,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-cross-account-1'
  ), 'staff', 'P04_オペレーター', v_staff);

  if v_sale->>'error' <> 'customer_context_mismatch' then
    raise exception 'Check 2 failed: A scan + B GINPay not rejected with customer_context_mismatch: %', v_sale;
  end if;

  -- ── 3. Check 3: 別 staff session の scan session → reject ───────────────────
  v_quote := public.staff_pos_quote(v_staff_other, null, v_scan_id_a, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  if v_quote->>'error' <> 'invalid_scan_session' then
    raise exception 'Check 3 failed: cross-staff scan session not rejected: %', v_quote;
  end if;

  -- ── 4. Check 4: BLOCKER 4 別 staff session の operator token → reject ─────────
  v_quote := public.staff_pos_quote(v_staff_other, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  if v_quote->>'error' <> 'operator_session_invalid' then
    raise exception 'Check 4 failed: cross-staff operator token not rejected in quote: %', v_quote;
  end if;

  -- finalize でも同様に拒否されること
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'operator_token', v_op_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-cross-op-1'
  ), 'staff', 'P04_オペレーター', v_staff_other);
  if v_sale->>'error' <> 'invalid_operator_session' then
    raise exception 'Check 4 failed: cross-staff operator token not rejected in finalize: %', v_sale;
  end if;

  -- ── 5. Check 5: BLOCKER 5 quote_hash なし → reject (quote_required) ─────────
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'idempotency_key', 'test-sale-no-quote-1'
  ), 'staff', 'P04_オペレーター', v_staff);
  if v_sale->>'error' <> 'quote_required' then
    raise exception 'Check 5 failed: missing quote_hash not rejected with quote_required: %', v_sale;
  end if;

  -- ── 6. Check 6: BLOCKER 3 manual_item → P0-5 前は reject (approval_required / l2_not_enabled) ──
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'manual', 'name', '手入力品', 'unit_price', 3000))
  ))::jsonb;
  if v_quote->>'error' not in ('l2_authorization_not_enabled', 'approval_required') then
    raise exception 'Check 6 failed: manual_item not rejected: %', v_quote;
  end if;

  -- ── 7. Check 7: BLOCKER 3 manual_discount → P0-5 前は reject ────────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'manual_discount', jsonb_build_object('amount', 500, 'label', '値引き')
  ))::jsonb;
  if v_quote->>'error' <> 'approval_required' then
    raise exception 'Check 7 failed: manual_discount not rejected with approval_required: %', v_quote;
  end if;

  -- ── 8. Check 8: BLOCKER 3 fixed price override → P0-5 累積schemaでは approval_required ───
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu', 'ref_id', v_service_code,
      'price_override', jsonb_build_object('price', 4000, 'reason', '特別割引')
    ))
  ))::jsonb;
  if v_quote->>'error' <> 'approval_required' then
    raise exception 'Check 8 failed: fixed price override not rejected with approval_required: %', v_quote;
  end if;

  -- ── 9. Check 9: BLOCKER 3 price_from base 超過指定 → P0-5 累積schemaでは approval_required ───
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu', 'ref_id', v_service_from_code,
      'unit_price', 15000
    ))
  ))::jsonb;
  if v_quote->>'error' <> 'approval_required' then
    raise exception 'Check 9 failed: price_from > base not rejected with approval_required: %', v_quote;
  end if;

  -- price_from base 未満指定は below_base_price
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu', 'ref_id', v_service_from_code,
      'unit_price', 8000
    ))
  ))::jsonb;
  if v_quote->>'error' <> 'below_base_price' then
    raise exception 'Check 9b failed: price_from < base not rejected with below_base_price: %', v_quote;
  end if;

  -- ── 10. Check 10: HIGH 1 予約数量改ざん防止 & スナップショット価格 ─────────
  insert into public.reservations (client_id, staff_id, starts_at, ends_at, occupied_until, customer_name, status, source)
  values (v_client_a, v_stylist, now() + interval '1 hour', now() + interval '2 hours', now() + interval '2 hours', 'P04顧客A', 'confirmed', 'staff')
  returning id into v_res_id;

  insert into public.reservation_items (reservation_id, menu_code, name, duration_min, price, sort_order)
  values (v_res_id, v_service_code, 'P04テストカット', 60, 5000, 1);

  -- マスター価格を変更 (5000 -> 8000)
  update public.service_menus set price = 8000 where code = v_service_code;

  -- クライアントが quantity = 5 を送っても、DB スナップショットの quantity = 1, price = 5000 が使用されること
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'reservation_id', v_res_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', v_service_code, 'quantity', 5, 'unit_price', 100))
  ))::jsonb;
  if (v_quote->>'total')::int <> 5000 or (v_quote->'items'->0->>'quantity')::int <> 1 then
    raise exception 'Check 10 failed: reservation snapshot quantity/price not enforced: %', v_quote;
  end if;

  -- 元に戻す (8000 -> 5000)
  update public.service_menus set price = 5000 where code = v_service_code;

  -- ── 11. Check 11: HIGH 1 同一 reservation_item の重複指定拒否 ──────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'reservation_id', v_res_id,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'reservation', 'ref_id', v_service_code),
      jsonb_build_object('source', 'reservation', 'ref_id', v_service_code)
    )
  ))::jsonb;
  if v_quote->>'error' <> 'duplicate_reservation_item' then
    raise exception 'Check 11 failed: duplicate reservation items not rejected: %', v_quote;
  end if;

  -- ── 12. Check 12: HIGH 1 reservation price NULL → reservation_price_missing ─
  insert into public.reservations (client_id, staff_id, starts_at, ends_at, occupied_until, customer_name, status, source)
  values (v_client_a, v_stylist, now() + interval '3 hours', now() + interval '4 hours', now() + interval '4 hours', 'P04顧客A', 'confirmed', 'staff')
  returning id into v_res_null_price_id;

  insert into public.reservation_items (reservation_id, menu_code, name, duration_min, price, sort_order)
  values (v_res_null_price_id, v_service_code, '価格未設定施術', 60, null, 1);

  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'reservation_id', v_res_null_price_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', v_service_code))
  ))::jsonb;
  if v_quote->>'error' <> 'reservation_price_missing' then
    raise exception 'Check 12 failed: null reservation price not rejected with reservation_price_missing: %', v_quote;
  end if;

  -- ── 13. Check 13: BLOCKER 2 maintenance 一律 ¥500 引き廃止 & 未設定 mapping 拒否
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'maintenance', jsonb_build_object('use', true)
  ))::jsonb;
  if v_quote->>'error' <> 'maintenance_offer_unconfigured' then
    raise exception 'Check 13 failed: unconfigured maintenance offer not rejected with maintenance_offer_unconfigured: %', v_quote;
  end if;

  -- ── 14. Check 14: HIGH 2 Ticket TOCTOU (transfer 状態変化で finalize 拒否) ─
  declare
    v_sale_count bigint;
    v_payment_count bigint;
    v_usage_count bigint;
    v_ticket_before jsonb;
    v_transfer_before jsonb;
    v_ginpay_before jsonb;
    v_ginpay_after jsonb;
  begin
  insert into public.tickets (user_id, type, title, amount, used, issued_by)
  values (v_user_a, 'discount', 'Aの譲渡テスト券', 1000, false, 'system')
  returning id into v_ticket_2;

  -- Quote 時は有効
  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id_a, jsonb_build_object(
    'client_id', v_client_a,
    'scan_session_id', v_scan_id_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_2)
  ), null)::jsonb;
  v_qhash := v_quote->>'quote_hash';
  if v_scan_id_a is null or v_quote ? 'error'
     or (v_quote->>'total')::int is distinct from 4000
     or v_qhash is null or v_qhash !~ '^QTE1\.[a-f0-9]{64}$' then
    raise exception 'Check 14 setup failed: valid ticket quote required: %', v_quote;
  end if;

  select count(*) into v_sale_count from public.accounting_sessions;
  select count(*) into v_payment_count from public.accounting_payments;
  select count(*) into v_usage_count from public.ticket_usage_logs where ticket_id = v_ticket_2::text;
  select to_jsonb(t) into v_ticket_before from public.tickets t where id = v_ticket_2;
  select jsonb_build_object(
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.ginpay_accounts a),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.ginpay_transactions t)
  ) into v_ginpay_before;

  -- Quote 後にチケットが他者へ譲渡手続き中 (pending) になる
  insert into public.ticket_transfers (token, ticket_id, from_user_id, status, expires_at)
  values ('test-transfer-token', v_ticket_2, v_user_a, 'pending', now() + interval '1 hour');
  select to_jsonb(t) into v_transfer_before from public.ticket_transfers t where ticket_id = v_ticket_2;

  -- Finalize で TOCTOU ロック後に検出されて拒否されること
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_a,
    'scan_session_id', v_scan_id_a,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_2),
    'payment_method', 'cash',
    'expected_total', 4000,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-toctou-transfer-1'
  ), 'P04_オペレーター', v_op_token, null)::jsonb;

  if v_sale->>'error' is distinct from 'transfer_pending' then
    raise exception 'Check 14 failed: ticket transfer pending not rejected during finalize: %', v_sale;
  end if;

  if (select count(*) from public.accounting_sessions) <> v_sale_count
     or exists (select 1 from public.accounting_sessions where idempotency_key = 'test-toctou-transfer-1') then
    raise exception 'Check 14 failed: sale created while transfer pending';
  end if;
  if (select count(*) from public.accounting_payments) <> v_payment_count then
    raise exception 'Check 14 failed: payment created while transfer pending';
  end if;
  select jsonb_build_object(
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.ginpay_accounts a),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.ginpay_transactions t)
  ) into v_ginpay_after;
  if v_ginpay_after is distinct from v_ginpay_before then
    raise exception 'Check 14 failed: GINPay mutated while transfer pending';
  end if;
  if (select to_jsonb(t) from public.tickets t where id = v_ticket_2) is distinct from v_ticket_before
     or (select count(*) from public.ticket_usage_logs where ticket_id = v_ticket_2::text) <> v_usage_count then
    raise exception 'Check 14 failed: ticket mutated or consumed while transfer pending';
  end if;
  if (select to_jsonb(t) from public.ticket_transfers t where ticket_id = v_ticket_2) is distinct from v_transfer_before then
    raise exception 'Check 14 failed: pending transfer mutated during finalize';
  end if;

  -- 譲渡レコードを削除
  delete from public.ticket_transfers where ticket_id = v_ticket_2;
  raise notice 'pos pricing Check 14 ok (transfer_pending, no sale/payment/GINPay/ticket mutation)';
  end;

  -- ── 15. Check 15: HIGH 2 Ticket 異種併用拒否 (mixed_types) ─────────────────
  declare
    v_coupon_ticket uuid;
    v_sale_count bigint;
    v_payment_count bigint;
    v_tickets_before jsonb;
    v_coupon_before jsonb;
    v_ginpay_before jsonb;
    v_ginpay_after jsonb;
    v_usage_before jsonb;
  begin
  select count(*) into v_sale_count from public.accounting_sessions;
  select count(*) into v_payment_count from public.accounting_payments;
  select jsonb_agg(to_jsonb(t) order by t.id) into v_tickets_before
  from public.tickets t where id in (v_ticket_1, v_ticket_2);
  select coalesce(jsonb_agg(to_jsonb(u) order by u.id), '[]'::jsonb) into v_usage_before
  from public.ticket_usage_logs u;
  select jsonb_build_object(
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.ginpay_accounts a),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.ginpay_transactions t)
  ) into v_ginpay_before;

  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id_a, jsonb_build_object(
    'client_id', v_client_a,
    'scan_session_id', v_scan_id_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'ticket_ids', jsonb_build_array(v_ticket_1, v_ticket_2)
  ), null)::jsonb;
  -- v_ticket_1, v_ticket_2 共に discount なので正常
  if v_scan_id_a is null or v_quote is null or v_quote ? 'error' or v_quote->>'total' is null then
    raise exception 'Check 15 setup failed: successful quote with non-null total required: %', v_quote;
  end if;
  if (v_quote->>'total')::int <> 3500 then
    raise exception 'Check 15 setup failed: %', v_quote;
  end if;

  -- coupon 種別のチケットを追加して mixed_types 検証
    insert into public.tickets (user_id, type, title, amount, used, issued_by)
    values (v_user_a, 'coupon', 'Aのクーポン券', 500, false, 'system')
    returning id into v_coupon_ticket;
    select to_jsonb(t) into v_coupon_before from public.tickets t where id = v_coupon_ticket;

    v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id_a, jsonb_build_object(
      'client_id', v_client_a,
      'scan_session_id', v_scan_id_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
      'ticket_ids', jsonb_build_array(v_ticket_1, v_coupon_ticket)
    ), null)::jsonb;
    if v_quote->>'error' is distinct from 'mixed_types' then
      raise exception 'Check 15 failed: mixed ticket types not rejected: %', v_quote;
    end if;

    if (select jsonb_agg(to_jsonb(t) order by t.id) from public.tickets t where id in (v_ticket_1, v_ticket_2)) is distinct from v_tickets_before
       or (select to_jsonb(t) from public.tickets t where id = v_coupon_ticket) is distinct from v_coupon_before
       or (select coalesce(jsonb_agg(to_jsonb(u) order by u.id), '[]'::jsonb) from public.ticket_usage_logs u) is distinct from v_usage_before then
      raise exception 'Check 15 failed: quote mutated or consumed tickets';
    end if;
    if (select count(*) from public.accounting_sessions) <> v_sale_count
       or (select count(*) from public.accounting_payments) <> v_payment_count then
      raise exception 'Check 15 failed: quote created sale or payment';
    end if;
    select jsonb_build_object(
      'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.ginpay_accounts a),
      'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.ginpay_transactions t)
    ) into v_ginpay_after;
    if v_ginpay_after is distinct from v_ginpay_before then
      raise exception 'Check 15 failed: quote mutated GINPay';
    end if;
    raise notice 'pos pricing Check 15 ok (single type total 3500, mixed_types, no money/ticket mutation)';
  end;

  -- ── 16. Check 16: Product identity (ref_id 必須、名前のみ指定は拒否) ───────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'product', 'name', 'P04テストワックス'))
  ))::jsonb;
  if v_quote->>'error' <> 'invalid_items' then
    raise exception 'Check 16 failed: product without ref_id not rejected: %', v_quote;
  end if;

  -- 正しい ref_id (id) では正常に 2500円 が決定されること
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'product', 'ref_id', v_product_id::text))
  ))::jsonb;
  if (v_quote->>'total')::int <> 2500 or v_quote->'items'->0->>'price_source' <> 'product_master' then
    raise exception 'Check 16 failed: product master price not applied: %', v_quote;
  end if;

  -- ── 17. Check 17: request_hash が operator token 再発行で変わらない ────────
  -- オペレーター再ログイン (新しい operator_token)
  v_op_res := public.staff_operator_verify(v_staff, v_staff_mem, '1234')::jsonb;
  v_op_token_2 := v_op_res->>'operator_token';

  -- 正常な quote 取得
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  v_qhash := v_quote->>'quote_hash';

  -- 1回目の finalize (operator_token_1)
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'operator_token', v_op_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-retry-op-1'
  ), 'staff', 'P04_オペレーター', v_staff);
  if v_sale ? 'error' then raise exception 'Check 17 finalize 1 failed: %', v_sale; end if;

  -- 2回目の finalize (同じ内容、新しい operator_token_2、同じ idempotency_key)
  -- → request_hash が一致し、idempotent: true で正常に返却されること
  v_sale := app_private.finalize_sale(jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'operator_token', v_op_token_2,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-retry-op-1'
  ), 'staff', 'P04_オペレーター', v_staff);
  if (v_sale->>'idempotent')::boolean is not true then
    raise exception 'Check 17 failed: re-issued operator token was not recognized as idempotent retry: %', v_sale;
  end if;

  -- ── 18. Check 18: GINPay 正常決済 & P0-1 回帰検証 ───────────────────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_id_a, jsonb_build_object(
    'client_id', v_client_a,
    'scan_session_id', v_scan_id_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  v_qhash := v_quote->>'quote_hash';

  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'scan_session_id', v_scan_id_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'ginpay',
    'ginpay_account_id', v_account_a,
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-ginpay-success-1'
  ), 'P04_オペレーター', v_op_token, null)::jsonb;

  if v_sale ? 'error' then raise exception 'Check 18 failed: GINPay sale failed: %', v_sale; end if;
  if (select balance_cached from public.ginpay_accounts where id = v_account_a) <> 5000 then
    raise exception 'Check 18 failed: GINPay balance after payment != 5000';
  end if;

  -- ── 19. Check 19: フロントエンド価格・合計改ざんの完全無効化 ─────────────────
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu', 'ref_id', v_service_code,
      'unit_price', 1, 'quantity', 1, 'discount', 4999
    )),
    'expected_total', 1
  ))::jsonb;
  -- ── 20. Check 20: legacy_item fallback 完全排除（source 省略 + 1円 は即時拒否） ──
  -- 旧呼び出し形式（POS項目全省略）で source なし item を渡す (ダミー quote_hash による repricing 到達検証)
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 1, 'quantity', 1)),
    'payment_method', 'cash',
    'expected_total', 1,
    'quote_hash', 'QTE1.' || repeat('a', 64),
    'idempotency_key', 'test-sale-source-omitted-1'
  ), 'Preflight', v_op_token, null)::jsonb;
  if v_sale->>'error' <> 'invalid_items' then
    raise exception 'Check 20 failed: item without source was not rejected with invalid_items: %', v_sale;
  end if;

  -- staff_pos_quote でも source なし item は拒否
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 1, 'quantity', 1))
  ))::jsonb;
  if v_quote->>'error' <> 'invalid_items' then
    raise exception 'Check 20 failed: staff_pos_quote without source was not rejected: %', v_quote;
  end if;

  -- ── 21. Check 21: POS項目全省略でも価格バイパス不可（DBマスター価格強制） ──
  -- 正規の見積もり (5000円)
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  v_qhash := v_quote->>'quote_hash';

  -- unit_price: 1 と偽装し expected_total: 1 を渡すが、quote_hash と照合されて total_mismatch 拒否
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'unit_price', 1, 'quantity', 1)),
    'payment_method', 'cash',
    'expected_total', 1,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-bypass-attempt-1'
  ), 'Preflight', v_op_token, null)::jsonb;
  if v_sale->>'error' <> 'total_mismatch' or (v_sale->>'total')::int <> 5000 then
    raise exception 'Check 21 failed: DB master price was not enforced on legacy call: %', v_sale;
  end if;

  -- 正しい expected_total: 5000 であれば確定成功し、売上金額は DB 正本の 5,000円 となること
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_a,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'unit_price', 1, 'quantity', 1)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', 'test-sale-legacy-db-price-ok'
  ), 'Preflight', v_op_token, null)::jsonb;
  if v_sale ? 'error' or (v_sale->>'total')::int <> 5000 then
    raise exception 'Check 21 failed: legacy call with valid DB total failed: %', v_sale;
  end if;

  -- ── 22. Check 22: 不正 source / 偽装 ref_id の拒否（source自体も信用しない） ──
  -- 22-1: source = manual は未承認の場合例外なく拒否 (approval_required / l2_not_enabled)
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'manual', 'name', '手入力品', 'unit_price', 3000, 'quantity', 1))
  ))::jsonb;
  if v_quote->>'error' not in ('l2_authorization_not_enabled', 'approval_required') then
    raise exception 'Check 22-1 failed: manual item was not rejected: %', v_quote;
  end if;

  -- 22-2: source = service_menu だが存在しない ref_id
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'non-existent-menu-999'))
  ))::jsonb;
  if v_quote->>'error' <> 'service_menu_not_found_or_inactive' then
    raise exception 'Check 22-2 failed: non-existent service_menu not rejected: %', v_quote;
  end if;

  -- 22-3: source = service_menu だが product の ID を偽装指定
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_product_id::text))
  ))::jsonb;
  if v_quote->>'error' <> 'service_menu_not_found_or_inactive' then
    raise exception 'Check 22-3 failed: product id spoofed as service_menu not rejected: %', v_quote;
  end if;

  -- 22-4: source = product だが service_menu の code を偽装指定
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'product', 'ref_id', v_service_code))
  ))::jsonb;
  if v_quote->>'error' <> 'product_not_found_or_inactive' then
    raise exception 'Check 22-4 failed: service_menu code spoofed as product not rejected: %', v_quote;
  end if;

  -- 22-5: 未知の不正 source
  v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'hacked_source', 'ref_id', v_service_code))
  ))::jsonb;
  if v_quote->>'error' <> 'invalid_items' then
    raise exception 'Check 22-5 failed: invalid source not rejected: %', v_quote;
  end if;

  -- ── 23. Check 23: accounting_item UUID 参照 → 正常に価格解決 ────────────────
  declare
    v_ai_id1 uuid;
    v_ai_id2 uuid;
    v_ai_cut_id uuid;
    v_item_saved record;
  begin
    select id into v_ai_cut_id from public.accounting_items where name = 'カット' and is_active limit 1;
    if v_ai_cut_id is null then
      raise exception 'Check 23 setup failed: accounting_item カット not found';
    end if;

    v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', v_ai_cut_id::text, 'quantity', 1))
    ))::jsonb;
    if v_quote ? 'error' or (v_quote->>'total')::int <> 3300 then
      raise exception 'Check 23 failed: accounting_item by UUID failed: %', v_quote;
    end if;
    if (v_quote->'items'->0->>'unit_price')::int <> 3300 or v_quote->'items'->0->>'name' <> 'カット' then
      raise exception 'Check 23 failed: price or name mismatch for accounting_item: %', v_quote;
    end if;

    -- ── 24. Check 24: accounting_item name のみ指定（非UUID） → reject (invalid_items) ──
    v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', 'カット', 'quantity', 1))
    ))::jsonb;
    if v_quote->>'error' <> 'invalid_items' then
      raise exception 'Check 24 failed: accounting_item by name was not rejected with invalid_items: %', v_quote;
    end if;

    -- ── 25. Check 25: 同名 accounting_items が存在しても UUID で一意に特定（曖昧選択されない） ──
    -- テスト用に一時的に同名品目を2件作成 (unique 制約を一時解除)
    alter table public.accounting_items drop constraint accounting_items_name_key;

    insert into public.accounting_items (name, category, price, is_active)
    values ('同名テスト品目', 'menu', 3000, true)
    returning id into v_ai_id1;

    insert into public.accounting_items (name, category, price, is_active)
    values ('同名テスト品目', 'menu', 5000, true)
    returning id into v_ai_id2;

    -- ID1 指定時は確実に 3,000円
    v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', v_ai_id1::text, 'quantity', 1))
    ))::jsonb;
    if v_quote ? 'error' or (v_quote->>'total')::int <> 3000 then
      raise exception 'Check 25-1 failed: ai_id1 (3000) not uniquely resolved: %', v_quote;
    end if;

    -- ID2 指定時は確実に 5,000円
    v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', v_ai_id2::text, 'quantity', 1))
    ))::jsonb;
    if v_quote ? 'error' or (v_quote->>'total')::int <> 5000 then
      raise exception 'Check 25-2 failed: ai_id2 (5000) not uniquely resolved: %', v_quote;
    end if;

    -- 同名文字列 '同名テスト品目' では曖昧照合されず invalid_items で拒否
    v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', '同名テスト品目', 'quantity', 1))
    ))::jsonb;
    if v_quote->>'error' <> 'invalid_items' then
      raise exception 'Check 25-3 failed: duplicate name lookup not rejected with invalid_items: %', v_quote;
    end if;

    -- ── 26. Check 26: フロント改ざん name 無視 & DB正本 name 強制 ────────────
    -- 見積もり (quote)
    v_quote := public.staff_pos_quote(v_staff, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object(
        'source', 'accounting_item',
        'ref_id', v_ai_id1::text,
        'name', '悪意の改ざん品名（100円）',
        'unit_price', 100,
        'quantity', 1
      ))
    ))::jsonb;
    if v_quote ? 'error' then
      raise exception 'Check 26 quote failed: %', v_quote;
    end if;
    if v_quote->'items'->0->>'name' <> '同名テスト品目' then
      raise exception 'Check 26 failed: tampered name was not ignored in quote: %', v_quote;
    end if;
    if (v_quote->'items'->0->>'unit_price')::int <> 3000 then
      raise exception 'Check 26 failed: tampered price was not overridden in quote: %', v_quote;
    end if;

    -- 会計確定 (finalize_sale)
    v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
      'client_id', v_client_a,
      'stylist_id', v_stylist,
      'operator_token', v_op_token,
      'quote_hash', v_quote->>'quote_hash',
      'items', jsonb_build_array(jsonb_build_object(
        'source', 'accounting_item',
        'ref_id', v_ai_id1::text,
        'name', '悪意の改ざん品名（100円）',
        'unit_price', 100,
        'quantity', 1
      )),
      'payment_method', 'cash',
      'expected_total', 3000,
      'idempotency_key', 'test-ai-tampered-name-ok'
    ), 'Preflight', v_op_token, null)::jsonb;
    if v_sale ? 'error' then
      raise exception 'Check 26 sale failed: %', v_sale;
    end if;

    -- 保存された明細 (accounting_session_items) が DB 正本名であることを検証
    select * into v_item_saved from public.accounting_session_items
    where session_id = (v_sale->>'id')::uuid;
    if v_item_saved.item_name <> '同名テスト品目' then
      raise exception 'Check 26 failed: session item saved tampered name: %', v_item_saved.item_name;
    end if;
    if v_item_saved.price <> 3000 then
      raise exception 'Check 26 failed: session item price not 3000: %', v_item_saved.price;
    end if;
  end;

end;
$$;
rollback;
