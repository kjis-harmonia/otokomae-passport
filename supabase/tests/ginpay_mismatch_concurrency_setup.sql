-- 台帳と一致しない GINPay 口座への同時書き込み（使い捨ての DB で実行）
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_mismatch_concurrency_setup.sql
--   pgbench "$DATABASE_URL" -n -c 10 -j 10 -t 1 -f supabase/tests/ginpay_mismatch_concurrency_worker.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_mismatch_concurrency_verify.sql
--
-- 口座：¥5,000 チャージ済み、キャッシュだけ ¥5,300（テストのためにガードを一時的に外してずらす）。
-- 10 件が同時に GINPay 払いの会計・店頭チャージ・調整を試みる → すべて ledger_mismatch_blocked、金銭は 0 件、
-- 監査（ledger_mismatch_blocked）は 10 件 commit される。

drop table if exists public.__ginpay_mismatch_cases;
create table public.__ginpay_mismatch_cases (
  run_id uuid not null,
  worker_no integer not null,
  op text not null,
  staff_token text not null,
  operator_token text not null,
  hq_token text not null,
  client_id uuid not null,
  scan_session_id uuid not null,
  stylist_id uuid not null,
  quote_hash text not null,
  idempotency_key text not null,
  primary key (run_id, worker_no)
);
create table if not exists public.__ginpay_mismatch_latest (
  id integer primary key default 1 check (id = 1),
  run_id uuid not null,
  account_id uuid not null
);

do $$
declare
  v_run uuid := gen_random_uuid();
  v_staff text := 'ginpay-mismatch-concurrency-staff-' || substr(v_run::text, 1, 8);
  v_hq text := 'ginpay-mismatch-concurrency-hq-' || substr(v_run::text, 1, 8);
  v_op_id uuid;
  v_op_tok text;
  v_cust uuid;
  v_customer_user_id text;
  v_customer_session text;
  v_presence_token text;
  v_client uuid;
  v_scan_id uuid;
  v_stylist uuid;
  v_charge jsonb;
  v_account uuid;
  v_qres jsonb;
  v_qhash text;
  i integer;
begin
  v_customer_user_id := 'u-ginpay-mismatch-conc-' || replace(v_run::text, '-', '');
  v_customer_session := 'cust-tok-mismatch-conc-' || replace(v_run::text, '-', '');

  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_staff), now() + interval '1 hour');
  insert into app_private.hq_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_hq), now() + interval '1 hour');

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('Mismatch Conc Operator ' || substr(v_run::text, 1, 6), false, true, 806) returning id into v_op_id;
  perform app_private.set_staff_operator_credentials(v_op_id, '1111', 'staff');
  v_op_tok := (public.staff_operator_verify(v_staff, v_op_id, '1111')->>'operator_token');

  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;
  v_client := app_private.create_client('GINPay Mismatch Concurrency', 'staff', 'staff', 'Preflight');
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_customer_user_id, 'Mismatch Conc Customer ' || substr(v_run::text, 1, 6), '0094', 'P-GINPAY-MISMATCH-CONC-' || substr(replace(v_run::text, '-', ''), 1, 12), app_private.norm_name('Mismatch Conc Customer ' || substr(v_run::text, 1, 6)))
  returning id into v_cust;
  perform app_private.merge_clients(v_client, app_private.member_client(v_cust), 'staff', 'staff');
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex(v_customer_session), v_customer_user_id, 'register')
  on conflict (token_hash) do update set user_id = excluded.user_id, revoked_at = null;
  v_presence_token := public.customer_issue_presence_token(v_customer_session)->>'token';
  v_scan_id := (public.staff_resolve_presence_token(v_staff, v_presence_token)->>'scan_session_id')::uuid;

  -- 正常チャージ (canonical 10引数)
  v_charge := public.staff_ginpay_charge_store(v_staff, v_op_tok, v_client, 5000, 'cash', 'Preflight', null, 'ginpay-mismatch-seed:' || v_run::text, null, null)::jsonb;
  if v_charge ? 'error' then raise exception 'seed charge failed: %', v_charge; end if;
  v_account := (v_charge->>'account_id')::uuid;

  -- 見積もり取得 (quote_hash)
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, jsonb_build_object(
    'client_id', v_client,
    'scan_session_id', v_scan_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1))
  ))::jsonb;
  v_qhash := v_qres->>'quote_hash';

  -- 不一致を作成
  alter table public.ginpay_accounts disable trigger ginpay_accounts_balance_guard;
  update public.ginpay_accounts set balance_cached = balance_cached + 300 where id = v_account;
  alter table public.ginpay_accounts enable trigger ginpay_accounts_balance_guard;

  -- 3経路 (sale / charge / adjustment) の coverage を維持して10件登録
  for i in 0..9 loop
    insert into public.__ginpay_mismatch_cases (run_id, worker_no, op, staff_token, operator_token, hq_token, client_id, scan_session_id, stylist_id, quote_hash, idempotency_key)
    values (v_run, i, case i % 3 when 0 then 'sale' when 1 then 'charge' else 'adjustment' end,
            v_staff, v_op_tok, v_hq, v_client, v_scan_id, v_stylist, v_qhash,
            'ginpay-mismatch:' || v_run::text || ':' || i);
  end loop;

  insert into public.__ginpay_mismatch_latest (id, run_id, account_id) values (1, v_run, v_account)
  on conflict (id) do update set run_id = excluded.run_id, account_id = excluded.account_id;
end $$;
