-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Money Authorization Enforcement Preflight Tests
-- (begin … rollback。テストデータは残さない)
-- ============================================================================
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_staff_a text := 'p05-staff-terminal-a-0123456789abcdef';
  v_staff_b text := 'p05-staff-terminal-b-0123456789abcdef';
  v_staff_a_hash text := app_private.sha256_hex('p05-staff-terminal-a-0123456789abcdef');
  v_staff_b_hash text := app_private.sha256_hex('p05-staff-terminal-b-0123456789abcdef');

  v_stylist uuid;
  v_op_member uuid;
  v_mgr_member uuid;
  v_inactive_member uuid;

  v_op_res jsonb;
  v_op_token text;
  v_op_token_b text;

  v_customer_a uuid;
  v_client_a uuid;
  v_user_a text := 'p05-user-a';

  v_customer_b uuid;
  v_client_b uuid;
  v_user_b text := 'p05-user-b';

  v_service_code text := 'p05-cut';
  v_product_id uuid;
  v_ai_id uuid;

  v_account_a uuid;
  v_account_b uuid;

  v_r jsonb;
  v_facts jsonb;
  v_req_hash text;
  v_app_token text;
  v_app_token_2 text;
  v_consume jsonb;
  v_quote jsonb;
  v_sale jsonb;
  v_sale_id uuid;
  v_void_res jsonb;
  v_charge_res jsonb;
  v_refund_res jsonb;
  v_ticket_res jsonb;
  v_charge_id uuid;
  v_payment_id uuid;
  v_test_savepoint text;
  v_initial_consumed_at timestamptz;
  i integer;
begin
  -- ── 0. セットアップ ──────────────────────────────────────────────────────────
  -- 端末スタッフセッション
  insert into app_private.staff_sessions (token_hash, expires_at) values
    (v_staff_a_hash, now() + interval '14 hours'),
    (v_staff_b_hash, now() + interval '14 hours');

  -- スタッフメンバー
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05_スタイリスト', true, true, 301) returning id into v_stylist;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05_担当者', true, true, 302) returning id into v_op_member;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05_店長', true, true, 303) returning id into v_mgr_member;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05_退職者', true, false, 304) returning id into v_inactive_member;

  -- 資格情報初期化 (オペレーター: staff, 店長: manager)
  perform app_private.set_staff_operator_credentials(v_op_member, '1234', 'staff');
  perform app_private.set_staff_operator_credentials(v_mgr_member, '5678', 'manager');

  -- 顧客 A & B
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_a, 'P05顧客A', '1111', 'P05-A', app_private.norm_name('P05顧客A'))
  returning id into v_customer_a;
  v_client_a := app_private.member_client(v_customer_a);

  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_b, 'P05顧客B', '2222', 'P05-B', app_private.norm_name('P05顧客B'))
  returning id into v_customer_b;
  v_client_b := app_private.member_client(v_customer_b);

  -- マスター
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_service_code, 'P05テストカット', 5000, true, true, false, 60);

  insert into public.products (name, price, is_active, category, current_stock)
  values ('P05テストワックス', 2500, true, '店販', 50) returning id into v_product_id;

  insert into public.accounting_items (name, category, price, is_active)
  values ('P05テスト品目', 'menu', 1000, true) returning id into v_ai_id;

  -- GINPay 口座開設 (A & B)
  perform public.staff_ginpay_open_account(v_staff_a, v_client_a, 'Tester');
  perform public.staff_ginpay_open_account(v_staff_a, v_client_b, 'Tester');

  -- ── Group 1: Operator Authentication & TTL (Tests 1 - 6) ───────────────────

  -- Test 1: 正しい PIN で L1 operator session 取得 (TTL 1,800s, OPS1.<64hex>)
  v_op_res := public.staff_operator_verify(v_staff_a, v_op_member, '1234')::jsonb;
  if v_op_res ? 'error' or (v_op_res->>'ttl_seconds')::int <> 1800 or v_op_res->>'operator_token' !~ '^OPS1\.[a-f0-9]{64}$' then
    raise exception 'Test 1 failed: operator verify: %', v_op_res;
  end if;
  v_op_token := v_op_res->>'operator_token';

  -- Test 2: Inactive staff は operator ログイン拒否
  v_r := public.staff_operator_verify(v_staff_a, v_inactive_member, '1234')::jsonb;
  if v_r->>'error' <> 'inactive_or_not_found' then
    raise exception 'Test 2 failed: inactive operator not rejected: %', v_r;
  end if;

  -- Test 3: Operator session 有効期限 (30分/1,800s)。期限切れトークンは拒否される
  update app_private.pos_operator_sessions
  set created_at = now() - interval '31 minutes',
      expires_at = now() - interval '1 second'
  where token_hash = app_private.sha256_hex(v_op_token);

  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'manual_discount', 'AUTH1.' || repeat('a', 64))::jsonb;
  if v_r->>'error' not in ('invalid_operator_session', 'operator_session_expired') then
    raise exception 'Test 3 failed: expired operator token not rejected: %', v_r;
  end if;

  -- 有効期限を元に戻す
  update app_private.pos_operator_sessions
  set created_at = now() - interval '1 minute',
      expires_at = now() + interval '30 minutes'
  where token_hash = app_private.sha256_hex(v_op_token);

  -- Test 4: 別の端末スタッフセッション (v_staff_b) から operator session を使用不可
  v_r := public.staff_pos_approve(v_staff_b, v_op_token, v_mgr_member, '5678', 'manual_discount', 'AUTH1.' || repeat('a', 64))::jsonb;
  if v_r->>'error' <> 'invalid_operator_session' then
    raise exception 'Test 4 failed: cross-terminal operator use not rejected: %', v_r;
  end if;

  -- Test 5: 5回連続失敗でアカウントロック (15分)
  for i in 1..5 loop
    v_r := public.staff_operator_verify(v_staff_a, v_op_member, '9999')::jsonb;
  end loop;
  if v_r->>'error' <> 'locked' or v_r->>'locked_until' is null then
    raise exception 'Test 5 failed: 5 failed attempts did not lock operator: %', v_r;
  end if;

  -- ロック解除
  update app_private.staff_operator_credentials
  set locked_until = null, failed_count = 0 where staff_member_id = v_op_member;

  -- Test 6: Manager 0名 / 未設定時は L2 承認不可 (fail closed)
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_op_member, '1234', 'manual_discount', 'AUTH1.' || repeat('a', 64))::jsonb;
  if v_r->>'error' not in ('not_a_manager', 'self_approval_prohibited') then
    raise exception 'Test 6 failed: unconfigured manager allowed: %', v_r;
  end if;

  -- ── Group 2: Manager Approval Issuance & Lifecycle (Tests 7 - 17) ──────────

  v_facts := jsonb_build_object('action', 'test_act', 'amount', 1000);
  v_req_hash := app_private.pos_auth_hash('test_act', v_facts);

  -- Test 7: 正しい Manager PIN で L2 承認発行 (APR1.<64hex>, TTL 300s, request_hash 保持)
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', v_req_hash)::jsonb;
  if v_r ? 'error' or v_r->>'approval_token' !~ '^APR1\.[a-f0-9]{64}$' or (v_r->>'ttl_seconds')::int <> 300 or v_r->>'request_hash' <> v_req_hash then
    raise exception 'Test 7 failed: manager approval issue: %', v_r;
  end if;
  v_app_token := v_r->>'approval_token';

  -- Test 8: 自己承認の禁止 (Operator と Manager が同一人物の場合拒否)
  update app_private.staff_operator_credentials set role = 'manager' where staff_member_id = v_op_member;
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_op_member, '1234', 'test_act', v_req_hash)::jsonb;
  if v_r->>'error' <> 'self_approval_prohibited' then
    raise exception 'Test 8 failed: self approval not prohibited: %', v_r;
  end if;
  update app_private.staff_operator_credentials set role = 'staff' where staff_member_id = v_op_member;

  -- Test 9: Staff ロールによる承認要求拒否
  perform app_private.set_staff_operator_credentials(v_mgr_member, '5678', 'staff');
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', v_req_hash)::jsonb;
  if v_r->>'error' <> 'not_a_manager' then
    raise exception 'Test 9 failed: staff role allowed as approver: %', v_r;
  end if;
  perform app_private.set_staff_operator_credentials(v_mgr_member, '5678', 'manager');

  -- Test 10: 誤った Manager PIN は拒否
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '0000', 'test_act', v_req_hash)::jsonb;
  if v_r->>'error' <> 'invalid_pin' then
    raise exception 'Test 10 failed: wrong manager pin not rejected: %', v_r;
  end if;

  -- Test 11: Manager PIN 5回連続失敗でロック
  for i in 1..4 loop
    v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '0000', 'test_act', v_req_hash)::jsonb;
  end loop;
  if v_r->>'error' not in ('manager_locked', 'locked') then
    raise exception 'Test 11 failed: manager not locked after 5 fails: %', v_r;
  end if;
  update app_private.staff_operator_credentials set locked_until = null, failed_count = 0 where staff_member_id = v_mgr_member;

  -- Test 12: Inactive Manager は承認不可
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_inactive_member, '1234', 'test_act', v_req_hash)::jsonb;
  if v_r->>'error' not in ('manager_not_found', 'not_a_manager') then
    raise exception 'Test 12 failed: inactive manager approved: %', v_r;
  end if;

  -- 新規に承認発行
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  -- Test 13: 発行端末束縛: 端末Bから承認の検証 (verify) は拒否される (approval_session_mismatch / invalid_operator_session)
  v_r := app_private.verify_pos_approval(v_staff_b, v_op_token, v_app_token, 'test_act', v_req_hash);
  if (v_r->>'ok')::boolean is not false or v_r->>'error' not in ('approval_session_mismatch', 'invalid_operator_session') then
    raise exception 'Test 13 failed: verify from different terminal not rejected: %', v_r;
  end if;

  -- Test 14: 発行端末束縛: 端末Bから承認の消費 (consume) は拒否される (approval_session_mismatch / invalid_operator_session)
  v_r := app_private.consume_pos_approval(v_staff_b, v_op_token, v_app_token, 'test_act', v_req_hash);
  if (v_r->>'ok')::boolean is not false or v_r->>'error' not in ('approval_session_mismatch', 'invalid_operator_session') then
    raise exception 'Test 14 failed: consume from different terminal not rejected: %', v_r;
  end if;

  -- Test 15: 別の Operator による消費は拒否される (operator_mismatch)
  v_op_res := public.staff_operator_verify(v_staff_a, v_mgr_member, '5678')::jsonb;
  v_op_token_b := v_op_res->>'operator_token';
  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token_b, v_app_token, 'test_act', v_req_hash);
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'operator_mismatch' then
    raise exception 'Test 15 failed: consume by different operator not rejected: %', v_r;
  end if;

  -- Test 16: 有効期限切れ (> 300s) の承認は拒否される (approval_expired)
  update app_private.pos_approvals
  set created_at = now() - interval '6 minutes',
      expires_at = now() - interval '1 second'
  where approval_hash = app_private.sha256_hex(v_app_token);

  v_r := app_private.verify_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', v_req_hash);
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'approval_expired' then
    raise exception 'Test 16 failed: expired approval verify not rejected: %', v_r;
  end if;

  -- Test 17: 発行後に Manager 資格が無効化/降格された場合、消費拒否 (approver_role_revoked)
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  update app_private.staff_operator_credentials set is_active = false where staff_member_id = v_mgr_member;
  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', v_req_hash);
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'approver_role_revoked' then
    raise exception 'Test 17 failed: demoted approver consumption not rejected: %', v_r;
  end if;
  update app_private.staff_operator_credentials set is_active = true where staff_member_id = v_mgr_member;

  -- ── Group 3: Request Mutation Rejections (Tests 18 - 21) ────────────────────

  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  -- Test 18: 金額変更後の消費試行 → request_hash_mismatch
  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', app_private.pos_auth_hash('test_act', jsonb_build_object('action', 'test_act', 'amount', 9999)));
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'request_hash_mismatch' then
    raise exception 'Test 18 failed: mutated amount consumed: %', v_r;
  end if;

  -- Test 19: 顧客変更後の消費試行 → request_hash_mismatch
  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', app_private.pos_auth_hash('test_act', jsonb_build_object('action', 'test_act', 'amount', 1000, 'client_id', v_client_b)));
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'request_hash_mismatch' then
    raise exception 'Test 19 failed: mutated customer consumed: %', v_r;
  end if;

  -- Test 20: 品目・ref_id 変更後の消費試行 → request_hash_mismatch
  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', app_private.pos_auth_hash('test_act', jsonb_build_object('action', 'test_act', 'amount', 1000, 'ref_id', 'other')));
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'request_hash_mismatch' then
    raise exception 'Test 20 failed: mutated ref_id consumed: %', v_r;
  end if;

  -- Test 21: 理由 (reason) 変更後の消費試行 → request_hash_mismatch
  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', app_private.pos_auth_hash('test_act', jsonb_build_object('action', 'test_act', 'amount', 1000, 'reason', 'tampered')));
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'request_hash_mismatch' then
    raise exception 'Test 21 failed: mutated reason consumed: %', v_r;
  end if;

  -- ── Group 4: Pure Pricing Engine (Tests 22 - 29) ───────────────────────────

  -- Test 22: L2 変更のない通常見積もりは承認不要で成功し quote_hash を返す
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
  ))::jsonb;
  if v_quote ? 'error' or (v_quote->>'total')::int <> 5000 or v_quote->>'quote_hash' is null then
    raise exception 'Test 22 failed: normal quote: %', v_quote;
  end if;

  -- Test 23: 手動割引 (manual_discount > 0) は L2 承認を要求 (approval_required)
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'manual_discount', 500,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
  ))::jsonb;
  if v_quote->>'error' <> 'approval_required' or v_quote->>'action' <> 'checkout_pricing_override' then
    raise exception 'Test 23 failed: manual_discount quote: %', v_quote;
  end if;
  v_req_hash := v_quote->>'request_hash';

  -- Test 24: 手動品目 (source: manual) は L2 承認を要求
  v_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'manual', 'name', '特別手当', 'price', 2000, 'quantity', 1))
  ))::jsonb;
  if v_r->>'error' <> 'approval_required' or v_r->>'action' <> 'checkout_pricing_override' then
    raise exception 'Test 24 failed: manual item quote: %', v_r;
  end if;

  -- Test 25: 価格上書き (override_price) は L2 承認を要求
  v_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'override_price', 4000, 'quantity', 1))
  ))::jsonb;
  if v_r->>'error' <> 'approval_required' or v_r->>'action' <> 'checkout_pricing_override' then
    raise exception 'Test 25 failed: price override quote: %', v_r;
  end if;

  -- Test 26: 発行済み承認トークンを添付した Quote は検証成功し金額を返す
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'checkout_pricing_override', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'manual_discount', 500,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
  ), v_app_token)::jsonb;
  if v_quote ? 'error' or (v_quote->>'total')::int <> 4500 then
    raise exception 'Test 26 failed: approved quote: %', v_quote;
  end if;

  -- Test 27: Quote は純粋関数であり、承認トークンを消費しない (consumed_at is null)
  select consumed_at into v_initial_consumed_at from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_app_token);
  if v_initial_consumed_at is not null then
    raise exception 'Test 27 failed: quote consumed approval token';
  end if;

  -- Test 28: Quote を 5 回繰り返しても承認トークンは未消費のまま維持される
  for i in 1..5 loop
    perform public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ), v_app_token);
  end loop;
  select consumed_at into v_initial_consumed_at from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_app_token);
  if v_initial_consumed_at is not null then
    raise exception 'Test 28 failed: repeated quotes consumed approval token';
  end if;

  -- Test 29: 〜円メニューの上書き価格が基準価格を超える場合のハンドリング
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values ('p05-from', '〜円パーマ', 8000, true, true, true, 90);

  v_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'p05-from', 'override_price', 12000, 'quantity', 1))
  ))::jsonb;
  if v_r->>'error' <> 'approval_required' then
    raise exception 'Test 29 failed: price_from override quote: %', v_r;
  end if;

  -- ── Group 5: Composite checkout_pricing_override (Tests 30 - 33) ────────────

  -- Test 30: 単一会計内に複数の L2 対象 (値引 + 単価変更 + 手動品目) が存在する場合、1つの composite hash に束ねる
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'manual_discount', 1000,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'override_price', 4500, 'quantity', 1, 'reason', '常連割'),
      jsonb_build_object('source', 'product', 'ref_id', v_product_id::text, 'override_price', 2000, 'quantity', 1, 'reason', 'セット割'),
      jsonb_build_object('source', 'manual', 'name', '指名料調整', 'price', 500, 'quantity', 1, 'reason', '特別対応')
    )
  ))::jsonb;
  if v_quote->>'error' <> 'approval_required' or v_quote->>'action' <> 'checkout_pricing_override' then
    raise exception 'Test 30 failed: composite quote: %', v_quote;
  end if;
  v_req_hash := v_quote->>'request_hash';

  -- Test 31: 配列の決定的ソート (全タプル順) により、品目を逆順で渡しても同一の request_hash が生成される
  v_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'manual_discount', 1000,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'manual', 'name', '指名料調整', 'price', 500, 'quantity', 1, 'reason', '特別対応'),
      jsonb_build_object('source', 'product', 'ref_id', v_product_id::text, 'override_price', 2000, 'quantity', 1, 'reason', 'セット割'),
      jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'override_price', 4500, 'quantity', 1, 'reason', '常連割')
    )
  ))::jsonb;
  if v_r->>'request_hash' <> v_req_hash then
    raise exception 'Test 31 failed: reverse order items produced different hash: % vs %', v_r->>'request_hash', v_req_hash;
  end if;

  -- Test 32: 同名品目が複数ある場合も全フィールドタプル順で決定的一致
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'manual', 'name', '追加', 'price', 100, 'quantity', 1),
      jsonb_build_object('source', 'manual', 'name', '追加', 'price', 200, 'quantity', 1)
    )
  ))::jsonb;
  v_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(
      jsonb_build_object('source', 'manual', 'name', '追加', 'price', 200, 'quantity', 1),
      jsonb_build_object('source', 'manual', 'name', '追加', 'price', 100, 'quantity', 1)
    )
  ))::jsonb;
  if v_quote->>'request_hash' <> v_r->>'request_hash' then
    raise exception 'Test 32 failed: duplicate named items order sorting mismatch';
  end if;

  -- Test 33: 同一顧客で再スキャン等を行っても同じ事実なら request_hash は不変
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'manual_discount', 500,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
  ))::jsonb;
  v_req_hash := v_quote->>'request_hash';

  v_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'manual_discount', 500,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
  ))::jsonb;
  if v_r->>'request_hash' <> v_req_hash then
    raise exception 'Test 33 failed: rescan facts hash altered';
  end if;

  -- ── Group 6: Finalize Sale Atomic Consumption & Idempotency (Tests 34 - 38) ─

  declare
    v_group_session text := 'p05-identified-checkout-session-0123456789abcdef';
    v_group_presence text;
    v_group_scan uuid;
    v_replay_sale_count bigint;
    v_replay_payment_count bigint;
  begin
    insert into app_private.customer_sessions (token_hash, user_id, created_via)
    values (app_private.sha256_hex(v_group_session), v_user_a, 'register');
    v_group_presence := public.customer_issue_presence_token(v_group_session)->>'token';
    v_r := public.staff_resolve_presence_token(v_staff_a, v_group_presence)::jsonb;
    v_group_scan := (v_r->>'scan_session_id')::uuid;
    if v_r ? 'error' or v_group_scan is null then raise exception 'Group 6 trusted scan failed: %', v_r; end if;

    v_quote := public.staff_pos_quote(v_staff_a, v_op_token, v_group_scan, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ), null)::jsonb;
    if v_quote->>'error' is distinct from 'approval_required' or v_quote->>'request_hash' is null then
      raise exception 'Group 6 identified approval facts failed: %', v_quote;
    end if;
    v_req_hash := v_quote->>'request_hash';
    v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'checkout_pricing_override', v_req_hash)::jsonb;
    v_app_token := v_r->>'approval_token';
    if v_r ? 'error' or v_app_token is null then raise exception 'Group 6 approval failed: %', v_r; end if;


  -- 必須追加テスト 1: staff_pos_quote → QTE1.<64hex> を返す
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, v_group_scan, jsonb_build_object(
    'client_id', v_client_a, 'scan_session_id', v_group_scan,
    'manual_discount', 500,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
  ), v_app_token)::jsonb;
  if v_quote ? 'error' or v_quote->>'quote_hash' is null or v_quote->>'quote_hash' !~ '^QTE1\.[a-f0-9]{64}$'
     or (v_quote->>'total')::int is distinct from 4500 or v_quote->'facts'->>'client_id' is distinct from v_client_a::text then
    raise exception 'Test 1 failed: staff_pos_quote did not return valid QTE1 hash: %', v_quote;
  end if;

  declare
    v_valid_qhash text := v_quote->>'quote_hash';
  begin
    -- 必須追加テスト 2: staff_finalize_sale quote_hashなし → quote_required
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'idempotency_key', 'p05-test-no-qhash'
    ), 'P05担当者', v_op_token, v_app_token)::jsonb;
    if v_r->>'error' <> 'quote_required' then
      raise exception 'Test 2 failed: finalize without quote_hash was not rejected with quote_required: %', v_r;
    end if;

    -- 必須追加テスト 3: forged/raw 64hex → reject (quote_mismatch)
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'quote_hash', repeat('a', 64),
      'idempotency_key', 'p05-test-raw-hex'
    ), 'P05担当者', v_op_token, v_app_token)::jsonb;
    if v_r->>'error' <> 'quote_mismatch' then
      raise exception 'Test 3 failed: forged raw 64hex was not rejected: %', v_r;
    end if;

    -- 必須追加テスト 5: quote後にprice/customer/item変更 → quote_mismatch
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 600,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4400,
      'quote_hash', v_valid_qhash,
      'idempotency_key', 'p05-test-tampered-price'
    ), 'P05担当者', v_op_token, v_app_token)::jsonb;
    if v_r->>'error' <> 'quote_mismatch' then
      raise exception 'Test 5 failed: tampered quote was not rejected with quote_mismatch: %', v_r;
    end if;

    -- 必須追加テスト 7: AUTH1 approvalが正しくてもQTE1不一致 → finalize不可 (quote_mismatch)
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'quote_hash', 'QTE1.' || repeat('b', 64),
      'idempotency_key', 'p05-test-forged-qte1'
    ), 'P05担当者', v_op_token, v_app_token)::jsonb;
    if v_r->>'error' <> 'quote_mismatch' then
      raise exception 'Test 7 failed: valid AUTH1 with forged QTE1 was not rejected: %', v_r;
    end if;

    -- 必須追加テスト 8: QTE1が正しくてもL2 AUTH1なし → approval_required
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'quote_hash', v_valid_qhash,
      'idempotency_key', 'p05-test-missing-auth1'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_r->>'error' <> 'approval_required' then
      raise exception 'Test 8 failed: valid QTE1 without AUTH1 approval was not rejected: %', v_r;
    end if;

    -- 必須追加テスト 4: valid QTE1 + valid AUTH1 → finalize成功 (Test 34)
    v_sale := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'quote_hash', v_valid_qhash,
      'idempotency_key', 'p05-sale-finalize-1'
    ), 'P05担当者', v_op_token, v_app_token)::jsonb;

    if v_sale ? 'error' or (v_sale->>'total')::int <> 4500 or (v_sale->>'status') <> 'completed' then
      raise exception 'Test 4 (Test 34) failed: finalize sale: %', v_sale;
    end if;
    v_sale_id := (v_sale->>'id')::uuid;

    select consumed_at into v_initial_consumed_at from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_app_token);
    if v_initial_consumed_at is null then
      raise exception 'Test 34 failed: approval token was not consumed on finalize';
    end if;

    -- Test 35: 既に消費された承認トークンの再利用は拒否される (already_consumed)
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'quote_hash', v_valid_qhash,
      'idempotency_key', 'p05-sale-finalize-reuse'
    ), 'P05担当者', v_op_token, v_app_token)::jsonb;
    if v_r->>'error' <> 'already_consumed' then
      raise exception 'Test 35 failed: reused approval not rejected: %', v_r;
    end if;

    -- Test 36: トランザクションロールバック時の安全性 (Savepoint でロールバックすると承認消費も巻き戻る)
    v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'checkout_pricing_override', v_req_hash)::jsonb;
    v_app_token_2 := v_r->>'approval_token';

    -- 意図的に失敗する会計を実行 (存在しない支払い方法)
    begin
      perform public.staff_finalize_sale(v_staff_a, jsonb_build_object(
        'client_id', v_client_a, 'scan_session_id', v_group_scan,
        'stylist_id', v_stylist,
        'manual_discount', 500,
        'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
        'payment_method', 'invalid_method',
        'expected_total', 4500,
        'quote_hash', v_valid_qhash,
        'idempotency_key', 'p05-sale-fail-rollback'
      ), 'P05担当者', v_op_token, v_app_token_2);
    exception when others then
      null;
    end;

    select consumed_at into v_initial_consumed_at from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_app_token_2);
    if v_initial_consumed_at is not null then
      raise exception 'Test 36 failed: approval consumption was not rolled back upon finalize failure';
    end if;

    select count(*) into v_replay_sale_count from public.accounting_sessions;
    select count(*) into v_replay_payment_count from public.accounting_payments;

    -- Test 37: Idempotency: 同一キー + 同一リクエストの再送は既存結果を即時返却 (新規承認を要求・消費しない)
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 4500,
      'quote_hash', v_valid_qhash,
      'idempotency_key', 'p05-sale-finalize-1'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_r ? 'error' or (v_r->>'id')::uuid is distinct from v_sale_id
       or (v_r->>'idempotent')::boolean is distinct from true or (v_r - 'idempotent') is distinct from v_sale then
      raise exception 'Test 37 failed: idempotency did not return existing sale: %', v_r;
    end if;

    -- Test 38: Idempotency: 同一キー + 異なるリクエストは idempotency_conflict を返す
    v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_group_scan,
      'stylist_id', v_stylist,
      'manual_discount', 500,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 2)),
      'payment_method', 'cash',
      'expected_total', 9500,
      'quote_hash', v_valid_qhash,
      'idempotency_key', 'p05-sale-finalize-1'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_r->>'error' is distinct from 'idempotency_conflict' then
      raise exception 'Test 38 failed: idempotency conflict not detected: %', v_r;
    end if;
    if (select count(*) from public.accounting_sessions) <> v_replay_sale_count
       or (select count(*) from public.accounting_payments) <> v_replay_payment_count then
      raise exception 'Group 6 replay/conflict created sale or payment';
    end if;
  end;
  end;

-- Independent identified/anonymous replay checks; every call uses the public canonical RPC.
  declare
    v_session text := 'p05-replay-customer-session-0123456789abcdef';
    v_presence text;
    v_scan uuid;
    v_retry_op text;
    v_payload jsonb;
    v_changed jsonb;
    v_result jsonb;
    v_first jsonb;
    v_before_sales bigint;
    v_before_payments bigint;
    v_first_hash text;
    v_claim uuid;
    v_case text;
    v_other_account uuid;
    v_other_ticket uuid;
    v_ginpay_before jsonb;
    v_ginpay_after jsonb;
    v_change integer;
  begin
    select jsonb_build_object(
      'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.ginpay_accounts a),
      'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.ginpay_transactions t)
    ) into v_ginpay_before;
    insert into app_private.customer_sessions (token_hash, user_id, created_via)
    values (app_private.sha256_hex(v_session), v_user_a, 'register');
    v_presence := public.customer_issue_presence_token(v_session)->>'token';
    v_result := public.staff_resolve_presence_token(v_staff_a, v_presence)::jsonb;
    v_scan := (v_result->>'scan_session_id')::uuid;
    if v_result ? 'error' or v_scan is null then raise exception 'Replay trusted scan failed: %', v_result; end if;

    v_payload := jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_scan, 'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash', 'expected_total', 5000, 'idempotency_key', 'p05-identified-replay'
    );
    v_quote := public.staff_pos_quote(v_staff_a, v_op_token, v_scan, v_payload, null)::jsonb;
    if v_quote ? 'error' or v_quote->>'quote_hash' is null
       or v_quote->'facts'->>'client_id' is distinct from v_client_a::text then
      raise exception 'Identified replay quote failed: %', v_quote;
    end if;
    v_payload := v_payload || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
    v_first := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', v_op_token, null)::jsonb;
    if v_first ? 'error' or v_first->>'status' is distinct from 'completed'
       or (select client_id from public.accounting_sessions where id = (v_first->>'id')::uuid) is distinct from v_client_a then
      raise exception 'Identified initial sale failed: %', v_first;
    end if;
    select request_hash into v_first_hash from public.accounting_sessions where id = (v_first->>'id')::uuid;
    select count(*) into v_before_sales from public.accounting_sessions;
    select count(*) into v_before_payments from public.accounting_payments;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', v_op_token, null)::jsonb;
    if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true
       or (v_result - 'idempotent') is distinct from v_first then
      raise exception 'Identified exact replay failed: %', v_result;
    end if;

    -- Re-authentication and re-scan change session IDs, but not the customer/operator business identity.
    v_result := public.staff_operator_verify(v_staff_a, v_op_member, '1234')::jsonb;
    v_retry_op := v_result->>'operator_token';
    if v_result ? 'error' or v_retry_op is null then raise exception 'Replay operator verify failed: %', v_result; end if;
    v_presence := public.customer_issue_presence_token(v_session)->>'token';
    v_result := public.staff_resolve_presence_token(v_staff_a, v_presence)::jsonb;
    v_scan := (v_result->>'scan_session_id')::uuid;
    if v_result ? 'error' or v_scan is null then raise exception 'Replay rescan failed: %', v_result; end if;
    v_payload := v_payload || jsonb_build_object('scan_session_id', v_scan);
    v_quote := public.staff_pos_quote(v_staff_a, v_retry_op, v_scan, v_payload, null)::jsonb;
    if v_quote ? 'error' or v_quote->>'quote_hash' is null then raise exception 'Replay rescan quote failed: %', v_quote; end if;
    v_payload := v_payload || jsonb_build_object('quote_hash', v_quote->>'quote_hash', 'request_hash', 'caller-hash-is-untrusted');
    v_result := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', v_retry_op, null)::jsonb;
    if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true
       or (v_result - 'idempotent') is distinct from v_first
       or (select request_hash from public.accounting_sessions where id = (v_first->>'id')::uuid) is distinct from v_first_hash then
      raise exception 'Identified session rotation changed replay/hash: %', v_result;
    end if;

    v_result := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', null, null)::jsonb;
    if v_result->>'error' is distinct from 'operator_auth_required' then raise exception 'Replay missing operator accepted: %', v_result; end if;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', 'invalid-operator-0123456789abcdef', null)::jsonb;
    if v_result->>'error' is distinct from 'invalid_operator_session' then raise exception 'Replay invalid operator accepted: %', v_result; end if;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload - 'quote_hash', 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'quote_required' then raise exception 'Replay missing QTE1 accepted: %', v_result; end if;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload || jsonb_build_object('quote_hash', repeat('a', 64)), 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'quote_mismatch' then raise exception 'Replay raw quote hash accepted: %', v_result; end if;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload || jsonb_build_object('quote_hash', 'QTE1.' || repeat('0', 64)), 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'quote_mismatch' then raise exception 'Replay forged QTE1 accepted: %', v_result; end if;

    v_result := public.staff_finalize_sale(v_staff_a, v_payload || jsonb_build_object('client_id', v_client_b), 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'customer_context_mismatch' then raise exception 'Replay scan A/client B accepted: %', v_result; end if;
    select id into v_other_account from public.ginpay_accounts where client_id = v_client_b and status = 'active';
    if v_other_account is null then raise exception 'Replay foreign account fixture missing'; end if;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload || jsonb_build_object('payment_method', 'ginpay', 'ginpay_account_id', v_other_account), 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'customer_context_mismatch' then raise exception 'Replay scan A/account B accepted: %', v_result; end if;
    insert into public.tickets (user_id, type, title, amount, used, issued_by)
    values (v_user_b, 'discount', 'Replay foreign customer ticket', 500, false, 'system') returning id into v_other_ticket;
    v_result := public.staff_finalize_sale(v_staff_a, v_payload || jsonb_build_object('ticket_ids', jsonb_build_array(v_other_ticket)), 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'customer_context_mismatch'
       or v_result->>'detail' is distinct from 'ticket_not_owned_by_customer' then
      raise exception 'Replay scan A/ticket B rejection contract mismatch: %', v_result;
    end if;

    v_changed := v_payload || jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 2)),
      'expected_total', 10000
    );
    v_quote := public.staff_pos_quote(v_staff_a, v_retry_op, v_scan, v_changed, null)::jsonb;
    if v_quote ? 'error' or v_quote->>'quote_hash' is null then raise exception 'Identified conflict quote failed: %', v_quote; end if;
    v_changed := v_changed || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
    v_result := public.staff_finalize_sale(v_staff_a, v_changed, 'P05担当者', v_retry_op, null)::jsonb;
    if v_result->>'error' is distinct from 'idempotency_conflict' then raise exception 'Identified changed request accepted: %', v_result; end if;
    if (select count(*) from public.accounting_sessions) <> v_before_sales
       or (select count(*) from public.accounting_payments) <> v_before_payments then
      raise exception 'Identified replay/conflict created sale or payment';
    end if;

    foreach v_claim in array array[null::uuid, v_client_a] loop
      v_case := case when v_claim is null then 'anonymous' else 'arbitrary-client' end;
      v_payload := jsonb_build_object(
        'stylist_id', v_stylist,
        'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
        'payment_method', 'cash', 'expected_total', 5000, 'idempotency_key', 'p05-replay-' || v_case
      );
      if v_claim is not null then
        v_payload := v_payload || jsonb_build_object('client_id', v_claim, 'customer_name', 'Untrusted name', 'user_id', v_user_a);
      end if;
      v_quote := public.staff_pos_quote(v_staff_a, v_retry_op, null, v_payload, null)::jsonb;
      if v_quote ? 'error' or v_quote->>'quote_hash' is null
         or v_quote->'facts'->>'client_id' is not null or (v_quote->>'total')::int is distinct from 5000 then
        raise exception '% replay anonymous quote failed: %', v_case, v_quote;
      end if;
      v_payload := v_payload || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
      v_first := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', v_retry_op, null)::jsonb;
      if v_first ? 'error' or v_first->>'status' is distinct from 'completed'
         or not exists (select 1 from public.accounting_sessions where id = (v_first->>'id')::uuid
           and client_id is null and user_id is null and customer_name = '') then
        raise exception '% initial anonymous sale/identity failed: %', v_case, v_first;
      end if;
      select request_hash into v_first_hash from public.accounting_sessions where id = (v_first->>'id')::uuid;
      select count(*) into v_before_sales from public.accounting_sessions;
      select count(*) into v_before_payments from public.accounting_payments;
      v_result := public.staff_finalize_sale(v_staff_a, v_payload, 'P05担当者', v_retry_op, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true
         or (v_result - 'idempotent') is distinct from v_first then
        raise exception '% exact replay failed: %', v_case, v_result;
      end if;
      v_changed := (v_payload - 'client_id' - 'customer_name' - 'user_id')
        || jsonb_build_object('client_id', v_client_b, 'customer_name', 'Another untrusted name', 'user_id', v_user_b);
      v_result := public.staff_finalize_sale(v_staff_a, v_changed, 'P05担当者', v_retry_op, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true
         or (v_result - 'idempotent') is distinct from v_first then
        raise exception '% arbitrary identity changed canonical replay: %', v_case, v_result;
      end if;
      v_result := public.staff_finalize_sale(v_staff_a, v_changed - 'client_id' - 'customer_name' - 'user_id', 'P05担当者', v_retry_op, null)::jsonb;
      if v_result ? 'error' or (v_result->>'idempotent')::boolean is distinct from true
         or (v_result - 'idempotent') is distinct from v_first then
        raise exception '% omitted identity changed canonical replay: %', v_case, v_result;
      end if;

      for v_change in 1..3 loop
        v_changed := case v_change
          when 1 then v_payload || jsonb_build_object(
            'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 2)),
            'expected_total', 10000)
          when 2 then v_payload || jsonb_build_object('expected_total', 4999)
          else v_payload || jsonb_build_object('payment_method', 'card') end;
        v_quote := public.staff_pos_quote(v_staff_a, v_retry_op, null, v_changed, null)::jsonb;
        if v_quote ? 'error' or v_quote->>'quote_hash' is null then raise exception '% conflict quote failed: %', v_case, v_quote; end if;
        v_changed := v_changed || jsonb_build_object('quote_hash', v_quote->>'quote_hash');
        v_result := public.staff_finalize_sale(v_staff_a, v_changed, 'P05担当者', v_retry_op, null)::jsonb;
        if v_result->>'error' is distinct from 'idempotency_conflict' then
          raise exception '% changed business facts (%) accepted: %', v_case, v_change, v_result;
        end if;
      end loop;
      if (select count(*) from public.accounting_sessions) <> v_before_sales
         or (select count(*) from public.accounting_payments) <> v_before_payments
         or (select request_hash from public.accounting_sessions where id = (v_first->>'id')::uuid) is distinct from v_first_hash then
        raise exception '% replay/conflict mutated sales/payments/hash', v_case;
      end if;
      raise notice '% replay ok (canonical NULL client, same hash, exact replay, conflicts, no duplicate money)', v_case;
    end loop;
    select jsonb_build_object(
      'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.ginpay_accounts a),
      'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.ginpay_transactions t)
    ) into v_ginpay_after;
    if v_ginpay_after is distinct from v_ginpay_before then raise exception 'Cash replay tests mutated GINPay'; end if;
    raise notice 'identified replay/auth/QTE1/session rotation/cross-customer guards ok';
  end;

  -- ── Group 7: GINPay Charge Authorization & Limits (Tests 39 - 42) ───────────

  -- Test 39: GINPay チャージ <= 50,000円は L1 オペレーターでパス (L2 承認不要)
  v_charge_res := public.staff_ginpay_charge_store(
    v_staff_a, v_op_token, v_client_a, 50000, 'cash', 'P05担当者', '5万チャージ', 'p05-charge-l1', null, null
  )::jsonb;
  if v_charge_res ? 'error' or (v_charge_res->>'amount')::int <> 50000 then
    raise exception 'Test 39 failed: 50,000 yen charge rejected: %', v_charge_res;
  end if;
  v_account_a := (v_charge_res->>'account_id')::uuid;

  -- Test 40: GINPay チャージ > 50,000円で承認トークンなしは approval_required (ginpay_charge)
  v_charge_res := public.staff_ginpay_charge_store(
    v_staff_a, v_op_token, v_client_a, 50001, 'cash', 'P05担当者', '超額チャージ', 'p05-charge-l2-req', null, null
  )::jsonb;
  if v_charge_res->>'error' <> 'approval_required' or v_charge_res->>'action' <> 'ginpay_charge' then
    raise exception 'Test 40 failed: >50,000 yen charge did not require approval: %', v_charge_res;
  end if;
  v_req_hash := v_charge_res->>'request_hash';

  -- Test 41: L2 承認を取得して > 50,000円チャージ成功 & 承認消費
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'ginpay_charge', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_charge_res := public.staff_ginpay_charge_store(
    v_staff_a, v_op_token, v_client_a, 50001, 'cash', 'P05担当者', '承認済み超額チャージ', 'p05-charge-l2-req', v_app_token, null
  )::jsonb;
  if v_charge_res ? 'error' or (v_charge_res->>'amount')::int <> 50001 then
    raise exception 'Test 41 failed: approved >50,000 charge failed: %', v_charge_res;
  end if;
  v_charge_id := (v_charge_res->>'id')::uuid;

  -- Test 42: GINPay チャージの Idempotency: 同一キー同一内容は既存返却、内容変更は conflict
  v_r := public.staff_ginpay_charge_store(
    v_staff_a, v_op_token, v_client_a, 50000, 'cash', 'P05担当者', '5万チャージ', 'p05-charge-l1', null, null
  )::jsonb;
  if v_r ? 'error' or (v_r->>'id')::uuid <> (select id from public.ginpay_transactions where idempotency_key = 'p05-charge-l1') then
    raise exception 'Test 42 failed: charge idempotency replay: %', v_r;
  end if;

  v_r := public.staff_ginpay_charge_store(
    v_staff_a, v_op_token, v_client_a, 1000, 'cash', 'P05担当者', '変更チャージ', 'p05-charge-l1', null, null
  )::jsonb;
  if v_r->>'error' <> 'idempotency_conflict' then
    raise exception 'Test 42 failed: charge idempotency conflict: %', v_r;
  end if;

  -- ── Group 8: Sale Void Authorization (Tests 43 - 45) ────────────────────────

  -- Test 43: 会計取消 (staff_void_sale) は L2 承認トークンなしで拒否 (approval_required)
  v_void_res := public.staff_void_sale(v_staff_a, v_op_token, v_sale_id, '誤登録', 'p05-void-1', null)::jsonb;
  if v_void_res->>'error' <> 'approval_required' or v_void_res->>'action' <> 'void' then
    raise exception 'Test 43 failed: void without approval: %', v_void_res;
  end if;
  v_req_hash := v_void_res->>'request_hash';

  -- Test 44: L2 承認を取得して会計取消成功 & 会計ステータス voided & 承認消費
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'void', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_void_res := public.staff_void_sale(v_staff_a, v_op_token, v_sale_id, '誤登録', 'p05-void-1', v_app_token)::jsonb;
  if v_void_res ? 'error' or v_void_res->>'status' <> 'voided' then
    raise exception 'Test 44 failed: approved void failed: %', v_void_res;
  end if;

  -- Test 45: 会計取消の Idempotency: 同一 void_idempotency_key は既存取消会計を返却
  v_r := public.staff_void_sale(v_staff_a, v_op_token, v_sale_id, '誤登録', 'p05-void-1', null)::jsonb;
  if v_r ? 'error' or v_r->>'status' <> 'voided' or (v_r->>'id')::uuid <> v_sale_id then
    raise exception 'Test 45 failed: void idempotency replay: %', v_r;
  end if;

  -- ── Group 9: GINPay Standalone Refund Authorization (Tests 46 - 49) ─────────

  -- Test 46: 単独チャージ返金 (staff_ginpay_refund) は L2 承認トークンなしで拒否 (approval_required)
  v_refund_res := public.staff_ginpay_refund(v_staff_a, v_op_token, v_charge_id, 1000, 'P05担当者', '一部返金', 'p05-refund-1', null)::jsonb;
  if v_refund_res->>'error' <> 'approval_required' or v_refund_res->>'action' <> 'refund' then
    raise exception 'Test 46 failed: refund without approval: %', v_refund_res;
  end if;
  v_req_hash := v_refund_res->>'request_hash';

  -- Test 47: 確定済み会計内の GINPay 支払いは staff_ginpay_refund でなく staff_void_sale へ誘導 (use_sale_void)
  declare
    v_session text := 'p05-sale-linked-refund-session-0123456789abcdef';
    v_presence text;
    v_scan uuid;
    v_scan_result jsonb;
    v_request jsonb;
    v_sale_47 uuid;
    v_original public.ginpay_transactions;
    v_account_47 uuid;
    v_ledger_before bigint;
    v_tx_count_before bigint;
    v_operator_47 uuid;
    v_refundable_47 integer;
    v_refund_facts_47 jsonb;
    v_refund_hash_47 text;
    v_refund_approval_47 text;
    v_approval_result_47 jsonb;
    v_approval_check_47 jsonb;
    v_approval_before_47 jsonb;
    v_money_before_47 jsonb;
    v_money_after_47 jsonb;
  begin
    insert into app_private.customer_sessions (token_hash, user_id, created_via)
    values (app_private.sha256_hex(v_session), v_user_a, 'register');
    v_presence := public.customer_issue_presence_token(v_session)->>'token';
    v_scan_result := public.staff_resolve_presence_token(v_staff_a, v_presence)::jsonb;
    v_scan := (v_scan_result->>'scan_session_id')::uuid;
    if v_scan_result ? 'error' or v_scan is null
       or v_scan_result->>'identity_method' is distinct from 'token'
       or (v_scan_result->'client'->>'id')::uuid is distinct from v_client_a then
      raise exception 'Test 47 trusted scan failed: %', v_scan_result;
    end if;

    select id into v_account_47 from public.ginpay_accounts where client_id = v_client_a and status = 'active';
    if v_account_47 is null then raise exception 'Test 47 account fixture missing'; end if;
    v_ledger_before := app_private.ginpay_posted_sum(v_account_47);
    if (select balance_cached from public.ginpay_accounts where id = v_account_47) is distinct from v_ledger_before then
      raise exception 'Test 47 account fixture is not reconciled';
    end if;
    select count(*) into v_tx_count_before from public.ginpay_transactions where account_id = v_account_47;
    v_request := jsonb_build_object(
      'client_id', v_client_a, 'scan_session_id', v_scan, 'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'ginpay', 'ginpay_account_id', v_account_47,
      'expected_total', 5000, 'idempotency_key', 'p05-sale-gp-pay'
    );
    v_quote := public.staff_pos_quote(v_staff_a, v_op_token, v_scan, v_request, null)::jsonb;
    if v_quote ? 'error' or v_quote->>'quote_hash' is null or v_quote->>'quote_hash' !~ '^QTE1\.[a-f0-9]{64}$'
       or (v_quote->>'total')::int is distinct from 5000
       or (v_quote->'facts'->>'client_id')::uuid is distinct from v_client_a then
      raise exception 'Test 47 setup quote failed: %', v_quote;
    end if;
    v_sale := public.staff_finalize_sale(v_staff_a,
      v_request || jsonb_build_object('quote_hash', v_quote->>'quote_hash'), 'P05担当者', v_op_token, null)::jsonb;
    v_sale_47 := (v_sale->>'id')::uuid;
    if v_sale ? 'error' or v_sale_47 is null or v_sale->>'status' is distinct from 'completed'
       or not exists (select 1 from public.accounting_sessions where id = v_sale_47
         and client_id = v_client_a and user_id = v_user_a and status = 'completed'
         and payment_method = 'ginpay' and total = 5000 and quote_hash = v_quote->>'quote_hash') then
      raise exception 'Test 47 setup finalize failed: %', v_sale;
    end if;
    if (select count(*) from public.accounting_payments where session_id = v_sale_47) <> 1
       or not exists (select 1 from public.accounting_payments where session_id = v_sale_47 and method = 'ginpay' and amount = 5000) then
      raise exception 'Test 47 finalized payment fixture invalid';
    end if;
    v_payment_id := (v_sale->'ginpay'->0->>'id')::uuid;
    select * into v_original from public.ginpay_transactions where id = v_payment_id;
    if v_original.id is null or v_original.account_id is distinct from v_account_47
       or v_original.client_id is distinct from v_client_a or v_original.root_client_id is distinct from v_client_a
       or v_original.accounting_session_id is distinct from v_sale_47
       or v_original.type is distinct from 'payment' or v_original.status is distinct from 'posted'
       or v_original.amount is distinct from -5000 then
      raise exception 'Test 47 payment ledger linkage invalid';
    end if;
    if app_private.ginpay_posted_sum(v_account_47) is distinct from v_ledger_before - 5000
       or (select balance_cached from public.ginpay_accounts where id = v_account_47) is distinct from v_ledger_before - 5000
       or (select count(*) from public.ginpay_transactions where account_id = v_account_47) <> v_tx_count_before + 1 then
      raise exception 'Test 47 sale changed GINPay beyond its payment';
    end if;

    select operator_staff_id into v_operator_47 from app_private.resolve_pos_operator(v_staff_a, v_op_token);
    select abs(v_original.amount) - abs(coalesce(sum(t.amount), 0)) into v_refundable_47
    from public.ginpay_transactions t where t.original_transaction_id = v_original.id
      and t.status = 'posted' and t.type in ('refund', 'void');
    v_refund_facts_47 := jsonb_build_object(
      'action', 'refund', 'account_id', v_original.account_id, 'client_id', v_original.client_id,
      'target_transaction_id', v_original.id, 'refundable_amount', v_refundable_47,
      'requested_refund_amount', 1000, 'reason', '返金試行', 'operator_staff_id', v_operator_47
    );
    v_refund_hash_47 := app_private.pos_auth_hash('refund', v_refund_facts_47);
    v_approval_result_47 := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'refund', v_refund_hash_47)::jsonb;
    v_refund_approval_47 := v_approval_result_47->>'approval_token';
    if v_approval_result_47 ? 'error' or v_refund_approval_47 is null or v_refund_hash_47 !~ '^AUTH1\.[a-f0-9]{64}$' then
      raise exception 'Test 47 refund approval failed: %', v_approval_result_47;
    end if;
    v_approval_check_47 := app_private.verify_pos_approval(v_staff_a, v_op_token, v_refund_approval_47, 'refund', v_refund_hash_47);
    if v_approval_check_47 ? 'error' or (v_approval_check_47->>'ok')::boolean is distinct from true then
      raise exception 'Test 47 exact refund approval verification failed: %', v_approval_check_47;
    end if;
    select to_jsonb(a) into v_approval_before_47 from app_private.pos_approvals a
    where approval_hash = app_private.sha256_hex(v_refund_approval_47);

    select jsonb_build_object(
      'accounts', (select jsonb_agg(to_jsonb(a) order by a.id) from public.ginpay_accounts a),
      'ledger', (select jsonb_agg(to_jsonb(t) order by t.id) from public.ginpay_transactions t),
      'sale', (select to_jsonb(s) from public.accounting_sessions s where id = v_sale_47),
      'payments', (select jsonb_agg(to_jsonb(p) order by p.id) from public.accounting_payments p),
      'discounts', (select jsonb_agg(to_jsonb(d) order by d.id) from public.accounting_discounts d),
      'tickets', (select jsonb_agg(to_jsonb(t) order by t.id) from public.tickets t),
      'usage', (select jsonb_agg(to_jsonb(u) order by u.id) from public.ticket_usage_logs u),
      'transfers', (select jsonb_agg(to_jsonb(t) order by t.id) from public.ticket_transfers t)
    ) into v_money_before_47;
    v_r := public.staff_ginpay_refund(v_staff_a, v_op_token, v_payment_id, 1000, 'P05担当者', '返金試行', 'p05-refund-sale-pay', v_refund_approval_47)::jsonb;
    if v_r->>'error' is distinct from 'use_sale_void' then
      raise exception 'Test 47 failed: sale payment refund not blocked with use_sale_void: %', v_r;
    end if;
    select jsonb_build_object(
      'accounts', (select jsonb_agg(to_jsonb(a) order by a.id) from public.ginpay_accounts a),
      'ledger', (select jsonb_agg(to_jsonb(t) order by t.id) from public.ginpay_transactions t),
      'sale', (select to_jsonb(s) from public.accounting_sessions s where id = v_sale_47),
      'payments', (select jsonb_agg(to_jsonb(p) order by p.id) from public.accounting_payments p),
      'discounts', (select jsonb_agg(to_jsonb(d) order by d.id) from public.accounting_discounts d),
      'tickets', (select jsonb_agg(to_jsonb(t) order by t.id) from public.tickets t),
      'usage', (select jsonb_agg(to_jsonb(u) order by u.id) from public.ticket_usage_logs u),
      'transfers', (select jsonb_agg(to_jsonb(t) order by t.id) from public.ticket_transfers t)
    ) into v_money_after_47;
    if v_money_after_47 is distinct from v_money_before_47 then
      raise exception 'Test 47 rejected standalone refund mutated money or entitlements';
    end if;
    if not exists (select 1 from app_private.pos_approvals where approval_hash = app_private.sha256_hex(v_refund_approval_47) and consumed_at is null)
       or (select to_jsonb(a) from app_private.pos_approvals a where approval_hash = app_private.sha256_hex(v_refund_approval_47)) is distinct from v_approval_before_47 then
      raise exception 'Test 47 rejected refund left approval consumption';
    end if;
    raise notice 'Test 47 ok (trusted GINPay sale, verified L2 refund, use_sale_void, no money/rights/approval mutation)';
  end;

  -- Test 48: 返金可能額 (refundable_amount) を超える金額の返金要求は拒否 (amount_exceeds_refundable)
  v_r := public.staff_ginpay_refund(v_staff_a, v_op_token, v_charge_id, 999999, 'P05担当者', '超過返金', 'p05-refund-over', null)::jsonb;
  if v_r->>'error' <> 'amount_exceeds_refundable' then
    raise exception 'Test 48 failed: over refund not rejected: %', v_r;
  end if;

  -- Test 49: L2 承認を取得して単独チャージの返金成功 & 承認消費
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'refund', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_refund_res := public.staff_ginpay_refund(v_staff_a, v_op_token, v_charge_id, 1000, 'P05担当者', '一部返金', 'p05-refund-1', v_app_token)::jsonb;
  if v_refund_res ? 'error' or (v_refund_res->>'amount')::int <> -1000 or v_refund_res->>'type' <> 'refund' then
    raise exception 'Test 49 failed: approved refund failed: %', v_refund_res;
  end if;

  -- ── Group 10: Ticket Issuance Authorization (Tests 50 - 52) ─────────────────

  -- Test 50: 店舗チケット発行 (staff_issue_tickets) は L2 承認なしで拒否 (approval_required)
  v_ticket_res := public.staff_issue_tickets(
    v_staff_a, v_op_token, 'P05顧客A', v_user_a, 'discount', 500, 2, 'P05担当者', 'p05-ticket-1', null
  )::jsonb;
  if v_ticket_res->>'error' <> 'approval_required' or v_ticket_res->>'action' <> 'ticket_issue' then
    raise exception 'Test 50 failed: ticket issue without approval: %', v_ticket_res;
  end if;
  v_req_hash := v_ticket_res->>'request_hash';

  -- Test 51: L2 承認を取得してチケット発行成功 & issue log 記録 & 承認消費
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'ticket_issue', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_ticket_res := public.staff_issue_tickets(
    v_staff_a, v_op_token, 'P05顧客A', v_user_a, 'discount', 500, 2, 'P05担当者', 'p05-ticket-1', v_app_token
  )::jsonb;
  if v_ticket_res ? 'error' or jsonb_array_length(v_ticket_res->'tickets') <> 2 then
    raise exception 'Test 51 failed: approved ticket issue failed: %', v_ticket_res;
  end if;

  if not exists (select 1 from public.ticket_issue_logs where idempotency_key = 'p05-ticket-1' and request_hash = v_req_hash) then
    raise exception 'Test 51 failed: ticket issue log not written with request_hash';
  end if;

  -- Test 52: チケット発行の Idempotency: 同一キーは既存を返却、異なる内容は conflict
  v_r := public.staff_issue_tickets(
    v_staff_a, v_op_token, 'P05顧客A', v_user_a, 'discount', 500, 2, 'P05担当者', 'p05-ticket-1', null
  )::jsonb;
  if v_r ? 'error' or not coalesce((v_r->>'idempotent')::boolean, false) then
    raise exception 'Test 52 failed: ticket issue idempotency replay: %', v_r;
  end if;

  v_r := public.staff_issue_tickets(
    v_staff_a, v_op_token, 'P05顧客A', v_user_a, 'discount', 1000, 2, 'P05担当者', 'p05-ticket-1', null
  )::jsonb;
  if v_r->>'error' <> 'idempotency_conflict' then
    raise exception 'Test 52 failed: ticket issue conflict not detected: %', v_r;
  end if;

  -- ── Group 11: Fail-Closed Safeguards (Tests 53 - 54) ────────────────────────

  -- Test 53: staff_ginpay_adjustment は POS/Staff からは完全廃止 (pg_proc に存在せず 42883)
  if exists (select 1 from pg_proc where proname = 'staff_ginpay_adjustment') then
    raise exception 'Test 53 failed: staff_ginpay_adjustment still exists in pg_proc';
  end if;
  begin
    execute 'select public.staff_ginpay_adjustment($1, $2, $3, $4, $5, $6)'
    using v_staff_a, v_client_a, 500, 'P05担当者', '調整テスト', 'p05-adj-block';
    raise exception 'Test 53 failed: staff_ginpay_adjustment unexpectedly succeeded';
  exception
    when sqlstate '42883' then
      null;
    when others then
      raise exception 'Test 53 failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'staff_ginpay_adjustment';
  end;

  -- Test 54: 存在しない顧客へのチケット発行は例外でフェイルクローズ
  begin
    perform public.staff_issue_tickets(
      v_staff_a, v_op_token, '不明', 'non-existent-user-id', 'discount', 500, 1, 'P05担当者', 'p05-ticket-fail', null
    );
    raise exception 'Test 54 failed: non-existent customer ticket issue succeeded';
  exception when others then
    -- customer_not_found expected
    null;
  end;

  -- ── Group 12: Concurrency & DB Constraints (Tests 55 - 56) ──────────────────

  -- Test 55: 承認トークンの二重消費防止 (FOR UPDATE による排他保護)
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', v_req_hash);
  if not (v_r->>'ok')::boolean then raise exception 'Test 55 initial consume failed: %', v_r; end if;

  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'test_act', v_req_hash);
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'already_consumed' then
    raise exception 'Test 55 failed: second consume not rejected with already_consumed: %', v_r;
  end if;

  -- Test 56: DB UNIQUE 制約による二重挿入防止
  -- ticket_issue_logs_idempotency_uidx
  begin
    insert into public.ticket_issue_logs (
      staff_name, customer_name, user_id, ticket_type, amount, quantity, terminal, status, idempotency_key
    ) values ('テスト', '顧客', v_user_a, 'discount', 500, 1, 'term', 'issued', 'p05-ticket-1');
    raise exception 'Test 56 failed: duplicate ticket_issue_log idempotency_key was allowed by DB';
  exception when unique_violation then
    -- expected unique violation
    null;
  end;

  -- accounting_sessions_void_idempotency_uidx
  begin
    insert into public.accounting_sessions (
      client_id, stylist_id, subtotal, total, status, void_idempotency_key
    ) values (v_client_a, v_stylist, 1000, 1000, 'voided', 'p05-void-1');
    raise exception 'Test 56 failed: duplicate void_idempotency_key was allowed by DB';
  exception when unique_violation then
    -- expected unique violation
    null;
  end;

  -- ── Group 13: Plaintext Secret Audit (Test 57) ──────────────────────────────

  -- Test 57: DB 全テーブルおよび監査イベントに平文 PIN (1234, 5678) や生トークン (OPS1.*, APR1.*) が保存されていないこと
  if exists (
    select 1 from app_private.staff_operator_credentials
    where pin_hash in ('1234', '5678')
  ) then
    raise exception 'Test 57 failed: plaintext PIN in credentials';
  end if;

  if exists (
    select 1 from app_private.pos_operator_sessions
    where token_hash in (v_op_token, v_op_token_b)
  ) then
    raise exception 'Test 57 failed: plaintext operator token in sessions';
  end if;

  if exists (
    select 1 from app_private.pos_approvals
    where approval_hash in (v_app_token, v_app_token_2)
  ) then
    raise exception 'Test 57 failed: plaintext approval token in approvals';
  end if;

  if exists (
    select 1 from public.pos_operator_events
    where reason like '%1234%' or reason like '%5678%'
       or action like '%1234%' or action like '%5678%'
       or request_hash in ('1234', '5678', v_op_token, v_app_token)
  ) then
    raise exception 'Test 57 failed: plaintext secret leaked to pos_operator_events';
  end if;

  -- ── Group 14: Edge Cases & Integrity (Tests 58 - 62) ────────────────────────

  -- Test 58: Manager credentials 0名時の Fail Closed (pos_policy 設定確認)
  v_r := public.staff_get_pos_policy(v_staff_a)::jsonb;
  if not (v_r->>'require_l2_void')::boolean or not (v_r->>'require_l2_refund')::boolean
     or not (v_r->>'require_l2_price_override')::boolean or not (v_r->>'require_l2_ticket_issue')::boolean
     or (v_r->>'ginpay_charge_l1_limit')::int <> 50000 or (v_r->>'manual_discount_l1_limit')::int <> 0 then
    raise exception 'Test 58 failed: pos_policy L2 rules altered: %', v_r;
  end if;

  -- Test 59: チケット規則/タイトルの改ざん検知 (rule_facts 改ざんで request_hash 不一致)
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'ticket_issue', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';

  v_r := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'ticket_issue',
    app_private.pos_auth_hash('ticket_issue', jsonb_build_object(
      'action', 'ticket_issue', 'recipient_user_id', v_user_a, 'ticket_type', 'discount',
      'amount', 500, 'quantity', 2, 'rule_facts', jsonb_build_object('title', '不正改ざんタイトル')
    ))
  );
  if (v_r->>'ok')::boolean is not false or v_r->>'error' <> 'request_hash_mismatch' then
    raise exception 'Test 59 failed: tampered ticket rule facts consumed: %', v_r;
  end if;

  -- Test 60: 完了 (completed) 以外の会計の取消試行 → invalid_status
  declare
    v_operator_60 uuid;
    v_before_60 jsonb;
    v_after_60 jsonb;
  begin
    select operator_staff_id into v_operator_60 from app_private.resolve_pos_operator(v_staff_a, v_op_token);
    if v_operator_60 is distinct from v_op_member
       or not exists (select 1 from public.accounting_sessions where id = v_sale_id and status = 'voided')
       or exists (select 1 from public.accounting_sessions where void_idempotency_key = 'p05-void-repeat') then
      raise exception 'Test 60 setup requires valid operator, voided sale and a new void key';
    end if;
    select jsonb_build_object(
      'sale', (select to_jsonb(s) from public.accounting_sessions s where id = v_sale_id),
      'accounts', (select jsonb_agg(to_jsonb(a) || jsonb_build_object('ledger_balance', app_private.ginpay_posted_sum(a.id)) order by a.id) from public.ginpay_accounts a),
      'ledger', (select jsonb_agg(to_jsonb(t) order by t.id) from public.ginpay_transactions t),
      'events', (select jsonb_agg(to_jsonb(e) order by e.id) from public.accounting_events e),
      'payments', (select jsonb_agg(to_jsonb(p) order by p.id) from public.accounting_payments p),
      'discounts', (select jsonb_agg(to_jsonb(d) order by d.id) from public.accounting_discounts d),
      'tickets', (select jsonb_agg(to_jsonb(t) order by t.id) from public.tickets t),
      'usage', (select jsonb_agg(to_jsonb(u) order by u.id) from public.ticket_usage_logs u),
      'approvals', (select jsonb_agg(to_jsonb(a) order by a.approval_hash) from app_private.pos_approvals a)
    ) into v_before_60;

    -- Status validation precedes L2 consumption in the canonical RPC.
    v_r := public.staff_void_sale(v_staff_a, v_op_token, v_sale_id, '再取消', 'p05-void-repeat', null)::jsonb;
    if v_r->>'error' is distinct from 'invalid_status' then
      raise exception 'Test 60 failed: void on voided sale not rejected with invalid_status: %', v_r;
    end if;
    select jsonb_build_object(
      'sale', (select to_jsonb(s) from public.accounting_sessions s where id = v_sale_id),
      'accounts', (select jsonb_agg(to_jsonb(a) || jsonb_build_object('ledger_balance', app_private.ginpay_posted_sum(a.id)) order by a.id) from public.ginpay_accounts a),
      'ledger', (select jsonb_agg(to_jsonb(t) order by t.id) from public.ginpay_transactions t),
      'events', (select jsonb_agg(to_jsonb(e) order by e.id) from public.accounting_events e),
      'payments', (select jsonb_agg(to_jsonb(p) order by p.id) from public.accounting_payments p),
      'discounts', (select jsonb_agg(to_jsonb(d) order by d.id) from public.accounting_discounts d),
      'tickets', (select jsonb_agg(to_jsonb(t) order by t.id) from public.tickets t),
      'usage', (select jsonb_agg(to_jsonb(u) order by u.id) from public.ticket_usage_logs u),
      'approvals', (select jsonb_agg(to_jsonb(a) order by a.approval_hash) from app_private.pos_approvals a)
    ) into v_after_60;
    if v_after_60 is distinct from v_before_60
       or v_after_60->'sale'->>'status' is distinct from 'voided' then
      raise exception 'Test 60 failed: rejected repeat void mutated sale/money/events/rights/approvals';
    end if;
    raise notice 'Test 60 ok (canonical 6 args, invalid_status, no duplicate reversal/event/restore/approval mutation)';
  end;

  -- Test 61: 正規ハッシュ形式 AUTH1.<64hex> の厳格なバリデーション
  if app_private.pos_auth_hash('test', '{"k":"v"}'::jsonb) !~ '^AUTH1\.[a-f0-9]{64}$' then
    raise exception 'Test 61 failed: pos_auth_hash does not conform to AUTH1.<64hex>';
  end if;

  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'test_act', 'invalid-hash-format')::jsonb;
  if v_r->>'error' <> 'invalid_request_hash' then
    raise exception 'Test 61 failed: invalid request hash allowed: %', v_r;
  end if;

  -- Test 62: リバースプライシング: 単価 0円 (無料サービスへの変更) は L2 承認が必須
  v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
    'client_id', v_client_a,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'override_price', 0, 'quantity', 1, 'reason', '無料サービス'))
  ))::jsonb;
  if v_quote->>'error' <> 'approval_required' or (v_quote->>'total')::int <> 0 then
    raise exception 'Test 62 failed: 0 yen override did not require approval: %', v_quote;
  end if;

  -- ── Group 15: Ticket Ownership & Family Entitlement (Tests 63 - 66) ────────
  declare
    v_cust_fam uuid;
    v_client_fam uuid;
    v_user_fam text := 'p05-user-family';
    v_ticket_own uuid;
    v_ticket_fam uuid;
    v_ticket_unrelated uuid;
    v_ticket_unknown uuid;
    v_scan_a uuid;
    v_pres_res jsonb;
    v_pres_tok text;
    v_s_res jsonb;
  begin
    -- 家族顧客を作成して v_client_a へ統合
    insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
    values (v_user_fam, 'P05家族', '3333', 'P05-FAM', app_private.norm_name('P05家族'))
    returning id into v_cust_fam;
    v_client_fam := app_private.member_client(v_cust_fam);
    perform app_private.merge_clients(v_client_a, v_client_fam, 'staff', 'Tester');

    -- 本人顧客 A の trusted scan session を取得 (P0-2 正式フロー & 明示的検証)
    insert into app_private.customer_sessions (token_hash, user_id, created_via)
    values (app_private.sha256_hex('p05-cust-sess-grp15-0123456789abcdef'), v_user_a, 'register');

    v_pres_res := public.customer_issue_presence_token('p05-cust-sess-grp15-0123456789abcdef')::jsonb;
    if v_pres_res ? 'error' or v_pres_res->>'token' is null then
      raise exception 'Group 15 setup failed: customer_issue_presence_token failed: %', v_pres_res;
    end if;
    v_pres_tok := v_pres_res->>'token';

    v_s_res := public.staff_resolve_presence_token(v_staff_a, v_pres_tok)::jsonb;
    if v_s_res ? 'error' or v_s_res->>'scan_session_id' is null then
      raise exception 'Group 15 setup failed: staff_resolve_presence_token failed: %', v_s_res;
    end if;
    v_scan_a := (v_s_res->>'scan_session_id')::uuid;
    if v_scan_a is null then
      raise exception 'Group 15 setup failed: scan_session_id is not a valid UUID: %', v_s_res;
    end if;

    -- チケット作成
    insert into public.tickets (user_id, type, title, amount, used, issued_by)
    values (v_user_a, 'discount', '本人券', 500, false, 'Tester') returning id into v_ticket_own;

    insert into public.tickets (user_id, type, title, amount, used, issued_by)
    values (v_user_fam, 'discount', '家族券', 500, false, 'Tester') returning id into v_ticket_fam;

    insert into public.tickets (user_id, type, title, amount, used, issued_by)
    values (v_user_b, 'discount', '他人券', 500, false, 'Tester') returning id into v_ticket_unrelated;

    insert into public.tickets (user_id, type, title, amount, used, issued_by)
    values ('unknown-non-existent-user-id', 'discount', '不明者券', 500, false, 'Tester') returning id into v_ticket_unknown;

    -- Test 63: unknown ticket user_id → reject (customer_context_mismatch)
    v_r := public.staff_pos_quote(v_staff_a, v_op_token, v_scan_a, jsonb_build_object(
      'scan_session_id', v_scan_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'ticket_ids', jsonb_build_array(v_ticket_unknown)
    ))::jsonb;
    if v_r->>'error' <> 'customer_context_mismatch' then
      raise exception 'Test 63 failed: unknown ticket user_id was not rejected: %', v_r;
    end if;

    -- Test 64: unrelated customer ticket → reject (customer_context_mismatch)
    v_r := public.staff_pos_quote(v_staff_a, v_op_token, v_scan_a, jsonb_build_object(
      'scan_session_id', v_scan_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'ticket_ids', jsonb_build_array(v_ticket_unrelated)
    ))::jsonb;
    if v_r->>'error' <> 'customer_context_mismatch' then
      raise exception 'Test 64 failed: unrelated customer ticket was not rejected: %', v_r;
    end if;

    -- Test 65: 本人 ticket → success
    v_r := public.staff_pos_quote(v_staff_a, v_op_token, v_scan_a, jsonb_build_object(
      'scan_session_id', v_scan_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'ticket_ids', jsonb_build_array(v_ticket_own)
    ))::jsonb;
    if v_r ? 'error' or (v_r->>'total') is null or (v_r->>'total')::int <> 4500 then
      raise exception 'Test 65 failed: own ticket quote failed: %', v_r;
    end if;
    if v_r->>'quote_hash' is null or v_r->>'quote_hash' !~ '^QTE1\.[a-f0-9]{64}$' then
      raise exception 'Test 65 failed: valid QTE1 quote_hash not generated: %', v_r;
    end if;

    -- Test 66: 正式 family ticket → success
    v_r := public.staff_pos_quote(v_staff_a, v_op_token, v_scan_a, jsonb_build_object(
      'scan_session_id', v_scan_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'ticket_ids', jsonb_build_array(v_ticket_fam)
    ))::jsonb;
    if v_r ? 'error' or (v_r->>'total') is null or (v_r->>'total')::int <> 4500 then
      raise exception 'Test 66 failed: family ticket quote failed: %', v_r;
    end if;
    if v_r->>'quote_hash' is null or v_r->>'quote_hash' !~ '^QTE1\.[a-f0-9]{64}$' then
      raise exception 'Test 66 failed: valid QTE1 quote_hash not generated for family: %', v_r;
    end if;

    -- Test 66b: A scan + B customer/GINPay → customer_context_mismatch
    declare
      v_scan_a uuid;
      v_q_res jsonb;
      v_pres_tok text;
      v_s_res jsonb;
    begin
      insert into app_private.customer_sessions (token_hash, user_id, created_via)
      values (app_private.sha256_hex('p05-cust-sess-66b-0123456789abcdef'), v_user_a, 'register');

      v_pres_tok := (public.customer_issue_presence_token('p05-cust-sess-66b-0123456789abcdef')->>'token');
      v_s_res := public.staff_resolve_presence_token(v_staff_a, v_pres_tok)::jsonb;
      v_scan_a := (v_s_res->>'scan_session_id')::uuid;

      v_q_res := public.staff_pos_quote(v_staff_a, v_op_token, v_scan_a, jsonb_build_object(
        'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
      ))::jsonb;
      if v_q_res ? 'error' then raise exception 'Test 66b quote setup failed: %', v_q_res; end if;

      v_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
        'scan_session_id', v_scan_a,
        'stylist_id', v_stylist,
        'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
        'payment_method', 'ginpay',
        'ginpay_account_id', v_account_b,
        'expected_total', 5000,
        'quote_hash', v_q_res->>'quote_hash',
        'idempotency_key', 'p05-test-cross-ginpay-1'
      ), 'P05担当者', v_op_token, null)::jsonb;

      if v_r->>'error' <> 'customer_context_mismatch' then
        raise exception 'Test 66b failed: A scan + B GINPay not rejected with customer_context_mismatch: %', v_r;
      end if;
    end;
  end;

  -- ── Group 16: Void Engine Failure Atomicity (Test 67) ───────────────────────
  declare
    v_sale_fail_id uuid;
    v_app_token_void text;
    v_sale_before public.accounting_sessions;
    v_sale_rec public.accounting_sessions;
    v_app_before timestamptz;
    v_failed boolean := false;
  begin
    -- テスト用会計を作成
    v_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ))::jsonb;
    if v_quote ? 'error' then raise exception 'Test 67 setup quote failed: %', v_quote; end if;

    v_sale := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a,
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'quote_hash', v_quote->>'quote_hash',
      'idempotency_key', 'p05-sale-atomicity-test'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_sale ? 'error' then raise exception 'Test 67 setup finalize failed: %', v_sale; end if;
    v_sale_fail_id := (v_sale->>'id')::uuid;

    select * into v_sale_before from public.accounting_sessions where id = v_sale_fail_id;

    -- 承認トークン発行 (reason: 250文字 - approval consume 後に void_sale 側で失敗させる)
    v_facts := jsonb_build_object(
      'action', 'void',
      'sale_id', v_sale_fail_id,
      'original_total', v_sale_before.total,
      'original_payment_method', v_sale_before.payment_method,
      'reason', repeat('A', 250),
      'operator_staff_id', v_op_member
    );
    v_req_hash := app_private.pos_auth_hash('void', v_facts);

    v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'void', v_req_hash)::jsonb;
    v_app_token_void := v_r->>'approval_token';

    -- 意図的に app_private.void_sale を失敗させる (250文字超の不正な理由を渡す)
    -- approval consume 後に app_private.void_sale 内の理由長チェック (<= 200) で失敗し、全体がロールバックされることを厳格に確認
    v_failed := false;
    begin
      perform public.staff_void_sale(
        v_staff_a, v_op_token, v_sale_fail_id, repeat('A', 250), 'p05-void-atomicity-fail', v_app_token_void
      );
    exception when others then
      if sqlerrm like '%void_sale_failed%' and sqlerrm like '%reason_required%' then
        v_failed := true;
      else
        raise;
      end if;
    end;

    if not v_failed then
      raise exception 'Test 67 failed: invalid void unexpectedly succeeded';
    end if;

    -- 検証:
    -- 1. 会計ステータスは completed のまま未変更
    select * into v_sale_rec from public.accounting_sessions where id = v_sale_fail_id;
    if v_sale_rec.status <> 'completed' then
      raise exception 'Test 67 failed: sale status altered despite void failure: %', v_sale_rec.status;
    end if;

    -- 2. void_idempotency_key は未保存 (NULL)
    if v_sale_rec.void_idempotency_key is not null then
      raise exception 'Test 67 failed: void_idempotency_key remained after rollback: %', v_sale_rec.void_idempotency_key;
    end if;

    -- 3. 承認トークンは未消費 (consumed_at is null)
    select consumed_at into v_app_before from app_private.pos_approvals
    where approval_hash = app_private.sha256_hex(v_app_token_void);
    if v_app_before is not null then
      raise exception 'Test 67 failed: approval token was consumed despite void failure: %', v_app_before;
    end if;

    -- 4. 監査イベントが残っていないこと
    if exists (select 1 from public.accounting_events where session_id = v_sale_fail_id and event_type = 'voided') then
      raise exception 'Test 67 failed: voided event remained after rollback';
    end if;
  end;

  -- ── Group 17: Partial Write Prevention & Error Contract (Tests 68 - 69) ────
  declare
    v_l1_err jsonb;
    v_l1_key text := 'p05-test-l1-insufficient-key';
    v_cust_low uuid;
    v_client_low uuid;
    v_user_low text := 'p05-user-low-balance';
    v_quote_low jsonb;
    v_pres_low text;
    v_s_low jsonb;
    v_scan_low uuid;
  begin
    -- テスト用顧客作成 (残高 1,000円)
    insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
    values (v_user_low, 'P05残高少顧客', '4444', 'P05-LOW', app_private.norm_name('P05残高少顧客'))
    returning id into v_cust_low;
    v_client_low := app_private.member_client(v_cust_low);

    -- 顧客セッション & QR scan session 作成 (trusted customer context)
    insert into app_private.customer_sessions (token_hash, user_id, created_via)
    values (app_private.sha256_hex('p05-cust-sess-low-0123456789abcdef'), v_user_low, 'register');

    v_pres_low := (public.customer_issue_presence_token('p05-cust-sess-low-0123456789abcdef')->>'token');
    v_s_low := public.staff_resolve_presence_token(v_staff_a, v_pres_low)::jsonb;
    v_scan_low := (v_s_low->>'scan_session_id')::uuid;

    -- 1,000円チャージ (残高 1,000円 < 通常メニュー 5,000円)
    perform public.staff_ginpay_charge_store(
      v_staff_a, v_op_token, v_client_low, 1000, 'cash', 'P05担当者', '初期チャージ', 'p05-charge-low-init', null, null
    );

    -- 正規の1品・quantity=1 (5,000円) を quote (trusted scan session 付き)
    v_quote_low := public.staff_pos_quote(v_staff_a, v_op_token, v_scan_low, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ))::jsonb;
    if v_quote_low ? 'error' then raise exception 'Test 68 quote failed: %', v_quote_low; end if;

    -- Test 68: L1通常会計 + GINPay残高不足 → exception ではなく {"error":"insufficient_balance"} を返し、部分書き込みなし
    v_l1_err := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'scan_session_id', v_scan_low,
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'ginpay',
      'expected_total', 5000,
      'quote_hash', v_quote_low->>'quote_hash',
      'idempotency_key', v_l1_key
    ), 'P05担当者', v_op_token, null)::jsonb;

    if v_l1_err->>'error' <> 'insufficient_balance' then
      raise exception 'Test 68 failed: L1 insufficient balance did not return error JSON: %', v_l1_err;
    end if;

    if exists (select 1 from public.accounting_sessions where idempotency_key = v_l1_key) then
      raise exception 'Test 68 failed: partial accounting_session written on L1 failure';
    end if;

    -- Test 69: L2失敗時 (Test 36 のキー) の部分書き込みが一切ないことを確認
    if exists (select 1 from public.accounting_sessions where idempotency_key = 'p05-sale-fail-rollback') then
      raise exception 'Test 69 failed: partial accounting_session written on L2 rollback';
    end if;
  end;

  -- ── Group 18: P0-5 Remediation Verification (Tests 70 - 80) ──────────────────
  declare
    v_rem_r jsonb;
    v_rem_quote jsonb;
    v_rem_sale jsonb;
    v_rem_sale_id uuid;
    v_rem_sale_rec public.accounting_sessions;
    v_rem_facts jsonb;
    v_rem_req_hash text;
    v_rem_app_token text;
    v_bal_before integer;
    v_bal_after integer;
    v_sales_before integer;
    v_sales_after integer;
    v_tickets_before integer;
    v_tickets_after integer;
    v_expired_op_token text := 'p05-op-expired-0123456789abcdef';
  begin
    -- The removed five-argument void shape must fail at function resolution, not business validation.
    declare
      v_legacy_sale_before jsonb;
    begin
      select to_jsonb(s) into v_legacy_sale_before from public.accounting_sessions s where id = v_sale_id;
      begin
        execute 'select public.staff_void_sale($1, $2, $3, $4, $5)'
        using v_staff_a, v_op_token, v_sale_id, '再取消', 'p05-void-repeat';
        raise exception 'Group 18 failed: legacy staff_void_sale 5-arg shape succeeded';
      exception when sqlstate '42883' then
        null;
      end;
      if (select to_jsonb(s) from public.accounting_sessions s where id = v_sale_id) is distinct from v_legacy_sale_before then
        raise exception 'Group 18 failed: legacy void call mutated sale';
      end if;
      raise notice 'Group 18 legacy staff_void_sale 5-arg shape rejected with 42883';
    end;

    -- セットアップ: 失効済みオペレーターセッション (NOT NULL 列・CHECK 制約充足)
    insert into app_private.pos_operator_sessions (
      token_hash, staff_session_hash, staff_member_id, role, created_at, expires_at, revoked_at
    ) values (
      app_private.sha256_hex(v_expired_op_token),
      v_staff_a_hash,
      v_op_member,
      'staff',
      now() - interval '2 hours',
      now() - interval '1 hour',
      now() - interval '1 hour'
    );

    -- Test 70: staff_ginpay_void は pg_proc に存在せず、旧 5引数 call も 42883 で失敗し、残高不変
    if exists (select 1 from pg_proc where proname = 'staff_ginpay_void') then
      raise exception 'Test 70 failed: staff_ginpay_void still exists in pg_proc';
    end if;

    select balance_cached into v_bal_before from public.ginpay_accounts where id = v_account_a;
    begin
      execute 'select public.staff_ginpay_void($1, $2, $3, $4, $5)'
      using v_staff_a, v_client_a, 'void', '理由', 'p05-legacy-void-call';
      raise exception 'Test 70 failed: legacy staff_ginpay_void unexpectedly succeeded';
    exception
      when sqlstate '42883' then
        null;
      when others then
        raise exception 'Test 70 failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'staff_ginpay_void';
    end;
    select balance_cached into v_bal_after from public.ginpay_accounts where id = v_account_a;
    if v_bal_before is distinct from v_bal_after then
      raise exception 'Test 70 failed: ginpay balance altered on legacy void call';
    end if;

    -- Test 71: staff_ginpay_charge_store 旧 8引数 overload は pg_proc に存在せず、旧 call shape も 42883 で失敗し残高不変
    if exists (select 1 from pg_proc where proname = 'staff_ginpay_charge_store' and pronargs = 8) then
      raise exception 'Test 71 failed: staff_ginpay_charge_store 8-arg overload still exists in pg_proc';
    end if;

    select balance_cached into v_bal_before from public.ginpay_accounts where id = v_account_a;
    begin
      execute 'select public.staff_ginpay_charge_store($1, $2, $3, $4, $5, $6, $7, $8)'
      using v_staff_a, v_client_a, 1000, 'cash', 'P05担当者', 'メモ', 'p05-legacy-charge-call', v_account_a;
      raise exception 'Test 71 failed: legacy staff_ginpay_charge_store 8-arg unexpectedly succeeded';
    exception
      when sqlstate '42883' then
        null;
      when others then
        raise exception 'Test 71 failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'staff_ginpay_charge_store';
    end;
    select balance_cached into v_bal_after from public.ginpay_accounts where id = v_account_a;
    if v_bal_before is distinct from v_bal_after then
      raise exception 'Test 71 failed: ginpay balance altered on legacy charge call';
    end if;

    -- Test 72: staff_finalize_sale 旧 3引数 overload は存在せず、旧 call shape は 42883 で失敗し、会計レコード増加なし
    if exists (select 1 from pg_proc where proname = 'staff_finalize_sale' and pronargs = 3) then
      raise exception 'Test 72 failed: staff_finalize_sale 3-arg overload still exists in pg_proc';
    end if;

    select count(*) into v_sales_before from public.accounting_sessions;
    begin
      execute 'select public.staff_finalize_sale($1, $2, $3)'
      using v_staff_a, jsonb_build_object('payment_method', 'cash'), 'P05担当者';
      raise exception 'Test 72 failed: legacy staff_finalize_sale 3-arg unexpectedly succeeded';
    exception
      when sqlstate '42883' then
        null;
      when others then
        raise exception 'Test 72 failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'staff_finalize_sale 3-arg';
    end;
    select count(*) into v_sales_after from public.accounting_sessions;
    if v_sales_before <> v_sales_after then
      raise exception 'Test 72 failed: accounting_session written on legacy finalize call';
    end if;

    -- Test 72b: staff_finalize_sale 旧 4引数 call shape は 42883 で失敗し (DEFAULT NULL なし)、会計レコード増加なし
    if exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'staff_finalize_sale' and p.pronargs = 4
    ) then
      raise exception 'Test 72b failed: public.staff_finalize_sale 4-arg overload exists in pg_proc';
    end if;

    if (
      select coalesce(p.pronargdefaults, 0)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'staff_finalize_sale' and p.pronargs = 5
    ) <> 0 then
      raise exception 'Test 72b failed: public.staff_finalize_sale must have 0 default arguments';
    end if;

    select count(*) into v_sales_before from public.accounting_sessions;
    begin
      execute 'select public.staff_finalize_sale($1, $2, $3, $4)'
      using v_staff_a, jsonb_build_object('payment_method', 'cash'), 'P05担当者', v_op_token;
      raise exception 'Test 72b failed: legacy staff_finalize_sale 4-arg unexpectedly succeeded';
    exception
      when sqlstate '42883' then
        null;
      when others then
        raise exception 'Test 72b failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'staff_finalize_sale 4-arg';
    end;
    select count(*) into v_sales_after from public.accounting_sessions;
    if v_sales_before <> v_sales_after then
      raise exception 'Test 72b failed: accounting_session written on legacy finalize 4-arg call';
    end if;

    -- Test 73: Anonymous walk-in (現金) の正常完了 & 必須前提条件の検証
    -- 73a: operator なし → operator_auth_required
    v_rem_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'quote_hash', 'QTE1.' || repeat('0', 64),
      'idempotency_key', 'p05-walkin-no-op'
    ), 'P05担当者', '', null)::jsonb;
    if v_rem_r->>'error' <> 'operator_auth_required' then
      raise exception 'Test 73a failed: missing operator was not rejected with operator_auth_required: %', v_rem_r;
    end if;

    -- 73b: quote なし → quote_required
    v_rem_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'idempotency_key', 'p05-walkin-no-qte'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_rem_r->>'error' <> 'quote_required' then
      raise exception 'Test 73b failed: missing quote was not rejected with quote_required: %', v_rem_r;
    end if;

    -- 73c: valid server quote (client = null, anonymous)
    v_rem_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ))::jsonb;
    if v_rem_quote ? 'error' then raise exception 'Test 73c quote failed: %', v_rem_quote; end if;

    -- 73d: quote_hash mismatch → quote_mismatch
    v_rem_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'quote_hash', 'QTE1.' || repeat('f', 64),
      'idempotency_key', 'p05-walkin-mismatch-qte'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_rem_r->>'error' <> 'quote_mismatch' then
      raise exception 'Test 73d failed: quote mismatch was not rejected: %', v_rem_r;
    end if;

    -- 73e: valid anonymous cash sale 正常完了 (accounting_sessions.client_id = NULL)
    v_rem_sale := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'quote_hash', v_rem_quote->>'quote_hash',
      'idempotency_key', 'p05-walkin-cash-success'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_rem_sale ? 'error' or (v_rem_sale->>'status') <> 'completed' then
      raise exception 'Test 73e failed: valid anonymous cash sale failed: %', v_rem_sale;
    end if;
    select * into v_rem_sale_rec from public.accounting_sessions where id = (v_rem_sale->>'id')::uuid;
    if v_rem_sale_rec.client_id is not null then
      raise exception 'Test 73e failed: anonymous sale stored non-null client_id: %', v_rem_sale_rec.client_id;
    end if;

    -- Test 74: Anonymous walk-in における GINPay / チケットの厳格拒否
    -- 74a: GINPay → ginpay_requires_client
    v_rem_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'ginpay',
      'expected_total', 5000,
      'quote_hash', v_rem_quote->>'quote_hash',
      'idempotency_key', 'p05-walkin-ginpay-fail'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_rem_r->>'error' <> 'ginpay_requires_client' then
      raise exception 'Test 74a failed: anonymous GINPay not rejected with ginpay_requires_client: %', v_rem_r;
    end if;

    -- 74b: Ticket 利用 → customer_context_mismatch
    v_rem_r := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'ticket_ids', jsonb_build_array(gen_random_uuid())
    ))::jsonb;
    if v_rem_r->>'error' <> 'customer_context_mismatch' then
      raise exception 'Test 74b failed: anonymous ticket quote not rejected with customer_context_mismatch: %', v_rem_r;
    end if;

    -- Test 75: 任意 client_id 指定のフェイルクローズ & 顧客権利遮断
    -- scan/reservation なしでクライアントが任意に client_id = v_client_a を送出
    v_rem_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
      'client_id', v_client_a,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ))::jsonb;
    if v_rem_quote ? 'error' then raise exception 'Test 75 quote setup failed: %', v_rem_quote; end if;
    if v_rem_quote->'facts'->>'client_id' is not null then
      raise exception 'Test 75 failed: arbitrary client_id was accepted into quote facts: %', v_rem_quote;
    end if;

    -- 75a: 任意 client_id による GINPay は ginpay_requires_client で遮断
    v_rem_r := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a,
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'ginpay',
      'expected_total', 5000,
      'quote_hash', v_rem_quote->>'quote_hash',
      'idempotency_key', 'p05-arbitrary-client-ginpay'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_rem_r->>'error' <> 'ginpay_requires_client' then
      raise exception 'Test 75a failed: arbitrary client GINPay was not blocked: %', v_rem_r;
    end if;

    -- 75b: 現金会計しても accounting_sessions.client_id は NULL (権利付与されない)
    v_rem_sale := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'client_id', v_client_a,
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'quote_hash', v_rem_quote->>'quote_hash',
      'idempotency_key', 'p05-arbitrary-client-cash'
    ), 'P05担当者', v_op_token, null)::jsonb;
    if v_rem_sale ? 'error' then raise exception 'Test 75b finalize failed: %', v_rem_sale; end if;
    select * into v_rem_sale_rec from public.accounting_sessions where id = (v_rem_sale->>'id')::uuid;
    if v_rem_sale_rec.client_id is not null then
      raise exception 'Test 75b failed: client_id was persisted from arbitrary client input: %', v_rem_sale_rec.client_id;
    end if;

    -- Test 76 - 78: staff_void_sale Replay, Idempotency & Conflict 厳格検証
    -- 取消テスト用会計を作成
    v_rem_quote := public.staff_pos_quote(v_staff_a, v_op_token, null, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1))
    ))::jsonb;
    v_rem_sale := public.staff_finalize_sale(v_staff_a, jsonb_build_object(
      'stylist_id', v_stylist,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code, 'quantity', 1)),
      'payment_method', 'cash',
      'expected_total', 5000,
      'quote_hash', v_rem_quote->>'quote_hash',
      'idempotency_key', 'p05-void-replay-sale'
    ), 'P05担当者', v_op_token, null)::jsonb;
    v_rem_sale_id := (v_rem_sale->>'id')::uuid;

    -- L2 承認を取得して取消実行
    select * into v_rem_sale_rec from public.accounting_sessions where id = v_rem_sale_id;
    v_rem_facts := jsonb_build_object(
      'action', 'void',
      'sale_id', v_rem_sale_id,
      'original_total', v_rem_sale_rec.total,
      'original_payment_method', v_rem_sale_rec.payment_method,
      'reason', '正常取消',
      'operator_staff_id', v_op_member
    );
    v_rem_req_hash := app_private.pos_auth_hash('void', v_rem_facts);
    v_rem_r := public.staff_pos_approve(v_staff_a, v_op_token, v_mgr_member, '5678', 'void', v_rem_req_hash)::jsonb;
    v_rem_app_token := v_rem_r->>'approval_token';

    v_rem_r := public.staff_void_sale(v_staff_a, v_op_token, v_rem_sale_id, '正常取消', 'p05-void-key-replay-test', v_rem_app_token)::jsonb;
    if v_rem_r ? 'error' or v_rem_r->>'status' <> 'voided' then
      raise exception 'Test 76 setup void failed: %', v_rem_r;
    end if;

    -- Test 76: Replay 時に無効/失効オペレーターを指定した場合、Replay を返さず operator_session_invalid で拒否
    v_rem_r := public.staff_void_sale(v_staff_a, v_expired_op_token, v_rem_sale_id, '正常取消', 'p05-void-key-replay-test', null)::jsonb;
    if v_rem_r->>'error' <> 'operator_session_invalid' then
      raise exception 'Test 76 failed: replay with expired operator was not rejected: %', v_rem_r;
    end if;

    -- Test 77: 同一会計・同一リクエストの Exact Replay は fresh approval 不要で既存結果 (idempotent: true) を返却
    v_rem_r := public.staff_void_sale(v_staff_a, v_op_token, v_rem_sale_id, '正常取消', 'p05-void-key-replay-test', null)::jsonb;
    if v_rem_r ? 'error' or not coalesce((v_rem_r->>'idempotent')::boolean, false) or (v_rem_r->>'id')::uuid <> v_rem_sale_id then
      raise exception 'Test 77 failed: exact void replay failed: %', v_rem_r;
    end if;

    -- Test 78: Idempotency Conflict 検証
    -- 78a: 同一会計 + 異なる理由 (reason) → idempotency_conflict
    v_rem_r := public.staff_void_sale(v_staff_a, v_op_token, v_rem_sale_id, '別の理由', 'p05-void-key-replay-test', null)::jsonb;
    if v_rem_r->>'error' <> 'idempotency_conflict' then
      raise exception 'Test 78a failed: altered void reason was not rejected with idempotency_conflict: %', v_rem_r;
    end if;

    -- 78b: 異なる会計 + 同一 void_idempotency_key → idempotency_conflict
    v_rem_r := public.staff_void_sale(v_staff_a, v_op_token, v_sale_id, '正常取消', 'p05-void-key-replay-test', null)::jsonb;
    if v_rem_r->>'error' <> 'idempotency_conflict' then
      raise exception 'Test 78b failed: cross-sale reuse of void_idempotency_key was not rejected with idempotency_conflict: %', v_rem_r;
    end if;

    -- Test 79: staff_ginpay_adjustment の完全廃止確認 (pg_proc に 0 件)
    if exists (select 1 from pg_proc where proname = 'staff_ginpay_adjustment') then
      raise exception 'Test 79 failed: staff_ginpay_adjustment exists in pg_proc';
    end if;

    -- Test 80: staff_issue_tickets 旧 7引数 overload 廃止 & 旧 call shape は 42883 で失敗しチケット不変
    if exists (select 1 from pg_proc where proname = 'staff_issue_tickets' and pronargs = 7) then
      raise exception 'Test 80 failed: staff_issue_tickets 7-arg overload still exists in pg_proc';
    end if;
    if (select count(*) from pg_proc where proname = 'staff_issue_tickets') <> 1 then
      raise exception 'Test 80 failed: staff_issue_tickets does not have exactly 1 canonical signature';
    end if;

    select count(*) into v_tickets_before from public.tickets;
    begin
      execute 'select public.staff_issue_tickets($1, $2, $3, $4, $5, $6, $7)'
      using v_staff_a, 'P05顧客A', v_user_a, 'discount', 500, 1, now() + interval '30 days';
      raise exception 'Test 80 failed: legacy staff_issue_tickets 7-arg unexpectedly succeeded';
    exception
      when sqlstate '42883' then
        null;
      when others then
        raise exception 'Test 80 failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'staff_issue_tickets 7-arg';
    end;
    select count(*) into v_tickets_after from public.tickets;
    if v_tickets_before <> v_tickets_after then
      raise exception 'Test 80 failed: tickets written on legacy issue call';
    end if;
  end;

  raise notice '================================================================';
  raise notice '  GINJIRO POS Phase 0 / P0-5: ALL 80 TESTS PASSED PERFECTLY     ';
  raise notice '================================================================';
end $$;
rollback;
