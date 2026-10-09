-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Replay Concurrency Setup
-- (preflight_replay_concurrency_setup.sql)
--
-- Prepares identical idempotency key and exact payload test fixtures for
-- pgbench concurrent execution on Refund and Ticket-used Sale.
-- ============================================================================

drop table if exists public.__preflight_replay_responses;
create table public.__preflight_replay_responses (
  run_id uuid not null,
  kind text not null check (kind in ('refund', 'sale')),
  worker_no integer not null,
  response jsonb not null,
  primary key (run_id, kind, worker_no)
);
revoke all on public.__preflight_replay_responses from public, anon, authenticated;

drop table if exists public.__preflight_replay_refund_cases;
create table public.__preflight_replay_refund_cases (
  run_id          uuid not null,
  worker_no       integer not null,
  staff_token     text not null,
  operator_token  text not null,
  tx_id           uuid not null,
  amount          integer not null,
  reason          text not null,
  idempotency_key text not null,
  approval_token  text not null,
  primary key (run_id, worker_no)
);

drop table if exists public.__preflight_replay_sale_cases;
create table public.__preflight_replay_sale_cases (
  run_id          uuid not null,
  worker_no       integer not null,
  staff_token     text not null,
  operator_token  text not null,
  payload         jsonb not null,
  primary key (run_id, worker_no)
);

create table if not exists public.__preflight_replay_latest (
  id              integer primary key default 1 check (id = 1),
  run_id          uuid not null,
  refund_tx_id    uuid not null,
  refund_key      text not null,
  sale_key        text not null,
  sale_ticket_id  uuid not null,
  client_id       uuid not null,
  account_id      uuid not null
);

do $$
declare
  v_run         uuid := gen_random_uuid();
  v_staff       text := 'replay-conc-staff-' || v_run::text;
  v_op_id       uuid;
  v_mgr_id      uuid;
  v_op_tok      text;
  v_client_id   uuid;
  v_account_id  uuid;
  v_user_id     text;
  v_cust_id     uuid;
  v_tx_res      json;
  v_refund_tx   uuid;
  v_facts       jsonb;
  v_req_hash    text;
  v_app_res     jsonb;
  v_app_tok     text;
  v_refund_key  text := 'replay-conc-refund-key-' || v_run::text;
  v_menu_code   text := 'conc-cut-' || substr(v_run::text, 1, 6);
  v_ticket_id   uuid;
  v_presence_tok text;
  v_scan_res    jsonb;
  v_scan_id     uuid;
  v_qres        jsonb;
  v_qhash       text;
  v_sale_key    text := 'replay-conc-sale-key-' || v_run::text;
  v_sale_payload jsonb;
  i             integer;
begin
  -- 1. 端末セッション & スタッフ資格情報
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour');

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Replay Conc Op ' || substr(v_run::text, 1, 6), true, true, 895) returning id into v_op_id;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Replay Conc Mgr ' || substr(v_run::text, 1, 6), false, true, 896) returning id into v_mgr_id;

  perform app_private.set_staff_operator_credentials(v_op_id, '1111', 'staff');
  perform app_private.set_staff_operator_credentials(v_mgr_id, '2222', 'manager');

  v_op_tok := (public.staff_operator_verify(v_staff, v_op_id, '1111')->>'operator_token');

  -- 2. 顧客 & 口座準備 (会員 & チケット用)
  v_user_id := 'u-conc-' || replace(v_run::text, '-', '');
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_user_id, 'Replay Conc Client ' || substr(v_run::text, 1, 6), '1111', 'CONC-' || substr(v_run::text, 1, 8), app_private.norm_name('Replay Conc Client'))
  returning id into v_cust_id;
  v_client_id := app_private.member_client(v_cust_id);
  v_account_id := app_private.ginpay_open_account(v_client_id, 'staff', 'Tester', true);

  -- 3. Refund用チャージ取引作成 (10,000円)
  v_tx_res := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client_id, 10000, 'cash', 'Tester', 'conc seed charge', 'conc-seed-chg-' || v_run::text, null, null);
  if v_tx_res->>'error' is not null then raise exception 'conc seed charge failed: %', v_tx_res; end if;
  v_refund_tx := (v_tx_res->>'id')::uuid;

  -- 4. 4,000円返金用 L2 承認取得
  v_facts := jsonb_build_object(
    'action', 'refund',
    'account_id', v_account_id,
    'client_id', v_client_id,
    'target_transaction_id', v_refund_tx,
    'refundable_amount', 10000,
    'requested_refund_amount', 4000,
    'reason', 'conc refund test',
    'operator_staff_id', v_op_id
  );
  v_req_hash := app_private.pos_auth_hash('refund', v_facts);
  v_app_res := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'refund', v_req_hash)::jsonb;
  v_app_tok := v_app_res->>'approval_token';

  for i in 0..9 loop
    insert into public.__preflight_replay_refund_cases (
      run_id, worker_no, staff_token, operator_token, tx_id, amount, reason, idempotency_key, approval_token
    ) values (
      v_run, i, v_staff, v_op_tok, v_refund_tx, 4000, 'conc refund test', v_refund_key, v_app_tok
    );
  end loop;

  -- 5. Sale用チケット・メニュー準備
  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_menu_code, 'Conc Test Cut', 5000, true, true, false, 60);

  insert into public.tickets (id, user_id, title, type, amount, used, issued_by, expires_at)
  values (gen_random_uuid(), v_user_id, 'Conc Discount Ticket', 'discount', 1000, false, 'system', now() + interval '30 days')
  returning id into v_ticket_id;

  -- 顧客の presence token 発行 & スキャン
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex('replay-conc-cust-session-' || v_run::text), v_user_id, 'register');

  v_presence_tok := (public.customer_issue_presence_token('replay-conc-cust-session-' || v_run::text)->>'token');
  v_scan_res := public.staff_resolve_presence_token(v_staff, v_presence_tok)::jsonb;
  if v_scan_res ? 'error' then raise exception 'conc scan resolve failed: %', v_scan_res; end if;
  v_scan_id := (v_scan_res->>'scan_session_id')::uuid;

  -- quote 取得
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text)
  ))::jsonb;
  if v_qres ? 'error' then raise exception 'conc quote failed: %', v_qres; end if;
  v_qhash := v_qres->>'quote_hash';

  v_sale_payload := jsonb_build_object(
    'scan_session_id', v_scan_id,
    'client_id', v_client_id,
    'stylist_id', v_op_id,
    'operator_token', v_op_tok,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_menu_code)),
    'ticket_ids', jsonb_build_array(v_ticket_id::text),
    'payment_method', 'cash',
    'expected_total', 4000,
    'quote_hash', v_qhash,
    'idempotency_key', v_sale_key
  );

  for i in 0..9 loop
    insert into public.__preflight_replay_sale_cases (
      run_id, worker_no, staff_token, operator_token, payload
    ) values (
      v_run, i, v_staff, v_op_tok, v_sale_payload
    );
  end loop;

  -- 6. Latest テーブル記録
  insert into public.__preflight_replay_latest (
    id, run_id, refund_tx_id, refund_key, sale_key, sale_ticket_id, client_id, account_id
  ) values (
    1, v_run, v_refund_tx, v_refund_key, v_sale_key, v_ticket_id, v_client_id, v_account_id
  ) on conflict (id) do update set
    run_id = excluded.run_id,
    refund_tx_id = excluded.refund_tx_id,
    refund_key = excluded.refund_key,
    sale_key = excluded.sale_key,
    sale_ticket_id = excluded.sale_ticket_id,
    client_id = excluded.client_id,
    account_id = excluded.account_id;
end $$;
