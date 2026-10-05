-- GINJIRO POS Phase 0 / P0-1：GINPay 台帳照合ガード
--   Part A（begin … rollback）：直接更新の拒否、正常な記録、不一致時に全経路（店頭チャージ・調整・取消・会計・会計取消・Stripe）が
--          金銭を記録せず { error } を返して監査を残すこと、表示の残高が台帳合計であること
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
begin
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_staff), now() + interval '1 hour');
  insert into app_private.hq_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_hq), now() + interval '1 hour');
  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;
  v_client := app_private.create_client('Preflight POS Reconcile', 'staff', 'staff', 'Preflight');

  -- 正常：チャージで balance_cached と台帳合計が一致して増える
  v_charge := public.staff_ginpay_charge_store(v_staff, v_client, 5000, 'cash', 'Preflight', null, 'pos-reconcile-charge-1')::jsonb;
  if v_charge ? 'error' then raise exception 'charge failed: %', v_charge; end if;
  v_account := (v_charge->>'account_id')::uuid;
  select balance_cached into v_cached from public.ginpay_accounts where id = v_account;
  if v_cached <> 5000 or app_private.ginpay_posted_sum(v_account) <> 5000 then raise exception 'normal_charge_mismatch'; end if;

  -- 正常：GINPay 払いの会計（後で取消の照合に使う）
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object('client_id', v_client, 'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
    'payment_method', 'ginpay', 'expected_total', 1000, 'idempotency_key', 'pos-reconcile-sale-1'), 'Preflight')::jsonb;
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

  -- 全経路：金銭を記録せず ledger_mismatch_blocked を返す（例外にしない）
  v_r := public.staff_ginpay_charge_store(v_staff, v_client, 1000, 'cash', 'Preflight', null, 'pos-reconcile-charge-2')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'charge_not_blocked: %', v_r; end if;
  v_r := public.staff_ginpay_adjustment(v_staff, v_client, -100, 'Preflight', 'test', 'pos-reconcile-adj-1')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'staff_adjustment_not_blocked: %', v_r; end if;
  v_r := public.hq_ginpay_adjustment(v_hq, v_client, 100, 'test', 'pos-reconcile-adj-2')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'hq_adjustment_not_blocked: %', v_r; end if;
  v_r := public.staff_ginpay_void(v_staff, (v_charge->>'id')::uuid, 'Preflight', 'test', 'pos-reconcile-void-1')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'staff_void_not_blocked: %', v_r; end if;
  v_r := public.staff_finalize_sale(v_staff, jsonb_build_object('client_id', v_client, 'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'cut-bangs', 'quantity', 1)),
    'payment_method', 'ginpay', 'expected_total', 500, 'idempotency_key', 'pos-reconcile-sale-2'), 'Preflight')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'finalize_not_blocked: %', v_r; end if;
  if exists (select 1 from public.accounting_sessions where idempotency_key = 'pos-reconcile-sale-2') then raise exception 'finalize_wrote_sale'; end if;
  v_r := public.hq_void_sale(v_hq, (v_sale->>'id')::uuid, 'test')::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' then raise exception 'sale_void_not_blocked: %', v_r; end if;
  if (select status from public.accounting_sessions where id = (v_sale->>'id')::uuid) <> 'completed' then raise exception 'sale_void_changed_sale'; end if;
  v_r := public.ginpay_apply_stripe_webhook('evt_pos_reconcile_1', 'payment_intent.succeeded', v_client, 2000, 'pi_pos_reconcile_1', null, null,
    jsonb_build_object('data', jsonb_build_object('object', jsonb_build_object('currency', 'jpy'))))::jsonb;
  if v_r->>'error' is distinct from 'ledger_mismatch_blocked' or not coalesce((v_r->>'retryable')::boolean, false) then raise exception 'stripe_not_blocked: %', v_r; end if;
  if exists (select 1 from public.ginpay_stripe_events where event_id = 'evt_pos_reconcile_1') then raise exception 'stripe_event_recorded_while_blocked'; end if;

  -- 金銭は一切記録されていない／キャッシュも変わっていない／監査は経路の数だけある
  if (select count(*) from public.ginpay_transactions where account_id = v_account) <> v_n then raise exception 'money_written_while_blocked'; end if;
  select balance_cached into v_cached from public.ginpay_accounts where id = v_account;
  if v_cached <> 4300 then raise exception 'cache_changed_while_blocked'; end if;
  select count(*) into v_ev from public.ginpay_account_events where account_id = v_account and event_type = 'ledger_mismatch_blocked';
  if v_ev < 7 then raise exception 'mismatch_audit_missing: %', v_ev; end if;
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
select app_private.create_client('Preflight POS Reconcile Commit', 'staff', 'staff', 'Preflight') as client_id \gset
insert into app_private.staff_sessions (token_hash, expires_at)
values (app_private.sha256_hex('preflight-pos-reconcile-commit-staff-0123456789'), now() + interval '1 hour');
select app_private.ginpay_open_account(:'client_id', 'system', 'Preflight', true) as account_id \gset
-- 不一致の口座（取引 0 件・キャッシュ 300）。テストだけの操作
alter table public.ginpay_accounts disable trigger ginpay_accounts_balance_guard;
update public.ginpay_accounts set balance_cached = 300 where id = :'account_id';
alter table public.ginpay_accounts enable trigger ginpay_accounts_balance_guard;

-- それぞれ独立したトランザクション（自動 commit）で呼ぶ
select public.staff_ginpay_adjustment('preflight-pos-reconcile-commit-staff-0123456789', :'client_id', 500, 'Preflight', 'test',
  'pos-reconcile-commit-adj') ->> 'error' as adj_error \gset
select public.staff_finalize_sale('preflight-pos-reconcile-commit-staff-0123456789', jsonb_build_object('client_id', :'client_id',
  'stylist_id', (select id from public.staff_members where is_active order by sort_order limit 1),
  'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
  'payment_method', 'ginpay', 'expected_total', 1000, 'idempotency_key', 'pos-reconcile-commit-sale'), 'Preflight') ->> 'error' as sale_error \gset

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
delete from public.ginpay_account_events where account_id = :'account_id';
delete from public.ginpay_accounts where id = :'account_id';
delete from public.clients where id = :'client_id';
delete from app_private.staff_sessions where token_hash = app_private.sha256_hex('preflight-pos-reconcile-commit-staff-0123456789');
