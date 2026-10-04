-- POS 提示トークンの同時読み取り（使い捨ての DB で実行）
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pos_presence_concurrency_setup.sql
--   pgbench "$DATABASE_URL" -n -c 10 -j 10 -t 1 -f supabase/tests/pos_presence_concurrency_worker.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pos_presence_concurrency_verify.sql
--
-- トークン A：10 台の別々の端末セッションが同時に読む → scan session は 1 つ、成功は 1 件、残りは already_used。
-- トークン B：同じ端末セッションから 10 件同時に読む → すべて同じ scan session（1 件が scanned、残りは retry）。

create table if not exists public.__pos_presence_cases (
  run_id uuid not null,
  worker_no integer not null,
  staff_token text not null,
  shared_staff_token text not null,
  token_a text not null,
  token_b text not null,
  primary key (run_id, worker_no)
);
create table if not exists public.__pos_presence_latest (
  id integer primary key default 1 check (id = 1),
  run_id uuid not null
);

do $$
declare
  v_run uuid := gen_random_uuid();
  v_uid_a text := 'pos-presence-concurrency-a-' || v_run::text;
  v_uid_b text := 'pos-presence-concurrency-b-' || v_run::text;
  v_sess_a text := 'pos-presence-concurrency-session-a-' || v_run::text;
  v_sess_b text := 'pos-presence-concurrency-session-b-' || v_run::text;
  v_shared text := 'pos-presence-concurrency-shared-' || v_run::text;
  v_tok_a text; v_tok_b text; i integer;
begin
  insert into public.customers (user_id, name, recovery_code) values
    (v_uid_a, 'POS同時A', 'PFPA' || substr(replace(v_run::text, '-', ''), 1, 8)),
    (v_uid_b, 'POS同時B', 'PFPB' || substr(replace(v_run::text, '-', ''), 1, 8));
  insert into app_private.customer_sessions (token_hash, user_id, created_via) values
    (app_private.sha256_hex(v_sess_a), v_uid_a, 'register'), (app_private.sha256_hex(v_sess_b), v_uid_b, 'register');
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_shared), now() + interval '1 hour');
  v_tok_a := public.customer_issue_presence_token(v_sess_a)::jsonb->>'token';
  v_tok_b := public.customer_issue_presence_token(v_sess_b)::jsonb->>'token';
  for i in 0..9 loop
    insert into app_private.staff_sessions (token_hash, expires_at)
    values (app_private.sha256_hex('pos-presence-concurrency-staff-' || i || '-' || v_run::text), now() + interval '1 hour');
    insert into public.__pos_presence_cases (run_id, worker_no, staff_token, shared_staff_token, token_a, token_b)
    values (v_run, i, 'pos-presence-concurrency-staff-' || i || '-' || v_run::text, v_shared, v_tok_a, v_tok_b);
  end loop;
  insert into public.__pos_presence_latest (id, run_id) values (1, v_run) on conflict (id) do update set run_id = excluded.run_id;
end $$;
