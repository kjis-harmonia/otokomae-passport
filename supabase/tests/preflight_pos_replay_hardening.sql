-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Phase B-1 Replay Hardening Functional Tests
-- (preflight_pos_replay_hardening.sql)
--
-- Tests:
-- 1. Full refund success -> same refundKey retry -> idempotent:true -> 1 refund row
-- 2. same refundKey + different amount -> idempotency_conflict
-- 3. same refundKey + different target transaction -> idempotency_conflict
-- 4. ticket-used sale success -> ticket used -> same saleKey retry -> idempotent:true -> no extra usage
-- 5. same saleKey + altered business intent (expected_total, stylist, payment_method, ginpay_account) -> idempotency_conflict
-- 6. anonymous cash + missing/empty key -> idempotency_key_required
-- 7. direct client / reservation + empty key -> idempotency_key_required
-- 8. invalid operator + empty key -> operator_auth_required / operator_session_invalid (auth precedence)
-- 9. B4 approval rollback on record transaction failure via transactional stub -> APR1 unconsumed & reusable
--
-- Safe for clean and baseline databases (all inside a single transaction, ends with rollback).
-- ============================================================================

begin;

do $$
declare
  v_staff text := 'preflight-replay-hardening-staff';
  v_op_id uuid;
  v_mgr_id uuid;
  v_op_tok text;
  v_client_id uuid;
  v_client_id2 uuid;
  v_account_id uuid;
  v_account_id2 uuid;
  v_client_id3 uuid;
  v_account_id3 uuid;
  v_refund_id uuid;
  v_user_id text := 'u-replay-hardening-cust';
  v_cust_id uuid;
  v_tx_id uuid;
  v_tx_id2 uuid;
  v_res json;
  v_res_b jsonb;
  v_app_tok text;
  v_req_hash text;
  v_facts jsonb;
  v_ticket_id uuid;
  v_presence_tok text;
  v_scan_res jsonb;
  v_scan_id uuid;
  v_menu_code text := 'p05-menu-replay-test';
  v_qres json;
  v_qhash text;
  v_sale_res json;
  v_sale_id uuid;
  v_payload jsonb;
  v_other_ticket uuid;
  v_reservation uuid;
  v_scan_id2 uuid;
  v_qhash2 text;
  v_c int;
begin
  -- ── Setup: 端末セッション & スタッフ & 操作者 & 管理者 ───────────────────
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Replay Hardening Operator', true, true, 891) returning id into v_op_id;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Replay Hardening Manager', false, true, 892) returning id into v_mgr_id;

  perform app_private.set_staff_operator_credentials(v_op_id, '1111', 'staff');
  perform app_private.set_staff_operator_credentials(v_mgr_id, '2222', 'manager');

  v_op_tok := (public.staff_operator_verify(v_staff, v_op_id, '1111')->>'operator_token');

  -- 顧客・GINPay口座準備 (会員 & チケット用)
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_id, 'Replay Hardening Client', '1111', 'REPLAY-A', app_private.norm_name('Replay Hardening Client'))
  returning id into v_cust_id;
  v_client_id := app_private.member_client(v_cust_id);
  v_account_id := app_private.ginpay_open_account(v_client_id, 'staff', 'Tester', true);

  v_client_id2 := app_private.create_client('Replay Hardening Client 2', 'staff', 'staff', 'Tester');
  v_account_id2 := app_private.ginpay_open_account(v_client_id2, 'staff', 'Tester', true);

  -- 初回チャージ 10,000円
  v_res := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client_id, 10000, 'cash', 'Tester', 'seed charge', 'seed-charge-key-1', null, null);
  if v_res->>'error' is not null then raise exception 'seed charge failed: %', v_res; end if;
  v_tx_id := (v_res->>'id')::uuid;

  v_res := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client_id, 10000, 'cash', 'Tester', 'seed charge 2', 'seed-charge-key-2', null, null);
  if v_res->>'error' is not null then raise exception 'seed charge 2 failed: %', v_res; end if;
  v_tx_id2 := (v_res->>'id')::uuid;

  -- ── Test 1: Full Refund 成功 -> same refundKey retry -> idempotent:true -> 1 row ──
  -- L2 承認取得 (10,000円全額返金)
  v_facts := jsonb_build_object(
    'action', 'refund',
    'account_id', v_account_id,
    'client_id', v_client_id,
    'target_transaction_id', v_tx_id,
    'refundable_amount', 10000,
    'requested_refund_amount', 10000,
    'reason', 'customer requested full refund',
    'operator_staff_id', v_op_id
  );
  v_req_hash := app_private.pos_auth_hash('refund', v_facts);
  v_res_b := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'refund', v_req_hash)::jsonb;
  v_app_tok := v_res_b->>'approval_token';

  -- 初回返金実行
  v_res := public.staff_ginpay_refund(v_staff, v_op_tok, v_tx_id, 10000, 'Tester', 'customer requested full refund', 'refund-idem-key-1', v_app_tok);
  if v_res->>'error' is not null then raise exception 'Test 1 initial refund failed: %', v_res; end if;
  if (v_res->>'idempotent')::boolean is true then raise exception 'Test 1 initial refund must not be idempotent'; end if;
  v_refund_id := (v_res->>'id')::uuid;
  if v_refund_id is null then raise exception 'Test 1 initial refund id missing'; end if;

  -- 同一キーで再送 (同一ペイロード)
  v_res := public.staff_ginpay_refund(v_staff, v_op_tok, v_tx_id, 10000, 'Tester', 'customer requested full refund', 'refund-idem-key-1', v_app_tok);
  if v_res->>'error' is not null then raise exception 'Test 1 retry failed: %', v_res; end if;
  if (v_res->>'idempotent')::boolean is not true then raise exception 'Test 1 retry must be idempotent:true'; end if;
  if (v_res->>'id')::uuid is distinct from v_refund_id then raise exception 'Test 1 replay refund id differs'; end if;

  -- 行数が厳密に1件であることを確認
  select count(*) into v_c from public.ginpay_transactions where idempotency_key = 'refund-idem-key-1';
  if v_c <> 1 then raise exception 'Test 1 refund row count % <> 1', v_c; end if;

  -- ── Test 2: same refundKey + different amount -> idempotency_conflict ─────
  v_res := public.staff_ginpay_refund(v_staff, v_op_tok, v_tx_id, 5000, 'Tester', 'customer requested full refund', 'refund-idem-key-1', v_app_tok);
  if v_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'Test 2 expected idempotency_conflict, got: %', v_res; end if;

  -- ── Test 3: same refundKey + different target transaction -> idempotency_conflict ──
  v_res := public.staff_ginpay_refund(v_staff, v_op_tok, v_tx_id2, 10000, 'Tester', 'customer requested full refund', 'refund-idem-key-1', v_app_tok);
  if v_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'Test 3 expected idempotency_conflict, got: %', v_res; end if;

  -- ── Test 4: ticket利用sale成功 -> ticket used -> same saleKey retry -> idempotent:true ──
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_menu_code, 'Replay Test Cut', 5000, true, true, false, 60);

  insert into public.tickets (id, user_id, title, type, amount, used, issued_by, expires_at)
  values (gen_random_uuid(), v_user_id, 'Replay Discount Ticket', 'discount', 1000, false, 'system', now() + interval '30 days')
  returning id into v_ticket_id;

  -- 顧客の presence token 発行 & スキャン
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex('replay-cust-session-0123456789abcdef'), v_user_id, 'register');

  v_presence_tok := (public.customer_issue_presence_token('replay-cust-session-0123456789abcdef')->>'token');
  v_scan_res := public.staff_resolve_presence_token(v_staff, v_presence_tok)::jsonb;
  if v_scan_res ? 'error' then raise exception 'Test 4 scan resolve failed: %', v_scan_res; end if;
  v_scan_id := (v_scan_res->>'scan_session_id')::uuid;

  v_qres := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text)
  ));
  if v_qres->>'error' is not null then raise exception 'Test 4 quote failed: %', v_qres; end if;
  v_qhash := v_qres->>'quote_hash';

  v_presence_tok := public.customer_issue_presence_token('replay-cust-session-0123456789abcdef')->>'token';
  v_scan_res := public.staff_resolve_presence_token(v_staff, v_presence_tok)::jsonb;
  v_scan_id2 := (v_scan_res->>'scan_session_id')::uuid;
  if v_scan_res ? 'error' or v_scan_id2 is null then raise exception 'second trusted scan failed: %', v_scan_res; end if;
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id2, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text)), null);
  if v_qres->>'error' is not null or v_qres->>'quote_hash' is null then raise exception 'rescan quote failed: %', v_qres; end if;
  v_qhash2 := v_qres->>'quote_hash';

  -- 初回確定
  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'scan_session_id', v_scan_id,
    'client_id', v_client_id,
    'stylist_id', v_op_id,
    'operator_token', v_op_tok,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text),
    'payment_method', 'cash',
    'expected_total', 4000,
    'quote_hash', v_qhash,
    'idempotency_key', 'sale-ticket-replay-key-1'
  ), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null then raise exception 'Test 4 initial sale failed: %', v_sale_res; end if;
  if (v_sale_res->>'idempotent')::boolean is true then raise exception 'Test 4 initial sale must not be idempotent'; end if;
  v_sale_id := (v_sale_res->>'id')::uuid;
  if v_sale_id is null then raise exception 'Test 4 initial sale id missing'; end if;

  -- チケットが used = true になっていることを確認
  if not exists (select 1 from public.tickets where id = v_ticket_id and used = true) then
    raise exception 'Test 4 ticket was not marked used';
  end if;

  -- 再送 (同一キー・同一意図) -> ticket used による pos_price 再実行で弾かれず idempotent:true を返すこと
  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'scan_session_id', v_scan_id,
    'client_id', v_client_id,
    'stylist_id', v_op_id,
    'operator_token', v_op_tok,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text),
    'payment_method', 'cash',
    'expected_total', 4000,
    'quote_hash', v_qhash,
    'idempotency_key', 'sale-ticket-replay-key-1'
  ), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null then raise exception 'Test 4 retry failed: %', v_sale_res; end if;
  if (v_sale_res->>'idempotent')::boolean is not true then raise exception 'Test 4 retry must be idempotent:true'; end if;
  if (v_sale_res->>'id')::uuid is distinct from v_sale_id then raise exception 'Test 4 retry returned different session id'; end if;

  -- ticket_usage_logs が厳密に1件のみ記録されていること
  select count(*) into v_c from public.ticket_usage_logs where ticket_id = v_ticket_id::text;
  if v_c <> 1 then raise exception 'Test 4 ticket usage count % <> 1', v_c; end if;

  v_payload := jsonb_build_object('scan_session_id', v_scan_id2, 'client_id', v_client_id,
    'stylist_id', v_op_id, 'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text), 'payment_method', 'cash', 'expected_total', 4000,
    'quote_hash', v_qhash2, 'idempotency_key', 'sale-ticket-replay-key-1');
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload, 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null or (v_sale_res->>'idempotent')::boolean is distinct from true
     or (v_sale_res->>'id')::uuid is distinct from v_sale_id then raise exception 'new scan replay failed: %', v_sale_res; end if;

  -- Exact original tickets ignore current owner/used/scan state.
  update public.tickets set user_id = 'foreign-after-completion' where id = v_ticket_id;
  update app_private.pos_scan_sessions set closed_at = now() where id = v_scan_id2;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload, 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null or (v_sale_res->>'idempotent')::boolean is distinct from true then
    raise exception 'exact replay consulted mutable ticket/scan state: %', v_sale_res;
  end if;
  update public.tickets set user_id = v_user_id where id = v_ticket_id;

  v_sale_res := public.staff_finalize_sale(v_staff, v_payload - 'client_id', 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'direct client missing accepted: %', v_sale_res; end if;

  insert into public.tickets (user_id, title, type, amount, used, issued_by)
  values ('foreign-ticket-owner', 'Foreign', 'discount', 1000, false, 'system') returning id into v_other_ticket;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('ticket_ids', jsonb_build_array(v_other_ticket)), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'customer_context_mismatch'
     or v_sale_res->>'detail' is distinct from 'ticket_not_owned_by_customer' then raise exception 'foreign ticket precedence failed: %', v_sale_res; end if;
  insert into public.tickets (user_id, title, type, amount, used, issued_by)
  values (v_user_id, 'Own alternative', 'discount', 1000, false, 'system') returning id into v_other_ticket;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('ticket_ids', jsonb_build_array(v_other_ticket)), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'own changed ticket accepted: %', v_sale_res; end if;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('items', jsonb_build_array(
    jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code, 'quantity', 2))), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'changed items accepted: %', v_sale_res; end if;

  -- ── Test 5: same saleKey + altered business intent -> idempotency_conflict ──
  -- 5a: expected_total 変更
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('expected_total', 9999), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'Test 5a expected idempotency_conflict, got: %', v_sale_res; end if;

  -- 5b: stylist_id 変更
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('stylist_id', v_mgr_id), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'Test 5b expected idempotency_conflict, got: %', v_sale_res; end if;

  -- 5c: payment_method 変更
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('payment_method', 'qr'), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'Test 5c expected idempotency_conflict, got: %', v_sale_res; end if;

  -- GINPay account changes retain the foreign-account security error.
  v_payload := jsonb_build_object('scan_session_id', v_scan_id, 'client_id', v_client_id, 'stylist_id', v_op_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'payment_method', 'ginpay', 'ginpay_account_id', v_account_id, 'expected_total', 5000,
    'idempotency_key', 'b1-ginpay-sale');
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, v_payload, null);
  if v_qres->>'error' is not null or v_qres->>'quote_hash' is null then raise exception 'GINPay quote failed: %', v_qres; end if;
  v_payload := v_payload || jsonb_build_object('quote_hash', v_qres->>'quote_hash');
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload, 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null or v_sale_res->>'status' is distinct from 'completed' then raise exception 'GINPay sale failed: %', v_sale_res; end if;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('ginpay_account_id', v_account_id2), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'customer_context_mismatch' then raise exception 'GINPay account precedence failed: %', v_sale_res; end if;

  -- A merged client's account stays separate but belongs to the same canonical family.
  v_client_id3 := app_private.create_client('Replay Hardening Same Family', 'staff', 'staff', 'Tester');
  v_account_id3 := app_private.ginpay_open_account(v_client_id3, 'staff', 'Tester', true);
  v_res_b := app_private.merge_clients(v_client_id, v_client_id3, 'staff', 'Tester');
  if v_res_b ? 'error' or not (v_account_id3 = any(app_private.ginpay_family_accounts(v_client_id))) then
    raise exception 'second family account fixture failed: %', v_res_b;
  end if;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('ginpay_account_id', v_account_id3), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'same-family account identity failed: %', v_sale_res; end if;

  -- Anonymous input identity is discarded consistently on initial call and replay.
  v_payload := jsonb_build_object('client_id', v_client_id, 'stylist_id', v_op_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'payment_method', 'cash', 'expected_total', 5000, 'idempotency_key', 'b1-anonymous');
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, null, v_payload, null);
  if v_qres->>'error' is not null or v_qres->>'quote_hash' is null then raise exception 'anonymous quote failed: %', v_qres; end if;
  v_payload := v_payload || jsonb_build_object('quote_hash', v_qres->>'quote_hash');
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload, 'Tester', v_op_tok, null);
  v_sale_id := (v_sale_res->>'id')::uuid;
  if v_sale_res->>'error' is not null or v_sale_id is null or not exists (
    select 1 from public.accounting_sessions where id = v_sale_id and client_id is null) then raise exception 'anonymous identity persisted: %', v_sale_res; end if;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object('client_id', v_client_id2), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null or (v_sale_res->>'idempotent')::boolean is distinct from true
     or (v_sale_res->>'id')::uuid is distinct from v_sale_id then raise exception 'anonymous normalization replay failed: %', v_sale_res; end if;

  -- Manual discount identity consists only of its amount, not its label.
  v_payload := (v_payload - 'quote_hash') || jsonb_build_object('expected_total', 4500,
    'idempotency_key', 'b1-manual', 'manual_discount', jsonb_build_object('amount', 500, 'label', 'loyalty'));
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, null, v_payload, null);
  if v_qres->>'error' is distinct from 'approval_required' or v_qres->>'request_hash' is null then raise exception 'manual approval entry failed: %', v_qres; end if;
  v_res_b := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'checkout_pricing_override', v_qres->>'request_hash')::jsonb;
  v_app_tok := v_res_b->>'approval_token';
  if v_res_b ? 'error' or v_app_tok is null then raise exception 'manual approval failed: %', v_res_b; end if;
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, null, v_payload, v_app_tok);
  if v_qres->>'error' is not null or v_qres->>'quote_hash' is null then raise exception 'approved manual quote failed: %', v_qres; end if;
  v_payload := v_payload || jsonb_build_object('quote_hash', v_qres->>'quote_hash');
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload, 'Tester', v_op_tok, v_app_tok);
  v_sale_id := (v_sale_res->>'id')::uuid;
  if v_sale_res->>'error' is not null or v_sale_id is null then raise exception 'manual sale failed: %', v_sale_res; end if;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object(
    'manual_discount', jsonb_build_object('amount', 500, 'label', 'apology')), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is not null or (v_sale_res->>'idempotent')::boolean is distinct from true
     or (v_sale_res->>'id')::uuid is distinct from v_sale_id then raise exception 'label incorrectly bound to identity: %', v_sale_res; end if;
  v_sale_res := public.staff_finalize_sale(v_staff, v_payload || jsonb_build_object(
    'manual_discount', jsonb_build_object('amount', 600, 'label', 'loyalty')), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'changed manual amount accepted: %', v_sale_res; end if;
  raise notice 'Manual identity: same amount/different label replay PASS; different amount conflict PASS';

  -- ── Test 6: anonymous cash + missing/empty key -> idempotency_key_required ──
  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'stylist_id', v_op_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', ''
  ), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_key_required' then raise exception 'Test 6 expected idempotency_key_required, got: %', v_sale_res; end if;

  -- ── Test 7: direct client / reservation + empty key -> idempotency_key_required ──
  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_op_id,
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', '   '
  ), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_key_required' then raise exception 'Test 7 expected idempotency_key_required, got: %', v_sale_res; end if;

  insert into public.reservations (client_id, staff_id, starts_at, ends_at, occupied_until, customer_name, status, source)
  values (v_client_id, v_op_id, now() + interval '5 days', now() + interval '5 days 1 hour',
    now() + interval '5 days 1 hour', 'Replay reservation', 'confirmed', 'staff') returning id into v_reservation;
  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object('reservation_id', v_reservation,
    'idempotency_key', null), 'Tester', v_op_tok, null);
  if v_sale_res->>'error' is distinct from 'idempotency_key_required' then raise exception 'reservation missing key accepted: %', v_sale_res; end if;

  -- ── Test 8: invalid operator + empty key -> auth error が優先 ────────────
  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_op_id,
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', ''
  ), 'Tester', 'invalid-op-token-xyz', null);
  if v_sale_res->>'error' is distinct from 'operator_session_invalid' then raise exception 'Test 8 expected operator_session_invalid, got: %', v_sale_res; end if;

  v_sale_res := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_op_id,
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', ''
  ), 'Tester', null, null);
  if v_sale_res->>'error' is distinct from 'operator_auth_required' then raise exception 'Test 8b expected operator_auth_required, got: %', v_sale_res; end if;

  raise notice 'Tests 1-8 passed successfully';
end $$;

-- Checkout-shaped inputs and frozen pricing provenance (no synthetic UI-only
-- values become business identity). All fixtures remain inside this transaction.
do $$
declare
  v_staff text := 'preflight-replay-hardening-staff';
  v_op uuid;
  v_manager uuid;
  v_operator text;
  v_client uuid;
  v_reservation uuid;
  v_option uuid;
  v_name_reservation uuid;
  v_product uuid;
  v_case record;
  v_request jsonb;
  v_retry jsonb;
  v_quote jsonb;
  v_result jsonb;
  v_approval text;
  v_sale uuid;
  v_snapshot jsonb;
  v_sales bigint;
  v_payments bigint;
  v_rejected boolean := false;
begin
  select id into strict v_op from public.staff_members where display_name = 'Replay Hardening Operator';
  select id into strict v_manager from public.staff_members where display_name = 'Replay Hardening Manager';
  select id into strict v_client from public.clients where display_name = 'Replay Hardening Client';
  v_operator := public.staff_operator_verify(v_staff, v_op, '1111')->>'operator_token';
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values ('b1-fixed-mode', 'Frozen fixed', 5000, true, true, false, 60),
    ('b1-from-mode', 'Frozen minimum', 5000, true, true, true, 60);
  insert into public.accounting_items (name, category, price, is_active)
  values ('Frozen option', 'option', 2000, true) returning id into v_option;
  insert into public.products (name, price, is_active, category, current_stock)
  values ('Frozen retail', 3000, true, '店販', 10) returning id into v_product;
  insert into public.reservations (client_id, staff_id, starts_at, ends_at, occupied_until, customer_name, status, source)
  values (v_client, v_op, now() + interval '12 days', now() + interval '12 days 1 hour',
    now() + interval '12 days 1 hour', 'Frozen reservation', 'confirmed', 'staff') returning id into v_reservation;
  insert into public.reservation_items (reservation_id, menu_code, name, duration_min, price, sort_order)
  values (v_reservation, 'b1-fixed-mode', 'Frozen reserved cut', 60, 5000, 0);
  insert into public.reservations (client_id, staff_id, starts_at, ends_at, occupied_until, customer_name, status, source)
  values (v_client, v_op, now() + interval '16 days', now() + interval '16 days 1 hour',
    now() + interval '16 days 1 hour', 'Name-resolved reservation', 'confirmed', 'staff') returning id into v_name_reservation;
  insert into public.reservation_items (reservation_id, menu_code, name, duration_min, price, sort_order)
  values (v_name_reservation, 'b1-fixed-mode', 'Named reserved cut', 60, 5000, 0);

  for v_case in select * from (values
    ('manual', 2000, 'manual', jsonb_build_object('source', 'manual', 'name', ' Manual line ',
      'category', 'menu', 'price', 1000, 'unit_price', 9999, 'quantity', 2, 'discount', 50, 'line_discount', 25)),
    ('manual-unit-only', 1200, 'manual', jsonb_build_object('source', 'manual', 'name', 'Checkout manual',
      'category', 'option', 'unit_price', 1200, 'quantity', 1, 'discount', 100)),
    ('fixed', 5000, 'fixed_master', jsonb_build_object('source', 'service_menu', 'ref_id', 'b1-fixed-mode',
      'name', 'UI label', 'category', 'retail', 'unit_price', 5000, 'quantity', 1, 'discount', 100)),
    ('fixed-raw-price', 5000, 'fixed_master', jsonb_build_object('source', 'service_menu', 'ref_id', 'b1-fixed-mode',
      'name', 'UI label', 'category', 'retail', 'unit_price', 1234, 'price', 9999, 'quantity', 1)),
    ('price-from', 5000, 'price_from', jsonb_build_object('source', 'service_menu', 'ref_id', 'b1-from-mode',
      'unit_price', 5000, 'quantity', 1)),
    ('override', 6500, 'override', jsonb_build_object('source', 'service_menu', 'ref_id', 'b1-fixed-mode',
      'unit_price', 1234, 'override_price', 6500, 'quantity', 1)),
    ('from-adjustment', 6500, 'price_from', jsonb_build_object('source', 'service_menu', 'ref_id', 'b1-from-mode',
      'unit_price', 5500, 'price_from_adjustment', 6500, 'quantity', 1)),
    ('option', 2000, 'fixed_master', jsonb_build_object('source', 'accounting_item', 'ref_id', v_option,
      'name', 'UI option', 'category', 'menu', 'unit_price', 99, 'quantity', 1)),
    ('retail', 3000, 'fixed_master', jsonb_build_object('source', 'product', 'ref_id', v_product,
      'name', 'UI retail', 'category', 'menu', 'unit_price', 99, 'quantity', 1)),
    ('reservation', 5000, 'reservation', jsonb_build_object('source', 'reservation', 'ref_id', 'b1-fixed-mode',
      'name', 'UI reservation', 'category', 'option', 'unit_price', 7777, 'quantity', 3)),
    ('reservation-name', 5000, 'reservation', jsonb_build_object('source', 'reservation',
      'name', 'Named reserved cut', 'category', 'option', 'unit_price', 7777, 'quantity', 3))
  ) cases(label, total, mode, item) loop
    v_request := jsonb_build_object('stylist_id', v_op, 'items', jsonb_build_array(v_case.item),
      'payment_method', 'cash', 'expected_total', v_case.total, 'idempotency_key', 'b1-shaped-' || v_case.label);
    if v_case.label in ('reservation', 'reservation-name') then
      v_request := v_request || jsonb_build_object('reservation_id',
        case when v_case.label = 'reservation' then v_reservation else v_name_reservation end);
    end if;
    v_approval := null;
    v_quote := public.staff_pos_quote(v_staff, v_operator, null, v_request, null)::jsonb;
    if v_quote->>'error' = 'approval_required' then
      if v_quote->>'action' is distinct from 'checkout_pricing_override' or v_quote->>'request_hash' is null then
        raise exception 'shaped % approval facts missing: %', v_case.label, v_quote;
      end if;
      v_result := public.staff_pos_approve(v_staff, v_operator, v_manager, '2222', v_quote->>'action', v_quote->>'request_hash')::jsonb;
      v_approval := v_result->>'approval_token';
      if v_result ? 'error' or v_approval is null then raise exception 'shaped % approval failed: %', v_case.label, v_result; end if;
      v_quote := public.staff_pos_quote(v_staff, v_operator, null, v_request, v_approval)::jsonb;
    end if;
    if v_quote ? 'error' or v_quote->>'quote_hash' is null
       or (v_quote->>'total')::integer is distinct from v_case.total then
      raise exception 'shaped % quote failed: %', v_case.label, v_quote;
    end if;
    v_request := v_request || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
    v_result := public.staff_finalize_sale(v_staff, v_request, 'Tester', v_operator, v_approval)::jsonb;
    v_sale := (v_result->>'id')::uuid;
    if v_result ? 'error' or v_sale is null or v_result->>'status' is distinct from 'completed' then
      raise exception 'shaped % initial sale failed: %', v_case.label, v_result;
    end if;
    select detail->'pos_replay_v1' into strict v_snapshot from public.accounting_events
    where session_id = v_sale and event_type = 'completed';
    if v_snapshot->>'version' is distinct from 'POS_REPLAY_V1'
       or v_snapshot->'items'->0->>'pricing_mode' is distinct from v_case.mode
       or (select (detail->>'total')::integer from public.accounting_events where session_id = v_sale and event_type = 'completed') is distinct from v_case.total
       or v_snapshot::text ~ '(scan_session|presence_token|operator_token|staff_token|approval_token|QTE1|APR1)' then
      raise exception 'shaped % snapshot contract failed: %', v_case.label, v_snapshot;
    end if;
    select count(*) into v_sales from public.accounting_sessions;
    select count(*) into v_payments from public.accounting_payments;
    v_result := public.staff_finalize_sale(v_staff, v_request, 'Tester', v_operator, null)::jsonb;
    if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true
       or (v_result->>'id')::uuid is distinct from v_sale then
      raise exception 'shaped % exact replay failed: %', v_case.label, v_result;
    end if;

    if v_case.label in ('manual', 'manual-unit-only') then
      v_retry := jsonb_set(v_request, '{items,0,category}', '"retail"');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'manual category replay failed: %', v_result; end if;
      v_retry := jsonb_set(jsonb_set(v_request, '{items,0,discount}', '999'), '{items,0,line_discount}', '888');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'manual ignored discount failed: %', v_result; end if;
      v_retry := jsonb_set(v_request, '{items,0,quantity}', '4');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result->>'error' is distinct from 'idempotency_conflict' then raise exception 'manual quantity accepted: %', v_result; end if;
      v_retry := jsonb_set(v_request, case when v_case.label = 'manual' then '{items,0,price}'::text[] else '{items,0,unit_price}'::text[] end, '1300');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result->>'error' is distinct from 'idempotency_conflict' then raise exception 'manual price accepted: %', v_result; end if;
    elsif v_case.label in ('fixed', 'fixed-raw-price') then
      v_retry := jsonb_set(v_request, '{items,0,unit_price}', '6000');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'fixed UI price false conflict: %', v_result; end if;
    elsif v_case.label = 'price-from' then
      v_retry := jsonb_set(v_request, '{items,0,unit_price}', '6000');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result->>'error' is distinct from 'idempotency_conflict' then raise exception 'price_from business change accepted: %', v_result; end if;
    elsif v_case.label in ('override', 'from-adjustment') then
      v_retry := jsonb_set(v_request, case when v_case.label = 'override' then '{items,0,override_price}'::text[] else '{items,0,price_from_adjustment}'::text[] end, '6600');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result->>'error' is distinct from 'idempotency_conflict' then raise exception 'override amount accepted: %', v_result; end if;
    elsif v_case.label in ('reservation', 'reservation-name') then
      v_retry := jsonb_set(v_request, '{items,0,quantity}', '7');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'reservation quantity false conflict: %', v_result; end if;
      v_result := public.staff_finalize_sale(v_staff, v_request || jsonb_build_object('client_id', v_client), 'Tester', v_operator, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'reservation explicit client replay failed: %', v_result; end if;
      v_retry := jsonb_set(v_request, '{items,0,name}', '"Changed reserved item"');
      v_result := public.staff_finalize_sale(v_staff, v_retry, 'Tester', v_operator, null)::jsonb;
      if v_case.label = 'reservation-name' then
        if v_snapshot->'items'->0->>'reference_mode' is distinct from 'name'
           or v_result->>'error' is distinct from 'idempotency_conflict' then
          raise exception 'reservation name-reference change accepted: %', v_result;
        end if;
      elsif v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then
        raise exception 'reservation display label false conflict: %', v_result;
      end if;
    end if;
    if (select count(*) from public.accounting_sessions) is distinct from v_sales
       or (select count(*) from public.accounting_payments) is distinct from v_payments then
      raise exception 'shaped % replay mutated sale/payment rows', v_case.label;
    end if;
    raise notice 'Checkout-shaped % / snapshot / replay / altered fields PASS', v_case.label;
  end loop;

  -- Changing the current master cannot change a frozen fixed/minimum rule.
  update public.service_menus set price = 9000, price_from = true, is_active = false where code = 'b1-fixed-mode';
  update public.service_menus set price = 100, price_from = false, is_active = false where code = 'b1-from-mode';
  for v_case in select * from (values ('fixed', 'b1-fixed-mode', 6000), ('price-from', 'b1-from-mode', 5000)) x(label, code, price) loop
    select jsonb_build_object('quote_hash', quote_hash), id into v_quote, v_sale from public.accounting_sessions where idempotency_key = 'b1-shaped-' || v_case.label;
    v_request := jsonb_build_object('stylist_id', v_op, 'items', jsonb_build_array(jsonb_build_object(
      'source', 'service_menu', 'ref_id', v_case.code, 'unit_price', v_case.price)),
      'payment_method', 'cash', 'expected_total', 5000, 'idempotency_key', 'b1-shaped-' || v_case.label,
      'quote_hash', v_quote->>'quote_hash');
    v_result := public.staff_finalize_sale(v_staff, v_request, 'Tester', v_operator, null)::jsonb;
    if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'replay read mutable master: %', v_result; end if;
  end loop;

  -- A genuine pre-snapshot writer produces the legacy fixture, not a guessed backfill.
  v_request := jsonb_build_object('stylist_id', v_op, 'items', jsonb_build_array(jsonb_build_object(
    'source', 'service_menu', 'ref_id', 'p05-menu-replay-test', 'unit_price', 5000)),
    'payment_method', 'cash', 'expected_total', 5000, 'operator_token', v_operator, 'idempotency_key', 'b1-legacy-sale');
  v_quote := public.staff_pos_quote(v_staff, v_operator, null, v_request, null)::jsonb;
  if v_quote ? 'error' or v_quote->>'quote_hash' is null then raise exception 'legacy quote failed: %', v_quote; end if;
  v_request := v_request || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
  v_result := app_private.finalize_sale(v_request, 'staff', 'Tester', v_staff);
  v_sale := (v_result->>'id')::uuid;
  if v_result ? 'error' or v_sale is null or exists (select 1 from public.accounting_events
    where session_id = v_sale and detail ? 'pos_replay_v1') then raise exception 'legacy fixture failed: %', v_result; end if;
  update public.service_menus set price = 9000, price_from = true, is_active = false where code = 'p05-menu-replay-test';
  v_result := public.staff_finalize_sale(v_staff, v_request, 'Tester', v_operator, null)::jsonb;
  if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true then raise exception 'safe legacy exact replay failed: %', v_result; end if;
  v_result := public.staff_finalize_sale(v_staff, jsonb_set(v_request, '{items,0,unit_price}', '6000'), 'Tester', v_operator, null)::jsonb;
  if v_result->>'error' is distinct from 'idempotency_conflict' then raise exception 'ambiguous legacy change accepted: %', v_result; end if;
  raise notice 'Frozen master independence and legacy safe/ambiguous replay PASS';

  -- A storage fault must roll back the finalized sale and consumed approval.
  v_request := jsonb_build_object('stylist_id', v_op, 'items', jsonb_build_array(jsonb_build_object(
    'source', 'manual', 'name', 'Atomic snapshot', 'unit_price', 1000, 'category', 'menu')),
    'payment_method', 'cash', 'expected_total', 1000, 'idempotency_key', 'b1-storage-failure');
  v_quote := public.staff_pos_quote(v_staff, v_operator, null, v_request, null)::jsonb;
  if v_quote->>'error' is distinct from 'approval_required' or v_quote->>'action' is null or v_quote->>'request_hash' is null then
    raise exception 'atomic snapshot approval entry failed: %', v_quote;
  end if;
  v_result := public.staff_pos_approve(v_staff, v_operator, v_manager, '2222', v_quote->>'action', v_quote->>'request_hash')::jsonb;
  v_approval := v_result->>'approval_token';
  if v_result ? 'error' or v_approval is null then raise exception 'atomic snapshot approval failed: %', v_result; end if;
  v_quote := public.staff_pos_quote(v_staff, v_operator, null, v_request, v_approval)::jsonb;
  if v_quote ? 'error' or v_quote->>'quote_hash' is null then raise exception 'atomic snapshot quote failed: %', v_quote; end if;
  v_request := v_request || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
  select count(*) into v_sales from public.accounting_sessions;
  select count(*) into v_payments from public.accounting_payments;
  execute $ddl$
    create function app_private.preflight_replay_storage_fault() returns trigger language plpgsql as $body$
    begin raise exception 'preflight_snapshot_storage_fault'; end $body$;
  $ddl$;
  execute 'create trigger preflight_replay_storage_fault before update on public.accounting_events
    for each row when (new.detail ? ''pos_replay_v1'') execute function app_private.preflight_replay_storage_fault()';
  begin
    perform public.staff_finalize_sale(v_staff, v_request, 'Tester', v_operator, v_approval);
  exception when sqlstate 'P0001' then
    if sqlerrm is distinct from 'preflight_snapshot_storage_fault' then raise; end if;
    v_rejected := true;
  end;
  execute 'drop trigger preflight_replay_storage_fault on public.accounting_events';
  execute 'drop function app_private.preflight_replay_storage_fault()';
  if not v_rejected or (select count(*) from public.accounting_sessions) is distinct from v_sales
     or (select count(*) from public.accounting_payments) is distinct from v_payments
     or not exists (select 1 from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_approval) and consumed_at is null)
     or exists (select 1 from public.accounting_sessions where idempotency_key = 'b1-storage-failure') then
    raise exception 'snapshot storage failure left sale/payment/consumed approval';
  end if;
  v_result := public.staff_finalize_sale(v_staff, v_request, 'Tester', v_operator, v_approval)::jsonb;
  if v_result ? 'error' or v_result->>'id' is null then raise exception 'atomic snapshot retry failed: %', v_result; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in ('pos_replay_items', 'pos_replay_pricing_snapshot')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'private replay helper exposed';
  end if;
  raise notice 'Snapshot persistence atomic rollback / APR1 reusable / private helpers PASS';
end $$;

-- ── Test 9: B4 Transactional Stub Rollback Test ─────────────────────────────
-- 一時的に app_private.ginpay_record_transaction をスタブ化し、
-- 承認消費後に業務エラーが返った際に subtransaction rollback により
-- pos_approvals.consumed_at が NULL に保たれ、APR1 が未消費であることを実証する。
do $$
declare
  v_staff text := 'preflight-replay-hardening-staff';
  v_op_id uuid;
  v_mgr_id uuid;
  v_op_tok text;
  v_client_id uuid;
  v_account_id uuid;
  v_app_tok text;
  v_req_hash text;
  v_facts jsonb;
  v_res json;
  v_res_b jsonb;
  v_consume jsonb;
  v_balance_before integer;
  v_tx_before bigint;
  v_audit_before bigint;
  v_ledger_before integer;
begin
  select id into v_op_id from public.staff_members where display_name = 'Replay Hardening Operator';
  select id into v_mgr_id from public.staff_members where display_name = 'Replay Hardening Manager';
  v_op_tok := (public.staff_operator_verify(v_staff, v_op_id, '1111')->>'operator_token');

  select id into v_client_id from public.clients where display_name = 'Replay Hardening Client';
  select id into v_account_id from public.ginpay_accounts where client_id = v_client_id and status = 'active' limit 1;

  -- 60,000円チャージ用 L2 承認取得
  v_facts := jsonb_build_object(
    'action', 'ginpay_charge',
    'client_id', v_client_id,
    'account_id', v_account_id,
    'amount', 60000,
    'payment_method', 'cash',
    'operator_staff_id', v_op_id
  );
  v_req_hash := app_private.pos_auth_hash('ginpay_charge', v_facts);
  v_res_b := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'ginpay_charge', v_req_hash)::jsonb;
  v_app_tok := v_res_b->>'approval_token';
  if v_res_b ? 'error' or v_app_tok is null then raise exception 'Test 9 approval fixture failed: %', v_res_b; end if;
  select balance_cached into v_balance_before from public.ginpay_accounts where id = v_account_id;

  -- Deliberately corrupt only this disposable fixture's ledger, without disabling
  -- any production trigger or changing a cached balance. The outer rollback removes it.
  insert into public.ginpay_transactions (account_id, client_id, root_client_id, amount,
    type, status, operator_type, operator_name, idempotency_key)
  values (v_account_id, v_client_id, v_client_id, 1, 'charge_store', 'posted', 'system', 'Fixture', 'b4-mismatch-fixture');
  v_ledger_before := app_private.ginpay_posted_sum(v_account_id);
  select count(*) into v_tx_before from public.ginpay_transactions;
  select count(*) into v_audit_before from public.ginpay_account_events
  where account_id = v_account_id and event_type = 'ledger_mismatch_blocked';
  v_res := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client_id, 60000, 'cash',
    'Tester', 'audit rollback test', 'b4-audit-preservation', v_app_tok, v_account_id);
  if v_res->>'error' is distinct from 'ledger_mismatch_blocked'
     or v_res->>'account_id' is distinct from v_account_id::text
     or (select balance_cached from public.ginpay_accounts where id = v_account_id) is distinct from v_balance_before
     or (select count(*) from public.ginpay_transactions) is distinct from v_tx_before
     or (select consumed_at from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_app_tok)) is not null
     or not exists (select 1 from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_app_tok)) then
    raise exception 'B4 real mismatch money/approval rollback failed: %', v_res;
  end if;
  if (select count(*) from public.ginpay_account_events where account_id = v_account_id
      and event_type = 'ledger_mismatch_blocked') is distinct from v_audit_before + 1
     or not exists (select 1 from public.ginpay_account_events where account_id = v_account_id
       and event_type = 'ledger_mismatch_blocked'
       and (detail->>'cached_balance')::integer = v_balance_before
       and (detail->>'ledger_balance')::integer = v_ledger_before
       and detail->'context'->>'idempotency_key' = 'b4-audit-preservation') then
    raise exception 'B4 mismatch audit was lost or incomplete';
  end if;
  raise notice 'B4 real mismatch audit preserved / approval and money rollback PASS';
  select count(*) into v_tx_before from public.ginpay_transactions;

  -- テスト専用スタブ関数の作成 (同一シグネチャで業務エラー JSON を返す)
  execute $stub$
    create or replace function app_private.ginpay_record_transaction(
      p_account_id uuid,
      p_type text,
      p_amount integer,
      p_status text,
      p_accounting_session_id uuid,
      p_stripe_event_id text,
      p_stripe_payment_intent_id text,
      p_stripe_checkout_session_id text,
      p_stripe_charge_id text,
      p_operator_type text,
      p_operator_name text,
      p_reason text,
      p_memo text,
      p_idempotency_key text,
      p_original_transaction_id uuid,
      p_metadata jsonb default '{}'::jsonb,
      p_request_hash text default null
    ) returns jsonb language plpgsql set search_path = public, extensions, pg_temp as $body$
    begin
      return jsonb_build_object('error', 'simulated_ledger_fault', 'account_id', p_account_id, 'detail', 'original detail');
    end;
    $body$;
  $stub$;

  -- staff_ginpay_charge_store を実行
  v_res := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client_id, 60000, 'cash', 'Tester', 'test memo', 'b4-rollback-idem-1', v_app_tok, v_account_id);

  -- 決定論的な業務エラー JSON がそのまま返されていること
  if v_res->>'error' is distinct from 'simulated_ledger_fault' then
    raise exception 'Test 9 expected simulated_ledger_fault, got: %', v_res;
  end if;

  if v_res->>'account_id' is distinct from v_account_id::text or v_res->>'detail' is distinct from 'original detail'
     or (select balance_cached from public.ginpay_accounts where id = v_account_id) is distinct from v_balance_before
     or (select count(*) from public.ginpay_transactions) is distinct from v_tx_before then
    raise exception 'Test 9 business JSON or money rollback failed: %', v_res;
  end if;

  -- 承認消費がロールバックされ、consumed_at が NULL のままであること
  if not exists (
    select 1 from app_private.pos_approvals
    where approval_hash = app_private.sha256_hex(v_app_tok) and consumed_at is null
  ) then
    raise exception 'Test 9 pos_approvals consumed_at was NOT rolled back';
  end if;

  -- ロールバック後も承認トークンが有効であり、直接再消費できること
  v_consume := app_private.consume_pos_approval(v_staff, v_op_tok, v_app_tok, 'ginpay_charge', v_req_hash);
  if (v_consume->>'ok')::boolean is not true then
    raise exception 'Test 9 approval token could not be consumed after rollback: %', v_consume;
  end if;

  raise notice 'Test 9 B4 transactional stub rollback passed successfully';
end $$;

rollback;
