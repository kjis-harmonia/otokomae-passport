-- ============================================================================
-- GINJIRO POS B-2C-1: 2つ以上のセッションの順序を決めた検証 (preflight_pos_operation_interleave.sql)
--
-- 使い捨てのローカル DB 専用。dblink で別のセッションを開き、片方のトランザクションを開いたまま
-- もう片方を送って「本当に lock で待っている」ことを確かめてから、commit / rollback の順番を決めて結果を見る。
-- dblink の接続はパスワードなし（trust / peer のローカル DB）を前提にする。テストの最後に dblink は外す。
--
-- 1 同じ依頼・違うキー / 2 違う依頼・同じキー / 3 同じ依頼・同じキー / 4 遅れた PREPARE と進行中の PREPARE・コミット前の失敗
-- 5 逆順の claim / 6 3者の重なり（デッドロックなし）/ 7 fence と claim の競合（両方の順）
-- 8 同じ効果の同時 discovery（キーと効果 ID、K1 と改名後の K2）/ 9 会計と支払いの同時 discovery
-- ============================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;

create extension if not exists dblink schema extensions;

create temp table c1i_results (n serial, label text not null);

create function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'C1 interleave FAIL: %', p_label; end if;
  insert into c1i_results (label) values (p_label);
end $$;

create function pg_temp.conn(p_name text) returns void language plpgsql as $$
begin
  if p_name = any (coalesce(extensions.dblink_get_connections(), '{}')) then perform extensions.dblink_disconnect(p_name); end if;
  perform extensions.dblink_connect(p_name, format('host=%s port=%s dbname=%s user=%s',
    'localhost', current_setting('port'), current_database(), current_user));
  perform extensions.dblink_exec(p_name, 'set client_min_messages = warning');
end $$;

-- 1行1列（jsonb）の問い合わせを同期で
create function pg_temp.q(p_conn text, p_sql text) returns jsonb language sql as $$
  select r from extensions.dblink(p_conn, p_sql) as t(r jsonb) $$;
create function pg_temp.x(p_conn text, p_sql text) returns void language sql as $$
  select extensions.dblink_exec(p_conn, p_sql) $$;
create function pg_temp.send(p_conn text, p_sql text) returns void language plpgsql as $$
begin
  if extensions.dblink_send_query(p_conn, p_sql) <> 1 then raise exception 'send failed on %', p_conn; end if;
end $$;
-- 送った問い合わせが lock で待っていること（0.4 秒たっても終わっていない・lock 待ちのセッションがある）
create function pg_temp.blocked(p_conn text) returns boolean language plpgsql as $$
begin
  perform pg_sleep(0.4);
  return extensions.dblink_is_busy(p_conn) = 1
    and exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                where not l.granted and a.datname = current_database());
end $$;
create function pg_temp.fetch(p_conn text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  select r into v from extensions.dblink_get_result(p_conn) as t(r jsonb);
  perform 1 from extensions.dblink_get_result(p_conn) as t(r jsonb);
  return v;
end $$;

-- 結果を受け取る（相手のセッションのエラーは {"remote_error": ...} として返す。40P01 のデッドロックもここで見える）
create function pg_temp.fetch_safe(p_conn text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    select r into v from extensions.dblink_get_result(p_conn) as t(r jsonb);
  exception when others then
    v := jsonb_build_object('remote_error', sqlerrm);
  end;
  begin
    perform 1 from extensions.dblink_get_result(p_conn) as t(r jsonb);
  exception when others then null;
  end;
  return v;
end $$;
-- 相手のセッションで文を順に実行して最後に COMMIT。どこかで失敗したらそのエラー文言を返す（成功なら null）。最後は必ず rollback で片付ける
create function pg_temp.remote_commit_err(p_conn text, p_sqls text[]) returns text language plpgsql as $$
declare
  v_msg text;
  v_s text;
begin
  begin
    perform extensions.dblink_exec(p_conn, 'begin');
    foreach v_s in array p_sqls loop
      perform extensions.dblink_exec(p_conn, v_s);
    end loop;
    perform extensions.dblink_exec(p_conn, 'commit');
  exception when others then
    v_msg := sqlerrm;
  end;
  begin
    perform extensions.dblink_exec(p_conn, 'rollback');
  exception when others then null;
  end;
  return v_msg;
end $$;

create function pg_temp.prep_sql(p_inst uuid, p_kind text, p_facts jsonb, p_key text, p_epoch bigint) returns text language sql as $$
  select format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, %s, null, %L, %L)', p_inst, p_kind, p_facts, p_key, p_epoch, 'test', 'C1並行') $$;
create function pg_temp.claim_sql(p_inst uuid, p_targets text[]) returns text language sql as $$
  select format('select app_private.pos_op_claim(%L::uuid, %L::text[])', p_inst, p_targets) $$;

do $$ begin perform pg_temp.conn('a'); perform pg_temp.conn('b'); perform pg_temp.conn('c'); perform pg_temp.conn('m'); end $$;

-- ── 1-3. 依頼の直列化 ──
do $$
declare
  v_i uuid := gen_random_uuid();
  f jsonb := jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 1000);
  k1 text := 'staff-store-charge:' || gen_random_uuid();
  k2 text := 'staff-store-charge:' || gen_random_uuid();
  ra jsonb; rb jsonb; v_blocked boolean;
begin
  -- 1. 同じ依頼 I、K1 と K2：B は依頼の lock で待ち、A のコミット後に instruction_conflict（K2 は印）
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.prep_sql(v_i, 'ginpay_charge', f, k1, 0));
  perform pg_temp.send('b', pg_temp.prep_sql(v_i, 'ginpay_charge', f, k2, 0));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked, '1 same I / K1 vs K2: second request waits on instruction lock');
  perform pg_temp.ok(ra ->> 'result' = 'prepared' and rb ->> 'error' = 'instruction_conflict' and rb ->> 'losing_key' = 'tombstoned',
    '1 same I / K1 vs K2: one owner, loser conflict + tombstone');
  perform pg_temp.ok((pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_business_instructions where instruction_id = %L', v_i)))::int = 1
    and pg_temp.q('m', format('select app_private.pos_op_status_by_key(%L, %L)', 'ginpay_tx', k2)) #>> '{operation,origin}' = 'conflict_tombstone',
    '1 same I / K1 vs K2: exactly one instruction, K2 permanently fenced');

  -- 3. 同じ依頼・同じキー：待ってから同じ結果
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.prep_sql(v_i, 'ginpay_charge', f, k1, 0));
  perform pg_temp.send('b', pg_temp.prep_sql(v_i, 'ginpay_charge', f, k1, 0));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'existing' and rb ->> 'result' = 'existing' and rb ->> 'operation_id' = ra ->> 'operation_id',
    '3 same I / same key concurrently: identical results');
end $$;

do $$
declare
  f jsonb := jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 1000);
  k text := 'staff-store-charge:' || gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid();
  ra jsonb; rb jsonb; v_blocked boolean;
begin
  -- 2. 違う依頼・同じキー：B はキーの lock で待ち、key_conflict（依頼は記録されない）
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.prep_sql(i1, 'ginpay_charge', f, k, 0));
  perform pg_temp.send('b', pg_temp.prep_sql(i2, 'ginpay_charge', f, k, 0));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'prepared' and rb ->> 'error' = 'key_conflict' and rb ->> 'operation_id' = ra ->> 'operation_id'
    and pg_temp.q('m', format('select app_private.pos_op_status_by_instruction(%L)', i2)) ->> 'found' = 'false',
    '2 different I / same key: waits on key lock, key_conflict, no instruction recorded');
end $$;

-- ── 4. 遅れた PREPARE と進行中の PREPARE / コミット前の失敗 ──
do $$
declare
  f jsonb := jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 1000);
  v_slot text := 'ginpay:account:' || (f ->> 'account_id');
  ia uuid := gen_random_uuid(); ib uuid := gen_random_uuid(); ic uuid := gen_random_uuid();
  ka text := 'staff-store-charge:' || gen_random_uuid();
  kb text := 'staff-store-charge:' || gen_random_uuid();
  kc text := 'staff-store-charge:' || gen_random_uuid();
  ra jsonb; rb jsonb; v_blocked boolean;
begin
  -- A が先に枠を押さえて受理 → 同じ版を見ていた B は枠の lock で待ち、stale_epoch（キーは印）
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.prep_sql(ia, 'ginpay_charge', f, ka, 0));
  perform pg_temp.send('b', pg_temp.prep_sql(ib, 'ginpay_charge', f, kb, 0));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'prepared' and rb ->> 'error' = 'stale_epoch'
    and pg_temp.q('m', format('select app_private.pos_op_status_by_key(%L, %L)', 'ginpay_tx', kb)) #>> '{operation,origin}' = 'stale_prepare',
    '4 in-flight PREPARE A wins; delayed B (same epoch) waits on slot then stale_epoch + tombstone');

  -- コミット前に落ちた PREPARE は何も残さない
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.prep_sql(ic, 'ginpay_charge', jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 5), kc, 0));
  perform pg_temp.x('a', 'rollback');
  perform pg_temp.ok(ra ->> 'result' = 'prepared'
    and pg_temp.q('m', format('select app_private.pos_op_status_by_instruction(%L)', ic)) ->> 'found' = 'false'
    and not (pg_temp.q('m', format('select app_private.pos_op_status_by_key(%L, %L)', 'ginpay_tx', kc)) ->> 'bound')::boolean,
    '4 PREPARE crash before commit leaves no instruction/key');
  -- 同じ依頼をあらためて送れば普通に受理される（落ちた依頼は存在しなかった）
  ra := pg_temp.q('a', pg_temp.prep_sql(ic, 'ginpay_charge', jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 5), kc, 0));
  perform pg_temp.ok(ra ->> 'result' = 'prepared', '4 retry after crash before commit is accepted');
end $$;

-- ── 5-6. claim の資源（逆順・3者の重なり・rollback） ──
do $$
declare
  t1 text := 'gpaccount:' || gen_random_uuid(); t2 text := 'reservation:' || gen_random_uuid();
  u1 text := 'client:' || gen_random_uuid(); u2 text := 'gpaccount:' || gen_random_uuid(); u3 text := 'reservation:' || gen_random_uuid();
  w1 text := 'client:' || gen_random_uuid(); w2 text := 'gpaccount:' || gen_random_uuid(); w3 text := 'reservation:' || gen_random_uuid();
  ix uuid; iy uuid; ip uuid; iq uuid; ir uuid; ip2 uuid; iq2 uuid; ir2 uuid;
  ra jsonb; rb jsonb; rc jsonb; v_blocked boolean; v_blocked2 boolean;
  function_prep text;
begin
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_reservation', jsonb_build_object('reservation_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into ix;
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_reservation', jsonb_build_object('reservation_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into iy;

  -- 5. 逆の順で同じ資源を要求：並べ替えて取るので B は t1 で待ち、A のコミット後に全体を戻す
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.claim_sql(ix, array[t2, t1]));
  perform pg_temp.send('b', pg_temp.claim_sql(iy, array[t1, t2]));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'claimed' and rb ->> 'error' = 'target_busy'
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_targets t join app_private.pos_business_instructions i using (operation_id) where i.instruction_id = %L', iy)))::int = 0
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_required_targets t join app_private.pos_business_instructions i using (operation_id) where i.instruction_id = %L', iy)))::int = 0,
    '5 opposite-order concurrent claims: no deadlock, loser keeps zero active and zero required targets');

  -- 6. 3者の重なり（P: u1,u2 / Q: u2,u3 / R: u3,u1）
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into ip;
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into iq;
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into ir;
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.claim_sql(ip, array[u1, u2]));
  perform pg_temp.send('b', pg_temp.claim_sql(iq, array[u2, u3]));
  perform pg_temp.send('c', pg_temp.claim_sql(ir, array[u3, u1]));
  v_blocked := pg_temp.blocked('b');
  v_blocked2 := pg_temp.blocked('c');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b'); rc := pg_temp.fetch('c');
  perform pg_temp.ok(v_blocked and v_blocked2 and ra ->> 'result' = 'claimed' and rb ->> 'error' = 'target_busy' and rc ->> 'error' = 'target_busy',
    '6 three-way overlap with commit: both waiters fail cleanly (no deadlock)');

  -- 6. 同じ形で A が rollback：Q と R のどちらか1つだけが全部を取る
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into ip2;
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into iq2;
  select (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0)) ->> 'instruction_id')::uuid into ir2;
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.claim_sql(ip2, array[w1, w2]));
  perform pg_temp.send('b', pg_temp.claim_sql(iq2, array[w2, w3]));
  perform pg_temp.send('c', pg_temp.claim_sql(ir2, array[w3, w1]));
  v_blocked := pg_temp.blocked('b');
  v_blocked2 := pg_temp.blocked('c');
  perform pg_temp.x('a', 'rollback');
  rb := pg_temp.fetch('b'); rc := pg_temp.fetch('c');
  perform pg_temp.ok(v_blocked and v_blocked2
    and ((rb ->> 'result' = 'claimed' and rc ->> 'error' = 'target_busy') or (rc ->> 'result' = 'claimed' and rb ->> 'error' = 'target_busy')),
    '6 three-way overlap with rollback: exactly one waiter claims its full set (no deadlock)');
  perform pg_temp.ok((pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_targets where target_key in (%L, %L, %L) and active', w1, w2, w3)))::int = 2
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_targets t join app_private.pos_business_instructions i using (operation_id) where i.instruction_id = %L', ip2)))::int = 0
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_required_targets t join app_private.pos_business_instructions i using (operation_id) where i.instruction_id = %L', ip2)))::int = 0
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_required_targets where target_key in (%L, %L, %L)', w1, w2, w3)))::int = 2,
    '6 rolled-back claim left nothing; winner holds exactly its two targets (required = active)');
end $$;

-- ── 7. fence と claim の競合（両方の順） ──
do $$
declare
  fw jsonb := jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 700);
  fz jsonb := jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 800);
  kw text := 'staff-store-charge:' || gen_random_uuid();
  kz text := 'staff-store-charge:' || gen_random_uuid();
  v1 text := 'gpaccount:' || (fw ->> 'account_id'); v2 text := 'gpaccount:' || (fz ->> 'account_id');
  iw uuid; iz uuid; ra jsonb; rb jsonb; v_blocked boolean; s jsonb;
begin
  iw := (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'ginpay_charge', fw, kw, 0)) ->> 'instruction_id')::uuid;
  iz := (pg_temp.q('a', pg_temp.prep_sql(gen_random_uuid(), 'ginpay_charge', fz, kz, 0)) ->> 'instruction_id')::uuid;

  -- claim が先：fence はキーの lock で待ち、claim のコミット後に abandoned（資源も解放）
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', pg_temp.claim_sql(iw, array[v1]));
  perform pg_temp.send('b', format('select app_private.pos_op_fence_key(%L, %L, %L)', 'ginpay_tx', kw, 'race'));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  s := pg_temp.q('m', format('select app_private.pos_op_status_by_key(%L, %L)', 'ginpay_tx', kw));
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'claimed' and rb ->> 'result' = 'abandoned'
    and s #>> '{operation,status}' = 'abandoned' and jsonb_array_length(s #> '{operation,active_targets}') = 0
    and (pg_temp.q('m', format('select app_private.pos_op_status_by_slot(%L)', 'ginpay:account:' || (fw ->> 'account_id'))) ->> 'active_instruction_id') is null,
    '7 claim then fence: fence waits, then abandons and releases targets and slot');

  -- fence が先：claim はキーの lock で待ち、operation_terminal
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', format('select app_private.pos_op_fence_key(%L, %L, %L)', 'ginpay_tx', kz, 'race'));
  perform pg_temp.send('b', pg_temp.claim_sql(iz, array[v2]));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'abandoned' and rb ->> 'error' = 'operation_terminal'
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_targets where target_key = %L', v2)))::int = 0,
    '7 fence then claim: claim waits, then refused; no targets');
end $$;

-- ── 8-9. 同じ効果の同時 discovery ──
do $$
declare
  l uuid := gen_random_uuid(); l2 uuid := gen_random_uuid();
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid(); tc uuid := gen_random_uuid(); td uuid := gen_random_uuid();
  k1 text := 'ticket-issue:' || gen_random_uuid(); k2 text := 'ticket-issue:' || gen_random_uuid();
  k3 text := 'ticket-issue:' || gen_random_uuid();
  s uuid := gen_random_uuid(); t uuid := gen_random_uuid(); ks text := 'checkout:' || gen_random_uuid();
  ra jsonb; rb jsonb; v_blocked boolean;
begin
  perform pg_temp.x('m', format($f$
    set session_replication_role = replica;
    insert into public.tickets (id, user_id, type, title, amount, issued_by) values
      (%1$L, 'c1i-user', 'discount', 'C1', 500, 't'), (%2$L, 'c1i-user', 'discount', 'C1', 500, 't'),
      (%3$L, 'c1i-user', 'discount', 'C1', 500, 't'), (%4$L, 'c1i-user', 'discount', 'C1', 500, 't');
    insert into public.ticket_issue_logs (id, staff_name, customer_name, user_id, ticket_type, amount, quantity, terminal, status, idempotency_key, request_hash, ticket_ids) values
      (%5$L, 't', '', 'c1i-user', 'discount', 500, 2, 'staff-terminal', 'issued', %7$L, %9$L, array[%1$L, %2$L]::uuid[]),
      (%6$L, 't', '', 'c1i-user', 'discount', 500, 2, 'staff-terminal', 'issued', %8$L, %9$L, array[%3$L, %4$L]::uuid[]);
    insert into public.accounting_sessions (id, customer_name, staff_name, payment_method, status, subtotal, discount_total, total, idempotency_key, completed_at)
      values (%10$L, 't', 't', 'ginpay', 'completed', 900, 0, 900, %12$L, now());
    insert into public.ginpay_transactions (id, account_id, client_id, amount, type, status, accounting_session_id, operator_type, idempotency_key)
      values (%11$L, gen_random_uuid(), gen_random_uuid(), -900, 'payment', 'posted', %10$L, 'staff', 'sale:' || %12$L);
    set session_replication_role = origin;
  $f$, ta, tb, tc, td, l, l2, k1, k3, 'AUTH1.' || repeat('e', 64), s, t, ks));

  -- 8. キー K1 と効果 ID L を同時に：1つの操作
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', format('select app_private.pos_op_discover_legacy(%L, %L, %L)', 'key', 'ticket_issue', k1));
  perform pg_temp.send('b', format('select app_private.pos_op_discover_legacy(%L, %L, %L)', 'effect', 'ticket_issue', l));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'discovered' and rb ->> 'result' = 'existing' and rb ->> 'operation_id' = ra ->> 'operation_id'
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_effects where effect_domain = %L and effect_identity = %L', 'ticket_issue', l)))::int = 1,
    '8 key vs effect-id concurrent discovery: one operation, one effect');

  -- 8. K1（コミット前）と、途中で改名された K2：同じ効果 → 同じ操作、K2 は別名
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', format('select app_private.pos_op_discover_legacy(%L, %L, %L)', 'key', 'ticket_issue', k3));
  perform pg_temp.x('c', format('update public.ticket_issue_logs set idempotency_key = %L where id = %L', k2, l2));
  perform pg_temp.send('b', format('select app_private.pos_op_discover_legacy(%L, %L, %L)', 'key', 'ticket_issue', k2));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'discovered' and rb ->> 'result' = 'enriched' and rb ->> 'operation_id' = ra ->> 'operation_id'
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_keys where operation_id = %L', ra ->> 'operation_id')))::int = 2
    and (pg_temp.q('m', format('select to_jsonb(count(*)) from app_private.pos_operation_effects where operation_id = %L', ra ->> 'operation_id')))::int = 1,
    '8 concurrent K1/K2 (renamed mid-flight) converge: one operation, two aliases, no orphan');

  -- 9. 会計のキーと支払いの効果 ID を同時に：1つの操作に会計と支払い
  perform pg_temp.x('a', 'begin');
  ra := pg_temp.q('a', format('select app_private.pos_op_discover_legacy(%L, %L, %L)', 'key', 'acct_sale', ks));
  perform pg_temp.send('b', format('select app_private.pos_op_discover_legacy(%L, %L, %L)', 'effect', 'ginpay_transaction', t));
  v_blocked := pg_temp.blocked('b');
  perform pg_temp.x('a', 'commit');
  rb := pg_temp.fetch('b');
  perform pg_temp.ok(v_blocked and ra ->> 'result' = 'discovered' and rb ->> 'result' = 'existing' and rb ->> 'operation_id' = ra ->> 'operation_id'
    and (pg_temp.q('m', format('select to_jsonb(count(distinct operation_id)) from app_private.pos_operation_effects where effect_identity in (%L, %L)', s, t)))::int = 1,
    '9 sale key vs payment effect-id concurrent discovery: one operation owns both');
end $$;

-- ── 10. 派生キーからの fence と、入口のキーからの claim（M3：以前は 40P01 のデッドロックになった並び） ──
-- 入口のキー E の lock id が派生キー D より小さくなるキーを選ぶ（claim は E → D の順に取る）。
-- c が E を押さえておき、その間に b（claim）と a（fence via D）を送ってから c を離す。
-- 以前の fence は D を先に取ってから E を待つので、b（E を持って D を待つ）と輪になった。今は fence も E → D の順に一式を取る
create function pg_temp.pick_checkout_key() returns text language plpgsql as $$
declare
  k text;
begin
  loop
    k := 'checkout:' || gen_random_uuid();
    exit when app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k)) < app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k));
  end loop;
  return k;
end $$;
create function pg_temp.gate_sql(p_key text) returns text language sql as $$
  select format('select to_jsonb(true) from (select pg_advisory_xact_lock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem(%L, %L)))) x', 'acct_sale', p_key) $$;

do $$
declare
  k text := pg_temp.pick_checkout_key();
  t text := 'client:' || gen_random_uuid();
  p jsonb; ra jsonb; rb jsonb; s jsonb; v_blocked_b boolean; v_blocked_a boolean;
begin
  p := pg_temp.q('m', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), k, 0));
  -- claim が先に E で待ち、fence（派生キー）が後から来る
  perform pg_temp.x('c', 'begin');
  perform pg_temp.q('c', pg_temp.gate_sql(k));
  perform pg_temp.send('b', pg_temp.claim_sql((p ->> 'instruction_id')::uuid, array[t]));
  v_blocked_b := pg_temp.blocked('b');
  perform pg_temp.send('a', format('select app_private.pos_op_fence_key(%L, %L, %L)', 'ginpay_tx', 'sale:' || k, 'race'));
  v_blocked_a := pg_temp.blocked('a');
  perform pg_temp.x('c', 'commit');
  rb := pg_temp.fetch_safe('b');
  ra := pg_temp.fetch_safe('a');
  s := pg_temp.q('m', format('select app_private.pos_op_status_by_operation(%L)', p ->> 'operation_id'));
  perform pg_temp.ok(v_blocked_b and v_blocked_a and not (ra ? 'remote_error') and not (rb ? 'remote_error'),
    '10 claim(entry) waiting, then fence(derived): no 40P01 deadlock (a=' || ra::text || ' b=' || rb::text || ')');
  perform pg_temp.ok(rb ->> 'result' = 'claimed' and ra ->> 'result' = 'abandoned'
    and s ->> 'status' = 'abandoned' and jsonb_array_length(s -> 'active_targets') = 0 and s -> 'required_targets' = jsonb_build_array(t)
    and (pg_temp.q('m', format('select app_private.pos_op_status_by_slot(%L)', p ->> 'slot_key')) ->> 'active_instruction_id') is null,
    '10 claim then fence: claim wins first, fence then abandons; targets released, slot cleared, no partial state');

  -- 逆の到着順：fence（派生キー）が先に待ち、claim が後
  k := pg_temp.pick_checkout_key();
  p := pg_temp.q('m', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), k, 0));
  perform pg_temp.x('c', 'begin');
  perform pg_temp.q('c', pg_temp.gate_sql(k));
  perform pg_temp.send('a', format('select app_private.pos_op_fence_key(%L, %L, %L)', 'ginpay_tx', 'sale:' || k, 'race'));
  v_blocked_a := pg_temp.blocked('a');
  perform pg_temp.send('b', pg_temp.claim_sql((p ->> 'instruction_id')::uuid, array['client:' || gen_random_uuid()]));
  v_blocked_b := pg_temp.blocked('b');
  perform pg_temp.x('c', 'commit');
  ra := pg_temp.fetch_safe('a');
  rb := pg_temp.fetch_safe('b');
  s := pg_temp.q('m', format('select app_private.pos_op_status_by_operation(%L)', p ->> 'operation_id'));
  perform pg_temp.ok(v_blocked_a and v_blocked_b and not (ra ? 'remote_error') and not (rb ? 'remote_error')
    and ra ->> 'result' = 'abandoned' and rb ->> 'error' = 'operation_terminal'
    and s ->> 'status' = 'abandoned' and jsonb_array_length(s -> 'required_targets') = 0 and jsonb_array_length(s -> 'active_targets') = 0,
    '10 reverse arrival (fence first): fence abandons, claim refused, no deadlock, no partial state');
end $$;

-- ── 11. 本当の COMMIT で不変条件が止める（別のセッションで直接書いて COMMIT） ──
do $$
declare
  p jsonb; q jsonb; v_msg text;
  ka text := 'client:' || gen_random_uuid(); kb text := 'reservation:' || gen_random_uuid();
begin
  p := pg_temp.q('m', pg_temp.prep_sql(gen_random_uuid(), 'checkout_client', jsonb_build_object('client_id', gen_random_uuid()::text), 'checkout:' || gen_random_uuid(), 0));
  v_msg := pg_temp.remote_commit_err('a', array[format('update app_private.pos_operations set status = %L where operation_id = %L', 'claimed', p ->> 'operation_id')]);
  perform pg_temp.ok(v_msg like '%pos_invariant_required_targets_missing%', '11 COMMIT of prepared->claimed with zero required targets fails (' || coalesce(v_msg, 'no error') || ')');
  v_msg := pg_temp.remote_commit_err('a', array[
    format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L), (%L, %L)', p ->> 'operation_id', ka, p ->> 'operation_id', kb),
    format('update app_private.pos_operations set status = %L where operation_id = %L', 'claimed', p ->> 'operation_id'),
    format('insert into app_private.pos_operation_targets (operation_id, target_key) values (%L, %L)', p ->> 'operation_id', ka)]);
  perform pg_temp.ok(v_msg like '%pos_invariant_claimed_targets%', '11 COMMIT of claimed with a missing required target fails (' || coalesce(v_msg, 'no error') || ')');
  v_msg := pg_temp.remote_commit_err('a', array[
    format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L)', p ->> 'operation_id', ka)]);
  perform pg_temp.ok(v_msg like '%pos_invariant_unclaimed_targets%', '11 COMMIT of required rows on a prepared operation fails (' || coalesce(v_msg, 'no error') || ')');
  perform pg_temp.ok(pg_temp.q('m', format('select app_private.pos_op_status_by_operation(%L)', p ->> 'operation_id')) ->> 'status' = 'prepared'
    and jsonb_array_length(pg_temp.q('m', format('select app_private.pos_op_status_by_operation(%L)', p ->> 'operation_id')) -> 'required_targets') = 0,
    '11 failed commits left the operation prepared with no required targets');
end $$;

do $$ begin perform extensions.dblink_disconnect(c) from unnest(extensions.dblink_get_connections()) c; end $$;
drop extension dblink;

do $$
begin
  raise warning 'POS B-2C-1 interleaving checks passed: %', (select count(*) from c1i_results);
end $$;
