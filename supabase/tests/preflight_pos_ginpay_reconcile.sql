-- GINJIRO POS Phase 0 / P0-1：GINPay 台帳照合ガード
--   Part A（begin … rollback）：直接更新の拒否、正常な記録、不一致時に全経路（店頭チャージ・返金・HQ調整・会計・会計取消・Stripe）が
--          金銭を記録せず { error } または例外ロールバックで監査を残すこと、表示の残高が台帳合計であること
--   Part B（自動 commit）：不一致で止めたとき、金銭の変更は何も commit されず、監査（ledger_mismatch_blocked）だけが
--          commit されて残ること（例外による取り消しで監査が消えない）。最後に作った行を削除する
\set ON_ERROR_STOP 1

-- ── Part A ─────────────────────────────────────────────────────────────────────
begin;
do $$
declare
  v_staff text := 'preflight-pos-reconcile-staff-0123456789abcdef';
  v_hq text := 'preflight-pos-reconcile-hq-0123456789abcdef0123';
  v_client uuid; v_account uuid; v_stylist uuid; v_r jsonb; v_sale jsonb; v_charge jsonb; v_n int; v_ev int; v_ok boolean;
  v_cached int; v_ledger int;
  v_op_staff uuid; v_mgr_id uuid; v_op_tok text;
  v_cust uuid; v_customer_session text := 'cust-tok-reconcile-0123456789abcdef'; v_presence_token text; v_scan_id uuid; v_qhash text;
  v_refund_req_hash text; v_refund_app_token text; v_refund_app_hash text;
  v_void_req_hash text; v_void_app_token text; v_void_app_hash text;
  v_app_consumed timestamptz;
begin
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_staff), now() + interval '1 hour');
  insert into app_private.hq_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_hq), now() + interval '1 hour');
  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;

  -- 操作者 (staff) & 承認者 (manager) のセットアップ
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Reconcile Operator', false, true, 801) returning id into v_op_staff;
  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Reconcile Manager', false, true, 802) returning id into v_mgr_id;

  perform app_private.set_staff_operator_credentials(v_op_staff, '1111', 'staff');
  perform app_private.set_staff_operator_credentials(v_mgr_id, '2222', 'manager');
  v_op_tok := (public.staff_operator_verify(v_staff, v_op_staff, '1111')->>'operator_token');

  -- クライアント & 顧客（scan session 発行用）
  v_client := app_private.create_client('Preflight POS Reconcile', 'staff', 'staff', 'Preflight');
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values ('u-pos-reconcile-1', 'Reconcile Customer', '0091', 'P-RECON-1', app_private.norm_name('Reconcile Customer'))
  returning id into v_cust;
  perform app_private.merge_clients(v_client, app_private.member_client(v_cust), 'staff', 'staff');
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex(v_customer_session), 'u-pos-reconcile-1', 'register');
  v_presence_token := public.customer_issue_presence_token(v_customer_session)->>'token';
  v_scan_id := (public.staff_resolve_presence_token(v_staff, v_presence_token)->>'scan_session_id')::uuid;

  -- 正常：チャージで balance_cached と台帳合計が一致して増える (canonical 10引数)
  v_charge := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client, 5000, 'cash', 'Preflight', null, 'pos-reconcile-charge-1', null, null)::jsonb;
  if v_charge ? 'error' then raise exception 'charge failed: %', v_charge; end if;
  v_account := (v_charge->>'account_id')::uuid;
  select balance_cached into v_cached from public.ginpay_accounts where id = v_account;
  if v_cached <> 5000 or app_private.ginpay_posted_sum(v_account) <> 5000 then raise exception 'normal_charge_mismatch'; end if;

  -- 正常：GINPay 払いの会計 (canonical 5引数 + valid quote)（後で取消の照合に使う）
  v_r := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, jsonb_build_object(
    'client_id', v_client, 'scan_session_id', v_scan_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1))
  ))::jsonb;
  v_qhash := v_r->>'quote_hash';

  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client, 'stylist_id', v_stylist, 'scan_session_id', v_scan_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
    'payment_method', 'ginpay', 'expected_total', 1000, 'quote_hash', v_qhash, 'idempotency_key', 'pos-reconcile-sale-1'
  ), 'Preflight', v_op_tok, null)::jsonb;
  if v_sale ? 'error' then raise exception 'ginpay sale failed: %', v_sale; end if;

  -- 直接更新の拒否（印なし・台帳と不一致）／作成時の残高は 0 のみ
  v_ok := false;
  begin update public.ginpay_accounts set balance_cached = balance_cached + 100 where id = v_account;
  exception when others then v_ok := sqlerrm = 'ginpay_balance_direct_update'; end;
  if not v_ok then raise exception 'direct_update_not_blocked'; end if;
  v_ok := false;
  begin
    perform set_config('app.ginpay_posting', 'on', true);
    update public.ginpay_accounts set balance_cached = balance_cached + 100 where id = v_account;   -- 印があっても台帳と不一致なら拒否
  exception when others then v_ok := sqlerrm = 'ginpay_balance_direct_update'; end;
  perform set_config('app.ginpay_posting', 'off', true);
  if not v_ok then raise exception 'flagged_update_not_matching_ledger_not_blocked'; end if;
  v_ok := false;
  begin insert into public.ginpay_accounts (client_id, balance_cached, opened_by_type) values (app_private.create_client('Preflight POS Reconcile 2', 'staff', 'staff', 'Preflight'), 100, 'system');
  exception when others then v_ok := sqlerrm = 'ginpay_balance_direct_update'; end;
  if not v_ok then raise exception 'insert_with_balance_not_blocked'; end if;

  -- 不一致を作る（テストだけの操作：ガードを一時的に外す）
  alter table public.ginpay_accounts disable trigger ginpay_accounts_balance_guard;
  update public.ginpay_accounts set balance_cached = balance_cached + 300 where id = v_account;
  alter table public.ginpay_accounts enable trigger ginpay_accounts_balance_guard;
  select count(*) into v_n from public.ginpay_transactions where account_id = v_account;

  -- 表示：残高は台帳合計、照合が取れていないことを返す
  v_r := app_private.ginpay_client_ledger_json(v_client, 50);
  if (v_r->>'balance')::int <> 4000 or (v_r->>'cached_balance')::int <> 4300 or (v_r->>'consistent')::boolean then
    raise exception 'ledger_json_not_ledger_based: %', v_r;
  end if;
  v_r := app_private.checkout_context_json(null, v_client);
  if (v_r->'ginpay_accounts'->0->>'balance')::int <> 4000 or (v_r->'ginpay_accounts'->0->>'consistent')::boolean then
    raise exception 'checkout_context_not_ledger_based: %', v_r->'ginpay_accounts';
  end if;

  -- 1. 店頭チャージ (canonical 10引数)：金銭を記録せず ledger_mismatch_blocked を返す
  v_r := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client, 1000, 'cash', 'Preflight', null, 'pos-reconcile-charge-2', null, null)::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'charge_not_blocked: %', v_r; end if;

  -- 2. 店頭返金 (canonical 8引数 + L2 refund approval)：不一致で失敗し、承認消費がロールバックされること
  v_refund_req_hash := app_private.pos_auth_hash('refund', jsonb_build_object(
    'action', 'refund',
    'account_id', v_account,
    'client_id', v_client,
    'target_transaction_id', (v_charge->>'id')::uuid,
    'refundable_amount', 5000,
    'requested_refund_amount', 500,
    'reason', 'test refund',
    'operator_staff_id', v_op_staff
  ));
  v_r := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'refund', v_refund_req_hash)::jsonb;
  v_refund_app_token := v_r->>'approval_token';
  v_refund_app_hash := app_private.sha256_hex(v_refund_app_token);

  v_ok := false;
  begin
    v_r := public.staff_ginpay_refund(v_staff, v_op_tok, (v_charge->>'id')::uuid, 500, 'Preflight', 'test refund', 'pos-reconcile-refund-1', v_refund_app_token)::jsonb;
  exception when others then
    v_ok := sqlerrm like '%ledger_mismatch_blocked%';
  end;
  if not v_ok and v_r->>'error' is distinct from 'ledger_mismatch_blocked' then
    raise exception 'refund_not_blocked: %', coalesce(v_r::text, 'exception');
  end if;

  -- 失敗時に承認消費がロールバックされ、consumed_at が戻ることの確認
  select consumed_at into v_app_consumed from app_private.pos_approvals where approval_hash = v_refund_app_hash;
  if v_app_consumed is not null then
    raise exception 'refund approval consumed despite ledger mismatch failure';
  end if;

  -- 3. 本部調整 (hq_ginpay_adjustment)：ledger_mismatch_blocked を返す
  v_r := public.hq_ginpay_adjustment(v_hq, v_client, 100, 'test', 'pos-reconcile-adj-2')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'hq_adjustment_not_blocked: %', v_r; end if;

  -- 4. 会計取消 (staff_void_sale 6引数 + L2 void approval)：completed かつ GINPay payment 済みの sale を対象として台帳照合ガードへ到達
  v_void_req_hash := app_private.pos_auth_hash('void', jsonb_build_object(
    'action', 'void',
    'sale_id', (v_sale->>'id')::uuid,
    'original_total', 1000,
    'original_payment_method', 'ginpay',
    'reason', 'test void',
    'operator_staff_id', v_op_staff
  ));
  v_r := public.staff_pos_approve(v_staff, v_op_tok, v_mgr_id, '2222', 'void', v_void_req_hash)::jsonb;
  v_void_app_token := v_r->>'approval_token';
  v_void_app_hash := app_private.sha256_hex(v_void_app_token);

  v_ok := false;
  begin
    v_r := public.staff_void_sale(v_staff, v_op_tok, (v_sale->>'id')::uuid, 'test void', 'pos-reconcile-void-sale-1', v_void_app_token)::jsonb;
  exception when others then
    v_ok := sqlerrm like '%ledger_mismatch_blocked%';
  end;
  if not v_ok and v_r->>'error' is distinct from 'ledger_mismatch_blocked' then
    raise exception 'staff_void_sale_not_blocked: %', coalesce(v_r::text, 'exception');
  end if;

  -- 失敗時に承認消費がロールバックされ、consumed_at が戻ること、会計状態が completed のままであることの確認
  select consumed_at into v_app_consumed from app_private.pos_approvals where approval_hash = v_void_app_hash;
  if v_app_consumed is not null then
    raise exception 'void approval consumed despite ledger mismatch failure';
  end if;
  if (select status from public.accounting_sessions where id = (v_sale->>'id')::uuid) <> 'completed' then
    raise exception 'sale status changed despite void failure';
  end if;

  -- 5. 会計確定 (staff_finalize_sale canonical 5引数)：ledger_mismatch_blocked を返す
  v_r := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, jsonb_build_object(
    'client_id', v_client, 'scan_session_id', v_scan_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'cut-bangs', 'quantity', 1))
  ))::jsonb;
  v_qhash := v_r->>'quote_hash';

  v_r := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client, 'stylist_id', v_stylist, 'scan_session_id', v_scan_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'cut-bangs', 'quantity', 1)),
    'payment_method', 'ginpay', 'expected_total', 500, 'quote_hash', v_qhash, 'idempotency_key', 'pos-reconcile-sale-2'
  ), 'Preflight', v_op_tok, null)::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'finalize_not_blocked: %', v_r; end if;
  if exists (select 1 from public.accounting_sessions where idempotency_key = 'pos-reconcile-sale-2') then raise exception 'finalize_wrote_sale'; end if;

  -- 6. 本部会計取消 (hq_void_sale)：ledger_mismatch_blocked を返す
  v_r := public.hq_void_sale(v_hq, (v_sale->>'id')::uuid, 'test')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'sale_void_not_blocked: %', v_r; end if;
  if (select status from public.accounting_sessions where id = (v_sale->>'id')::uuid) <> 'completed' then raise exception 'sale_void_changed_sale'; end if;

  -- 7. Stripe 入金：ledger_mismatch_blocked を返す
  v_r := public.ginpay_apply_stripe_webhook('evt_pos_reconcile_1', 'payment_intent.succeeded', v_client, 2000, 'pi_pos_reconcile_1', null, null,
    jsonb_build_object('data', jsonb_build_object('object', jsonb_build_object('currency', 'jpy'))))::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' or not coalesce((v_r->>'retryable')::boolean, false) then raise exception 'stripe_not_blocked: %', v_r; end if;
  if exists (select 1 from public.ginpay_stripe_events where event_id = 'evt_pos_reconcile_1') then raise exception 'stripe_event_recorded_while_blocked'; end if;

  -- 金銭は一切記録されていない／キャッシュも変わっていない／監査が記録されている
  if (select count(*) from public.ginpay_transactions where account_id = v_account) <> v_n then raise exception 'money_written_while_blocked'; end if;
  select balance_cached into v_cached from public.ginpay_accounts where id = v_account;
  if v_cached <> 4300 then raise exception 'cache_changed_while_blocked'; end if;
  select count(*) into v_ev from public.ginpay_account_events where account_id = v_account and event_type = 'ledger_mismatch_blocked';
  if v_ev < 5 then raise exception 'mismatch_audit_missing: %', v_ev; end if;
  if exists (select 1 from public.ginpay_account_events where account_id = v_account and event_type = 'ledger_mismatch_blocked'
             and not (detail ? 'cached_balance' and detail ? 'ledger_balance' and detail ? 'context')) then
    raise exception 'mismatch_audit_incomplete';
  end if;

  -- 権限：照合関数・ガードは外部から呼べない
  if has_function_privilege('anon', 'app_private.ginpay_check_reconciled(uuid, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app_private.ginpay_check_reconciled(uuid, jsonb, text, text)', 'EXECUTE') then
    raise exception 'check_reconciled_executable_by_client';
  end if;
  if has_table_privilege('anon', 'public.ginpay_accounts', 'UPDATE') or has_table_privilege('authenticated', 'public.ginpay_accounts', 'UPDATE') then
    raise exception 'ginpay_accounts_updatable_by_client';
  end if;
  raise notice 'pos reconcile part A ok';
end $$;
rollback;

-- ── Part B（自動 commit）：監査だけが残り、金銭の変更は commit されない ─────────────────────
select jsonb_build_object(
  'customers', (select count(*) from public.customers),
  'clients', (select count(*) from public.clients),
  'identifiers', (select count(*) from public.client_identifiers),
  'client_events', (select count(*) from public.client_events),
  'staff', (select count(*) from public.staff_members)
)::text as fixture_before_counts \gset
select app_private.create_client('Preflight POS Reconcile Commit', 'staff', 'staff', 'Preflight') as client_id \gset
insert into app_private.staff_sessions (token_hash, expires_at)
values (app_private.sha256_hex('preflight-pos-reconcile-commit-staff-0123456789'), now() + interval '1 hour');
insert into app_private.hq_sessions (token_hash, expires_at)
values (app_private.sha256_hex('preflight-pos-reconcile-commit-hq-0123456789abcdef'), now() + interval '1 hour');

-- オペレーター設定
insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
values ('Reconcile Commit Operator', false, true, 803) returning id as op_staff_id \gset
select app_private.set_staff_operator_credentials(:'op_staff_id'::uuid, '1111', 'staff');
select (public.staff_operator_verify('preflight-pos-reconcile-commit-staff-0123456789', :'op_staff_id'::uuid, '1111')->>'operator_token') as op_token \gset

-- 顧客 & scan session 設定
select 'u-pos-reconcile-commit-' || replace(gen_random_uuid()::text, '-', '') as customer_user_id \gset
select 'cust-tok-reconcile-commit-' || replace(gen_random_uuid()::text, '-', '') as customer_session \gset
insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
values (:'customer_user_id', 'Reconcile Commit Customer', '0092', 'P-RECON-COMMIT-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), app_private.norm_name('Reconcile Commit Customer'))
returning id as cust_id \gset
select app_private.member_client(:'cust_id'::uuid) as source_client_id \gset
select app_private.merge_clients(:'client_id'::uuid, :'source_client_id'::uuid, 'staff', 'staff');
insert into app_private.customer_sessions (token_hash, user_id, created_via)
values (app_private.sha256_hex(:'customer_session'), :'customer_user_id', 'register');
select public.customer_issue_presence_token(:'customer_session')->>'token' as presence_token \gset
select (public.staff_resolve_presence_token('preflight-pos-reconcile-commit-staff-0123456789',
        :'presence_token'))->>'scan_session_id' as scan_session_id \gset

select app_private.ginpay_open_account(:'client_id', 'system', 'Preflight', true) as account_id \gset
-- 不一致の口座（取引 0 件・キャッシュ 300）。テストだけの操作
alter table public.ginpay_accounts disable trigger ginpay_accounts_balance_guard;
update public.ginpay_accounts set balance_cached = 300 where id = :'account_id';
alter table public.ginpay_accounts enable trigger ginpay_accounts_balance_guard;

-- 見積もり取得 (quote_hash)
select (public.staff_pos_quote('preflight-pos-reconcile-commit-staff-0123456789', :'op_token', :'scan_session_id'::uuid, jsonb_build_object(
  'client_id', :'client_id'::uuid, 'scan_session_id', :'scan_session_id'::uuid,
  'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1))
))->>'quote_hash') as qhash \gset

-- それぞれ独立したトランザクション（自動 commit）で呼ぶ
select public.hq_ginpay_adjustment('preflight-pos-reconcile-commit-hq-0123456789abcdef', :'client_id', 500, 'test',
  'pos-reconcile-commit-adj') ->> 'error' as adj_error \gset
select public.staff_finalize_sale('preflight-pos-reconcile-commit-staff-0123456789', jsonb_build_object(
  'client_id', :'client_id',
  'stylist_id', (select id from public.staff_members where is_active order by sort_order limit 1),
  'scan_session_id', :'scan_session_id'::uuid,
  'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
  'payment_method', 'ginpay', 'expected_total', 1000, 'quote_hash', :'qhash', 'idempotency_key', 'pos-reconcile-commit-sale'),
  'Preflight', :'op_token', null) ->> 'error' as sale_error \gset

-- 別のトランザクションから確認（psql 変数は DO の中で展開されないため、セッション設定で渡す）
select set_config('pf.account_id', :'account_id', false), set_config('pf.client_id', :'client_id', false),
       set_config('pf.adj_error', coalesce(:'adj_error', ''), false), set_config('pf.sale_error', coalesce(:'sale_error', ''), false);
do $$
declare v_account uuid := current_setting('pf.account_id')::uuid; v_client uuid := current_setting('pf.client_id')::uuid;
begin
  if current_setting('pf.adj_error') <> 'ledger_mismatch_blocked' or current_setting('pf.sale_error') <> 'ledger_mismatch_blocked' then
    raise exception 'commit_path_not_blocked: % / %', current_setting('pf.adj_error'), current_setting('pf.sale_error');
  end if;
  if (select count(*) from public.ginpay_account_events where account_id = v_account and event_type = 'ledger_mismatch_blocked') <> 2 then
    raise exception 'mismatch_audit_not_committed';
  end if;
  if exists (select 1 from public.ginpay_transactions where account_id = v_account) then raise exception 'money_committed_while_blocked'; end if;
  if exists (select 1 from public.accounting_sessions where client_id = v_client or idempotency_key = 'pos-reconcile-commit-sale') then
    raise exception 'sale_committed_while_blocked';
  end if;
  if (select balance_cached from public.ginpay_accounts where id = v_account) <> 300 then raise exception 'cache_committed_while_blocked'; end if;
  raise notice 'pos reconcile part B ok (audit committed, no money committed)';
end $$;

-- 後片付け（このテストで作った行だけ）
begin;
select set_config('pf.source_client_id', :'source_client_id', true),
       set_config('pf.customer_id', :'cust_id', true),
       set_config('pf.customer_session_hash', app_private.sha256_hex(:'customer_session'), true),
       set_config('pf.scan_session_id', :'scan_session_id', true),
       set_config('pf.operator_id', :'op_staff_id', true),
       set_config('pf.fixture_before_counts', :'fixture_before_counts', true);
do $$
declare
  v_source uuid := current_setting('pf.source_client_id')::uuid;
  v_target uuid := current_setting('pf.client_id')::uuid;
  v_customer uuid := current_setting('pf.customer_id')::uuid;
  v_account uuid := current_setting('pf.account_id')::uuid;
  v_scan uuid := current_setting('pf.scan_session_id')::uuid;
  v_operator uuid := current_setting('pf.operator_id')::uuid;
  v_customer_hash text := current_setting('pf.customer_session_hash');
  v_staff_hash text := app_private.sha256_hex('preflight-pos-reconcile-commit-staff-0123456789');
  v_hq_hash text := app_private.sha256_hex('preflight-pos-reconcile-commit-hq-0123456789abcdef');
  v_after jsonb;
begin
  if v_source = v_target
     or not exists (select 1 from public.clients where id = v_source and merged_into = v_target)
     or exists (select 1 from public.clients where merged_into = v_target and id <> v_source)
     or exists (select 1 from public.clients where merged_into = v_source) then
    raise exception 'cleanup_unexpected_merge_dependency';
  end if;

  delete from public.ginpay_account_events where account_id = v_account;
  delete from public.ginpay_accounts where id = v_account;
  delete from public.pos_scan_events where scan_session_id = v_scan
    or token_hash in (select token_hash from app_private.customer_presence_tokens where customer_session_hash = v_customer_hash);
  delete from app_private.pos_scan_sessions where id = v_scan;
  delete from app_private.customer_presence_tokens where customer_session_hash = v_customer_hash;
  delete from public.customers where id = v_customer;
  delete from app_private.customer_sessions where token_hash = v_customer_hash;
  delete from public.client_identifiers where client_id in (v_source, v_target);
  delete from public.client_events where client_id in (v_source, v_target);
  delete from public.clients where id = v_source;
  delete from public.clients where id = v_target;
  delete from public.pos_operator_events where staff_member_id = v_operator and staff_session_hash = v_staff_hash;
  delete from app_private.pos_operator_sessions where staff_member_id = v_operator and staff_session_hash = v_staff_hash;
  delete from app_private.staff_operator_credentials where staff_member_id = v_operator;
  delete from public.staff_members where id = v_operator;
  delete from app_private.staff_sessions where token_hash = v_staff_hash;
  delete from app_private.hq_sessions where token_hash = v_hq_hash;

  if exists (select 1 from public.clients where id in (v_source, v_target))
     or exists (select 1 from public.customers where id = v_customer)
     or exists (select 1 from public.client_identifiers where client_id in (v_source, v_target) or (kind = 'app_member' and value = v_customer::text))
     or exists (select 1 from public.client_events where client_id in (v_source, v_target) or other_client_id in (v_source, v_target))
     or exists (select 1 from public.ginpay_accounts where id = v_account or client_id in (v_source, v_target))
     or exists (select 1 from public.ginpay_account_events where account_id = v_account)
     or exists (select 1 from app_private.pos_scan_sessions where id = v_scan or client_id in (v_source, v_target))
     or exists (select 1 from app_private.customer_presence_tokens where customer_session_hash = v_customer_hash)
     or exists (select 1 from app_private.customer_sessions where token_hash = v_customer_hash)
     or exists (select 1 from public.pos_scan_events where scan_session_id = v_scan or staff_session_hash = v_staff_hash)
     or exists (select 1 from public.pos_operator_events where staff_member_id = v_operator or approver_staff_id = v_operator)
     or exists (select 1 from app_private.pos_operator_sessions where staff_member_id = v_operator)
     or exists (select 1 from app_private.staff_operator_credentials where staff_member_id = v_operator)
     or exists (select 1 from public.staff_members where id = v_operator)
     or exists (select 1 from app_private.staff_sessions where token_hash = v_staff_hash)
     or exists (select 1 from app_private.hq_sessions where token_hash = v_hq_hash) then
    raise exception 'cleanup_fixture_remaining';
  end if;
  v_after := jsonb_build_object(
    'customers', (select count(*) from public.customers),
    'clients', (select count(*) from public.clients),
    'identifiers', (select count(*) from public.client_identifiers),
    'client_events', (select count(*) from public.client_events),
    'staff', (select count(*) from public.staff_members)
  );
  if v_after <> current_setting('pf.fixture_before_counts')::jsonb then
    raise exception 'cleanup_changed_existing_counts: %', v_after;
  end if;
  raise notice 'pos reconcile cleanup ok (no fixture remains, existing counts unchanged)';
end $$;
commit;
