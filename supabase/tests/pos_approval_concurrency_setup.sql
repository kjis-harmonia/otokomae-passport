-- POS Approval 承認消費の同時実行テスト準備（使い捨て DB で実行）
--   1 つの承認トークンに対して 10 クライアントが同時に consume_pos_approval を実行する
--   → 成功（consumed）はちょうど 1 件、残りの 9 件は already_consumed で拒否されることを検証する

create table if not exists public.__pos_approval_cases (
  run_id          uuid not null,
  worker_no       integer not null,
  staff_token     text not null,
  operator_token  text not null,
  approval_token  text not null,
  action          text not null,
  request_hash    text not null,
  primary key (run_id, worker_no)
);

create table if not exists public.__pos_approval_latest (
  id      integer primary key default 1 check (id = 1),
  run_id  uuid not null
);

do $$
declare
  v_run         uuid := gen_random_uuid();
  v_staff       text := 'pos-approval-conc-staff-' || v_run::text;
  v_op_id       uuid;
  v_mgr_id      uuid;
  v_op_tok      text;
  v_app_tok     text;
  v_req_hash    text := encode(extensions.digest('order:concurrent_test:' || v_run::text, 'sha256'), 'hex');
  v_r           jsonb;
  i             integer;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour');

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('POS_同時_操作者_' || substr(v_run::text, 1, 6), true, true, 201) returning id into v_op_id;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('POS_同時_管理者_' || substr(v_run::text, 1, 6), true, true, 202) returning id into v_mgr_id;

  perform app_private.set_staff_operator_credentials(v_op_id, '1111', 'staff');
  perform app_private.set_staff_operator_credentials(v_mgr_id, '2222', 'manager');

  -- L1 ログイン
  v_r := public.staff_operator_verify(v_staff, v_op_id, '1111')::jsonb;
  v_op_tok := v_r->>'operator_token';

  -- L2 承認発行
  v_r := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'manual_discount', v_req_hash)::jsonb;
  v_app_tok := v_r->>'approval_token';

  for i in 0..9 loop
    insert into public.__pos_approval_cases (
      run_id, worker_no, staff_token, operator_token, approval_token, action, request_hash
    ) values (
      v_run, i, v_staff, v_op_tok, v_app_tok, 'manual_discount', v_req_hash
    );
  end loop;

  insert into public.__pos_approval_latest (id, run_id)
  values (1, v_run)
  on conflict (id) do update set run_id = excluded.run_id;
end $$;
