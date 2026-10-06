-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Money Authorization Enforcement
-- ============================================================================

-- ── 1. スキーマ拡張 (端末発行時バインド & Idempotency / Request Hash) ──────────

-- pos_approvals に発行時点の端末スタッフセッションハッシュを追加
alter table app_private.pos_approvals
  add column if not exists issued_for_staff_session_hash text;

-- accounting_sessions に request_hash, void_idempotency_key, void_request_hash を追加
alter table public.accounting_sessions
  add column if not exists request_hash text;
alter table public.accounting_sessions
  add column if not exists void_idempotency_key text;
alter table public.accounting_sessions
  add column if not exists void_request_hash text;

create unique index if not exists accounting_sessions_void_idempotency_uidx
  on public.accounting_sessions (void_idempotency_key)
  where void_idempotency_key is not null;

-- 確定後・取消後の会計の不変性ガード (void_idempotency_key, void_request_hash も保護)
create or replace function app_private.guard_accounting_session()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('completed', 'voided') then raise exception 'accounting_immutable'; end if;
    return old;
  end if;
  if old.status in ('completed', 'voided') then
    if (new.user_id, new.customer_name, new.staff_name, new.stylist_name, new.stylist_id, new.payment_method, new.subtotal,
        new.discount_total, new.total, new.used_ticket_ids, new.created_at, new.completed_at, new.reservation_id, new.tax_mode, new.tax_rate,
        new.idempotency_key, new.request_hash, new.quote_hash)
       is distinct from
       (old.user_id, old.customer_name, old.staff_name, old.stylist_name, old.stylist_id, old.payment_method, old.subtotal,
        old.discount_total, old.total, old.used_ticket_ids, old.created_at, old.completed_at, old.reservation_id, old.tax_mode, old.tax_rate,
        old.idempotency_key, old.request_hash, old.quote_hash) then
      raise exception 'accounting_immutable';
    end if;
    if old.status = 'voided' and (new.status, new.voided_at, new.voided_by, new.void_reason, new.void_idempotency_key, new.void_request_hash) is distinct from (old.status, old.voided_at, old.voided_by, old.void_reason, old.void_idempotency_key, old.void_request_hash) then
      raise exception 'accounting_immutable';
    end if;
    if old.status = 'completed' and new.status not in ('completed', 'voided') then raise exception 'accounting_immutable'; end if;
  end if;
  return new;
end;
$$;

-- ginpay_transactions に request_hash を追加 & チャージ返金対応の金額符号制約更新
alter table public.ginpay_transactions
  add column if not exists request_hash text;

do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.ginpay_transactions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%charge_store%'
  loop
    execute format('alter table public.ginpay_transactions drop constraint %I', c);
  end loop;
end $$;

alter table public.ginpay_transactions add constraint ginpay_transactions_amount_type_check
  check (
    status <> 'posted'
    or ((type in ('charge_store', 'charge_stripe')) and amount > 0)
    or (type = 'payment' and amount < 0)
    or (type in ('refund', 'adjustment', 'void') and amount <> 0)
  );

-- ticket_issue_logs に idempotency_key, request_hash, ticket_ids を追加
alter table public.ticket_issue_logs
  add column if not exists idempotency_key text;
alter table public.ticket_issue_logs
  add column if not exists request_hash text;
alter table public.ticket_issue_logs
  add column if not exists ticket_ids uuid[];

create unique index if not exists ticket_issue_logs_idempotency_uidx
  on public.ticket_issue_logs (idempotency_key)
  where idempotency_key is not null;

-- ── 2. staff_pos_approve の更新 (AUTH1.<64hex> 形式統一 & 端末発行時バインド) ──

create or replace function public.staff_pos_approve(
  p_staff text,
  p_operator_token text,
  p_manager_staff_id uuid,
  p_manager_pin text,
  p_action text,
  p_request_hash text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash   text;
  v_op_hash      text;
  v_op_session   app_private.pos_operator_sessions;
  v_op_member    public.staff_members;
  v_mgr_cred     app_private.staff_operator_credentials;
  v_mgr_member   public.staff_members;
  v_raw_token    text;
  v_app_hash     text;
  v_exp          timestamptz;
  v_ttl          integer := 300;
  v_policy       public.pos_policy;
  v_norm_req_hash text;
begin
  -- 1. 店舗スタッフセッション検証
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- 2. オペレーターセッション検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;
  v_op_hash := app_private.sha256_hex(p_operator_token);

  select * into v_op_session
  from app_private.pos_operator_sessions
  where token_hash = v_op_hash and revoked_at is null;

  if v_op_session.token_hash is null then
    return json_build_object('error', 'invalid_operator_session');
  end if;

  if v_op_session.expires_at <= now() then
    return json_build_object('error', 'operator_session_expired');
  end if;

  if v_op_session.staff_session_hash <> v_staff_hash then
    return json_build_object('error', 'invalid_operator_session');
  end if;

  select * into v_op_member from public.staff_members where id = v_op_session.staff_member_id;

  -- 3. アクションと request_hash の検証 (AUTH1.<64hex> または 64hex)
  if p_action is null or btrim(p_action) = '' then
    return json_build_object('error', 'invalid_action');
  end if;

  if p_request_hash is null or p_request_hash !~ '^(AUTH1\.)?[a-f0-9]{64}$' then
    return json_build_object('error', 'invalid_request_hash');
  end if;

  v_norm_req_hash := case when p_request_hash ~ '^AUTH1\.' then p_request_hash else 'AUTH1.' || p_request_hash end;

  -- 4. Manager の検証
  if p_manager_staff_id is null then
    return json_build_object('error', 'manager_required');
  end if;

  -- 自己承認の禁止チェック
  select * into v_policy from public.pos_policy where id = 1;
  if p_manager_staff_id = v_op_session.staff_member_id then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_requested', 'rejected', 'self_approval_prohibited',
      v_op_session.staff_member_id, p_manager_staff_id, p_action, v_norm_req_hash, v_staff_hash
    );
    return json_build_object('error', 'self_approval_prohibited');
  end if;

  select * into v_mgr_member from public.staff_members where id = p_manager_staff_id and is_active;
  if v_mgr_member.id is null then
    return json_build_object('error', 'manager_not_found');
  end if;

  select * into v_mgr_cred from app_private.staff_operator_credentials
  where staff_member_id = p_manager_staff_id and is_active;

  if v_mgr_cred.staff_member_id is null or v_mgr_cred.role <> 'manager' then
    return json_build_object('error', 'not_a_manager');
  end if;

  -- ロック確認
  if v_mgr_cred.locked_until is not null and v_mgr_cred.locked_until > now() then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_requested', 'locked', 'manager_locked',
      v_op_session.staff_member_id, p_manager_staff_id, p_action, v_norm_req_hash, v_staff_hash
    );
    return json_build_object('error', 'locked', 'locked_until', v_mgr_cred.locked_until);
  end if;

  -- マネージャーPIN照合
  if p_manager_pin is null or crypt(p_manager_pin, v_mgr_cred.pin_hash) <> v_mgr_cred.pin_hash then
    v_mgr_cred.failed_count := v_mgr_cred.failed_count + 1;
    if v_mgr_cred.failed_count >= 5 then
      update app_private.staff_operator_credentials
      set failed_count = 0,
          locked_until = now() + interval '15 minutes',
          updated_at = now()
      where staff_member_id = p_manager_staff_id;

      insert into public.pos_operator_events (
        event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
      ) values (
        'approval_requested', 'locked', 'max_failed_attempts',
        v_op_session.staff_member_id, p_manager_staff_id, p_action, v_norm_req_hash, v_staff_hash
      );
      return json_build_object('error', 'locked', 'locked_until', now() + interval '15 minutes');
    else
      update app_private.staff_operator_credentials
      set failed_count = v_mgr_cred.failed_count,
          updated_at = now()
      where staff_member_id = p_manager_staff_id;

      insert into public.pos_operator_events (
        event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
      ) values (
        'approval_requested', 'failure', 'invalid_pin',
        v_op_session.staff_member_id, p_manager_staff_id, p_action, v_norm_req_hash, v_staff_hash
      );
      return json_build_object('error', 'invalid_pin', 'remaining_attempts', 5 - v_mgr_cred.failed_count);
    end if;
  end if;

  -- 認証成功
  update app_private.staff_operator_credentials
  set failed_count = 0,
      locked_until = null,
      updated_at = now()
  where staff_member_id = p_manager_staff_id;

  v_raw_token := 'APR1.' || encode(gen_random_bytes(32), 'hex');
  v_app_hash := app_private.sha256_hex(v_raw_token);
  v_exp := now() + make_interval(secs => v_ttl);

  -- 発行時点で terminal staff_session_hash を固定保存
  insert into app_private.pos_approvals (
    approval_hash, action, request_hash, operator_staff_id, approver_staff_id,
    expires_at, issued_for_staff_session_hash
  ) values (
    v_app_hash, p_action, v_norm_req_hash, v_op_session.staff_member_id, p_manager_staff_id,
    v_exp, v_staff_hash
  );

  insert into public.pos_operator_events (
    event_type, result, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
  ) values (
    'approval_requested', 'approved',
    v_op_session.staff_member_id, p_manager_staff_id, p_action, v_norm_req_hash, v_staff_hash
  );

  return json_build_object(
    'approval_token', v_raw_token,
    'action', p_action,
    'request_hash', p_request_hash,
    'canonical_request_hash', v_norm_req_hash,
    'operator_staff_id', v_op_session.staff_member_id,
    'approver_staff_id', p_manager_staff_id,
    'approver_name', v_mgr_member.display_name,
    'expires_at', v_exp,
    'ttl_seconds', v_ttl
  );
end;
$$;

-- ── 3. Canonical AUTH Facts Hashing ヘルパー ─────────────────────────────────

create or replace function app_private.pos_auth_hash(
  p_action text,
  p_facts jsonb
) returns text language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_sorted_json text;
begin
  -- jsonb は内部でキー順が正規化される
  -- 出力形式: AUTH1.<sha256(canonical_facts)>
  v_sorted_json := (p_facts || jsonb_build_object('action', p_action))::text;
  return 'AUTH1.' || app_private.sha256_hex(v_sorted_json);
end;
$$;

-- ── 4. 承認の参照検証 (Pure & Read-Only Helper) ───────────────────────────────

create or replace function app_private.verify_pos_approval(
  p_staff text,
  p_operator_token text,
  p_approval_token text,
  p_expected_action text,
  p_expected_hash text
) returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash   text;
  v_op_hash      text;
  v_op_session   app_private.pos_operator_sessions;
  v_app_hash     text;
  v_app          app_private.pos_approvals;
  v_mgr_cred     app_private.staff_operator_credentials;
  v_norm_hash    text;
  v_app_norm     text;
begin
  if p_approval_token is null or btrim(p_approval_token) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_approval_token');
  end if;

  -- 1. 店舗端末セッション
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- 2. オペレーターセッション
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_operator_session');
  end if;
  v_op_hash := app_private.sha256_hex(p_operator_token);

  select * into v_op_session
  from app_private.pos_operator_sessions
  where token_hash = v_op_hash and revoked_at is null;

  if v_op_session.token_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_operator_session');
  end if;
  if v_op_session.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'invalid_operator_session');
  end if;
  if v_op_session.staff_session_hash <> v_staff_hash then
    return jsonb_build_object('ok', false, 'error', 'invalid_operator_session');
  end if;

  -- 3. 承認レコード取得
  v_app_hash := app_private.sha256_hex(p_approval_token);
  select * into v_app
  from app_private.pos_approvals
  where approval_hash = v_app_hash;

  if v_app.approval_hash is null then
    return jsonb_build_object('ok', false, 'error', 'approval_not_found');
  end if;

  -- 4. 各種バインディング検証
  if v_app.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_consumed');
  end if;

  if v_app.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'approval_expired');
  end if;

  if v_app.operator_staff_id <> v_op_session.staff_member_id then
    return jsonb_build_object('ok', false, 'error', 'operator_mismatch');
  end if;

  -- 自己承認チェック (fail closed)
  if v_app.approver_staff_id = v_op_session.staff_member_id then
    return jsonb_build_object('ok', false, 'error', 'self_approval_prohibited');
  end if;

  -- 発行端末バインド検証 (issued_for_staff_session_hash)
  if v_app.issued_for_staff_session_hash is not null and v_app.issued_for_staff_session_hash <> v_staff_hash then
    return jsonb_build_object('ok', false, 'error', 'approval_session_mismatch');
  end if;

  if v_app.action <> p_expected_action then
    return jsonb_build_object('ok', false, 'error', 'action_mismatch');
  end if;

  v_norm_hash := case when p_expected_hash ~ '^AUTH1\.' then p_expected_hash else 'AUTH1.' || p_expected_hash end;
  v_app_norm := case when v_app.request_hash ~ '^AUTH1\.' then v_app.request_hash else 'AUTH1.' || v_app.request_hash end;
  if v_app_norm <> v_norm_hash then
    return jsonb_build_object('ok', false, 'error', 'request_hash_mismatch');
  end if;

  -- 5. マネージャー現役状態確認 (発行後に無効化または権限変更されたか)
  select * into v_mgr_cred
  from app_private.staff_operator_credentials
  where staff_member_id = v_app.approver_staff_id;

  if v_mgr_cred.staff_member_id is null or not v_mgr_cred.is_active
     or not exists (select 1 from public.staff_members where id = v_app.approver_staff_id and is_active) then
    return jsonb_build_object('ok', false, 'error', 'approver_role_revoked');
  end if;

  if v_mgr_cred.role <> 'manager' then
    return jsonb_build_object('ok', false, 'error', 'approver_role_revoked');
  end if;

  return jsonb_build_object('ok', true, 'approval_id', v_app.approval_hash);
end;
$$;

-- ── 5. 承認のアトミック消費 (Transaction Mutation Helper) ─────────────────────

drop function if exists app_private.consume_pos_approval(text, text, text, text, text);

create or replace function app_private.consume_pos_approval(
  p_staff text,
  p_operator_token text,
  p_approval_token text,
  p_action text,
  p_request_hash text
) returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash   text;
  v_op           app_private.pos_operator_sessions;
  v_app_hash     text;
  v_app          app_private.pos_approvals;
  v_mgr_cred     app_private.staff_operator_credentials;
  v_norm_hash    text;
  v_app_norm     text;
begin
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- 1. Operator session 検証
  if p_operator_token is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_operator_session');
  end if;

  select * into v_op from app_private.pos_operator_sessions
  where token_hash = app_private.sha256_hex(p_operator_token)
    and staff_session_hash = v_staff_hash
    and revoked_at is null;

  if v_op.token_hash is null or v_op.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'invalid_operator_session');
  end if;

  -- 2. Approval token 行ロック取得 (FOR UPDATE)
  if p_approval_token is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_approval_token');
  end if;

  v_app_hash := app_private.sha256_hex(p_approval_token);
  select * into v_app from app_private.pos_approvals
  where approval_hash = v_app_hash for update;

  v_norm_hash := case when p_request_hash ~ '^AUTH1\.' then p_request_hash else 'AUTH1.' || p_request_hash end;

  if v_app.approval_hash is null then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'approval_not_found', v_op.staff_member_id, p_action, v_norm_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approval_not_found');
  end if;

  v_app_norm := case when v_app.request_hash ~ '^AUTH1\.' then v_app.request_hash else 'AUTH1.' || v_app.request_hash end;

  -- 3. 状態・期限・バインド検証 (各失敗時に監査イベントを記録)
  if v_app.consumed_at is not null then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'already_consumed', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'already_consumed');
  end if;

  if v_app.expires_at <= now() then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_expired', 'expired', 'approval_expired', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approval_expired');
  end if;

  if v_app.operator_staff_id <> v_op.staff_member_id then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'operator_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'operator_mismatch');
  end if;

  -- 追加条件 1: 自己承認チェック (fail closed)
  if v_app.approver_staff_id = v_op.staff_member_id then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'self_approval_prohibited', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'self_approval_prohibited');
  end if;

  -- P0-5: 発行端末バインド検証 (issued_for_staff_session_hash)
  if v_app.issued_for_staff_session_hash is not null and v_app.issued_for_staff_session_hash <> v_staff_hash then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'approval_session_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approval_session_mismatch');
  end if;

  if v_app.action <> p_action then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'action_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'action_mismatch');
  end if;

  -- P0-5: AUTH1 プレフィックス正規化比較
  if v_app_norm <> v_norm_hash then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'request_hash_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_norm_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'request_hash_mismatch');
  end if;

  -- 4. 承認者マネージャー資格現役状態確認
  select * into v_mgr_cred from app_private.staff_operator_credentials
  where staff_member_id = v_app.approver_staff_id;

  if v_mgr_cred.staff_member_id is null or v_mgr_cred.role <> 'manager' or not v_mgr_cred.is_active
     or not exists (select 1 from public.staff_members where id = v_app.approver_staff_id and is_active) then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'approver_role_revoked', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_app_norm, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approver_role_revoked');
  end if;

  -- 5. 消費実行
  update app_private.pos_approvals
  set consumed_at = now(),
      consumed_by_staff_session_hash = v_staff_hash
  where approval_hash = v_app_hash;

  insert into public.pos_operator_events (
    event_type, result, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
  ) values (
    'approval_consumed', 'consumed', v_op.staff_member_id, v_app.approver_staff_id, p_action, v_norm_hash, v_staff_hash
  );

  return jsonb_build_object(
    'ok', true,
    'action', p_action,
    'request_hash', v_norm_hash,
    'operator_staff_id', v_op.staff_member_id,
    'approver_staff_id', v_app.approver_staff_id,
    'consumed_at', now()
  );
end;
$$;

-- ── 5-B. resolve_pos_client_context の更新 (anonymous walk-in & arbitrary client_id 防御) ──

create or replace function app_private.resolve_pos_client_context(
  p_staff_token text,
  p_scan_session uuid,
  p_client_id uuid,
  p_reservation_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash text;
  v_ss app_private.pos_scan_sessions;
  v_res public.reservations;
  v_canonical_scan uuid := null;
  v_canonical_res uuid := null;
  v_canonical_client uuid := null;
  v_request_client uuid := null;
  v_member uuid := null;
  v_user text := null;
  v_name text := null;
  v_scan_id uuid := null;
begin
  -- 1. scan_session が指定されている場合 (trusted QR scan)
  if p_scan_session is not null then
    if p_staff_token is null or btrim(p_staff_token) = '' then
      return jsonb_build_object('error', 'staff_auth_required');
    end if;
    v_staff_hash := app_private.sha256_hex(p_staff_token);

    select * into v_ss
    from app_private.pos_scan_sessions
    where id = p_scan_session;

    if v_ss.id is null or v_ss.closed_at is not null or v_ss.expires_at <= now()
       or v_ss.staff_session_hash <> v_staff_hash then
      return jsonb_build_object('error', 'invalid_scan_session');
    end if;

    v_canonical_scan := app_private.client_root(v_ss.client_id);
    if v_canonical_scan is null then
      return jsonb_build_object('error', 'invalid_scan_session');
    end if;

    v_scan_id := v_ss.id;
  end if;

  -- 2. reservation_id が指定されている場合 (trusted reservation: 正本パイプライン)
  if p_reservation_id is not null then
    select * into v_res from public.reservations where id = p_reservation_id;
    if v_res.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if v_res.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;

    v_canonical_res := app_private.client_root(v_res.client_id);
    v_name := coalesce(v_res.customer_name, '');
  end if;

  -- request の client_id が指定されている場合、事前解決
  if p_client_id is not null then
    v_request_client := app_private.client_root(p_client_id);
  end if;

  -- 3. 統合照合と canonical client の確定
  if p_scan_session is not null and p_reservation_id is not null then
    -- スキャンと予約が両方ある場合: 予約が匿名 (v_canonical_res is null) または 顧客 root 不一致なら遮断
    if v_canonical_res is null or v_canonical_scan is distinct from v_canonical_res then
      return jsonb_build_object('error', 'customer_context_mismatch');
    end if;
    if p_client_id is not null and v_request_client is distinct from v_canonical_scan then
      return jsonb_build_object('error', 'customer_context_mismatch');
    end if;
    v_canonical_client := v_canonical_scan;

  elsif p_scan_session is not null then
    if p_client_id is not null and v_request_client is distinct from v_canonical_scan then
      return jsonb_build_object('error', 'customer_context_mismatch');
    end if;
    v_canonical_client := v_canonical_scan;

  elsif p_reservation_id is not null then
    if p_client_id is not null and (v_canonical_res is null or v_request_client is distinct from v_canonical_res) then
      return jsonb_build_object('error', 'customer_context_mismatch');
    end if;
    v_canonical_client := v_canonical_res;

  else
    -- scan_session も reservation_id もない場合 (walk-in)
    -- request の client_id は信用せず無視し、anonymous として扱う
    v_canonical_client := null;
  end if;

  if v_canonical_client is not null then
    if v_name is null or v_name = '' then
      select display_name into v_name from public.clients where id = v_canonical_client;
    end if;
    v_member := (app_private.client_members(app_private.client_family(v_canonical_client)))[1];
    if v_member is not null then
      select user_id into v_user from public.customers where id = v_member;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'client_id', v_canonical_client,
    'customer_id', v_user,
    'customer_name', v_name,
    'scan_session_id', v_scan_id,
    'reservation_id', p_reservation_id
  );
end;
$$;

-- ── 6. pos_price の完全純粋化 & 複合価格変更 (checkout_pricing_override) ───────

drop function if exists app_private.pos_price(jsonb, uuid, jsonb, boolean);
drop function if exists app_private.pos_price(jsonb, text, text, text, text, text);
drop function if exists app_private.pos_price(jsonb, text, text, uuid, jsonb, boolean);
drop function if exists app_private.pos_price(jsonb, text, text, uuid, jsonb, boolean, text, text, text);
drop function if exists app_private.pos_price(jsonb, uuid, jsonb, boolean, text, text, text);

create or replace function app_private.pos_price(
  p_request jsonb,
  p_operator_staff_id uuid default null,
  p_client_context jsonb default null,
  p_is_pos boolean default false,
  p_staff text default null,
  p_operator_token text default null,
  p_approval_token text default null
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_items jsonb := coalesce(p_request->'items', '[]'::jsonb);
  v_client_ctx jsonb;
  v_client uuid;
  v_res_id uuid;
  v_scan_session_id uuid;
  v_name text;
  v_op_staff_id uuid := p_operator_staff_id;

  v_subtotal bigint := 0;
  v_discount bigint := 0;
  v_ticket_disc bigint := 0;
  v_manual_disc bigint := 0;
  v_total bigint := 0;

  v_item jsonb;
  v_source text;
  v_ref_id text;
  v_qty int;
  v_unit_price int;
  v_list_price int;
  v_price_source text;
  v_item_name text;
  v_cat text;

  v_has_l2 boolean := false;
  v_normalized_items jsonb := '[]'::jsonb;
  v_overrides_facts jsonb := '[]'::jsonb;
  v_manual_facts jsonb := '[]'::jsonb;

  v_tids uuid[] := '{}'::uuid[];
  v_ticket_details jsonb := '[]'::jsonb;

  v_tax record;
  v_seen_res_items uuid[] := '{}'::uuid[];
  v_i int := 0;

  v_facts jsonb;
  v_req_hash text;
  v_canonical_facts jsonb;
  v_quote_hash text;
begin
  -- 1. Client Identity & Context 解決 (P0-4 契約)
  if p_client_context is not null then
    v_client_ctx := p_client_context;
  else
    v_client_ctx := app_private.resolve_pos_client_context(
      p_staff,
      nullif(p_request->>'scan_session_id', '')::uuid,
      nullif(p_request->>'client_id', '')::uuid,
      nullif(p_request->>'reservation_id', '')::uuid
    );
  end if;

  if v_client_ctx ? 'error' then
    return v_client_ctx;
  end if;

  v_client := nullif(v_client_ctx->>'client_id', '')::uuid;
  v_res_id := nullif(v_client_ctx->>'reservation_id', '')::uuid;
  v_scan_session_id := nullif(v_client_ctx->>'scan_session_id', '')::uuid;
  v_name := v_client_ctx->>'customer_name';

  -- オペレーター ID の解決
  if v_op_staff_id is null and p_operator_token is not null and btrim(p_operator_token) <> '' then
    select staff_member_id into v_op_staff_id
    from app_private.pos_operator_sessions
    where token_hash = app_private.sha256_hex(p_operator_token) and revoked_at is null;
  end if;

  -- 2. Items 価格計算
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('error', 'invalid_items');
  end if;

  for v_i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_item := v_items->v_i;
    v_source := coalesce(v_item->>'source', '');
    v_ref_id := nullif(btrim(coalesce(v_item->>'ref_id', '')), '');
    v_qty := coalesce((v_item->>'quantity')::int, 1);
    v_item_name := coalesce(v_item->>'name', '');
    if v_qty <= 0 or v_qty > 100 then
      return jsonb_build_object('error', 'invalid_quantity');
    end if;

    case v_source
      when 'reservation' then
        if v_res_id is null then return jsonb_build_object('error', 'reservation_required_for_item'); end if;
        declare
          ri public.reservation_items;
          v_ov_price int;
        begin
          select * into ri from public.reservation_items
          where reservation_id = v_res_id
            and (menu_code = v_ref_id or id::text = v_ref_id)
          order by sort_order limit 1;

          if ri.id is null and v_item_name <> '' then
            select * into ri from public.reservation_items
            where reservation_id = v_res_id and name = v_item_name
            order by sort_order limit 1;
          end if;

          if ri.id is null then return jsonb_build_object('error', 'reservation_item_not_found'); end if;

          if ri.id = any(v_seen_res_items) then
            return jsonb_build_object('error', 'duplicate_reservation_item');
          end if;
          v_seen_res_items := array_append(v_seen_res_items, ri.id);

          if ri.price is null then
            return jsonb_build_object('error', 'reservation_price_missing');
          end if;

          v_qty := 1;
          v_list_price := ri.price;
          v_item_name := ri.name;
          v_cat := 'menu';
          v_price_source := 'reservation_snapshot';

          -- L2 override check
          v_ov_price := case
            when v_item ? 'override_price' and v_item->>'override_price' is not null then (v_item->>'override_price')::int
            when v_item ? 'price_override' and v_item->'price_override' ? 'price' then (v_item->'price_override'->>'price')::int
            else null end;

          if v_ov_price is not null then
            v_has_l2 := true;
            v_unit_price := v_ov_price;
            v_overrides_facts := v_overrides_facts || jsonb_build_array(jsonb_build_object(
              'source', 'reservation',
              'ref_id', ri.id::text,
              'base_price', v_list_price,
              'override_price', v_ov_price,
              'quantity', v_qty,
              'reason', coalesce(v_item->>'reason', v_item->'price_override'->>'reason', '')
            ));
          else
            v_unit_price := ri.price;
          end if;
        end;

      when 'service_menu' then
        declare
          sm public.service_menus;
          v_ov_price int;
        begin
          if v_ref_id is null then return jsonb_build_object('error', 'invalid_items'); end if;

          select * into sm from public.service_menus
          where (code = v_ref_id or id::text = v_ref_id) and is_active;

          if sm.id is null or not sm.checkout_enabled or sm.price is null then
            return jsonb_build_object('error', 'service_menu_not_found_or_inactive');
          end if;

          v_item_name := sm.name;
          v_cat := case sm.kind when 'option' then 'option' else 'menu' end;
          v_list_price := sm.price;
          v_price_source := 'service_master';

          v_ov_price := case
            when v_item ? 'override_price' and v_item->>'override_price' is not null then (v_item->>'override_price')::int
            when v_item ? 'price_override' and v_item->'price_override' ? 'price' then (v_item->'price_override'->>'price')::int
            else null end;

          if v_ov_price is not null then
            v_has_l2 := true;
            v_unit_price := v_ov_price;
            v_overrides_facts := v_overrides_facts || jsonb_build_array(jsonb_build_object(
              'source', 'service_menu',
              'ref_id', sm.code,
              'base_price', v_list_price,
              'override_price', v_ov_price,
              'quantity', v_qty,
              'reason', coalesce(v_item->>'reason', v_item->'price_override'->>'reason', '')
            ));
          elsif sm.price_from then
            if (v_item->>'unit_price' is not null and (v_item->>'unit_price')::int < sm.price)
               or (v_item->>'price' is not null and (v_item->>'price')::int < sm.price) then
              return jsonb_build_object('error', 'below_base_price', 'base_price', sm.price);
            end if;

            if (v_item ? 'price_from_adjustment' and (v_item->>'price_from_adjustment')::int > sm.price) then
              v_has_l2 := true;
              v_unit_price := (v_item->>'price_from_adjustment')::int;
              v_overrides_facts := v_overrides_facts || jsonb_build_array(jsonb_build_object(
                'source', 'service_menu',
                'ref_id', sm.code,
                'base_price', v_list_price,
                'override_price', v_unit_price,
                'quantity', v_qty,
                'reason', 'price_from_adjustment'
              ));
            elsif (v_item->>'unit_price' is not null and (v_item->>'unit_price')::int > sm.price)
               or (v_item->>'price' is not null and (v_item->>'price')::int > sm.price) then
              v_has_l2 := true;
              v_unit_price := coalesce((v_item->>'unit_price')::int, (v_item->>'price')::int);
              v_overrides_facts := v_overrides_facts || jsonb_build_array(jsonb_build_object(
                'source', 'service_menu',
                'ref_id', sm.code,
                'base_price', v_list_price,
                'override_price', v_unit_price,
                'quantity', v_qty,
                'reason', coalesce(v_item->>'reason', 'price_from_adjustment')
              ));
            else
              v_unit_price := sm.price;
            end if;
          else
            v_unit_price := sm.price;
          end if;
        end;

      when 'product' then
        declare
          prod public.products;
          v_ov_price int;
        begin
          if v_ref_id is null then return jsonb_build_object('error', 'invalid_items'); end if;

          select * into prod from public.products
          where id::text = v_ref_id and is_active and category = '店販';

          if prod.id is null or prod.price is null or prod.price <= 0 then
            return jsonb_build_object('error', 'product_not_found_or_inactive');
          end if;

          v_item_name := prod.name;
          v_cat := 'retail';
          v_list_price := prod.price;
          v_price_source := 'product_master';

          v_ov_price := case
            when v_item ? 'override_price' and v_item->>'override_price' is not null then (v_item->>'override_price')::int
            when v_item ? 'price_override' and v_item->'price_override' ? 'price' then (v_item->'price_override'->>'price')::int
            else null end;

          if v_ov_price is not null then
            v_has_l2 := true;
            v_unit_price := v_ov_price;
            v_overrides_facts := v_overrides_facts || jsonb_build_array(jsonb_build_object(
              'source', 'product',
              'ref_id', prod.id::text,
              'base_price', v_list_price,
              'override_price', v_ov_price,
              'quantity', v_qty,
              'reason', coalesce(v_item->>'reason', v_item->'price_override'->>'reason', '')
            ));
          else
            v_unit_price := prod.price;
          end if;
        end;

      when 'accounting_item' then
        declare
          ai public.accounting_items;
          v_ov_price int;
        begin
          if v_ref_id is null or v_ref_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            return jsonb_build_object('error', 'invalid_items');
          end if;

          select * into ai from public.accounting_items
          where id = v_ref_id::uuid and is_active and category in ('menu', 'option');

          if ai.id is null or ai.price is null then
            return jsonb_build_object('error', 'accounting_item_not_found_or_inactive');
          end if;

          v_item_name := ai.name;
          v_cat := ai.category;
          v_list_price := ai.price;
          v_price_source := 'accounting_master';
          v_ref_id := ai.id::text;

          v_ov_price := case
            when v_item ? 'override_price' and v_item->>'override_price' is not null then (v_item->>'override_price')::int
            when v_item ? 'price_override' and v_item->'price_override' ? 'price' then (v_item->'price_override'->>'price')::int
            else null end;

          if v_ov_price is not null then
            v_has_l2 := true;
            v_unit_price := v_ov_price;
            v_overrides_facts := v_overrides_facts || jsonb_build_array(jsonb_build_object(
              'source', 'accounting_item',
              'ref_id', ai.id::text,
              'base_price', v_list_price,
              'override_price', v_ov_price,
              'quantity', v_qty,
              'reason', coalesce(v_item->>'reason', v_item->'price_override'->>'reason', '')
            ));
          else
            v_unit_price := ai.price;
          end if;
        end;

      when 'manual' then
        v_has_l2 := true;
        v_item_name := btrim(coalesce(v_item->>'name', ''));
        if v_item_name = '' then return jsonb_build_object('error', 'invalid_item_name'); end if;
        v_unit_price := coalesce((v_item->>'price')::int, (v_item->>'unit_price')::int, 0);
        if v_unit_price < 0 then return jsonb_build_object('error', 'invalid_price'); end if;
        v_list_price := v_unit_price;
        v_cat := 'manual';
        v_price_source := 'manual_entry';
        v_ref_id := null;

        v_manual_facts := v_manual_facts || jsonb_build_array(jsonb_build_object(
          'name', v_item_name,
          'price', v_unit_price,
          'quantity', v_qty,
          'reason', coalesce(v_item->>'reason', '')
        ));

      else
        return jsonb_build_object('error', 'invalid_items');
    end case;

    v_subtotal := v_subtotal + (v_unit_price * v_qty);

    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'index', v_i,
      'source', v_source,
      'ref_id', v_ref_id,
      'name', v_item_name,
      'category', v_cat,
      'quantity', v_qty,
      'unit_price', v_unit_price,
      'list_price', v_list_price,
      'line_discount', 0,
      'line_total', v_unit_price * v_qty,
      'price_source', v_price_source
    ));
  end loop;

  -- 3. 割引評価
  -- チケット割引 (P0-4 厳格検証)
  if p_request ? 'ticket_ids' and p_request->'ticket_ids' is not null and jsonb_array_length(p_request->'ticket_ids') > 0 then
    select coalesce(array_agg(x::uuid), '{}') into v_tids
    from jsonb_array_elements_text(p_request->'ticket_ids') x;

    if cardinality(v_tids) > 0 then
      if v_client is null then return jsonb_build_object('error', 'customer_context_mismatch', 'detail', 'customer_required_for_tickets'); end if;
      declare
        v_uids text[];
        v_tcount int;
        v_types text[];
        v_tuser text;
        t record;
      begin
        v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
        if v_uids is null or cardinality(v_uids) = 0 then
          return jsonb_build_object('error', 'customer_context_mismatch', 'detail', 'ticket_not_owned_by_customer');
        end if;

        select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1], coalesce(sum(amount), 0)
        into v_tcount, v_types, v_tuser, v_ticket_disc
        from public.tickets
        where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());

        if v_tcount <> cardinality(v_tids) then
          return jsonb_build_object('error', 'customer_context_mismatch', 'detail', 'ticket_not_owned_by_customer');
        end if;
        if cardinality(v_types) <> 1 then return jsonb_build_object('error', 'mixed_types'); end if;
        if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
          return jsonb_build_object('error', 'transfer_pending');
        end if;
        if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
           and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2)) then
          return jsonb_build_object('error', 'welcome_weekend');
        end if;
        if not app_private.can_use_type(app_private.today_used_type(v_tuser), v_types[1]) then
          return jsonb_build_object('error', 'daily_rule');
        end if;

        for t in select id, type, title, amount from public.tickets where id = any(v_tids) order by id loop
          v_ticket_details := v_ticket_details || jsonb_build_array(jsonb_build_object(
            'id', t.id, 'type', t.type, 'title', t.title, 'amount', t.amount
          ));
        end loop;
      end;
    end if;
  end if;

  -- メンテナンス割引
  if (p_request ? 'maintenance' and p_request->'maintenance' is not null and (p_request->'maintenance'->>'use')::boolean is true)
     or (p_request ? 'use_maintenance' and (p_request->>'use_maintenance')::boolean is true) then
    return jsonb_build_object('error', 'maintenance_offer_unconfigured');
  end if;

  -- 手動値引き
  if p_request ? 'manual_discount' and p_request->'manual_discount' is not null then
    if jsonb_typeof(p_request->'manual_discount') = 'number' then
      v_manual_disc := greatest(0, (p_request->>'manual_discount')::int);
    elsif jsonb_typeof(p_request->'manual_discount') = 'object' then
      v_manual_disc := greatest(0, coalesce((p_request->'manual_discount'->>'amount')::int, 0));
    end if;

    if v_manual_disc > 0 then
      v_has_l2 := true;
    end if;
  end if;

  v_discount := v_ticket_disc + v_manual_disc;
  v_total := greatest(0, v_subtotal - v_discount);

  select * into v_tax from public.accounting_settings where id = 1;

  -- 4. L2 facts と request_hash の計算
  if v_has_l2 then
    select coalesce(jsonb_agg(elem order by elem->>'source', coalesce(elem->>'ref_id', ''), elem->>'base_price', elem->>'override_price', elem->>'quantity', elem->>'reason'), '[]'::jsonb)
    into v_overrides_facts from jsonb_array_elements(v_overrides_facts) elem;

    select coalesce(jsonb_agg(elem order by elem->>'name', elem->>'price', elem->>'quantity', elem->>'reason'), '[]'::jsonb)
    into v_manual_facts from jsonb_array_elements(v_manual_facts) elem;

    v_facts := jsonb_build_object(
      'client_id', v_client,
      'reservation_id', v_res_id,
      'operator_staff_id', v_op_staff_id,
      'manual_discount', v_manual_disc,
      'overrides', v_overrides_facts,
      'manual_items', v_manual_facts
    );

    v_req_hash := app_private.pos_auth_hash('checkout_pricing_override', v_facts);
  end if;

  -- 5. Canonical Facts & quote_hash 生成 (QTE1.<64hex>)
  select jsonb_build_object(
    'c', v_client,
    'd', case when v_manual_disc > 0 then
      jsonb_build_object(
        'm', v_manual_disc,
        't', case when cardinality(v_tids) > 0 then jsonb_build_object('a', v_ticket_disc, 'ids', (select jsonb_agg(x order by x) from unnest(v_tids) x)) else null end
      )
    else
      jsonb_build_object(
        't', case when cardinality(v_tids) > 0 then jsonb_build_object('a', v_ticket_disc, 'ids', (select jsonb_agg(x order by x) from unnest(v_tids) x)) else null end
      )
    end,
    'dt', v_discount,
    'i', (select jsonb_agg(
            jsonb_build_object(
              'c', item->>'category',
              'n', item->>'name',
              'p', (item->>'unit_price')::int,
              'ps', item->>'price_source',
              'q', (item->>'quantity')::int,
              'r', item->>'ref_id',
              's', item->>'source'
            )
            order by item->>'source', coalesce(item->>'ref_id', ''), item->>'name', (item->>'unit_price')::int, (item->>'quantity')::int
          ) from jsonb_array_elements(v_normalized_items) item),
    'o', v_op_staff_id,
    'r', v_res_id,
    'ss', v_scan_session_id,
    'st', v_subtotal,
    'tm', v_tax.tax_mode,
    'tr', v_tax.tax_rate,
    'tt', v_total
  ) into v_canonical_facts;

  v_quote_hash := 'QTE1.' || app_private.sha256_hex(v_canonical_facts::text);

  return jsonb_build_object(
    'ok', true,
    'quote_hash', v_quote_hash,
    'request_hash', v_req_hash,
    'has_l2_overrides', v_has_l2,
    'subtotal', v_subtotal,
    'discount_total', v_discount,
    'total', v_total,
    'items', v_normalized_items,
    'discounts', jsonb_build_object(
      'ticket_discount', v_ticket_disc,
      'maintenance_discount', 0,
      'manual_discount', v_manual_disc,
      'manual_discount_label', '',
      'ticket_ids', (select coalesce(jsonb_agg(x), '[]'::jsonb) from unnest(v_tids) x),
      'tickets', v_ticket_details
    ),
    'tax', jsonb_build_object(
      'tax_mode', v_tax.tax_mode,
      'tax_rate', v_tax.tax_rate
    ),
    'facts', jsonb_build_object(
      'client_id', v_client,
      'client_name', v_name,
      'reservation_id', v_res_id,
      'scan_session_id', v_scan_session_id,
      'operator_staff_id', v_op_staff_id
    )
  );
end;
$$;

-- ── 7. staff_pos_quote の更新 ────────────────────────────────────────────────

drop function if exists public.staff_pos_quote(text, text, uuid, jsonb);
drop function if exists public.staff_pos_quote(text, text, uuid, jsonb, text);

create or replace function public.staff_pos_quote(
  p_staff text,
  p_operator_token text,
  p_scan_session uuid,
  p_request jsonb,
  p_approval_token text default null
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_op record;
  v_op_staff_id uuid := null;
  v_req jsonb := coalesce(p_request, '{}'::jsonb);
  v_client_ctx jsonb;
  v_res jsonb;
  v_verify jsonb;
begin
  perform app_private.assert_staff(p_staff);

  -- 1. Operator session 検証
  if p_operator_token is not null and btrim(p_operator_token) <> '' then
    begin
      select * into v_op from app_private.resolve_pos_operator(p_staff, p_operator_token);
      v_op_staff_id := v_op.operator_staff_id;
    exception
      when sqlstate 'P0001' then
        if sqlerrm = 'invalid_operator_session' then
          return json_build_object('error', 'operator_session_invalid');
        elsif sqlerrm = 'staff_auth_required' then
          return json_build_object('error', 'staff_auth_required');
        else
          raise;
        end if;
    end;
    if v_op_staff_id is null then
      return json_build_object('error', 'operator_session_invalid');
    end if;
  end if;

  -- 2. Customer context 解決
  v_client_ctx := app_private.resolve_pos_client_context(
    p_staff,
    p_scan_session,
    nullif(v_req->>'client_id', '')::uuid,
    nullif(v_req->>'reservation_id', '')::uuid
  );
  if v_client_ctx ? 'error' then
    return v_client_ctx::json;
  end if;

  -- 3. 価格計算 (Pure)
  v_res := app_private.pos_price(
    p_request := v_req,
    p_operator_staff_id := v_op_staff_id,
    p_client_context := v_client_ctx,
    p_is_pos := true,
    p_staff := p_staff,
    p_operator_token := p_operator_token,
    p_approval_token := p_approval_token
  );
  if v_res ? 'error' then
    return v_res::json;
  end if;

  -- 4. L2 override 検証 (Pure: verify のみ)
  if (v_res->>'has_l2_overrides')::boolean is true then
    if p_approval_token is null or btrim(p_approval_token) = '' then
      return json_build_object(
        'error', 'approval_required',
        'action', 'checkout_pricing_override',
        'request_hash', v_res->>'request_hash',
        'subtotal', v_res->>'subtotal',
        'total', v_res->>'total'
      );
    end if;

    v_verify := app_private.verify_pos_approval(p_staff, p_operator_token, p_approval_token, 'checkout_pricing_override', v_res->>'request_hash');
    if (v_verify->>'ok')::boolean is not true or v_verify ? 'error' then
      return v_verify::json;
    end if;
  end if;

  return v_res::json;
end;
$$;

revoke all on function public.staff_pos_quote(text, text, uuid, jsonb, text) from public;
grant execute on function public.staff_pos_quote(text, text, uuid, jsonb, text) to anon, authenticated;

-- One whitelist of server-priced business facts for initial writes, retries and insert races.
create or replace function app_private.pos_sale_request_hash(
  p jsonb,
  p_quote jsonb,
  p_operator_staff_id uuid
) returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select 'REQ1.' || app_private.sha256_hex(jsonb_build_object(
    'version', 'pos-sale-v1',
    'client_id', p_quote->'facts'->'client_id',
    'reservation_id', p_quote->'facts'->'reservation_id',
    'operator_staff_id', p_operator_staff_id,
    'stylist_id', nullif(p->>'stylist_id', '')::uuid,
    'payment_method', p->>'payment_method',
    'expected_total', nullif(p->>'expected_total', '')::bigint,
    'ginpay_account_id', case when p->>'payment_method' = 'ginpay'
      then nullif(p->>'ginpay_account_id', '')::uuid else null end,
    'items', (select coalesce(jsonb_agg(item - 'index' order by (item - 'index')::text), '[]'::jsonb)
      from jsonb_array_elements(p_quote->'items') item),
    'discounts', (p_quote->'discounts') - 'ticket_ids' - 'tickets' || jsonb_build_object(
      'ticket_ids', (select coalesce(jsonb_agg(id order by id::text), '[]'::jsonb)
        from jsonb_array_elements(p_quote->'discounts'->'ticket_ids') id),
      'tickets', (select coalesce(jsonb_agg(ticket order by ticket->>'id'), '[]'::jsonb)
        from jsonb_array_elements(p_quote->'discounts'->'tickets') ticket)),
    'subtotal', p_quote->'subtotal',
    'total', p_quote->'total',
    'tax', p_quote->'tax',
    'pricing_approval_facts_hash', p_quote->>'request_hash'
  )::text);
$$;
revoke all on function app_private.pos_sale_request_hash(jsonb, jsonb, uuid) from public, anon, authenticated;

create or replace function app_private.finalize_sale(
  p jsonb,
  p_actor_type text,
  p_actor_name text,
  p_staff_token text default null
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  r public.reservations;
  v_staff_token text := coalesce(p_staff_token, nullif(p->>'_staff_token', ''), nullif(p->>'staff_token', ''));
  v_client_ctx jsonb;
  v_client uuid;
  v_user text;
  v_name text;
  v_stylist public.staff_members;
  v_item jsonb;
  v_items jsonb;
  v_subtotal bigint;
  v_disc_total bigint;
  v_ticket_disc bigint := 0;
  v_total bigint;
  v_tids uuid[] := '{}'::uuid[];
  v_method text := p->>'payment_method';
  v_legacy text;
  v_tax public.accounting_settings;
  v_id uuid;
  t record;
  v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), '');
  v_req_hash text;
  v_existing uuid;
  v_existing_req_hash text;
  v_gp jsonb;
  v_account public.ginpay_accounts;
  v_mismatch jsonb;
  v_op record;
  v_op_staff_id uuid := null;
  v_price_res jsonb;
  v_quote_hash text;
  v_is_pos_path boolean;
begin
  if p_actor_name is null or btrim(p_actor_name) = '' then return jsonb_build_object('error', 'operator_required'); end if;
  if v_method is null or v_method not in ('cash', 'card', 'qr', 'ginpay', 'other') then return jsonb_build_object('error', 'invalid_payment_method'); end if;
  if v_key is not null and length(v_key) > 100 then return jsonb_build_object('error', 'invalid_idempotency_key'); end if;
  if v_method = 'ginpay' and v_key is null then return jsonb_build_object('error', 'idempotency_key_required'); end if;

  -- 1. Operator session 検証 (BLOCKER 4)
  if nullif(p->>'operator_token', '') is not null then
    begin
      select * into v_op from app_private.resolve_pos_operator(v_staff_token, p->>'operator_token');
      v_op_staff_id := v_op.operator_staff_id;
    exception when others then
      return jsonb_build_object('error', 'invalid_operator_session');
    end;
  end if;

  v_legacy := case v_method when 'card' then 'credit' else v_method end;

  -- 3. Customer Context 解決 (CRITICAL 1)
  v_client_ctx := app_private.resolve_pos_client_context(
    v_staff_token,
    nullif(p->>'scan_session_id', '')::uuid,
    nullif(p->>'client_id', '')::uuid,
    nullif(p->>'reservation_id', '')::uuid
  );
  if v_client_ctx ? 'error' then
    return v_client_ctx;
  end if;

  v_client := (v_client_ctx->>'client_id')::uuid;
  v_user := v_client_ctx->>'customer_id';
  v_name := v_client_ctx->>'customer_name';

  -- Authenticate and resolve identity before pricing or hashing; both paths use the same business facts.
  v_is_pos_path := (p ? 'quote_hash' or p ? 'scan_session_id' or p ? 'operator_token');
  v_price_res := app_private.pos_price(p, p_operator_staff_id => v_op_staff_id, p_client_context => v_client_ctx, p_is_pos => v_is_pos_path);
  if v_price_res ? 'error' then return v_price_res; end if;
  v_req_hash := app_private.pos_sale_request_hash(p, v_price_res, v_op_staff_id);

  if v_key is not null then
    select id, request_hash into v_existing, v_existing_req_hash
    from public.accounting_sessions
    where idempotency_key = v_key and status in ('completed', 'voided');
    if v_existing is not null then
      if v_existing_req_hash is distinct from v_req_hash then
        return jsonb_build_object('error', 'idempotency_conflict');
      end if;
      if v_is_pos_path and p->>'quote_hash' is distinct from v_price_res->>'quote_hash' then
        return jsonb_build_object('error', 'quote_mismatch');
      end if;
      return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true);
    end if;
  end if;


  -- 4. 予約の行ロック
  if nullif(p->>'reservation_id', '') is not null then
    select * into r from public.reservations where id = (p->>'reservation_id')::uuid for update;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if r.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
    if exists (select 1 from public.accounting_sessions where reservation_id = r.id and status = 'completed') then
      return jsonb_build_object('error', 'already_paid');
    end if;
  end if;

  -- 担当スタイリスト
  select * into v_stylist from public.staff_members where id = nullif(p->>'stylist_id', '')::uuid;
  if v_stylist.id is null then return jsonb_build_object('error', 'stylist_required'); end if;

  -- 5. チケットの行ロック & TOCTOU 再検証 (HIGH 2)
  if p ? 'ticket_ids' and p->'ticket_ids' is not null and jsonb_array_length(p->'ticket_ids') > 0 then
    select coalesce(array_agg(x::uuid), '{}') into v_tids
    from jsonb_array_elements_text(p->'ticket_ids') x;

    if cardinality(v_tids) > 0 then
      if v_client is null then return jsonb_build_object('error', 'invalid_tickets'); end if;

      perform 1 from public.tickets where id = any(v_tids) order by id for update;

      declare
        v_uids text[];
        v_types text[];
        v_tuser text;
        v_locked_count int;
      begin
        v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
        if v_uids is null or cardinality(v_uids) = 0 then
          return jsonb_build_object('error', 'invalid_tickets');
        end if;

        select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1]
        into v_locked_count, v_types, v_tuser
        from public.tickets
        where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());

        if v_locked_count <> cardinality(v_tids) then
          return jsonb_build_object('error', 'invalid_tickets');
        end if;
        if cardinality(v_types) <> 1 then
          return jsonb_build_object('error', 'mixed_types');
        end if;
        if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
          return jsonb_build_object('error', 'transfer_pending');
        end if;
        if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
           and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2)) then
          return jsonb_build_object('error', 'welcome_weekend');
        end if;
        if not app_private.can_use_type(app_private.today_used_type(v_tuser), v_types[1]) then
          return jsonb_build_object('error', 'daily_rule');
        end if;
      end;
    end if;
  end if;

  -- 6. POS 経路判定 & 価格・見積もり再計算 (ロック取得後 & canonical client context で実行)
  v_is_pos_path := (p ? 'quote_hash' or p ? 'scan_session_id' or p ? 'operator_token');

  v_price_res := app_private.pos_price(p, p_operator_staff_id => v_op_staff_id, p_client_context => v_client_ctx, p_is_pos => v_is_pos_path);
  if v_price_res ? 'error' then return v_price_res; end if;
  v_req_hash := app_private.pos_sale_request_hash(p, v_price_res, v_op_staff_id);

  v_quote_hash := v_price_res->>'quote_hash';
  v_subtotal := (v_price_res->>'subtotal')::bigint;
  v_disc_total := (v_price_res->>'discount_total')::bigint;
  v_total := (v_price_res->>'total')::bigint;
  v_items := v_price_res->'items';
  v_ticket_disc := (v_price_res->'discounts'->>'ticket_discount')::bigint;

  -- 7. quote_hash 照合 (BLOCKER 5: POS 経路では必須)
  if v_is_pos_path then
    if nullif(btrim(coalesce(p->>'quote_hash', '')), '') is null then
      return jsonb_build_object('error', 'quote_required');
    end if;
    if p->>'quote_hash' <> v_quote_hash then
      return jsonb_build_object('error', 'quote_mismatch');
    end if;
  end if;

  -- 8. expected_total 照合
  if nullif(p->>'expected_total', '') is null or (p->>'expected_total')::bigint <> v_total then
    return jsonb_build_object('error', 'total_mismatch', 'total', v_total);
  end if;

  select * into v_tax from public.accounting_settings where id = 1;

  -- 9. GINPay 払い (CRITICAL 1: 口座が canonical client に属しているか検証)
  if v_method = 'ginpay' then
    if v_client is null then return jsonb_build_object('error', 'ginpay_requires_client'); end if;
    if v_total <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;

    -- 渡された口座の所有者照合 (CRITICAL 1)
    if nullif(p->>'ginpay_account_id', '') is not null then
      select * into v_account from public.ginpay_accounts where id = (p->>'ginpay_account_id')::uuid;
      if v_account.id is null or app_private.client_root(v_account.client_id) <> v_client then
        return jsonb_build_object('error', 'customer_context_mismatch');
      end if;
    end if;

    v_gp := app_private.ginpay_resolve_account(v_client, nullif(p->>'ginpay_account_id', '')::uuid, false, p_actor_type, btrim(p_actor_name));
    if v_gp ? 'error' then
      if v_gp->>'error' = 'account_not_found' and exists (select 1 from public.ginpay_accounts a
           where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended') then
        return jsonb_build_object('error', 'ginpay_account_suspended');
      end if;
      return jsonb_build_object('error', case v_gp->>'error' when 'account_not_found' then 'ginpay_account_not_found' else v_gp->>'error' end);
    end if;
    select * into v_account from public.ginpay_accounts where id = (v_gp->>'account_id')::uuid for update;
    if v_account.status <> 'active' then return jsonb_build_object('error', 'ginpay_account_suspended'); end if;
    -- 書き込み前に台帳と照合
    v_mismatch := app_private.ginpay_check_reconciled(v_account.id, jsonb_build_object(
      'operation', 'sale_payment', 'amount', v_total, 'idempotency_key', v_key, 'reservation_id', r.id), p_actor_type, btrim(p_actor_name));
    if v_mismatch is not null then return v_mismatch; end if;
    if v_account.balance_cached < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached);
    end if;
  end if;

  -- 10. 会計レコード作成 (以後の失敗は例外で全体を取り消す)
  begin
    insert into public.accounting_sessions (user_id, customer_name, staff_name, stylist_name, stylist_id, payment_method, status,
      subtotal, discount_total, total, used_ticket_ids, client_id, reservation_id, tax_mode, tax_rate, idempotency_key,
      request_hash, quote_hash)
    values (v_user, coalesce(v_name, r.customer_name, ''), btrim(p_actor_name), v_stylist.display_name, v_stylist.id, v_legacy, 'pending',
      v_subtotal, v_disc_total, v_total, (select array_agg(x::text) from unnest(v_tids) x),
      v_client, r.id, v_tax.tax_mode, v_tax.tax_rate, v_key,
      v_req_hash, v_quote_hash)
    returning id into v_id;
  exception when unique_violation then
    if v_key is not null then
      select id, request_hash into v_existing, v_existing_req_hash
      from public.accounting_sessions
      where idempotency_key = v_key and status in ('completed', 'voided');

      if v_existing is not null then
        if v_existing_req_hash is not null and v_existing_req_hash <> v_req_hash then
          return jsonb_build_object('error', 'idempotency_conflict');
        end if;
        return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true);
      end if;
    end if;
    return jsonb_build_object('error', 'already_paid');
  end;

  -- 明細保存 (サーバー正規化 items)
  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.accounting_session_items (session_id, item_id, item_name, category, price, quantity, source, ref_id, list_price,
      line_discount, line_total, tax_mode, tax_rate, sort_order)
    values (
      v_id,
      case when v_item->>'source' in ('accounting_item', 'product') and (v_item->>'ref_id') ~ '^[0-9a-fA-F-]{36}$' then (v_item->>'ref_id')::uuid end,
      btrim(v_item->>'name'),
      v_item->>'category',
      (v_item->>'unit_price')::int,
      coalesce((v_item->>'quantity')::int, 1),
      case when v_item->>'source' = 'legacy' then null else v_item->>'source' end,
      v_item->>'ref_id',
      (v_item->>'list_price')::int,
      0,
      (v_item->>'line_total')::int,
      v_tax.tax_mode,
      v_tax.tax_rate,
      (v_item->>'index')::int
    );
  end loop;

  -- チケット割引明細
  for t in select id, type, title, amount from public.tickets where id = any(v_tids) order by id loop
    insert into public.accounting_discounts (session_id, kind, label, amount, ticket_id, ticket_type)
    values (v_id, 'ticket', t.title, t.amount, t.id, t.type);
  end loop;

  -- 支払レコード
  insert into public.accounting_payments (session_id, method, amount)
  values (v_id, v_legacy, v_total);

  -- GINPay 支払い
  if v_method = 'ginpay' then
    v_gp := app_private.ginpay_pay(v_client, v_account.id, v_total::int, v_id, p_actor_type, btrim(p_actor_name), 'sale:' || v_key);
    if v_gp ? 'error' then raise exception '%', v_gp->>'error'; end if;
  end if;

  -- チケット消費
  if cardinality(v_tids) > 0 then
    update public.tickets set used = true, used_at = now() where id = any(v_tids);
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used'
    from public.tickets t2 where t2.id = any(v_tids);
  end if;

  if v_user is not null then perform app_private.touch_visit(v_user); end if;

  update public.accounting_sessions set status = 'completed', completed_at = now() where id = v_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, detail)
  values (v_id, 'completed', p_actor_type, btrim(p_actor_name), jsonb_build_object('total', v_total, 'payment_method', v_method, 'quote_hash', v_quote_hash));

  -- 予約の完了
  if r.id is not null and r.status <> 'completed' then
    if (app_private.set_reservation_status(r.id, 'completed', p_actor_type, btrim(p_actor_name), null)) ? 'error' then
      raise exception 'reservation_not_completed';
    end if;
  end if;

  return app_private.sale_json(v_id);
end;
$$;
revoke all on function app_private.finalize_sale(jsonb, text, text, text) from public, anon, authenticated;

-- ── 8. staff_finalize_sale の更新 (Idempotency先行 & アトミック承認消費) ───────

drop function if exists public.staff_finalize_sale(text, jsonb, text);
drop function if exists public.staff_finalize_sale(text, jsonb, text, text);
drop function if exists public.staff_finalize_sale(text, jsonb, text, text, text);

create or replace function public.staff_finalize_sale(
  p_staff text,
  p jsonb,
  p_staff_name text,
  p_operator_token text,
  p_approval_token text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_op_token text := coalesce(p_operator_token, p->>'operator_token');
  v_app_token text := coalesce(p_approval_token, p->>'approval_token');
  v_quote_hash text;
  v_idem_key text := btrim(coalesce(p->>'idempotency_key', ''));
  v_existing public.accounting_sessions;
  v_req_hash text;
  v_client_ctx jsonb;
  v_quote jsonb;
  v_consume jsonb;
  v_sale jsonb;
  v_final_p jsonb := p;
  v_op_staff_id uuid := null;
  v_approval_consumed boolean := false;
begin
  perform app_private.assert_staff(p_staff);

  -- 1. オペレーター検証 (全リクエストで必須。operatorなしは fail-closed)
  if v_op_token is null or btrim(v_op_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_staff_id from app_private.resolve_pos_operator(p_staff, v_op_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;
  if v_op_staff_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  v_final_p := v_final_p || jsonb_build_object('operator_token', v_op_token);

  if v_app_token is not null and btrim(v_app_token) <> '' then
    v_final_p := v_final_p || jsonb_build_object('approval_token', v_app_token);
  end if;

  -- 2. quote_hash 検証 (全リクエストで必須かつ QTE1.<64hex> 形式必須)
  v_quote_hash := nullif(btrim(coalesce(p->>'quote_hash', '')), '');
  if v_quote_hash is null then
    return json_build_object('error', 'quote_required');
  end if;
  if v_quote_hash !~ '^QTE1\.[a-f0-9]{64}$' then
    return json_build_object('error', 'quote_mismatch');
  end if;

  -- Resolve trusted identity first; request client_id never supplies anonymous identity.
  v_client_ctx := app_private.resolve_pos_client_context(
    p_staff, nullif(p->>'scan_session_id', '')::uuid,
    nullif(p->>'client_id', '')::uuid, nullif(p->>'reservation_id', '')::uuid
  );
  if v_client_ctx ? 'error' then return v_client_ctx::json; end if;
  v_final_p := v_final_p - 'client_id' - 'customer_name' - 'user_id';
  if v_client_ctx->>'client_id' is not null then
    v_final_p := v_final_p || jsonb_build_object('client_id', v_client_ctx->>'client_id');
  end if;

  -- 3. 価格計算エンジン (server-side repricing)
  v_quote := app_private.pos_price(
    p_request := v_final_p,
    p_operator_staff_id := v_op_staff_id,
    p_client_context := v_client_ctx,
    p_is_pos := true,
    p_staff := p_staff,
    p_operator_token := v_op_token,
    p_approval_token := v_app_token
  );
  if v_quote ? 'error' then
    return v_quote::json;
  end if;

  if p->>'payment_method' = 'ginpay' then
    if v_client_ctx->>'client_id' is null then return json_build_object('error', 'ginpay_requires_client'); end if;
    if nullif(p->>'ginpay_account_id', '') is not null and not exists (
      select 1 from public.ginpay_accounts a where a.id = (p->>'ginpay_account_id')::uuid
        and app_private.client_root(a.client_id) = (v_client_ctx->>'client_id')::uuid
    ) then
      return json_build_object('error', 'customer_context_mismatch');
    end if;
  end if;

  -- Whitelisted business facts exclude scan IDs, tokens and caller-provided hashes.
  v_req_hash := app_private.pos_sale_request_hash(v_final_p, v_quote, v_op_staff_id);

  -- 6. Idempotency 評価 (before fresh approval; identity and current pricing were verified)
  if v_idem_key <> '' then
    select * into v_existing from public.accounting_sessions where idempotency_key = v_idem_key;
    if v_existing.id is not null then
      if v_existing.request_hash is distinct from v_req_hash then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      if v_quote->>'quote_hash' is distinct from v_quote_hash then
        return json_build_object('error', 'quote_mismatch');
      end if;
      return (app_private.sale_json(v_existing.id) || jsonb_build_object('idempotent', true))::json;
    end if;
  end if;

  if v_quote->>'quote_hash' is distinct from v_quote_hash then
    return json_build_object('error', 'quote_mismatch');
  end if;

  -- 7. L2 承認が必要な場合のアトミック消費
  if (v_quote->>'has_l2_overrides')::boolean is true then
    if v_app_token is null or btrim(v_app_token) = '' then
      return json_build_object('error', 'approval_required', 'action', 'checkout_pricing_override', 'request_hash', v_quote->>'request_hash');
    end if;

    v_consume := app_private.consume_pos_approval(
      p_staff, v_op_token, v_app_token,
      'checkout_pricing_override', v_quote->>'request_hash'
    );
    if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then
      return v_consume::json;
    end if;
    v_approval_consumed := true;
  end if;

  -- 8. 会計確定 (mutation)
  v_sale := app_private.finalize_sale(v_final_p, 'staff', p_staff_name, p_staff);

  if v_sale ? 'error' then
    if v_approval_consumed then
      raise exception 'finalize_failed: %', v_sale;
    end if;
    return v_sale::json;
  end if;

  return v_sale::json;
end;
$$;

revoke all on function public.staff_finalize_sale(text, jsonb, text, text, text) from public;
grant execute on function public.staff_finalize_sale(text, jsonb, text, text, text) to anon, authenticated;

-- ── 8-B. GINPay 不変台帳への canonical request_hash 永続化ヘルパー ───────────

create or replace function app_private.ginpay_tx_json(t public.ginpay_transactions)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'id', t.id,
    'account_id', t.account_id,
    'client_id', t.client_id,
    'client_name', (select c.display_name from public.clients c where c.id = t.client_id),
    'root_client_id', t.root_client_id,
    'amount', t.amount,
    'type', t.type,
    'status', t.status,
    'accounting_session_id', t.accounting_session_id,
    'stripe_event_id', t.stripe_event_id,
    'stripe_payment_intent_id', t.stripe_payment_intent_id,
    'stripe_checkout_session_id', t.stripe_checkout_session_id,
    'stripe_charge_id', t.stripe_charge_id,
    'operator_type', t.operator_type,
    'operator_name', t.operator_name,
    'reason', t.reason,
    'memo', t.memo,
    'idempotency_key', t.idempotency_key,
    'original_transaction_id', t.original_transaction_id,
    'created_at', t.created_at,
    'request_hash', t.request_hash
  )
$$;

-- 旧16引数シグネチャを明示DROP (overload残存・ambiguous call防止)
drop function if exists app_private.ginpay_record_transaction(
  uuid, text, integer, text, uuid, text, text, text, text, text, text, text, text, text, uuid, jsonb
);

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
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_account public.ginpay_accounts;
  v_tx public.ginpay_transactions;
  v_existing public.ginpay_transactions;
  v_next_balance integer;
  v_original public.ginpay_transactions;
  v_sale_reversal boolean := false;
  v_clean_req_hash text;
  v_mismatch jsonb;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    return jsonb_build_object('error', 'idempotency_key_required');
  end if;

  -- request_hash 形式検証 (AUTH1.<64hex> のみ受付)
  if p_request_hash is not null and btrim(p_request_hash) <> '' then
    if p_request_hash !~ '^AUTH1\.[a-f0-9]{64}$' then
      return jsonb_build_object('error', 'invalid_request_hash');
    end if;
    v_clean_req_hash := btrim(p_request_hash);
  else
    v_clean_req_hash := null;
  end if;

  select * into v_existing
  from public.ginpay_transactions
  where idempotency_key = btrim(p_idempotency_key);
  if v_existing.id is not null then
    if v_clean_req_hash is not null and v_existing.request_hash is not null and v_existing.request_hash <> v_clean_req_hash then
      return jsonb_build_object('error', 'idempotency_conflict');
    end if;
    return app_private.ginpay_idempotent_result(v_existing, p_account_id, p_type, p_amount, p_accounting_session_id, p_original_transaction_id);
  end if;

  select * into v_account
  from public.ginpay_accounts
  where id = p_account_id
  for update;
  if v_account.id is null then return jsonb_build_object('error', 'account_not_found'); end if;

  -- 台帳照合ガード (P0-1 契約)
  if p_status = 'posted' then
    v_mismatch := app_private.ginpay_check_reconciled(v_account.id, jsonb_build_object(
      'operation', p_type, 'amount', p_amount, 'accounting_session_id', p_accounting_session_id,
      'original_transaction_id', p_original_transaction_id, 'idempotency_key', btrim(p_idempotency_key)), p_operator_type, p_operator_name);
    if v_mismatch is not null then return v_mismatch; end if;
  end if;

  if v_account.status = 'suspended' and p_type in ('void', 'refund') and p_original_transaction_id is not null
     and p_accounting_session_id is not null and p_amount > 0 then
    select * into v_original from public.ginpay_transactions where id = p_original_transaction_id;
    v_sale_reversal := v_original.id is not null
      and v_original.account_id = v_account.id
      and v_original.type = 'payment' and v_original.status = 'posted'
      and v_original.accounting_session_id = p_accounting_session_id
      and exists (select 1 from public.accounting_sessions s where s.id = p_accounting_session_id and s.status = 'voided')
      and p_amount <= -(v_original.amount + coalesce((select sum(t.amount) from public.ginpay_transactions t
                          where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void')), 0));
  end if;
  if v_account.status <> 'active' and not v_sale_reversal then return jsonb_build_object('error', 'account_not_active'); end if;

  if p_status = 'posted' then
    v_next_balance := v_account.balance_cached + p_amount;
    if v_next_balance < 0 then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached);
    end if;
  else
    v_next_balance := v_account.balance_cached;
  end if;

  begin
    insert into public.ginpay_transactions (
      account_id, client_id, root_client_id, amount, type, status, accounting_session_id,
      stripe_event_id, stripe_payment_intent_id, stripe_checkout_session_id, stripe_charge_id,
      operator_type, operator_name, reason, memo, idempotency_key, original_transaction_id, metadata,
      request_hash
    )
    values (
      v_account.id, v_account.client_id, app_private.client_root(v_account.client_id), p_amount, p_type, p_status, p_accounting_session_id,
      nullif(btrim(coalesce(p_stripe_event_id, '')), ''),
      nullif(btrim(coalesce(p_stripe_payment_intent_id, '')), ''),
      nullif(btrim(coalesce(p_stripe_checkout_session_id, '')), ''),
      nullif(btrim(coalesce(p_stripe_charge_id, '')), ''),
      p_operator_type, nullif(btrim(coalesce(p_operator_name, '')), ''),
      nullif(btrim(coalesce(p_reason, '')), ''),
      nullif(btrim(coalesce(p_memo, '')), ''),
      btrim(p_idempotency_key), p_original_transaction_id, coalesce(p_metadata, '{}'::jsonb),
      v_clean_req_hash
    )
    returning * into v_tx;
  exception when unique_violation then
    select * into v_existing
    from public.ginpay_transactions
    where idempotency_key = p_idempotency_key
       or (p_stripe_event_id is not null and stripe_event_id = p_stripe_event_id)
       or (p_type = 'charge_stripe' and p_status = 'posted'
           and p_stripe_payment_intent_id is not null
           and stripe_payment_intent_id = p_stripe_payment_intent_id
           and type = 'charge_stripe' and status = 'posted')
    order by created_at
    limit 1;
    if v_existing.id is not null then
      if v_clean_req_hash is not null and v_existing.request_hash is not null and v_existing.request_hash <> v_clean_req_hash then
        return jsonb_build_object('error', 'idempotency_conflict');
      end if;
      return app_private.ginpay_idempotent_result(v_existing, p_account_id, p_type, p_amount, p_accounting_session_id, p_original_transaction_id);
    end if;
    raise;
  end;

  if p_status = 'posted' then
    perform set_config('app.ginpay_posting', 'on', true);
    update public.ginpay_accounts
    set balance_cached = v_next_balance, updated_at = now()
    where id = v_account.id;
    perform set_config('app.ginpay_posting', 'off', true);
  end if;

  if v_sale_reversal then
    insert into public.ginpay_account_events (account_id, client_id, event_type, actor_type, actor_name, detail)
    values (v_account.id, v_account.client_id, 'sale_reversal_while_suspended', p_operator_type, nullif(btrim(coalesce(p_operator_name, '')), ''),
            jsonb_build_object('transaction_id', v_tx.id, 'original_transaction_id', p_original_transaction_id,
                               'accounting_session_id', p_accounting_session_id, 'amount', p_amount, 'reason', p_reason));
  end if;

  return app_private.ginpay_tx_json(v_tx) || jsonb_build_object('balance', v_next_balance, 'idempotent', false);
exception
  when check_violation or foreign_key_violation or invalid_text_representation then
    return jsonb_build_object('error', 'invalid_value');
end;
$$;

-- 旧7引数シグネチャを明示DROP (overload残存・ambiguous call防止)
drop function if exists app_private.ginpay_reverse_transaction(
  uuid, integer, text, text, text, text, text
);

create or replace function app_private.ginpay_reverse_transaction(
  p_transaction_id uuid,
  p_amount integer,
  p_kind text,
  p_actor_type text,
  p_actor_name text,
  p_reason text,
  p_idempotency_key text,
  p_request_hash text default null
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_original public.ginpay_transactions;
  v_effect integer;
  v_amount integer;
begin
  if p_reason is null or btrim(p_reason) = '' then return jsonb_build_object('error', 'reason_required'); end if;

  select * into v_original
  from public.ginpay_transactions
  where id = p_transaction_id and status = 'posted';
  if v_original.id is null then return jsonb_build_object('error', 'transaction_not_found'); end if;
  if v_original.type = 'void' then return jsonb_build_object('error', 'invalid_transaction'); end if;
  if v_original.type = 'payment' and exists (
       select 1 from public.accounting_sessions s where s.id = v_original.accounting_session_id and s.status = 'completed') then
    return jsonb_build_object('error', 'use_sale_void');
  end if;

  perform 1
  from public.ginpay_accounts
  where id = v_original.account_id
  for update;

  if p_kind = 'refund' then
    if v_original.type not in ('payment', 'charge_store') then
      return jsonb_build_object('error', 'invalid_transaction');
    end if;
    if p_amount is null or p_amount <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
    select coalesce(sum(t.amount), 0) into v_effect
    from public.ginpay_transactions t
    where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void');
    if p_amount > (abs(v_original.amount) - abs(v_effect)) then return jsonb_build_object('error', 'amount_exceeds_refundable'); end if;
    v_amount := case when v_original.type = 'charge_store' then -p_amount else p_amount end;
  elsif p_kind = 'void' then
    select v_original.amount + coalesce(sum(t.amount), 0) into v_effect
    from public.ginpay_transactions t
    where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void');
    if v_effect = 0 then return jsonb_build_object('error', 'already_reversed'); end if;
    v_amount := -v_effect;
  else
    return jsonb_build_object('error', 'invalid_transaction');
  end if;

  return app_private.ginpay_record_transaction(
    v_original.account_id, p_kind, v_amount, 'posted', v_original.accounting_session_id,
    null, null, null, null, p_actor_type, p_actor_name, p_reason, null,
    p_idempotency_key, v_original.id, jsonb_build_object('reverses', v_original.id),
    p_request_hash
  );
end;
$$;

-- ── 9. staff_ginpay_charge_store の強化 ──────────────────────────────────────

drop function if exists public.staff_ginpay_charge_store(text, uuid, integer, text, text, text, text, uuid);
drop function if exists public.staff_ginpay_charge_store(text, text, uuid, integer, text, text, text, text, text, uuid);

create or replace function public.staff_ginpay_charge_store(
  p_staff text,
  p_operator_token text,
  p_client_id uuid,
  p_amount integer,
  p_payment_method text,
  p_staff_name text,
  p_memo text,
  p_idempotency_key text,
  p_approval_token text,
  p_account_id uuid
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.ginpay_transactions;
  v_acc_res jsonb;
  v_account_id uuid;
  v_policy public.pos_policy;
  v_op_member_id uuid;
  v_facts jsonb;
  v_req_hash text;
  v_consume jsonb;
  v_tx jsonb;
begin
  perform app_private.assert_staff(p_staff);

  -- 1. 基本引数検証
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if p_amount is null or p_amount <= 0 then return json_build_object('error', 'invalid_amount'); end if;
  if coalesce(p_payment_method, '') not in ('cash', 'credit', 'qr', 'other') then return json_build_object('error', 'invalid_payment_method'); end if;

  -- 2. オペレーター検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;

  if v_op_member_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  -- 3. GINPay 口座解決
  v_acc_res := app_private.ginpay_resolve_account(p_client_id, p_account_id, true, 'staff', p_staff_name);
  if v_acc_res ? 'error' then return v_acc_res::json; end if;
  v_account_id := (v_acc_res->>'account_id')::uuid;

  -- 4. canonical request_hash 生成
  v_facts := jsonb_build_object(
    'action', 'ginpay_charge',
    'client_id', p_client_id,
    'account_id', v_account_id,
    'amount', p_amount,
    'payment_method', p_payment_method,
    'operator_staff_id', v_op_member_id
  );
  v_req_hash := app_private.pos_auth_hash('ginpay_charge', v_facts);

  -- 5. Idempotency 先行評価 (保存済み request_hash との完全一致確認)
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select * into v_existing
    from public.ginpay_transactions
    where idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if v_existing.amount <> p_amount
         or v_existing.client_id <> p_client_id
         or (v_existing.request_hash is not null and v_existing.request_hash <> v_req_hash) then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      return (app_private.ginpay_tx_json(v_existing) || jsonb_build_object('idempotent', true, 'balance', (select balance_cached from public.ginpay_accounts where id = v_existing.account_id)))::json;
    end if;
  end if;

  -- 6. L2 限度額チェック (50,000円超で L2 承認要求)
  select * into v_policy from public.pos_policy where id = 1;
  if p_amount > coalesce(v_policy.ginpay_charge_l1_limit, 50000) then
    if p_approval_token is null or btrim(p_approval_token) = '' then
      return json_build_object('error', 'approval_required', 'action', 'ginpay_charge', 'request_hash', v_req_hash);
    end if;

    v_consume := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, 'ginpay_charge', v_req_hash);
    if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then return v_consume::json; end if;
  end if;

  -- 7. チャージ実行 (request_hash は INSERT 時に直接永続化)
  v_tx := app_private.ginpay_record_transaction(
    v_account_id, 'charge_store', p_amount, 'posted', null, null, null, null, null,
    'staff', p_staff_name, p_payment_method, p_memo, p_idempotency_key, null,
    jsonb_build_object('store_payment_method', p_payment_method),
    v_req_hash
  );

  return v_tx::json;
end;
$$;

-- -- ── 9-B. staff_ginpay_void の完全廃止 (BLOCKER 2: 新規作成せず明示DROP) ───────
drop function if exists public.staff_ginpay_void(text, uuid, text, text, text);
drop function if exists public.staff_ginpay_void(text, text, uuid, text, text, text, text);

-- ── 9-C. staff_ginpay_adjustment の完全廃止 (HQ/L3専用化) ────────────────────
drop function if exists public.staff_ginpay_adjustment(text, uuid, integer, text, text, text, uuid);
drop function if exists public.staff_ginpay_adjustment(text, uuid, integer, text, text, text);

-- ── 10. staff_ginpay_refund の強化 ───────────────────────────────────────────

drop function if exists public.staff_ginpay_refund(text, uuid, integer, text, text, text);
drop function if exists public.staff_ginpay_refund(text, text, uuid, integer, text, text, text, text);

create or replace function public.staff_ginpay_refund(
  p_staff text,
  p_operator_token text,
  p_transaction_id uuid,
  p_amount integer,
  p_staff_name text,
  p_reason text,
  p_idempotency_key text,
  p_approval_token text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.ginpay_transactions;
  v_original public.ginpay_transactions;
  v_op_member_id uuid;
  v_effect integer;
  v_refundable integer;
  v_facts jsonb;
  v_req_hash text;
  v_consume jsonb;
  v_res jsonb;
begin
  perform app_private.assert_staff(p_staff);

  -- 1. 基本引数検証
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if p_amount is null or p_amount <= 0 then return json_build_object('error', 'invalid_amount'); end if;
  if p_reason is null or btrim(p_reason) = '' then return json_build_object('error', 'reason_required'); end if;

  -- 2. オペレーター検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;

  if v_op_member_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  -- 3. 対象取引の検証 & 返金可能額計算
  select * into v_original
  from public.ginpay_transactions
  where id = p_transaction_id and status = 'posted';

  if v_original.id is null then return json_build_object('error', 'transaction_not_found'); end if;
  if v_original.type = 'void' then return json_build_object('error', 'invalid_transaction'); end if;

  -- 確定済み会計の支払いは会計取消へ誘導
  if v_original.type = 'payment' and exists (
       select 1 from public.accounting_sessions s where s.id = v_original.accounting_session_id and s.status = 'completed') then
    return json_build_object('error', 'use_sale_void');
  end if;

  if v_original.type <> 'payment' and v_original.type <> 'charge_store' then
    return json_build_object('error', 'invalid_transaction');
  end if;

  select coalesce(sum(t.amount), 0) into v_effect
  from public.ginpay_transactions t
  where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void');

  v_refundable := abs(v_original.amount) - abs(v_effect);
  if v_refundable <= 0 or p_amount > v_refundable then
    return json_build_object('error', 'amount_exceeds_refundable', 'refundable_amount', v_refundable);
  end if;

  -- 4. canonical request_hash 生成
  v_facts := jsonb_build_object(
    'action', 'refund',
    'account_id', v_original.account_id,
    'client_id', v_original.client_id,
    'target_transaction_id', v_original.id,
    'refundable_amount', v_refundable,
    'requested_refund_amount', p_amount,
    'reason', btrim(p_reason),
    'operator_staff_id', v_op_member_id
  );
  v_req_hash := app_private.pos_auth_hash('refund', v_facts);

  -- 5. Idempotency 先行評価 (保存済み request_hash との完全一致確認)
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select * into v_existing
    from public.ginpay_transactions
    where idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if abs(v_existing.amount) <> p_amount
         or v_existing.original_transaction_id <> p_transaction_id
         or (v_existing.request_hash is not null and v_existing.request_hash <> v_req_hash) then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      return (app_private.ginpay_tx_json(v_existing) || jsonb_build_object('idempotent', true, 'balance', (select balance_cached from public.ginpay_accounts where id = v_existing.account_id)))::json;
    end if;
  end if;

  -- 6. L2 承認要求
  if p_approval_token is null or btrim(p_approval_token) = '' then
    return json_build_object('error', 'approval_required', 'action', 'refund', 'request_hash', v_req_hash);
  end if;

  v_consume := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, 'refund', v_req_hash);
  if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then return v_consume::json; end if;

  -- 7. 返金実行 (request_hash は INSERT 時に直接永続化)
  v_res := app_private.ginpay_reverse_transaction(
    p_transaction_id, p_amount, 'refund', 'staff', p_staff_name, btrim(p_reason), p_idempotency_key,
    v_req_hash
  );

  if v_res ? 'error' then
    -- 例外化してトランザクションをロールバック (承認消費もすべて巻き戻る)
    raise exception 'refund_failed: %', v_res;
  end if;

  return v_res::json;
end;
$$;

-- ── 11. staff_void_sale の新設 ────────────────────────────────────────────────

drop function if exists public.staff_void_sale(text, text, uuid, text, text);
drop function if exists public.staff_void_sale(text, text, uuid, text, text, text);

create or replace function public.staff_void_sale(
  p_staff text,
  p_operator_token text,
  p_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_approval_token text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.accounting_sessions;
  v_sale public.accounting_sessions;
  v_op_member_id uuid;
  v_facts jsonb;
  v_req_hash text;
  v_consume jsonb;
  v_res jsonb;
begin
  -- 1. 店舗端末セッション検証
  perform app_private.assert_staff(p_staff);

  -- 2. 基本引数検証
  if p_reason is null or btrim(p_reason) = '' then return json_build_object('error', 'reason_required'); end if;

  -- 3. オペレーター検証 (replay 前に必ず検証。invalid/revoked operator には replay 結果を返さない)
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;

  if v_op_member_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  -- 4. 対象会計の存在確認 & 行ロック
  select * into v_sale from public.accounting_sessions where id = p_id for update;
  if v_sale.id is null then return json_build_object('error', 'not_found'); end if;

  -- 5. stable canonical request_hash 生成
  -- mutation後の可変状態 (status = voided等) は含めず、元会計の不変値とリクエスト事実のみを正本とする
  v_facts := jsonb_build_object(
    'action', 'void',
    'sale_id', v_sale.id,
    'original_total', v_sale.total,
    'original_payment_method', v_sale.payment_method,
    'reason', btrim(p_reason),
    'operator_staff_id', v_op_member_id
  );
  v_req_hash := app_private.pos_auth_hash('void', v_facts);

  -- 6. Idempotency Replay 評価 (オペレーター認証・ハッシュ照合後の exact replay)
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select * into v_existing
    from public.accounting_sessions
    where void_idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if v_existing.id <> p_id then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      if v_existing.void_request_hash is not null and v_existing.void_request_hash <> v_req_hash then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      -- 一致: 保存済み結果を返却 (successful retry では fresh approval 不要)
      return (app_private.sale_json(v_existing.id) || jsonb_build_object('idempotent', true))::json;
    end if;
  end if;

  -- 7. 新規取消処理 (未取消であることを確認)
  if v_sale.status <> 'completed' then return json_build_object('error', 'invalid_status'); end if;

  -- L2 承認要求
  if p_approval_token is null or btrim(p_approval_token) = '' then
    return json_build_object('error', 'approval_required', 'action', 'void', 'request_hash', v_req_hash);
  end if;

  v_consume := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, 'void', v_req_hash);
  if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then return v_consume::json; end if;

  -- void_idempotency_key & void_request_hash の記録
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    update public.accounting_sessions
    set void_idempotency_key = p_idempotency_key,
        void_request_hash = v_req_hash
    where id = p_id;
  end if;

  -- 会計取消実行 (app_private.void_sale)
  v_res := app_private.void_sale(p_id, btrim(p_reason), 'staff', 'スタッフ');
  if v_res ? 'error' then
    -- 例外化してトランザクションをロールバック (承認消費・void_idempotency_key・void_request_hash 記録もすべて巻き戻る)
    raise exception 'void_sale_failed: %', v_res;
  end if;

  return v_res::json;
end;
$$;

-- ── 12. staff_issue_tickets の強化 ───────────────────────────────────────────

drop function if exists public.staff_issue_tickets(text, text, text, integer, integer, text, text);
drop function if exists public.staff_issue_tickets(text, text, text, text, text, integer, integer, text, text, text);
drop function if exists public.staff_issue_tickets(text, text, text, text, text, integer, integer, text, text);

create or replace function public.staff_issue_tickets(
  p_staff text,
  p_operator_token text,
  p_customer_name text,
  p_user_id text,
  p_type text,
  p_amount integer,
  p_quantity integer,
  p_staff_name text,
  p_idempotency_key text,
  p_approval_token text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.ticket_issue_logs;
  v_op_member_id uuid;
  v_client_id uuid;
  v_facts jsonb;
  v_req_hash text;
  v_consume jsonb;
  v_title text;
  v_rows json;
  v_ticket_ids uuid[];
begin
  perform app_private.assert_staff(p_staff);

  -- 1. 基本引数検証
  if p_type not in ('otoku', 'discount') then raise exception 'invalid_ticket_type'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then raise exception 'invalid_amount'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 30 then raise exception 'invalid_quantity'; end if;
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;
  if not exists (select 1 from public.customers where user_id = p_user_id) then raise exception 'customer_not_found'; end if;

  -- 2. オペレーター検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;

  if v_op_member_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  v_client_id := app_private.user_client(p_user_id);
  v_title := case p_type when 'otoku' then '漢トク券' else '割引券' end;

  -- 3. canonical request_hash 生成
  v_facts := jsonb_build_object(
    'action', 'ticket_issue',
    'recipient_user_id', p_user_id,
    'recipient_client_id', v_client_id,
    'ticket_type', p_type,
    'amount', p_amount,
    'quantity', p_quantity,
    'rule_facts', jsonb_build_object('title', v_title),
    'operator_staff_id', v_op_member_id
  );
  v_req_hash := app_private.pos_auth_hash('ticket_issue', v_facts);

  -- 4. Idempotency 先行評価 (exact ticket IDs バインド)
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select * into v_existing
    from public.ticket_issue_logs
    where idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if (v_existing.request_hash is not null and v_existing.request_hash <> v_req_hash)
         or v_existing.amount <> p_amount
         or v_existing.quantity <> p_quantity
         or v_existing.user_id <> p_user_id then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      return json_build_object(
        'tickets', (
          select coalesce(json_agg(row_to_json(t) order by t.created_at, t.id), '[]'::json)
          from public.tickets t
          where t.id = any(v_existing.ticket_ids)
        ),
        'idempotent', true
      );
    end if;
  end if;

  -- 5. L2 承認要求
  if p_approval_token is null or btrim(p_approval_token) = '' then
    return json_build_object('error', 'approval_required', 'action', 'ticket_issue', 'request_hash', v_req_hash);
  end if;

  v_consume := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, 'ticket_issue', v_req_hash);
  if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then return v_consume::json; end if;

  -- 6. 発行実行 & exact ticket IDs 永続化
  with ins as (
    insert into public.tickets (user_id, type, title, amount, issued_by, used)
    select p_user_id, p_type, v_title, p_amount, p_staff_name, false
    from generate_series(1, p_quantity)
    returning *
  )
  select coalesce(array_agg(ins.id), '{}'), coalesce(json_agg(row_to_json(ins)), '[]'::json)
  into v_ticket_ids, v_rows
  from ins;

  insert into public.ticket_issue_logs (
    staff_name, customer_name, user_id, ticket_type, amount, quantity, terminal, status,
    idempotency_key, request_hash, ticket_ids
  ) values (
    p_staff_name, coalesce(p_customer_name, ''), p_user_id, p_type, p_amount, p_quantity, 'staff-terminal', 'issued',
    p_idempotency_key, v_req_hash, v_ticket_ids
  );

  return json_build_object('tickets', v_rows);
end;
$$;

-- ── 12-B. staff_issue_tickets 旧シグネチャの完全撤廃 ─────────────────────────
drop function if exists public.staff_issue_tickets(text, text, text, integer, integer, text, text);
drop function if exists public.staff_issue_tickets(text, text, text, text, text, integer, integer, text, text);

-- ── 13. staff_ginpay_adjustment の完全廃止 (店舗側RPC全廃 / HQ・L3専用) ───────
drop function if exists public.staff_ginpay_adjustment(text, uuid, integer, text, text, text, uuid);
drop function if exists public.staff_ginpay_adjustment(text, uuid, integer, text, text, text);

-- ── 13-B. staff_use_tickets の完全廃止 (POS会計 staff_finalize_sale 内でのみチケット消費を許可) ───
drop function if exists public.staff_use_tickets(text, text, uuid[], text, text);

-- ── 13-C. staff_pos_operator_candidates (予約枠独立・資格検証済みOperator候補一覧) ──
create or replace function public.staff_pos_operator_candidates(
  p_staff text
) returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff jsonb;
begin
  -- 1. 店舗端末セッション検証 (未認証は即時拒否)
  perform app_private.assert_staff(p_staff);

  -- 2. 有効な Operator 資格を持つ現役スタッフのみ抽出 (is_bookable に依存しない)
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'name', m.display_name
      ) order by m.sort_order, m.display_name
    ),
    '[]'::jsonb
  ) into v_staff
  from public.staff_members m
  inner join app_private.staff_operator_credentials c
    on c.staff_member_id = m.id
  where m.is_active = true
    and c.is_active = true
    and c.role in ('staff', 'manager');

  return jsonb_build_object('staff', v_staff);
end;
$$;

-- ── 14. 権限設定 (GRANT / REVOKE の境界明確化: 正本シグネチャのみ公開) ──────────

do $$
declare f text;
begin
  foreach f in array array[
    'public.staff_operator_verify(text, uuid, text)',
    'public.staff_pos_approve(text, text, uuid, text, text, text)',
    'public.staff_pos_quote(text, text, uuid, jsonb, text)',
    'public.staff_finalize_sale(text, jsonb, text, text, text)',
    'public.staff_ginpay_charge_store(text, text, uuid, integer, text, text, text, text, text, uuid)',
    'public.staff_ginpay_refund(text, text, uuid, integer, text, text, text, text)',
    'public.staff_void_sale(text, text, uuid, text, text, text)',
    'public.staff_issue_tickets(text, text, text, text, text, integer, integer, text, text, text)',
    'public.staff_pos_operator_candidates(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema app_private from public, anon, authenticated;
