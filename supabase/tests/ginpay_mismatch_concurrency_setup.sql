-- 台帳と一致しない GINPay 口座への同時書き込み（使い捨ての DB で実行）
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_mismatch_concurrency_setup.sql
--   pgbench "$DATABASE_URL" -n -c 10 -j 10 -t 1 -f supabase/tests/ginpay_mismatch_concurrency_worker.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_mismatch_concurrency_verify.sql
--
-- 口座：¥5,000 チャージ済み、キャッシュだけ ¥5,300（テストのためにガードを一時的に外してずらす）。
-- 10 件が同時に GINPay 払いの会計・店頭チャージ・調整を試みる → すべて ledger_mismatch_blocked、金銭は 0 件、
-- 監査（ledger_mismatch_blocked）は 10 件 commit される。

create table if not exists public.__ginpay_mismatch_cases (
  run_id uuid not null,
  worker_no integer not null,
  op text not null,
  staff_token text not null,
  client_id uuid not null,
  stylist_id uuid not null,
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
  v_staff text := 'ginpay-mismatch-concurrency-staff-' || v_run::text;
  v_client uuid; v_stylist uuid; v_charge jsonb; v_account uuid; i integer;
begin
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_staff), now() + interval '1 hour');
  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;
  v_client := app_private.create_client('GINPay Mismatch Concurrency', 'staff', 'staff', 'Preflight');
  v_charge := public.staff_ginpay_charge_store(v_staff, v_client, 5000, 'cash', 'Preflight', null, 'ginpay-mismatch-seed:' || v_run::text)::jsonb;
  if v_charge ? 'error' then raise exception 'seed charge failed: %', v_charge; end if;
  v_account := (v_charge->>'account_id')::uuid;
  alter table public.ginpay_accounts disable trigger ginpay_accounts_balance_guard;
  update public.ginpay_accounts set balance_cached = balance_cached + 300 where id = v_account;
  alter table public.ginpay_accounts enable trigger ginpay_accounts_balance_guard;
  for i in 0..9 loop
    insert into public.__ginpay_mismatch_cases (run_id, worker_no, op, staff_token, client_id, stylist_id, idempotency_key)
    values (v_run, i, case i % 3 when 0 then 'sale' when 1 then 'charge' else 'adjustment' end, v_staff, v_client, v_stylist,
            'ginpay-mismatch:' || v_run::text || ':' || i);
  end loop;
  insert into public.__ginpay_mismatch_latest (id, run_id, account_id) values (1, v_run, v_account)
  on conflict (id) do update set run_id = excluded.run_id, account_id = excluded.account_id;
end $$;
