-- ============================================================================
-- GINJIRO POS B-2C-1: 操作レジストリの同時実行（準備）(pos_operation_concurrency_setup.sql)
--
-- pgbench の 10 クライアントが同じ瞬間に始まるように開始時刻をそろえ、:client_id ごとに決めたケースを実行する。
--   0-3 同じ依頼 I・違うキー（同じ枠・同じ版）       → 依頼は1つ、ほかは instruction_conflict（キーは印）
--   4-6 違う依頼・同じキー（同じ枠・同じ版）         → 受理は1つ、ほかは key_conflict
--   7-9 受理済みの3件が重なる資源を claim（w1,w2 / w2,w3 / w3,w1） → デッドロックなし、資源は二重に押さえない
-- 使い捨てのローカル DB 専用。表と関数は verify で消す。
-- ============================================================================

set client_min_messages = warning;

drop function if exists public.__pos_op_conc_run(integer);
drop table if exists public.__pos_op_conc_responses;
drop table if exists public.__pos_op_conc_cases;
drop table if exists public.__pos_op_conc_latest;

create table public.__pos_op_conc_latest (
  id       integer primary key default 1 check (id = 1),
  run_id   uuid not null,
  start_at timestamptz not null,
  slot1    text not null,
  slot2    text not null,
  inst1    uuid not null,
  shared_key text not null,
  targets  text[] not null
);
create table public.__pos_op_conc_cases (
  worker_no integer primary key,
  call      text not null
);
create table public.__pos_op_conc_responses (
  worker_no integer primary key,
  response  jsonb not null,
  finished_at timestamptz not null default clock_timestamp()
);
alter table public.__pos_op_conc_latest enable row level security;
alter table public.__pos_op_conc_cases enable row level security;
alter table public.__pos_op_conc_responses enable row level security;
revoke all on public.__pos_op_conc_latest, public.__pos_op_conc_cases, public.__pos_op_conc_responses from public, anon, authenticated;

do $$
declare
  v_acct1 text := gen_random_uuid()::text;
  v_acct2 text := gen_random_uuid()::text;
  v_i1 uuid := gen_random_uuid();
  v_shared text := 'staff-store-charge:' || gen_random_uuid();
  v_f1 jsonb := jsonb_build_object('account_id', v_acct1, 'amount', 1000);
  v_f2 jsonb := jsonb_build_object('account_id', v_acct2, 'amount', 2000);
  v_t text[] := array['gpaccount:' || gen_random_uuid(), 'reservation:' || gen_random_uuid(), 'client:' || gen_random_uuid()];
  v_inst uuid;
  n integer;
begin
  for n in 0..3 loop
    insert into public.__pos_op_conc_cases values (n, format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 0, null, %L, %L)',
      v_i1, 'ginpay_charge', v_f1, 'staff-store-charge:' || gen_random_uuid(), 'test', 'C1同時'));
  end loop;
  for n in 4..6 loop
    insert into public.__pos_op_conc_cases values (n, format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 0, null, %L, %L)',
      gen_random_uuid(), 'ginpay_charge', v_f2, v_shared, 'test', 'C1同時'));
  end loop;
  for n in 7..9 loop
    v_inst := (app_private.pos_op_prepare(gen_random_uuid(), 'checkout_reservation', jsonb_build_object('reservation_id', gen_random_uuid()::text),
      'checkout:' || gen_random_uuid(), 0, null, 'test', 'C1同時') ->> 'instruction_id')::uuid;
    insert into public.__pos_op_conc_cases values (n, format('select app_private.pos_op_claim(%L::uuid, %L::text[])', v_inst,
      case n when 7 then array[v_t[2], v_t[1]] when 8 then array[v_t[3], v_t[2]] else array[v_t[1], v_t[3]] end));
  end loop;
  insert into public.__pos_op_conc_latest values (1, gen_random_uuid(), clock_timestamp() + interval '3 seconds',
    'ginpay:account:' || v_acct1, 'ginpay:account:' || v_acct2, v_i1, v_shared, v_t);
end $$;

-- 開始時刻まで待ってから、そのクライアントのケースを実行する（試験用。verify で消す）
create function public.__pos_op_conc_run(p_worker integer)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_call text;
  v_res jsonb;
begin
  perform pg_sleep(greatest(0, extract(epoch from ((select start_at from public.__pos_op_conc_latest) - clock_timestamp()))));
  select call into v_call from public.__pos_op_conc_cases where worker_no = p_worker;
  execute v_call into v_res;
  return v_res;
end;
$$;
revoke all on function public.__pos_op_conc_run(integer) from public, anon, authenticated;
