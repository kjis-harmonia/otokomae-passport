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

create table if not exists public.__ginpay_concurrency_cases (
  run_id uuid not null,
  worker_no integer not null,
  staff_token text not null,
  client_id uuid not null,
  stylist_id uuid not null,
  amount integer not null,
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
  v_staff text := 'ginpay-concurrency-staff';
  v_client uuid;
  i integer;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  v_client := app_private.create_client('GINPay Concurrency ' || v_run::text, 'staff', 'staff', 'Concurrency');

  perform public.staff_ginpay_charge_store(
    v_staff,
    v_client,
    1000,
    'cash',
    'Concurrency',
    'concurrency seed',
    'ginpay-concurrency-charge:' || v_run::text
  );

  for i in 0..9 loop
    insert into public.__ginpay_concurrency_cases (run_id, worker_no, staff_token, client_id, stylist_id, amount, idempotency_key)
    values (v_run, i, v_staff, v_client, (select id from public.staff_members order by sort_order limit 1), 700,
            'ginpay-concurrency-payment:' || v_run::text || ':' || i::text);
  end loop;

  insert into public.__ginpay_concurrency_latest (id, run_id, created_at)
  values (1, v_run, now())
  on conflict (id) do update set run_id = excluded.run_id, created_at = excluded.created_at;

  raise notice 'GINPay concurrency run_id=%', v_run;
end $$;
