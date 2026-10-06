-- GINPay concurrent payment setup.
--
-- Run against a disposable database after migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_concurrency_setup.sql
--   pgbench "$DATABASE_URL" -c 10 -j 10 -t 1 -f supabase/tests/ginpay_concurrency_worker.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_concurrency_verify.sql
--
-- The setup creates one client with a 1,000 yen balance and ten 700 yen payment
-- attempts (walk-in sales paid by GINPay through staff_finalize_sale). Exactly one sale and one
-- payment may post; the rest must return insufficient_balance.

drop table if exists public.__ginpay_concurrency_cases;
create table public.__ginpay_concurrency_cases (
  run_id uuid not null,
  worker_no integer not null,
  staff_token text not null,
  operator_token text not null,
  client_id uuid not null,
  scan_session_id uuid not null,
  stylist_id uuid not null,
  amount integer not null,
  quote_hash text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  primary key (run_id, worker_no)
);

create table if not exists public.__ginpay_concurrency_latest (
  id integer primary key default 1 check (id = 1),
  run_id uuid not null,
  created_at timestamptz not null default now()
);

do $$
declare
  v_run uuid := gen_random_uuid();
  v_staff text := 'ginpay-concurrency-staff-0123456789abcdef';
  v_op_id uuid;
  v_op_tok text;
  v_cust uuid;
  v_customer_user_id text;
  v_customer_session text;
  v_presence_token text;
  v_client uuid;
  v_scan_id uuid;
  v_ai_id uuid;
  v_qres jsonb;
  v_qhash text;
  i integer;
begin
  v_customer_user_id := 'u-ginpay-conc-' || replace(v_run::text, '-', '');
  v_customer_session := 'cust-tok-ginpay-conc-' || replace(v_run::text, '-', '');

  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('GINPay Conc Operator ' || substr(v_run::text, 1, 6), false, true, 805) returning id into v_op_id;
  perform app_private.set_staff_operator_credentials(v_op_id, '1111', 'staff');
  v_op_tok := (public.staff_operator_verify(v_staff, v_op_id, '1111')->>'operator_token');

  v_client := app_private.create_client('GINPay Concurrency ' || v_run::text, 'staff', 'staff', 'Concurrency');
  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values (v_customer_user_id, 'GINPay Conc Customer ' || substr(v_run::text, 1, 6), '0093', 'P-GINPAY-CONC-' || substr(replace(v_run::text, '-', ''), 1, 12), app_private.norm_name('GINPay Conc Customer ' || substr(v_run::text, 1, 6)))
  returning id into v_cust;
  perform app_private.merge_clients(v_client, app_private.member_client(v_cust), 'staff', 'staff');
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex(v_customer_session), v_customer_user_id, 'register')
  on conflict (token_hash) do update set user_id = excluded.user_id, revoked_at = null;
  v_presence_token := public.customer_issue_presence_token(v_customer_session)->>'token';
  v_scan_id := (public.staff_resolve_presence_token(v_staff, v_presence_token)->>'scan_session_id')::uuid;

  -- テスト専用の会計品目を一時作成（正式マスターは改変しない）
  insert into public.accounting_items (name, category, price, is_active)
  values ('ginpay-concurrency-700', 'menu', 700, true)
  on conflict (name) do update set price = 700, is_active = true
  returning id into v_ai_id;

  perform public.staff_ginpay_charge_store(
    v_staff,
    v_op_tok,
    v_client,
    1000,
    'cash',
    'Concurrency',
    'concurrency seed',
    'ginpay-concurrency-charge:' || v_run::text,
    null,
    null
  );

  -- quote を取得して quote_hash を発行
  v_qres := public.staff_pos_quote(v_staff, v_op_tok, v_scan_id, jsonb_build_object(
    'client_id', v_client,
    'scan_session_id', v_scan_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', v_ai_id::text, 'quantity', 1))
  ))::jsonb;
  v_qhash := v_qres->>'quote_hash';

  for i in 0..9 loop
    insert into public.__ginpay_concurrency_cases (run_id, worker_no, staff_token, operator_token, client_id, scan_session_id, stylist_id, amount, quote_hash, idempotency_key)
    values (v_run, i, v_staff, v_op_tok, v_client, v_scan_id, (select id from public.staff_members where is_active order by sort_order limit 1), 700,
            v_qhash, 'ginpay-concurrency-payment:' || v_run::text || ':' || i::text);
  end loop;

  insert into public.__ginpay_concurrency_latest (id, run_id, created_at)
  values (1, v_run, now())
  on conflict (id) do update set run_id = excluded.run_id, created_at = excluded.created_at;

  raise notice 'GINPay concurrency run_id=%', v_run;
end $$;
