-- POS Approval 承認消費の同時実行検証
do $$
declare
  v_run         uuid;
  v_app_tok     text;
  v_app_hash    text;
  v_consumed    integer;
  v_failures    integer;
  v_already     integer;
  v_row         app_private.pos_approvals;
begin
  select run_id into v_run from public.__pos_approval_latest where id = 1;
  if v_run is null then raise exception 'pos approval concurrency run_id missing'; end if;

  select approval_token into v_app_tok
  from public.__pos_approval_cases where run_id = v_run limit 1;
  v_app_hash := app_private.sha256_hex(v_app_tok);

  -- 1. pos_approvals テーブルの検証: 1行のみ存在し、consumed_at が記録されていること
  select * into v_row from app_private.pos_approvals where approval_hash = v_app_hash;
  if v_row.approval_hash is null then
    raise exception 'pos approval row missing for hash %', v_app_hash;
  end if;
  if v_row.consumed_at is null or v_row.consumed_by_staff_session_hash is null then
    raise exception 'pos approval row was not consumed';
  end if;

  -- 2. 監査イベントの集計: consumed 成功が 1 件、already_consumed 失敗が 9 件であること
  select
    count(*) filter (where event_type = 'approval_consumed' and result = 'consumed'),
    count(*) filter (where event_type = 'approval_consumed' and result = 'failure'),
    count(*) filter (where event_type = 'approval_consumed' and result = 'failure' and reason = 'already_consumed')
  into v_consumed, v_failures, v_already
  from public.pos_operator_events
  where staff_member_id = v_row.operator_staff_id
    and approver_staff_id = v_row.approver_staff_id
    and action = v_row.action
    and request_hash = v_row.request_hash;

  if v_consumed <> 1 or v_failures <> 9 or v_already <> 9 then
    raise exception 'pos approval concurrency: consumed=% failures=% already_consumed=% (expected 1/9/9)',
      v_consumed, v_failures, v_already;
  end if;

  raise notice 'pos approval concurrency ok: 1 consumed / 9 already_consumed (exact single-use enforced)';
end $$;
