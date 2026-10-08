-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Manager Approval Candidates RPC
-- (20261009000400_pos_money_authorization.sql の後に適用)
--
-- 店舗端末 /staff における管理者承認（L2）の候補者一覧を取得する。
--   * 端末セッション（p_staff: 14時間）および操作者セッション（p_operator_token: 30分）を検証
--   * role = 'manager' かつ資格情報・スタッフともに有効なメンバーのみ抽出
--   * 現在の操作者（L1）本人は候補から除外（自己承認禁止）
--   * ロック中（locked_until）のマネージャーも隠蔽（oracle攻撃防止）のため一覧に含める
--   * 予約受付可否（is_bookable）は不問
--   * 返却項目は id, name のみ（PINハッシュ・失敗回数・ロック時刻等の内部情報は非公開）
-- ============================================================================

create or replace function public.staff_pos_manager_candidates(
  p_staff text,
  p_operator_token text
) returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash text;
  v_op_member_id uuid;
  v_candidates jsonb;
begin
  -- 1. 端末セッション検証 (SQLSTATE 28000 staff_auth_required をそのまま維持)
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- 2. オペレーター検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return jsonb_build_object('error', 'operator_session_invalid');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        -- 期限切れかそれ以外（不一致・未存在・失効）かを特定
        if exists (
          select 1 from app_private.pos_operator_sessions
          where token_hash = app_private.sha256_hex(p_operator_token)
            and staff_session_hash = v_staff_hash
            and revoked_at is null
            and expires_at <= now()
        ) then
          return jsonb_build_object('error', 'operator_session_expired');
        end if;
        return jsonb_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        raise exception 'staff_auth_required' using errcode = '28000';
      else
        raise;
      end if;
    when sqlstate '28000' then
      raise;
  end;

  if v_op_member_id is null then
    return jsonb_build_object('error', 'operator_session_invalid');
  end if;

  -- 3. 承認可能なマネージャー一覧取得
  -- 条件: staff_members.is_active = true, credential.is_active = true, role = 'manager'
  -- current operator 本人除外, is_bookable は不問, locked_until / failed_count による除外禁止
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'name', m.display_name
  ) order by m.sort_order, m.display_name), '[]'::jsonb)
  into v_candidates
  from public.staff_members m
  join app_private.staff_operator_credentials c on c.staff_member_id = m.id
  where m.is_active = true
    and c.is_active = true
    and c.role = 'manager'
    and m.id <> v_op_member_id;

  return jsonb_build_object('candidates', v_candidates);
end;
$$;

revoke all on function public.staff_pos_manager_candidates(text, text) from public;
grant execute on function public.staff_pos_manager_candidates(text, text) to anon, authenticated;
