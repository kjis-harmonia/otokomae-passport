-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Manager Approval & Candidates Preflight Tests
--
-- 検証項目:
--   1. 有効な端末セッション + 有効な操作者セッションでの候補者取得
--   2. role = 'manager' のみが返却され、role = 'staff' は除外されること
--   3. 現在の操作者本人が manager であっても候補から除外されること（自己承認防止）
--   4. is_active = false のスタッフが除外されること
--   5. is_active = false の資格情報が除外されること
--   6. is_bookable = false の manager も候補に含まれること
--   7. locked_until が未来の manager も候補に含まれること（Oracle 攻撃防止）
--   8. レスポンス JSON に private フィールド（pin, pin_hash, locked_until 等）が漏洩しないこと
--   9. 無効な端末セッションで SQLSTATE 28000 / staff_auth_required となること
--  10. 無効な操作者トークンで operator_session_invalid となること
--  11. 期限切れの操作者トークンで operator_session_expired となること
--  12. manager が 0 件の場合に candidates: [] が返却されること
-- ============================================================================

begin;

do $$
declare
  v_staff_a text := 'p05-mgr-test-staff-token-aaaaaaaa';
  v_staff_hash text;
  v_op_token text := 'OPS1.p05mgr0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
  v_op_hash text;
  v_op_member uuid;
  v_mgr1 uuid;
  v_mgr2 uuid;
  v_mgr3_nobook uuid;
  v_mgr4_locked uuid;
  v_staff_only uuid;
  v_inactive_member uuid;
  v_inactive_cred uuid;
  v_r jsonb;
  v_candidates jsonb;
  v_json_text text;
begin
  -- ── 0. セットアップ: 端末セッション & 操作者 ─────────────────────────────
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff_a), now() + interval '14 hours');
  v_staff_hash := app_private.sha256_hex(v_staff_a);

  -- 操作者スタッフ (自身も manager ロールを持つ)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2操作者兼店長', true, true, 1)
  returning id into v_op_member;

  perform app_private.set_staff_operator_credentials(v_op_member, '1111', 'manager');

  v_op_hash := app_private.sha256_hex(v_op_token);
  insert into app_private.pos_operator_sessions (
    token_hash, staff_session_hash, staff_member_id, role, expires_at
  ) values (
    v_op_hash, v_staff_hash, v_op_member, 'manager', now() + interval '30 minutes'
  );

  -- ── Check 12: manager 候補 0 件の検証（初期状態では自身しか manager がいないため 0 件） ─
  v_r := public.staff_pos_manager_candidates(v_staff_a, v_op_token);
  if v_r ? 'error' or (v_r->'candidates') is null or jsonb_array_length(v_r->'candidates') <> 0 then
    raise exception 'Check 12 failed: expected 0 candidates when only operator is manager: %', v_r;
  end if;

  -- ── テスト用スタッフ追加 ────────────────────────────────────────────────
  -- Manager 1 (正常・予約可)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2マネージャー1', true, true, 10)
  returning id into v_mgr1;
  perform app_private.set_staff_operator_credentials(v_mgr1, '2222', 'manager');

  -- Manager 2 (正常・予約可)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2マネージャー2', true, true, 20)
  returning id into v_mgr2;
  perform app_private.set_staff_operator_credentials(v_mgr2, '3333', 'manager');

  -- Manager 3 (予約不可 is_bookable = false)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2マネージャー3予約不可', false, true, 30)
  returning id into v_mgr3_nobook;
  perform app_private.set_staff_operator_credentials(v_mgr3_nobook, '4444', 'manager');

  -- Manager 4 (ロック中 locked_until > now())
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2マネージャー4ロック中', true, true, 40)
  returning id into v_mgr4_locked;
  perform app_private.set_staff_operator_credentials(v_mgr4_locked, '5555', 'manager');
  update app_private.staff_operator_credentials
  set locked_until = now() + interval '10 minutes', failed_count = 5
  where staff_member_id = v_mgr4_locked;

  -- Staff Only (role = 'staff')
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2一般スタッフ', true, true, 50)
  returning id into v_staff_only;
  perform app_private.set_staff_operator_credentials(v_staff_only, '6666', 'staff');

  -- Inactive Member (staff_members.is_active = false)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2無効メンバー', true, false, 60)
  returning id into v_inactive_member;
  perform app_private.set_staff_operator_credentials(v_inactive_member, '7777', 'manager');

  -- Inactive Credential (credentials.is_active = false)
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('P05-A4-2無効資格', true, true, 70)
  returning id into v_inactive_cred;
  perform app_private.set_staff_operator_credentials(v_inactive_cred, '8888', 'manager');
  update app_private.staff_operator_credentials
  set is_active = false
  where staff_member_id = v_inactive_cred;

  -- ── Check 1〜7: 候補一覧の取得 & フィルタリング検証 ──────────────────────
  v_r := public.staff_pos_manager_candidates(v_staff_a, v_op_token);
  if v_r ? 'error' then
    raise exception 'Check 1 failed: error returned for valid request: %', v_r;
  end if;

  v_candidates := v_r->'candidates';

  -- 期待件数: mgr1, mgr2, mgr3_nobook, mgr4_locked の計4名
  if jsonb_array_length(v_candidates) <> 4 then
    raise exception 'Check 1-7 failed: expected 4 candidates, got %: %', jsonb_array_length(v_candidates), v_candidates;
  end if;

  -- Check 3: 操作者本人が除外されていること
  if exists (select 1 from jsonb_array_elements(v_candidates) c where (c->>'id')::uuid = v_op_member) then
    raise exception 'Check 3 failed: operator himself was included in candidates';
  end if;

  -- Check 2: role = staff が除外されていること
  if exists (select 1 from jsonb_array_elements(v_candidates) c where (c->>'id')::uuid = v_staff_only) then
    raise exception 'Check 2 failed: role=staff was included in candidates';
  end if;

  -- Check 4: is_active = false のスタッフが除外されていること
  if exists (select 1 from jsonb_array_elements(v_candidates) c where (c->>'id')::uuid = v_inactive_member) then
    raise exception 'Check 4 failed: inactive staff member was included in candidates';
  end if;

  -- Check 5: is_active = false の資格情報が除外されていること
  if exists (select 1 from jsonb_array_elements(v_candidates) c where (c->>'id')::uuid = v_inactive_cred) then
    raise exception 'Check 5 failed: inactive credentials were included in candidates';
  end if;

  -- Check 6: is_bookable = false の manager が含まれていること
  if not exists (select 1 from jsonb_array_elements(v_candidates) c where (c->>'id')::uuid = v_mgr3_nobook) then
    raise exception 'Check 6 failed: is_bookable=false manager was excluded';
  end if;

  -- Check 7: locked_until が未来の manager が含まれていること
  if not exists (select 1 from jsonb_array_elements(v_candidates) c where (c->>'id')::uuid = v_mgr4_locked) then
    raise exception 'Check 7 failed: locked manager was excluded';
  end if;

  -- ── Check 8: 内部シークレット情報の非漏洩検証 ─────────────────────────────
  v_json_text := v_r::text;
  if v_json_text like '%pin%' or v_json_text like '%hash%' or v_json_text like '%locked%'
     or v_json_text like '%failed%' or v_json_text like '%role%' then
    raise exception 'Check 8 failed: internal security attributes leaked in candidates response: %', v_json_text;
  end if;

  -- 各要素のキーが 'id' と 'name' のみであること
  declare
    elem jsonb;
  begin
    for elem in select * from jsonb_array_elements(v_candidates) loop
      if (select count(*) from jsonb_object_keys(elem)) <> 2 or not elem ? 'id' or not elem ? 'name' then
        raise exception 'Check 8 failed: candidate element has unexpected keys: %', elem;
      end if;
    end loop;
  end;

  -- ── Check 9: 端末セッション無効時の拒否 (SQLSTATE 28000 / staff_auth_required) ─
  begin
    perform public.staff_pos_manager_candidates('invalid-staff-token', v_op_token);
    raise exception 'Check 9 failed: invalid terminal session did not raise exception';
  exception
    when sqlstate '28000' then
      if sqlerrm is distinct from 'staff_auth_required' then
        raise exception 'Check 9 failed: unexpected sqlerrm: %', sqlerrm;
      end if;
    when others then
      raise exception 'Check 9 failed: unexpected sqlstate % (%): %', sqlstate, sqlerrm, 'invalid terminal';
  end;

  -- ── Check 10: 操作者トークン無効時の拒否 (operator_session_invalid) ───────
  v_r := public.staff_pos_manager_candidates(v_staff_a, 'OPS1.invalid-token-123456789012345678901234567890123456789012345678');
  if v_r->>'error' is distinct from 'operator_session_invalid' then
    raise exception 'Check 10 failed: invalid operator token did not return operator_session_invalid: %', v_r;
  end if;

  -- 空の操作者トークン
  v_r := public.staff_pos_manager_candidates(v_staff_a, '');
  if v_r->>'error' is distinct from 'operator_session_invalid' then
    raise exception 'Check 10b failed: empty operator token did not return operator_session_invalid: %', v_r;
  end if;

  -- ── Check 11: 操作者トークン期限切れの検証 (operator_session_expired) ────
  declare
    v_exp_token text := 'OPS1.p05exp0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
    v_exp_hash text;
  begin
    v_exp_hash := app_private.sha256_hex(v_exp_token);
    insert into app_private.pos_operator_sessions (
      token_hash,
      staff_session_hash,
      staff_member_id,
      role,
      created_at,
      expires_at
    ) values (
      v_exp_hash,
      v_staff_hash,
      v_op_member,
      'manager',
      now() - interval '31 minutes',
      now() - interval '1 minute'
    );

    v_r := public.staff_pos_manager_candidates(v_staff_a, v_exp_token);
    if v_r->>'error' is distinct from 'operator_session_expired' then
      raise exception 'Check 11 failed: expired operator token did not return operator_session_expired: %', v_r;
    end if;
  end;

  -- ── Check 12: 別端末Operatorトークン拒否の検証 (cross-terminal operator token) ─
  declare
    v_staff_b text := 'p05-mgr-test-staff-token-bbbbbbbb';
  begin
    insert into app_private.staff_sessions (token_hash, expires_at)
    values (app_private.sha256_hex(v_staff_b), now() + interval '14 hours');

    -- terminal B の端末トークンと、terminal A で発行された操作者トークンを組み合わせて呼び出す
    v_r := public.staff_pos_manager_candidates(v_staff_b, v_op_token);
    if v_r->>'error' is distinct from 'operator_session_invalid' then
      raise exception 'Check 12 failed: cross-terminal operator token did not return operator_session_invalid: %', v_r;
    end if;
  end;

end;
$$;

rollback;
