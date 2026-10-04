-- ============================================================================
-- GINJIRO POS Phase 0 / P0-3: Operator Authentication & Approval
-- (20261009000100_customer_presence_token.sql の後に適用)
--
-- 店舗端末 /staff における操作者（L1）および管理者承認（L2）の基盤。
--   * スタッフ個別本人確認（L1）: staff_members の担当者ごとの PIN（bcrypt）照合により
--     staff_member_id を操作者の正本として確定。
--   * 管理者承認（L2）: L1 操作者とは別の manager role を持つスタッフによる 1 回限りの承認。
--     5分有効、1回限り、request_hash にバインド。平文 approval token は DB に保存しない。
--   * 操作者と承認者の分離: operator_staff_id <> approver_staff_id を制約・RPC 両面で強制。
--   * 初期状態: manager 0名、fail closed。特定スタッフを manager に自動設定しない。
--   * 初期 policy (pos_policy):
--       manual_discount_l1_limit = 0（手入力値引きは L1 で禁止、将来 L2 必須）
--       ginpay_charge_l1_limit = 50000（店頭チャージ上限 50,000円）
--       require_l2_ticket_issue / refund / void / price_override / manual_item = true
--   * 監査 (pos_operator_events): ログイン成功/失敗/ロック、承認申請/承認/拒否/消費/期限切れ。
--     PIN・平文セッショントークン・平文承認トークン・Customer QR・PII は記録しない。
-- ============================================================================

-- ── 1. スタッフ個人資格情報 (app_private) ──────────────────────────────────────
create table if not exists app_private.staff_operator_credentials (
  staff_member_id uuid primary key references public.staff_members(id) on delete cascade,
  pin_hash        text not null,
  role            text not null check (role in ('staff', 'manager')),
  failed_count    integer not null default 0 check (failed_count >= 0),
  locked_until    timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists staff_operator_credentials_role_idx
  on app_private.staff_operator_credentials (role) where is_active;

-- ── 2. オペレーター個別セッション (app_private) ────────────────────────────────
-- 店舗端末セッション（p_staff）内に紐づく個人認証セッション（TTL: 30分）
create table if not exists app_private.pos_operator_sessions (
  token_hash          text primary key,
  staff_session_hash  text not null,
  staff_member_id     uuid not null references public.staff_members(id),
  role                text not null check (role in ('staff', 'manager')),
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  check (expires_at > created_at)
);
create index if not exists pos_operator_sessions_staff_session_idx
  on app_private.pos_operator_sessions (staff_session_hash, created_at desc);
create index if not exists pos_operator_sessions_staff_member_idx
  on app_private.pos_operator_sessions (staff_member_id, created_at desc);

-- ── 3. POS 承認トークン (app_private) ──────────────────────────────────────────
-- 管理者による1回限り・5分有効・request_hash にバインドされた承認
create table if not exists app_private.pos_approvals (
  approval_hash                   text primary key,
  action                          text not null,
  request_hash                    text not null,
  operator_staff_id               uuid not null references public.staff_members(id),
  approver_staff_id               uuid not null references public.staff_members(id),
  created_at                      timestamptz not null default now(),
  expires_at                      timestamptz not null,
  consumed_at                     timestamptz,
  consumed_by_staff_session_hash  text,
  check (operator_staff_id <> approver_staff_id),
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumed_by_staff_session_hash is null))
);
create index if not exists pos_approvals_request_idx
  on app_private.pos_approvals (request_hash, action);

-- ── 4. POS ポリシー基盤 (public) ──────────────────────────────────────────────
create table if not exists public.pos_policy (
  id                          smallint primary key default 1 check (id = 1),
  manual_discount_l1_limit    integer not null default 0 check (manual_discount_l1_limit >= 0),
  ginpay_charge_l1_limit      integer not null default 50000 check (ginpay_charge_l1_limit >= 0),
  require_l2_ticket_issue     boolean not null default true,
  require_l2_refund           boolean not null default true,
  require_l2_void             boolean not null default true,
  require_l2_price_override   boolean not null default true,
  require_l2_manual_item      boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
insert into public.pos_policy (id) values (1) on conflict (id) do nothing;

-- ── 5. POS オペレーター & 承認監査イベント (public) ───────────────────────────
create table if not exists public.pos_operator_events (
  id                  bigint generated always as identity primary key,
  event_type          text not null check (event_type in (
    'operator_login',
    'approval_requested',
    'approval_approved',
    'approval_rejected',
    'approval_consumed',
    'approval_expired'
  )),
  result              text not null check (result in (
    'success',
    'failure',
    'locked',
    'approved',
    'rejected',
    'consumed',
    'expired'
  )),
  reason              text,
  staff_member_id     uuid references public.staff_members(id),
  approver_staff_id   uuid references public.staff_members(id),
  action              text,
  request_hash        text,
  staff_session_hash  text,
  created_at          timestamptz not null default now()
);
create index if not exists pos_operator_events_staff_idx
  on public.pos_operator_events (staff_member_id, created_at desc);
create index if not exists pos_operator_events_session_idx
  on public.pos_operator_events (staff_session_hash, created_at desc);

-- ── 6. RLS とアクセス権の保護 ─────────────────────────────────────────────────
alter table app_private.staff_operator_credentials enable row level security;
alter table app_private.pos_operator_sessions enable row level security;
alter table app_private.pos_approvals enable row level security;
alter table public.pos_policy enable row level security;
alter table public.pos_operator_events enable row level security;

revoke all on app_private.staff_operator_credentials from public, anon, authenticated;
revoke all on app_private.pos_operator_sessions from public, anon, authenticated;
revoke all on app_private.pos_approvals from public, anon, authenticated;
revoke all on public.pos_policy from public, anon, authenticated;
revoke all on public.pos_operator_events from public, anon, authenticated;
revoke all on sequence public.pos_operator_events_id_seq from public, anon, authenticated;

-- ── 7. 内部設定ヘルパー (app_private) ──────────────────────────────────────────
/** スタッフ個人 PIN およびロールの設定（bcrypt ハッシュのみ保存） */
create or replace function app_private.set_staff_operator_credentials(
  p_staff_member_id uuid,
  p_pin text,
  p_role text default 'staff'
) returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_member public.staff_members;
begin
  select * into v_member from public.staff_members where id = p_staff_member_id;
  if v_member.id is null then
    raise exception 'staff_member_not_found' using errcode = '22023';
  end if;
  if p_role not in ('staff', 'manager') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'invalid_pin_format' using errcode = '22023';
  end if;

  insert into app_private.staff_operator_credentials (
    staff_member_id, pin_hash, role, failed_count, locked_until, is_active, updated_at
  ) values (
    p_staff_member_id,
    crypt(p_pin, gen_salt('bf', 10)),
    p_role,
    0,
    null,
    true,
    now()
  )
  on conflict (staff_member_id) do update set
    pin_hash = excluded.pin_hash,
    role = excluded.role,
    failed_count = 0,
    locked_until = null,
    is_active = true,
    updated_at = now();

  -- PIN 変更時は既存の該当スタッフの operator session を無効化
  update app_private.pos_operator_sessions
  set revoked_at = now()
  where staff_member_id = p_staff_member_id and revoked_at is null;
end;
$$;

-- ── 8. HQ RPC: スタッフ資格情報・役職の設定 ───────────────────────────────────
create or replace function public.hq_set_staff_operator_credential(
  p_hq text,
  p_staff_member_id uuid,
  p_pin text,
  p_role text default 'staff'
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  perform app_private.set_staff_operator_credentials(p_staff_member_id, p_pin, p_role);
  return json_build_object('ok', true, 'staff_member_id', p_staff_member_id, 'role', p_role);
end;
$$;

-- ── 9. スタッフ本人確認 RPC (L1 昇格) ─────────────────────────────────────────
create or replace function public.staff_operator_verify(
  p_staff text,
  p_staff_member_id uuid,
  p_pin text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash text;
  v_member public.staff_members;
  v_cred app_private.staff_operator_credentials;
  v_raw_token text;
  v_token_hash text;
  v_exp timestamptz := now() + interval '30 minutes';
begin
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- スタッフ存在・有効性
  select * into v_member from public.staff_members where id = p_staff_member_id;
  if v_member.id is null or not v_member.is_active then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, staff_session_hash
    ) values (
      'operator_login', 'failure', 'inactive_or_not_found', p_staff_member_id, v_staff_hash
    );
    return json_build_object('error', 'inactive_or_not_found');
  end if;

  -- 認証情報照合 (FOR UPDATE でロックして同時試行・総当たりを防ぐ)
  select * into v_cred from app_private.staff_operator_credentials
  where staff_member_id = p_staff_member_id for update;

  if v_cred.staff_member_id is null then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, staff_session_hash
    ) values (
      'operator_login', 'failure', 'not_configured', p_staff_member_id, v_staff_hash
    );
    return json_build_object('error', 'not_configured');
  end if;

  if not v_cred.is_active then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, staff_session_hash
    ) values (
      'operator_login', 'failure', 'credential_revoked', p_staff_member_id, v_staff_hash
    );
    return json_build_object('error', 'credential_revoked');
  end if;

  -- ロック中か確認
  if v_cred.locked_until is not null and v_cred.locked_until > now() then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, staff_session_hash
    ) values (
      'operator_login', 'locked', 'temporarily_locked', p_staff_member_id, v_staff_hash
    );
    return json_build_object('error', 'locked', 'locked_until', v_cred.locked_until);
  end if;

  -- PIN 照合 (bcrypt)
  if p_pin is null or crypt(p_pin, v_cred.pin_hash) <> v_cred.pin_hash then
    v_cred.failed_count := v_cred.failed_count + 1;
    if v_cred.failed_count >= 5 then
      update app_private.staff_operator_credentials
      set failed_count = 0,
          locked_until = now() + interval '15 minutes',
          updated_at = now()
      where staff_member_id = p_staff_member_id;

      insert into public.pos_operator_events (
        event_type, result, reason, staff_member_id, staff_session_hash
      ) values (
        'operator_login', 'locked', 'max_failed_attempts', p_staff_member_id, v_staff_hash
      );
      return json_build_object('error', 'locked', 'locked_until', now() + interval '15 minutes');
    else
      update app_private.staff_operator_credentials
      set failed_count = v_cred.failed_count,
          updated_at = now()
      where staff_member_id = p_staff_member_id;

      insert into public.pos_operator_events (
        event_type, result, reason, staff_member_id, staff_session_hash
      ) values (
        'operator_login', 'failure', 'invalid_pin', p_staff_member_id, v_staff_hash
      );
      return json_build_object('error', 'invalid_pin', 'remaining_attempts', 5 - v_cred.failed_count);
    end if;
  end if;

  -- 認証成功: カウントリセット、セッショントークン生成
  update app_private.staff_operator_credentials
  set failed_count = 0,
      locked_until = null,
      updated_at = now()
  where staff_member_id = p_staff_member_id;

  v_raw_token := 'OPS1.' || encode(gen_random_bytes(32), 'hex');
  v_token_hash := app_private.sha256_hex(v_raw_token);

  insert into app_private.pos_operator_sessions (
    token_hash, staff_session_hash, staff_member_id, role, expires_at
  ) values (
    v_token_hash, v_staff_hash, p_staff_member_id, v_cred.role, v_exp
  );

  insert into public.pos_operator_events (
    event_type, result, staff_member_id, staff_session_hash
  ) values (
    'operator_login', 'success', p_staff_member_id, v_staff_hash
  );

  return json_build_object(
    'operator_token', v_raw_token,
    'staff_member_id', p_staff_member_id,
    'staff_name', v_member.display_name,
    'role', v_cred.role,
    'expires_at', v_exp,
    'ttl_seconds', 1800
  );
end;
$$;

-- ── 10. 管理者承認 RPC (L2 発行) ──────────────────────────────────────────────
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
  v_staff_hash text;
  v_op app_private.pos_operator_sessions;
  v_mgr public.staff_members;
  v_mgr_cred app_private.staff_operator_credentials;
  v_raw_approval text;
  v_approval_hash text;
  v_exp timestamptz := now() + interval '5 minutes';
begin
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- 1. Operator session 検証
  if p_operator_token is null then
    insert into public.pos_operator_events (
      event_type, result, reason, action, request_hash, staff_session_hash
    ) values (
      'approval_rejected', 'rejected', 'missing_operator_token', p_action, p_request_hash, v_staff_hash
    );
    return json_build_object('error', 'invalid_operator_session');
  end if;

  select * into v_op from app_private.pos_operator_sessions
  where token_hash = app_private.sha256_hex(p_operator_token)
    and staff_session_hash = v_staff_hash
    and revoked_at is null;

  if v_op.token_hash is null or v_op.expires_at <= now() then
    insert into public.pos_operator_events (
      event_type, result, reason, action, request_hash, staff_session_hash
    ) values (
      'approval_rejected', 'rejected',
      case when v_op.token_hash is null then 'invalid_operator_session' else 'operator_session_expired' end,
      p_action, p_request_hash, v_staff_hash
    );
    return json_build_object('error', 'invalid_operator_session');
  end if;

  -- 2. 操作者と承認者の分離 (同一人物は不可)
  if p_manager_staff_id = v_op.staff_member_id then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_rejected', 'rejected', 'self_approval_prohibited', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return json_build_object('error', 'self_approval_prohibited');
  end if;

  -- 3. アクションと request_hash の検証
  if p_action is null or btrim(p_action) = '' then
    return json_build_object('error', 'invalid_action');
  end if;
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    return json_build_object('error', 'invalid_request_hash');
  end if;

  -- 4. Manager の検証
  select * into v_mgr from public.staff_members where id = p_manager_staff_id;
  if v_mgr.id is null or not v_mgr.is_active then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_rejected', 'rejected', 'manager_not_found_or_inactive', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return json_build_object('error', 'manager_not_found_or_inactive');
  end if;

  -- Manager の資格情報 (FOR UPDATE でロック)
  select * into v_mgr_cred from app_private.staff_operator_credentials
  where staff_member_id = p_manager_staff_id for update;

  if v_mgr_cred.staff_member_id is null or v_mgr_cred.role <> 'manager' or not v_mgr_cred.is_active then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_rejected', 'rejected', 'not_a_manager', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return json_build_object('error', 'not_a_manager');
  end if;

  if v_mgr_cred.locked_until is not null and v_mgr_cred.locked_until > now() then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_rejected', 'rejected', 'manager_locked', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return json_build_object('error', 'manager_locked');
  end if;

  -- Manager PIN 検証
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
        'approval_rejected', 'rejected', 'manager_locked_max_failures', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
      );
      return json_build_object('error', 'manager_locked');
    else
      update app_private.staff_operator_credentials
      set failed_count = v_mgr_cred.failed_count,
          updated_at = now()
      where staff_member_id = p_manager_staff_id;

      insert into public.pos_operator_events (
        event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
      ) values (
        'approval_rejected', 'rejected', 'invalid_manager_pin', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
      );
      return json_build_object('error', 'invalid_manager_pin');
    end if;
  end if;

  -- 認証成功: カウントリセット
  update app_private.staff_operator_credentials
  set failed_count = 0,
      locked_until = null,
      updated_at = now()
  where staff_member_id = p_manager_staff_id;

  -- 5. Approval token 発行
  v_raw_approval := 'APR1.' || encode(gen_random_bytes(32), 'hex');
  v_approval_hash := app_private.sha256_hex(v_raw_approval);

  insert into app_private.pos_approvals (
    approval_hash, action, request_hash, operator_staff_id, approver_staff_id, expires_at
  ) values (
    v_approval_hash, p_action, p_request_hash, v_op.staff_member_id, p_manager_staff_id, v_exp
  );

  insert into public.pos_operator_events (
    event_type, result, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
  ) values (
    'approval_approved', 'approved', v_op.staff_member_id, p_manager_staff_id, p_action, p_request_hash, v_staff_hash
  );

  return json_build_object(
    'approval_token', v_raw_approval,
    'action', p_action,
    'request_hash', p_request_hash,
    'operator_staff_id', v_op.staff_member_id,
    'approver_staff_id', p_manager_staff_id,
    'expires_at', v_exp,
    'ttl_seconds', 300
  );
end;
$$;

-- ── 11. 承認消費ヘルパー (app_private: 今後 P0-4/P0-5 から利用) ─────────────────
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
  v_staff_hash text;
  v_op app_private.pos_operator_sessions;
  v_app app_private.pos_approvals;
  v_mgr_cred app_private.staff_operator_credentials;
  v_approval_hash text;
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

  -- 2. Approval token 行ロック
  if p_approval_token is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_approval_token');
  end if;

  v_approval_hash := app_private.sha256_hex(p_approval_token);
  select * into v_app from app_private.pos_approvals
  where approval_hash = v_approval_hash for update;

  if v_app.approval_hash is null then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'approval_not_found', v_op.staff_member_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approval_not_found');
  end if;

  -- 3. 状態・期限・バインド検証
  if v_app.consumed_at is not null then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'already_consumed', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'already_consumed');
  end if;

  if v_app.expires_at <= now() then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_expired', 'expired', 'approval_expired', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approval_expired');
  end if;

  if v_app.operator_staff_id <> v_op.staff_member_id then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'operator_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'operator_mismatch');
  end if;

  if v_app.action <> p_action then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'action_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'action_mismatch');
  end if;

  if v_app.request_hash <> p_request_hash then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'request_hash_mismatch', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'request_hash_mismatch');
  end if;

  -- 4. 承認者の権限が依然として有効か確認 (事後降格・停止の検知)
  select * into v_mgr_cred from app_private.staff_operator_credentials
  where staff_member_id = v_app.approver_staff_id;

  if v_mgr_cred.staff_member_id is null or v_mgr_cred.role <> 'manager' or not v_mgr_cred.is_active
     or not exists (select 1 from public.staff_members where id = v_app.approver_staff_id and is_active) then
    insert into public.pos_operator_events (
      event_type, result, reason, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
    ) values (
      'approval_consumed', 'failure', 'approver_role_revoked', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
    );
    return jsonb_build_object('ok', false, 'error', 'approver_role_revoked');
  end if;

  -- 5. 消費実行
  update app_private.pos_approvals
  set consumed_at = now(),
      consumed_by_staff_session_hash = v_staff_hash
  where approval_hash = v_approval_hash;

  insert into public.pos_operator_events (
    event_type, result, staff_member_id, approver_staff_id, action, request_hash, staff_session_hash
  ) values (
    'approval_consumed', 'consumed', v_op.staff_member_id, v_app.approver_staff_id, p_action, p_request_hash, v_staff_hash
  );

  return jsonb_build_object(
    'ok', true,
    'action', p_action,
    'request_hash', p_request_hash,
    'operator_staff_id', v_op.staff_member_id,
    'approver_staff_id', v_app.approver_staff_id,
    'consumed_at', now()
  );
end;
$$;

/** 例外を投げるアサーション版ヘルパー */
create or replace function app_private.assert_pos_approval(
  p_staff text,
  p_operator_token text,
  p_approval_token text,
  p_action text,
  p_request_hash text
) returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_res jsonb;
begin
  v_res := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, p_action, p_request_hash);
  if not (v_res->>'ok')::boolean then
    raise exception 'pos_approval_failed: %', (v_res->>'error') using errcode = '28000';
  end if;
  return v_res;
end;
$$;

-- ── 12. POS ポリシー取得 RPC & ヘルパー ─────────────────────────────────────────
create or replace function app_private.get_pos_policy()
returns public.pos_policy language sql stable
set search_path = public, extensions, pg_temp
as $$ select * from public.pos_policy where id = 1; $$;

create or replace function public.staff_get_pos_policy(p_staff text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_p public.pos_policy;
begin
  perform app_private.assert_staff(p_staff);
  select * into v_p from public.pos_policy where id = 1;
  return row_to_json(v_p);
end;
$$;

-- ── 13. RPC 実行権限の付与 ───────────────────────────────────────────────────
revoke all on function public.staff_operator_verify(text, uuid, text) from public;
grant execute on function public.staff_operator_verify(text, uuid, text) to anon, authenticated;

revoke all on function public.staff_pos_approve(text, text, uuid, text, text, text) from public;
grant execute on function public.staff_pos_approve(text, text, uuid, text, text, text) to anon, authenticated;

revoke all on function public.staff_get_pos_policy(text) from public;
grant execute on function public.staff_get_pos_policy(text) to anon, authenticated;

revoke all on function public.hq_set_staff_operator_credential(text, uuid, text, text) from public;
grant execute on function public.hq_set_staff_operator_credential(text, uuid, text, text) to anon, authenticated;

revoke all on all functions in schema app_private from public, anon, authenticated;
