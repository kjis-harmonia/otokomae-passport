-- GINJIRO POS Phase 0 / P0-3: Operator Authentication & Approval
-- (begin … rollback。テストデータは残さない)
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_staff_a text := 'preflight-pos-op-staff-a-0123456789abcdef';
  v_staff_b text := 'preflight-pos-op-staff-b-0123456789abcdef';
  v_staff_mem_1 uuid;
  v_staff_mem_2 uuid;
  v_staff_mem_inactive uuid;
  v_r jsonb;
  v_op_token text;
  v_op_token_2 text;
  v_app_token text;
  v_req_hash text := encode(digest('order:cart_1001:amount:5000', 'sha256'), 'hex');
  v_diff_hash text := encode(digest('order:cart_1001:amount:9999', 'sha256'), 'hex');
  v_consume_res jsonb;
  v_ok boolean;
  i int;
begin
  -- テスト用スタッフセッション
  insert into app_private.staff_sessions (token_hash, expires_at) values
    (app_private.sha256_hex(v_staff_a), now() + interval '2 hours'),
    (app_private.sha256_hex(v_staff_b), now() + interval '2 hours');

  -- テスト用スタッフメンバー（public.staff_members）
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P03_担当者1', true, true, 101) returning id into v_staff_mem_1;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P03_店長2', true, true, 102) returning id into v_staff_mem_2;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P03_退職者', true, false, 103) returning id into v_staff_mem_inactive;

  -- ── Check 5: inactive staff は拒否されること ─────────────────────────────
  v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_inactive, '1234')::jsonb;
  if v_r->>'error' <> 'inactive_or_not_found' then
    raise exception 'Check 5 failed: inactive staff not rejected: %', v_r;
  end if;

  -- 初期状態（資格情報未設定）での検証拒否
  v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_1, '1234')::jsonb;
  if v_r->>'error' <> 'not_configured' then
    raise exception 'unconfigured credentials not rejected: %', v_r;
  end if;

  -- ── スタッフ資格情報の設定（担当者1: staff, PIN: 1234） ─────────────────
  perform app_private.set_staff_operator_credentials(v_staff_mem_1, '1234', 'staff');

  -- ── Check 2: 誤った PIN は拒否されること ─────────────────────────────────
  v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_1, '9999')::jsonb;
  if v_r->>'error' <> 'invalid_pin' or (v_r->>'remaining_attempts')::int <> 4 then
    raise exception 'Check 2 failed: wrong pin rejection incorrect: %', v_r;
  end if;

  -- ── Check 3: 連続 5 回の誤りでロックされること ───────────────────────────
  for i in 1..4 loop
    v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_1, '9999')::jsonb;
  end loop;
  if v_r->>'error' <> 'locked' or v_r->>'locked_until' is null then
    raise exception 'Check 3 failed: 5 failed attempts did not lock account: %', v_r;
  end if;

  -- ロック中は正しい PIN でも拒否されること
  v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_1, '1234')::jsonb;
  if v_r->>'error' <> 'locked' then
    raise exception 'Check 3b failed: locked account allowed login: %', v_r;
  end if;

  -- ロック解除（テスト用に reset）
  update app_private.staff_operator_credentials
  set locked_until = null, failed_count = 0
  where staff_member_id = v_staff_mem_1;

  -- ── Check 1: 正しい PIN で L1 operator session を取得できること ──────────
  v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_1, '1234')::jsonb;
  if v_r ? 'error' then
    raise exception 'Check 1 failed: valid login rejected: %', v_r;
  end if;
  v_op_token := v_r->>'operator_token';
  if v_op_token !~ '^OPS1\.[a-f0-9]{64}$' then
    raise exception 'Check 1 failed: invalid operator token format: %', v_op_token;
  end if;
  if (v_r->>'staff_member_id')::uuid <> v_staff_mem_1 or v_r->>'role' <> 'staff' then
    raise exception 'Check 1 failed: incorrect operator session info: %', v_r;
  end if;
  if (v_r->>'ttl_seconds')::int <> 1800 then
    raise exception 'Check 1 failed: ttl_seconds should be 1800: %', v_r;
  end if;

  -- ── Check 4: 別の店舗端末セッション（v_staff_b）から operator session を使用不可
  v_r := public.staff_pos_approve(v_staff_b, v_op_token, v_staff_mem_2, '5678', 'manual_discount', v_req_hash)::jsonb;
  if v_r->>'error' <> 'invalid_operator_session' then
    raise exception 'Check 4 failed: operator token used across staff sessions: %', v_r;
  end if;

  -- ── Check 6: 初期状態（manager 0名）では L2 承認不可（fail closed） ──────
  -- 店長2はまだ manager 資格情報が設定されていない
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_staff_mem_2, '5678', 'manual_discount', v_req_hash)::jsonb;
  if v_r->>'error' <> 'not_a_manager' then
    raise exception 'Check 6 failed: unconfigured manager allowed or wrong error: %', v_r;
  end if;

  -- ── Check 9: staff role の人は manager 承認不可 ──────────────────────────
  -- 担当者1（staff ロール）を承認者として指定しても拒否される
  perform app_private.set_staff_operator_credentials(v_staff_mem_2, '5678', 'staff');
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_staff_mem_2, '5678', 'manual_discount', v_req_hash)::jsonb;
  if v_r->>'error' <> 'not_a_manager' then
    raise exception 'Check 9 failed: staff role allowed as approver: %', v_r;
  end if;

  -- ── 店長2 を manager に昇格設定 ──────────────────────────────────────────
  perform app_private.set_staff_operator_credentials(v_staff_mem_2, '5678', 'manager');

  -- ── Check 8: operator 本人が自分を承認しようとすると拒否（自己承認禁止） ─
  -- 仮に担当者1が manager だったとしても、自分自身の操作を承認することは禁止
  update app_private.staff_operator_credentials set role = 'manager' where staff_member_id = v_staff_mem_1;
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_staff_mem_1, '1234', 'manual_discount', v_req_hash)::jsonb;
  if v_r->>'error' <> 'self_approval_prohibited' then
    raise exception 'Check 8 failed: self-approval not prohibited: %', v_r;
  end if;
  update app_private.staff_operator_credentials set role = 'staff' where staff_member_id = v_staff_mem_1;

  -- ── Check 7: manager 設定後、L2 承認が成功すること ───────────────────────
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_staff_mem_2, '5678', 'manual_discount', v_req_hash)::jsonb;
  if v_r ? 'error' then
    raise exception 'Check 7 failed: valid manager approval rejected: %', v_r;
  end if;
  v_app_token := v_r->>'approval_token';
  if v_app_token !~ '^APR1\.[a-f0-9]{64}$' then
    raise exception 'Check 7 failed: invalid approval token format: %', v_app_token;
  end if;
  if (v_r->>'ttl_seconds')::int <> 300 or v_r->>'action' <> 'manual_discount' or v_r->>'request_hash' <> v_req_hash then
    raise exception 'Check 7 failed: approval token metadata mismatch: %', v_r;
  end if;

  -- ── Check 10: approval は request_hash が違えば拒否されること ────────────
  v_consume_res := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'manual_discount', v_diff_hash);
  if (v_consume_res->>'ok')::boolean or v_consume_res->>'error' <> 'request_hash_mismatch' then
    raise exception 'Check 10 failed: mismatched request_hash was consumed: %', v_consume_res;
  end if;

  -- アクションが違っても拒否されること
  v_consume_res := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'void', v_req_hash);
  if (v_consume_res->>'ok')::boolean or v_consume_res->>'error' <> 'action_mismatch' then
    raise exception 'Check 10b failed: mismatched action was consumed: %', v_consume_res;
  end if;

  -- ── Check 13: approval token を別の operator が使用できないこと ──────────
  -- 店長2で operator session を作成
  v_r := public.staff_operator_verify(v_staff_a, v_staff_mem_2, '5678')::jsonb;
  v_op_token_2 := v_r->>'operator_token';
  v_consume_res := app_private.consume_pos_approval(v_staff_a, v_op_token_2, v_app_token, 'manual_discount', v_req_hash);
  if (v_consume_res->>'ok')::boolean or v_consume_res->>'error' <> 'operator_mismatch' then
    raise exception 'Check 13 failed: another operator was able to consume approval: %', v_consume_res;
  end if;

  -- ── 正常消費: 正しい operator・action・request_hash で消費 ───────────────
  v_consume_res := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'manual_discount', v_req_hash);
  if not (v_consume_res->>'ok')::boolean then
    raise exception 'valid consumption failed: %', v_consume_res;
  end if;

  -- ── Check 11: approval は 1 回しか消費できないこと（二重消費拒否） ───────
  v_consume_res := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'manual_discount', v_req_hash);
  if (v_consume_res->>'ok')::boolean or v_consume_res->>'error' <> 'already_consumed' then
    raise exception 'Check 11 failed: second consumption was not rejected: %', v_consume_res;
  end if;

  -- ── Check 12: approval expiry 後は拒否されること ─────────────────────────
  -- 新規に承認を発行して有効期限切れに設定
  v_r := public.staff_pos_approve(v_staff_a, v_op_token, v_staff_mem_2, '5678', 'refund', v_req_hash)::jsonb;
  v_app_token := v_r->>'approval_token';
  update app_private.pos_approvals
  set expires_at = now() - interval '1 second', created_at = now() - interval '6 minutes'
  where approval_hash = app_private.sha256_hex(v_app_token);

  v_consume_res := app_private.consume_pos_approval(v_staff_a, v_op_token, v_app_token, 'refund', v_req_hash);
  if (v_consume_res->>'ok')::boolean or v_consume_res->>'error' <> 'approval_expired' then
    raise exception 'Check 12 failed: expired approval was not rejected: %', v_consume_res;
  end if;

  -- ── Check 15: 平文 PIN / トークンが DB / audit に残っていないこと ────────
  if exists (
    select 1 from app_private.staff_operator_credentials
    where pin_hash in ('1234', '5678')
  ) then
    raise exception 'Check 15 failed: plaintext PIN stored in credentials';
  end if;

  if exists (
    select 1 from app_private.pos_operator_sessions
    where token_hash in (v_op_token, v_op_token_2)
  ) then
    raise exception 'Check 15 failed: plaintext operator token stored in sessions';
  end if;

  if exists (
    select 1 from app_private.pos_approvals
    where approval_hash = v_app_token
  ) then
    raise exception 'Check 15 failed: plaintext approval token stored in approvals';
  end if;

  -- 監査テーブル pos_operator_events に平文トークンや PIN が記録されていないこと
  if exists (
    select 1 from public.pos_operator_events
    where reason like '%1234%' or reason like '%5678%'
       or action like '%1234%' or action like '%5678%'
       or request_hash in ('1234', '5678', v_op_token, v_app_token)
  ) then
    raise exception 'Check 15 failed: plaintext secret leaked to audit events';
  end if;

  -- ── Check 16: SECURITY DEFINER / grants / RLS の確認 ─────────────────────
  -- pos_policy 初期値の確認（staff_get_pos_policy RPC 経由）
  v_r := public.staff_get_pos_policy(v_staff_a)::jsonb;
  if (v_r->>'manual_discount_l1_limit')::int <> 0 then
    raise exception 'Check 16 failed: pos_policy manual_discount_l1_limit != 0: %', v_r;
  end if;
  if (v_r->>'ginpay_charge_l1_limit')::int <> 50000 then
    raise exception 'Check 16 failed: pos_policy ginpay_charge_l1_limit != 50000: %', v_r;
  end if;
  if not (v_r->>'require_l2_ticket_issue')::boolean or not (v_r->>'require_l2_refund')::boolean
     or not (v_r->>'require_l2_void')::boolean or not (v_r->>'require_l2_price_override')::boolean
     or not (v_r->>'require_l2_manual_item')::boolean then
    raise exception 'Check 16 failed: pos_policy L2 requirements not enabled: %', v_r;
  end if;

end;
$$;
rollback;
