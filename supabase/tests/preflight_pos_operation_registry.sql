-- ============================================================================
-- GINJIRO POS B-2C-1: 操作レジストリ（1セッションの検証）(preflight_pos_operation_registry.sql)
--
-- 使い捨てのローカル DB 専用（staging-preflight.mjs の pos-operation-registry 段）。本番・Staging・本番コピーでは実行しない。
-- 旧データの分類のために、会計・GINPay・チケットの表へテスト用の行を直接入れる（トリガーを止めて入れる）。
-- 登録簿の表は削除できない設計なので、実行のたびに新しい ID を使う。
--
-- A キーの範囲 / B 依頼 / C 枠の版 / D 資源 / E 取り消しの印 / F 旧データの分類 / G 効果（E1）/ H 読み取り専用 / I 不変条件 / J 権限
-- K〜M 監査の指摘の再発防止 / N キーは digest で持つ（CG1） / O 物理の照会も btrim の同値類（CG2） / P 逆向きの fence も親を確かめる（CG2-R1） / Q 前向きの fence も sale:K を確かめる（CG2-R2） / R 負けたキーも sale:K を確かめる（CG2-R3） / T 負けたキーの印は PREPARE の衝突の分岐の中だけ（CG2-R4/R5） / U 依頼の参照と予約されたコードは表の境界で守る（G1/G2）
-- 2つのセッションの順序を決めた検証は preflight_pos_operation_interleave.sql、同時実行は pos_operation_concurrency_*.sql
-- ============================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;

create temp table c1_results (n serial, label text not null);
create temp table c1_vars (k text primary key, v text);

create function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'C1 FAIL: %', p_label; end if;
  insert into c1_results (label) values (p_label);
end $$;

-- p_sql を実行して、エラー文言が p_like に合うこと（成功したら失敗扱い）
create function pg_temp.err(p_sql text, p_like text, p_label text) returns void language plpgsql as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  perform pg_temp.ok(v_msg is not null and v_msg like p_like, p_label || ' (' || coalesce(v_msg, 'no error') || ')');
end $$;

create function pg_temp.setv(p_k text, p_v text) returns void language sql as $$
  insert into c1_vars (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.getv(p_k text) returns text language sql as $$ select v from c1_vars where k = p_k $$;
create function pg_temp.u() returns text language sql as $$ select gen_random_uuid()::text $$;
-- 送ったキーをテスト側で覚えておく（台帳はキーの文字列を持たないので、あとで台帳から読み戻せない）
create function pg_temp.keep(p_k text, p_v text) returns text language sql as $$ select pg_temp.setv(p_k, p_v); select p_v $$;

-- 登録簿の表の件数（何も書かれていないことの確認用）
create function pg_temp.registry_counts() returns text language sql as $$
  select concat_ws(',',
    (select count(*) from app_private.pos_operations), (select count(*) from app_private.pos_operation_keys),
    (select count(*) from app_private.pos_business_instructions), (select count(*) from app_private.pos_business_slots),
    (select count(*) from app_private.pos_operation_targets), (select count(*) from app_private.pos_operation_effects),
    (select count(*) from app_private.pos_operation_events), (select count(*) from app_private.pos_operation_required_targets),
    (select coalesce(sum(slot_epoch), 0) from app_private.pos_business_slots),
    (select count(*) from app_private.pos_operation_targets where active)) $$;

-- ── テスト用の旧データ（トリガーを止めて直接入れる。外部キーも止まる） ──
create function pg_temp.fx_sale(
  p_status text, p_method text, p_total integer, p_key text,
  p_completed boolean default true, p_voided boolean default false, p_void_key text default null, p_void_hash text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.accounting_sessions (id, customer_name, staff_name, payment_method, status, subtotal, discount_total, total,
    idempotency_key, completed_at, voided_at, void_idempotency_key, void_request_hash, used_ticket_ids)
  values (v_id, 'テスト', 'テスト', p_method, p_status, p_total, 0, p_total, p_key,
    case when p_completed then now() end, case when p_voided then now() end, p_void_key, p_void_hash, null);
  perform set_config('session_replication_role', 'origin', true);
  return v_id;
end $$;

create function pg_temp.fx_gp(
  p_type text, p_status text, p_amount integer, p_key text, p_sale uuid default null, p_orig uuid default null,
  p_account uuid default null
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.ginpay_transactions (id, account_id, client_id, amount, type, status, accounting_session_id,
    stripe_payment_intent_id, operator_type, idempotency_key, original_transaction_id)
  values (v_id, coalesce(p_account, gen_random_uuid()), gen_random_uuid(), p_amount, p_type, p_status, p_sale,
    case when p_type = 'charge_stripe' then 'pi_' || replace(gen_random_uuid()::text, '-', '') end,
    case when p_type = 'charge_stripe' then 'stripe' else 'staff' end, p_key, p_orig);
  perform set_config('session_replication_role', 'origin', true);
  return v_id;
end $$;

create function pg_temp.fx_ticket_issue(
  p_qty integer, p_type text, p_amount integer, p_key text,
  p_hash text default 'AUTH1.' || repeat('a', 64), p_tickets integer default null, p_user text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_user text := coalesce(p_user, 'c1-user-' || gen_random_uuid()::text);
  v_ids uuid[];
begin
  perform set_config('session_replication_role', 'replica', true);
  with ins as (
    insert into public.tickets (user_id, type, title, amount, issued_by, used)
    select v_user, p_type, 'C1テスト', p_amount, 'テスト', false from generate_series(1, coalesce(p_tickets, p_qty))
    returning id
  ) select array_agg(id) into v_ids from ins;
  insert into public.ticket_issue_logs (id, staff_name, customer_name, user_id, ticket_type, amount, quantity, terminal, status,
    idempotency_key, request_hash, ticket_ids)
  values (v_id, 'テスト', '', v_user, p_type, p_amount, p_qty, 'staff-terminal', 'issued', p_key, p_hash, v_ids);
  perform set_config('session_replication_role', 'origin', true);
  return v_id;
end $$;

-- 依頼の短縮形
create function pg_temp.prep(p_inst text, p_kind text, p_facts jsonb, p_key text, p_epoch bigint, p_lane text default null)
returns jsonb language sql as $$
  select app_private.pos_op_prepare(p_inst::uuid, p_kind, p_facts, p_key, p_epoch, p_lane, 'test', 'C1テスト') $$;
create function pg_temp.slot(p_slot text) returns jsonb language sql as $$ select app_private.pos_op_status_by_slot(p_slot) $$;

-- 旧データの代表の結果（許可リストどおりの形）
create function pg_temp.legacy_result(p_kind text) returns jsonb language sql as $$
  select jsonb_build_object('representative_only', true, 'kind', p_kind, 'classifier_version', 'c1-legacy-v1',
    'initial_effects', '[]'::jsonb, 'headline', '{}'::jsonb) $$;

-- コミット時の検査：p_sqls を実行してから遅延の不変条件をその場で走らせ（SET CONSTRAINTS ALL IMMEDIATE = COMMIT と同じ検査）、
-- エラー文言が p_like に合うこと。p_disable（'表|トリガー'）は止めてから実行する（行ごとのガードの裏で、遅延の検査や CHECK が
-- 単独で効くことを見る）。どの場合も最後に例外で戻すので、止めたトリガーも書いた行も残らない
create function pg_temp.err_commit(p_sqls text[], p_like text, p_label text, p_disable text[] default '{}') returns void language plpgsql as $$
declare
  v_msg text;
  v_s text;
begin
  begin
    foreach v_s in array p_disable loop
      execute format('alter table %s disable trigger %I', split_part(v_s, '|', 1), split_part(v_s, '|', 2));
    end loop;
    foreach v_s in array p_sqls loop
      execute v_s;
    end loop;
    set constraints all immediate;
    raise exception 'C1 no error at commit';
  exception when others then
    v_msg := sqlerrm;
  end;
  set constraints all deferred;
  perform pg_temp.ok(v_msg like p_like, p_label || ' (' || coalesce(v_msg, 'no error') || ')');
end $$;

-- 効果を直接入れる SQL
create function pg_temp.eff_sql(p_domain text, p_id uuid, p_op uuid, p_kind text, p_pd text, p_pi uuid, p_snap jsonb) returns text language sql as $$
  select format('insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, parent_domain, parent_identity, '
    || 'snapshot, snapshot_hash, classifier_version, registered_via) values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    p_domain, p_id, p_op, p_kind, p_pd, p_pi, p_snap, app_private.pos_op_hash('LEG1', p_snap), 'c1-legacy-v1', 'discovery_effect') $$;

create function pg_temp.gp_snap(p_id uuid) returns jsonb language sql as $$
  select app_private.pos_op_ginpay_snapshot(g) from public.ginpay_transactions g where g.id = p_id $$;

-- ════════════════════════════════════════════════════════════════════════════
-- A. キーの範囲
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  r jsonb;
  v_raw text := 'c1-same-raw-' || pg_temp.u();
  v_fb text := 'checkout:' || (extract(epoch from now()) * 1000)::bigint || '-c1fallback' || substr(md5(random()::text), 1, 8);
  v_k text := 'checkout:' || pg_temp.u();
  v_charge text := 'staff-refund:' || pg_temp.u();
begin
  perform pg_temp.ok(app_private.pos_op_key_normalize('acct_sale', '  checkout:X  ') = 'checkout:X', 'A D1 btrim');
  perform pg_temp.ok(app_private.pos_op_key_normalize('ginpay_tx', '  staff-refund:X ') = 'staff-refund:X', 'A D3 btrim');
  -- PostgreSQL の btrim と同じ（空白だけを除く。タブなど別の文字は除かない）
  perform pg_temp.ok(app_private.pos_op_key_normalize('ginpay_tx', E' staff-refund:X\t') = btrim(E' staff-refund:X\t')
    and app_private.pos_op_key_normalize('ginpay_tx', E' staff-refund:X\t') = E'staff-refund:X\t', 'A D3 exactly btrim-compatible (no alternate trim)');
  perform pg_temp.ok(app_private.pos_op_key_normalize('acct_void', ' v:X ') = ' v:X ', 'A D2 raw exact');
  perform pg_temp.ok(app_private.pos_op_key_normalize('ticket_issue', ' t:X ') = ' t:X ', 'A D4 raw exact');
  perform pg_temp.ok(app_private.pos_op_key_normalize('acct_sale', 'Checkout:ABC') = 'Checkout:ABC', 'A no lowercase conversion');
  perform pg_temp.ok(app_private.pos_op_key_normalize('ticket_issue', '   ') is null and app_private.pos_op_key_normalize('acct_sale', '') is null, 'A empty keys are not keys');
  perform pg_temp.ok(app_private.pos_op_key_normalize('stripe', 'x') is null, 'A unknown domain rejected');

  -- D1 は btrim した形で結ぶ / D4 は送られたまま
  r := app_private.pos_op_fence_key('acct_sale', '   ' || v_k || '  ', 'test');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned', 'A D1 fence with surrounding spaces');
  perform pg_temp.ok((app_private.pos_op_status_by_key('acct_sale', v_k) ->> 'bound')::boolean, 'A D1 binding stored in btrim form');
  perform pg_temp.ok((app_private.pos_op_status_by_key('ginpay_tx', 'sale:' || v_k) ->> 'bound')::boolean, 'A D1 fence also fences derived sale:<key>');
  r := app_private.pos_op_fence_key('ticket_issue', ' ' || v_raw || ' ', 'test');
  perform pg_temp.ok((app_private.pos_op_status_by_key('ticket_issue', ' ' || v_raw || ' ') ->> 'bound')::boolean
    and not (app_private.pos_op_status_by_key('ticket_issue', v_raw) ->> 'bound')::boolean, 'A D4 raw form kept distinct');

  -- 同じ文字列でも範囲が違えば別のキー
  r := app_private.pos_op_fence_key('acct_void', v_raw, 'test');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned', 'A cross-domain same raw (D2)');
  r := app_private.pos_op_fence_key('ticket_issue', v_raw, 'test');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned'
    and (app_private.pos_op_status_by_key('acct_void', v_raw) #>> '{operation,operation_id}')
        <> (app_private.pos_op_status_by_key('ticket_issue', v_raw) #>> '{operation,operation_id}'), 'A cross-domain same raw (D4) separate operation');

  -- D3 は種類に関係なく1つの範囲：返金のキーに印を付けたら、どの経路でも同じ印
  r := app_private.pos_op_fence_key('ginpay_tx', v_charge, 'test');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned', 'A D3 fence refund key');
  r := app_private.pos_op_fence_key('ginpay_tx', v_charge, 'again');
  perform pg_temp.ok(r ->> 'result' = 'already_terminal' and r ->> 'operation_id' = (app_private.pos_op_status_by_key('ginpay_tx', v_charge) #>> '{operation,operation_id}'),
    'A D3 same key resolves to same operation');
  perform pg_temp.err(format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, app_private.pos_op_key_ident(%1$L, %L), %L, %L)',
    'ginpay_tx', v_charge, r ->> 'operation_id', 'fence'), '%duplicate key%', 'A D3 global uniqueness (no second binding)');

  -- 以前の形式（UUID でない）のキーも印を付けられる
  r := app_private.pos_op_fence_key('acct_sale', v_fb, 'fallback');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned', 'A fallback legacy key format');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- B. 依頼（同じ ID・違うキー・違う事実・物理の衝突）
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_acct text := pg_temp.u();
  v_i text := pg_temp.u();
  v_i2 text := pg_temp.u();
  v_k1 text := 'staff-store-charge:' || pg_temp.u();
  v_k2 text := 'staff-store-charge:' || pg_temp.u();
  v_k3 text := 'staff-store-charge:' || pg_temp.u();
  v_facts jsonb;
  r jsonb;
  v_before text;
  v_res uuid := gen_random_uuid();
begin
  v_facts := jsonb_build_object('account_id', v_acct, 'amount', 3000);
  r := pg_temp.prep(v_i, 'ginpay_charge', v_facts, v_k1, 0);
  perform pg_temp.ok(r ->> 'result' = 'prepared' and (r ->> 'installed_epoch')::int = 1, 'B accept new instruction');
  perform pg_temp.setv('b_op', r ->> 'operation_id');

  r := pg_temp.prep(v_i, 'ginpay_charge', v_facts, v_k1, 0);
  perform pg_temp.ok(r ->> 'result' = 'existing' and r ->> 'operation_id' = pg_temp.getv('b_op'), 'B same I + same key = same result');

  r := pg_temp.prep(v_i, 'ginpay_charge', jsonb_build_object('account_id', v_acct, 'amount', 3001), v_k1, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'already_bound', 'B same I + different facts = conflict');

  r := pg_temp.prep(v_i, 'ginpay_charge', v_facts, v_k1, 5);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict', 'B same I + different observed epoch = conflict');

  -- 違うキー：負けたキーは取り消しの印になり、遅れて来ても復活しない
  r := pg_temp.prep(v_i, 'ginpay_charge', v_facts, v_k2, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'tombstoned', 'B same I + K2 = conflict, K2 tombstoned');
  perform pg_temp.ok(app_private.pos_op_status_by_key('ginpay_tx', v_k2) #>> '{operation,origin}' = 'conflict_tombstone'
    and app_private.pos_op_status_by_key('ginpay_tx', v_k2) ->> 'key_role' = 'fence', 'B losing key bound to conflict tombstone');
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(v_i, 'ginpay_charge', v_facts, v_k2, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'already_bound'
    and pg_temp.registry_counts() = v_before, 'B losing K2 retried later stays dead, no new rows');
  r := pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts, v_k2, 1);
  perform pg_temp.ok(r ->> 'error' = 'key_conflict' and r ->> 'key_role' = 'fence', 'B losing K2 cannot be revived by another instruction');

  -- 違う依頼・同じキー：key_conflict、依頼は記録しない
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(v_i2, 'ginpay_charge', v_facts, v_k1, 1);
  perform pg_temp.ok(r ->> 'error' = 'key_conflict' and r ->> 'operation_id' = pg_temp.getv('b_op') and pg_temp.registry_counts() = v_before
    and (app_private.pos_op_status_by_instruction(v_i2::uuid) ->> 'found') = 'false', 'B different I + same key = key_conflict, no writes');

  -- 物理の衝突：既存の GINPay 取引に同じキー → 何も書かない
  perform pg_temp.fx_gp('charge_store', 'posted', 1000, v_k3);
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 1000), v_k3, 0);
  perform pg_temp.ok(r ->> 'error' = 'legacy_key_present' and pg_temp.registry_counts() = v_before, 'B physical key collision: no writes');
  -- 負けたキーが物理にある：印は作らない
  r := pg_temp.prep(v_i, 'ginpay_charge', v_facts, v_k3, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present'
    and not (app_private.pos_op_status_by_key('ginpay_tx', v_k3) ->> 'bound')::boolean, 'B losing key with physical row is not tombstoned');

  -- 会計の派生キー sale:<key> がすでに GINPay にある（乗っ取られた）→ 受けない
  v_k1 := 'checkout:' || pg_temp.u();
  perform pg_temp.fx_gp('charge_store', 'posted', 500, 'sale:' || v_k1);
  r := pg_temp.prep(pg_temp.u(), 'checkout_reservation', jsonb_build_object('reservation_id', pg_temp.u()), v_k1, 0);
  perform pg_temp.ok(r ->> 'error' = 'legacy_key_present' and r ->> 'key_domain' = 'ginpay_tx', 'B derived sale:<key> already physically used');

  -- 形式・事実の検証（DB に書かない）
  v_before := pg_temp.registry_counts();
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts, ' ' || v_k2, 0) ->> 'error' = 'invalid_key', 'B key with spaces rejected');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts, upper(v_k2), 0) ->> 'error' = 'invalid_key', 'B uppercase key rejected');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts, 'staff-refund:' || pg_temp.u(), 0) ->> 'error' = 'invalid_key', 'B wrong prefix for kind rejected');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts, 'sale:checkout:' || pg_temp.u(), 0) ->> 'error' = 'invalid_key', 'B reserved sale: namespace cannot be an entry');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts || '{"pin":"1234"}', 'staff-store-charge:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts',
    'B secret-like fact (pin) rejected by allow-list');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', v_facts || '{"approval_token":"APR1.x"}', 'staff-store-charge:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts',
    'B approval token rejected by allow-list');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u(), 'ticket_ids',
      jsonb_build_array('ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000000')), 'checkout:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts',
    'B unsorted ticket ids rejected (canonical facts)');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', v_acct, 'amount', 1.5), 'staff-store-charge:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts',
    'B non-integer amount rejected');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'checkout_anonymous', '{}'::jsonb, 'checkout:' || pg_temp.u(), 0) ->> 'error' = 'invalid_request',
    'B anonymous checkout requires a lane');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'B validation failures write nothing');

  -- 依頼は書き換えられない
  perform pg_temp.err(format('update app_private.pos_business_instructions set facts = %L where instruction_id = %L', '{}', v_i), '%pos_registry_immutable%', 'B instruction update blocked');
  perform pg_temp.err(format('delete from app_private.pos_business_instructions where instruction_id = %L', v_i), '%pos_registry_immutable%', 'B instruction delete blocked');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- C. 枠の版（遅れて届いた PREPARE・正確な再送・終了の再送）
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_acct text := pg_temp.u();
  v_slot text := 'ginpay:account:' || v_acct;
  f jsonb := jsonb_build_object('account_id', v_acct, 'amount', 1000);
  a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; g jsonb; h jsonb; j jsonb; r jsonb;
  v_ia text := pg_temp.u(); v_ka text := 'staff-store-charge:' || pg_temp.u();
  v_ib text := pg_temp.u(); v_kb text := 'staff-store-charge:' || pg_temp.u();
  v_before text;
  v_slots bigint;
begin
  a := pg_temp.prep(v_ia, 'ginpay_charge', f, v_ka, 0);
  perform pg_temp.ok(a ->> 'result' = 'prepared' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 1
    and pg_temp.slot(v_slot) ->> 'active_instruction_id' = v_ia, 'C accepted PREPARE: empty -> I, epoch +1');

  -- A が受理されたあとに、epoch 0 を見ていた B が届く
  b := pg_temp.prep(v_ib, 'ginpay_charge', f, v_kb, 0);
  perform pg_temp.ok(b ->> 'error' = 'stale_epoch' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 1
    and pg_temp.slot(v_slot) ->> 'active_instruction_id' = v_ia, 'C delayed PREPARE (B wins race) -> stale_epoch, slot unchanged');
  perform pg_temp.ok(app_private.pos_op_status_by_key('ginpay_tx', v_kb) #>> '{operation,origin}' = 'stale_prepare'
    and app_private.pos_op_status_by_instruction(v_ib::uuid) ->> 'disposition' = 'refused', 'C stale key tombstoned, instruction recorded refused');

  -- A が進行中に epoch 1 を見て送る → slot_busy
  c := pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, pg_temp.keep('c_busy_key', 'staff-store-charge:' || pg_temp.u()), 1);
  perform pg_temp.ok(c ->> 'error' = 'slot_busy' and app_private.pos_op_status_by_key('ginpay_tx', pg_temp.getv('c_busy_key')) #>> '{operation,origin}' = 'busy_prepare',
    'C PREPARE while active -> slot_busy, key tombstoned');

  -- CLAIM は版を変えない
  -- 書き込みと確認は別の文にする（STABLE の照会は文の開始時点のスナップショットを見るため）
  r := app_private.pos_op_claim(v_ia::uuid, array['gpaccount:' || v_acct]);
  perform pg_temp.ok(r ->> 'result' = 'claimed' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 1, 'C CLAIM keeps epoch');
  -- 完了：空にして +1。もう一度終えても変わらない
  r := app_private.pos_op_finish((a ->> 'operation_id')::uuid, 'completed', null, jsonb_build_object('transaction_id', pg_temp.u(), 'amount', 1000, 'balance_after', 0));
  perform pg_temp.ok(r ->> 'result' = 'completed'
    and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 2 and pg_temp.slot(v_slot) ->> 'active_instruction_id' is null, 'C completed: I -> empty, epoch +1');
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_finish((a ->> 'operation_id')::uuid, 'completed');
  perform pg_temp.ok(r ->> 'result' = 'already_terminal' and pg_temp.registry_counts() = v_before, 'C terminal replay: no second epoch advance, no writes');
  r := app_private.pos_op_finish((a ->> 'operation_id')::uuid, 'abandoned');
  perform pg_temp.ok(r ->> 'result' = 'already_terminal' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 2
    and app_private.pos_op_status_by_operation((a ->> 'operation_id')::uuid) ->> 'status' = 'completed', 'C terminal cannot be replaced');

  -- A が進行中に epoch 1 を見ていた D が、A の完了後に届く
  d := pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 1);
  perform pg_temp.ok(d ->> 'error' = 'stale_epoch', 'C delayed PREPARE after completion -> stale_epoch');

  -- 正確な再送は版が進んでいても同じ結果
  a := pg_temp.prep(v_ia, 'ginpay_charge', f, v_ka, 0);
  perform pg_temp.ok(a ->> 'result' = 'existing' and a ->> 'status' = 'completed', 'C exact retry of old instruction after epoch advance returns same instruction');
  b := pg_temp.prep(v_ib, 'ginpay_charge', f, v_kb, 0);
  perform pg_temp.ok(b ->> 'error' = 'stale_epoch' and (b ->> 'replay')::boolean, 'C exact retry of refused instruction returns same refusal');

  -- 新しい人の操作：今の版を読んで、新しい ID・キーで
  e := pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 2);
  perform pg_temp.ok(e ->> 'result' = 'prepared' and (e ->> 'installed_epoch')::int = 3, 'C fresh attempt with fresh epoch succeeds');
  -- 却下（claimed → rejected）でも枠は空になり +1、古い観察は stale
  perform app_private.pos_op_claim((e ->> 'instruction_id')::uuid, array['gpaccount:' || v_acct]);
  r := app_private.pos_op_finish((e ->> 'operation_id')::uuid, 'rejected', 'insufficient_balance');
  perform pg_temp.ok(r ->> 'result' = 'rejected' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 4, 'C rejected: I -> empty, epoch +1');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 3) ->> 'error' = 'stale_epoch',
    'C delayed PREPARE after rejection -> stale_epoch');
  -- prepared から rejected へは行けない
  g := pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 4);
  perform pg_temp.ok(app_private.pos_op_finish((g ->> 'operation_id')::uuid, 'rejected') ->> 'error' = 'invalid_transition'
    and app_private.pos_op_finish((g ->> 'operation_id')::uuid, 'completed') ->> 'error' = 'invalid_transition', 'C prepared -> rejected/completed not allowed');
  -- 取り消し（prepared → abandoned）
  r := app_private.pos_op_finish((g ->> 'operation_id')::uuid, 'abandoned', 'staff_cancelled');
  perform pg_temp.ok(r ->> 'result' = 'abandoned' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 6, 'C abandoned: I -> empty, epoch +1');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 5) ->> 'error' = 'stale_epoch',
    'C delayed PREPARE after abandon -> stale_epoch');

  -- 古い操作は新しい依頼の active を消せない
  h := pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 6);
  r := app_private.pos_op_finish((g ->> 'operation_id')::uuid, 'abandoned');
  perform pg_temp.ok(r ->> 'result' = 'already_terminal'
    and pg_temp.slot(v_slot) ->> 'active_instruction_id' = h ->> 'instruction_id' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 7,
    'C old terminal operation cannot clear newer pointer');
  perform pg_temp.err(format('update app_private.pos_business_slots set slot_epoch = slot_epoch + 1, active_instruction_id = null where slot_key = %L', v_slot),
    '%pos_slot_pointer_clear_requires_terminal%', 'C pointer cannot be cleared while its operation is unresolved');

  -- 枠の fence：進行中なら abandoned、空なら版だけ +1
  r := app_private.pos_op_fence_slot(v_slot, 'test');
  perform pg_temp.ok(r ->> 'result' = 'abandoned'
    and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 8 and pg_temp.slot(v_slot) ->> 'active_instruction_id' is null, 'C slot fence abandons active');
  r := app_private.pos_op_fence_slot(v_slot, 'test');
  perform pg_temp.ok(r ->> 'result' = 'slot_fenced' and (pg_temp.slot(v_slot) ->> 'slot_epoch')::int = 9, 'C empty slot fence: empty -> empty, epoch +1');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', f, 'staff-store-charge:' || pg_temp.u(), 8) ->> 'error' = 'stale_epoch',
    'C PREPARE observed before lane fence is stale');

  -- 枠の分からないキーだけの印は枠を触らない
  v_slots := (select count(*) + coalesce(sum(slot_epoch), 0) from app_private.pos_business_slots);
  perform app_private.pos_op_fence_key('ginpay_tx', 'staff-store-charge:' || pg_temp.u(), 'test');
  perform pg_temp.ok((select count(*) + coalesce(sum(slot_epoch), 0) from app_private.pos_business_slots) = v_slots, 'C key-only tombstone touches no slot');

  -- 匿名の会計はレーンごと
  j := pg_temp.prep(pg_temp.u(), 'checkout_anonymous', '{"method":"cash","total":1200}', 'checkout:' || pg_temp.u(), 0, pg_temp.u());
  perform pg_temp.ok(j ->> 'result' = 'prepared' and j ->> 'slot_key' like 'checkout:lane:%', 'C anonymous checkout uses the lane slot');
  -- 履歴は枠が空になっても見える
  perform pg_temp.ok(jsonb_array_length(pg_temp.slot(v_slot) -> 'instructions') >= 8, 'C historical instructions remain discoverable after pointer clear');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- D. 資源（target）
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  t1 text := 'gpaccount:' || pg_temp.u();
  t2 text := 'reservation:' || pg_temp.u();
  t3 text := 'client:' || pg_temp.u();
  x jsonb; y jsonb; z jsonb; r jsonb;
  v_before text;
begin
  x := pg_temp.prep(pg_temp.u(), 'checkout_reservation', jsonb_build_object('reservation_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0);
  y := pg_temp.prep(pg_temp.u(), 'checkout_reservation', jsonb_build_object('reservation_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0);
  r := app_private.pos_op_claim((x ->> 'instruction_id')::uuid, array[t2, t1]);
  perform pg_temp.ok(r ->> 'result' = 'claimed' and r -> 'targets' = to_jsonb(array(select unnest(array[t1, t2]) order by 1)), 'D claim stores sorted target set');
  perform pg_temp.ok(app_private.pos_op_claim((x ->> 'instruction_id')::uuid, array[t1, t2]) ->> 'result' = 'already_claimed', 'D claim retry with same set is idempotent');
  perform pg_temp.ok(app_private.pos_op_claim((x ->> 'instruction_id')::uuid, array[t1]) ->> 'error' = 'claim_conflict', 'D claim retry with different set conflicts');

  -- 重なる資源：全体を戻す（重ならない t3 も入らない、状態は prepared のまま）
  r := app_private.pos_op_claim((y ->> 'instruction_id')::uuid, array[t3, t1]);
  perform pg_temp.ok(r ->> 'error' = 'target_busy' and r ->> 'blocking_operation_id' = x ->> 'operation_id'
    and (app_private.pos_op_status_by_operation((y ->> 'operation_id')::uuid) ->> 'status') = 'prepared'
    and not exists (select 1 from app_private.pos_operation_targets where operation_id = (y ->> 'operation_id')::uuid)
    and not exists (select 1 from app_private.pos_operation_required_targets where operation_id = (y ->> 'operation_id')::uuid), 'D conflicting claim rolls back entirely (no required/active rows)');
  perform pg_temp.ok(app_private.pos_op_status_by_target(t1) #>> '{active_operation,operation_id}' = x ->> 'operation_id', 'D target lookup shows active operation');

  -- 終了で解放 → 次の claim が通る
  perform app_private.pos_op_finish((x ->> 'operation_id')::uuid, 'abandoned', 'test');
  perform pg_temp.ok(not exists (select 1 from app_private.pos_operation_targets where operation_id = (x ->> 'operation_id')::uuid and active)
    and (select count(*) from app_private.pos_operation_targets where operation_id = (x ->> 'operation_id')::uuid) = 2, 'D terminal releases targets (history kept)');
  perform pg_temp.ok(app_private.pos_op_claim((y ->> 'instruction_id')::uuid, array[t3, t1]) ->> 'result' = 'claimed', 'D released target can be claimed again');

  -- 直接の書き込みは不変条件で止まる
  z := pg_temp.prep(pg_temp.u(), 'checkout_reservation', jsonb_build_object('reservation_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0);
  perform pg_temp.err(format('insert into app_private.pos_operation_targets (operation_id, target_key) values (%L, %L)', z ->> 'operation_id', 'client:' || pg_temp.u()),
    '%pos_target_invalid_construction%', 'D prepared operation cannot hold targets');
  perform pg_temp.err(format('update app_private.pos_operation_targets set active = false where operation_id = %L', y ->> 'operation_id'),
    '%pos_target_invalid_update%', 'D claimed operation cannot release targets early');
  perform pg_temp.err(format('delete from app_private.pos_operation_targets where operation_id = %L', y ->> 'operation_id'),
    '%pos_registry_immutable%', 'D targets cannot be deleted');
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_claim((z ->> 'instruction_id')::uuid, '{}');
  perform pg_temp.ok(r ->> 'error' = 'targets_required' and pg_temp.registry_counts() = v_before
    and app_private.pos_op_status_by_operation((z ->> 'operation_id')::uuid) ->> 'status' = 'prepared', 'D claim with zero targets refused (min_targets), no writes');
  perform pg_temp.ok(app_private.pos_op_claim((z ->> 'instruction_id')::uuid, array['client:' || pg_temp.u()]) ->> 'result' = 'claimed', 'D claim with declared targets');
  v_before := pg_temp.registry_counts();
  perform pg_temp.ok(app_private.pos_op_claim(gen_random_uuid(), '{}') ->> 'error' = 'instruction_not_found' and pg_temp.registry_counts() = v_before,
    'D claim cannot invent an instruction');
  perform pg_temp.ok(app_private.pos_op_claim((z ->> 'instruction_id')::uuid, array['Bad Target']) ->> 'error' = 'invalid_request', 'D invalid target format rejected');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- E. 取り消しの印（tombstone）と別名の回り込み
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_k text := 'checkout:' || pg_temp.u();
  v_res text := pg_temp.u();
  r jsonb; p jsonb;
  v_before text;
  v_pending text := 'checkout:' || pg_temp.u();
  v_done text := 'checkout:' || pg_temp.u();
begin
  -- 無いキーに印 → 遅れて届いた PREPARE も、派生キーからも実行できない
  r := app_private.pos_op_fence_key('acct_sale', v_k, 'lost_terminal');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 2, 'E absent key tombstoned with derived alias');
  p := pg_temp.prep(pg_temp.u(), 'checkout_reservation', jsonb_build_object('reservation_id', v_res), v_k, 0);
  perform pg_temp.ok(p ->> 'error' = 'key_conflict' and p ->> 'key_role' = 'fence', 'E delayed PREPARE after tombstone refused');
  perform pg_temp.ok(app_private.pos_op_key_executable('acct_sale', v_k) ->> 'reason' = 'role_fence'
    and app_private.pos_op_key_executable('ginpay_tx', 'sale:' || v_k) ->> 'reason' = 'role_fence', 'E neither entry nor derived alias executable after tombstone');
  perform pg_temp.ok(app_private.pos_op_fence_key('acct_sale', v_k) ->> 'result' = 'already_terminal', 'E tombstone permanent (fence again is a no-op)');

  -- 受理済みの操作に印：どの別名から見ても同じ abandoned
  p := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), pg_temp.keep('e_alias_key', 'checkout:' || pg_temp.u()), 0);
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || pg_temp.getv('e_alias_key'), 'via_alias');
  perform pg_temp.ok(r ->> 'result' = 'abandoned', 'E fence through derived alias terminalizes the operation');
  perform pg_temp.ok(app_private.pos_op_status_by_operation((p ->> 'operation_id')::uuid) ->> 'status' = 'abandoned', 'E operation resolves to abandoned');
  r := app_private.pos_op_claim((p ->> 'instruction_id')::uuid, array['client:' || pg_temp.u()]);
  perform pg_temp.ok(r ->> 'error' = 'operation_terminal', 'E delayed claim after fence refused');
  perform pg_temp.ok(app_private.pos_op_key_executable('acct_sale', pg_temp.getv('e_alias_key')) ->> 'reason' = 'status_abandoned',
    'E entry key no longer executable');

  -- 既存の表に行があるキーには印を付けない
  perform pg_temp.fx_sale('pending', 'cash', 1000, v_pending, false);
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_fence_key('acct_sale', v_pending);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and pg_temp.registry_counts() = v_before, 'E fence on ambiguous physical row: blocked, no writes');
  perform pg_temp.fx_sale('completed', 'cash', 1000, v_done);
  r := app_private.pos_op_fence_key('acct_sale', v_done);
  perform pg_temp.ok(r ->> 'error' = 'legacy_effect_present' and pg_temp.registry_counts() = v_before, 'E fence on proven physical row: no tombstone');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- F. 旧データの分類（SELECT だけ）
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  k text; s uuid; t uuid; v uuid; l uuid; c jsonb;
  h text := 'AUTH1.' || repeat('b', 64);
begin
  -- D1
  k := 'checkout:' || pg_temp.u(); perform pg_temp.fx_sale('completed', 'cash', 2000, k);
  c := app_private.pos_op_classify_legacy_key('acct_sale', k);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and c ->> 'kind' = 'legacy_sale' and jsonb_array_length(c -> 'effects') = 1, 'F D1 completed cash sale proven');
  k := 'checkout:' || pg_temp.u(); perform pg_temp.fx_sale('pending', 'cash', 2000, k, false);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'sale_status_pending', 'F D1 pending blocked');
  k := 'checkout:' || pg_temp.u(); perform pg_temp.fx_sale('failed', 'cash', 2000, k, false);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'sale_status_failed', 'F D1 failed blocked');
  k := 'checkout:' || pg_temp.u(); perform pg_temp.fx_sale('completed', 'cash', 2000, k, false);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'sale_completed_at_missing', 'F D1 completed without completed_at blocked');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'ginpay', 3000, k); perform pg_temp.fx_gp('payment', 'posted', -3000, 'sale:' || k, s);
  c := app_private.pos_op_classify_legacy_key('acct_sale', k);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and jsonb_array_length(c -> 'effects') = 2 and jsonb_array_length(c -> 'keys') = 2
    and c #>> '{effects,1,k}' = 'ginpay_sale_payment' and c #>> '{effects,1,pd}' = 'accounting_sale', 'F D1 GINPay sale proven with payment child');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'ginpay', 3000, k); perform pg_temp.fx_gp('payment', 'posted', -2999, 'sale:' || k, s);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'ginpay_payment_mismatch', 'F D1 GINPay amount mismatch blocked');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'ginpay', 3000, k);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'ginpay_payment_missing', 'F D1 GINPay without payment blocked');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'ginpay', 3000, k); perform pg_temp.fx_gp('payment', 'posted', -3000, 'sale:checkout:' || pg_temp.u(), s);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'ginpay_payment_mismatch', 'F D1 GINPay payment without sale:<key> relation blocked');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'cash', 3000, k); perform pg_temp.fx_gp('payment', 'posted', -3000, 'sale:' || k, s);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'unexpected_ginpay_payment', 'F D1 cash sale with GINPay payment blocked');
  k := 'checkout:' || pg_temp.u(); perform pg_temp.fx_sale('voided', 'cash', 2000, k, true, true);
  c := app_private.pos_op_classify_legacy_key('acct_sale', k);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and c #>> '{effects,0,s,status_at_discovery}' = 'voided', 'F D1 voided sale is still a proven historical sale');
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', 'checkout:' || pg_temp.u()) ->> 'verdict' = 'no_physical_record', 'F D1 absent key');

  -- D2
  k := 'hq-sale-void:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'cash', 2000, 'checkout:' || pg_temp.u(), true, true, k, h);
  c := app_private.pos_op_classify_legacy_key('acct_void', k);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and c ->> 'kind' = 'legacy_sale_void' and c #>> '{effects,0,i}' = s::text, 'F D2 voided cash sale proven (identity = sale id)');
  k := 'hq-sale-void:' || pg_temp.u(); perform pg_temp.fx_sale('completed', 'cash', 2000, 'checkout:' || pg_temp.u(), true, false, k, h);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_void', k) ->> 'reason' = 'sale_not_voided', 'F D2 void key on completed sale is not proof');
  k := 'hq-sale-void:' || pg_temp.u(); perform pg_temp.fx_sale('voided', 'cash', 2000, 'checkout:' || pg_temp.u(), true, true, k, null);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_void', k) ->> 'reason' = 'void_key_without_request_hash', 'F D2 void key without request hash blocked');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 4000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -4000, 'sale:' || k, s);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'sale_void_reversal_unproven', 'F D2 GINPay void without reversal blocked');
  v := pg_temp.fx_gp('void', 'posted', 4000, 'sale-void:' || s::text, s, t, (select account_id from public.ginpay_transactions where id = t));
  c := app_private.pos_op_classify_legacy_effect('accounting_sale_void', s);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and jsonb_array_length(c -> 'effects') = 2 and c #>> '{effects,1,i}' = v::text, 'F D2 GINPay void with proven reversal');

  -- D3
  k := 'staff-store-charge:' || pg_temp.u(); perform pg_temp.fx_gp('charge_store', 'posted', 5000, k);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', '  ' || k) ->> 'kind' = 'legacy_ginpay_charge', 'F D3 posted charge proven (btrim lookup)');
  k := 'staff-store-charge:' || pg_temp.u(); perform pg_temp.fx_gp('charge_store', 'failed', 5000, k);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', k) ->> 'reason' = 'ginpay_status_failed', 'F D3 failed blocked');
  k := 'staff-store-charge:' || pg_temp.u(); perform pg_temp.fx_gp('charge_store', 'cancelled', 5000, k);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', k) ->> 'reason' = 'ginpay_status_cancelled', 'F D3 cancelled blocked');
  t := pg_temp.fx_gp('charge_store', 'posted', 5000, 'staff-store-charge:' || pg_temp.u());
  k := 'staff-store-charge:' || pg_temp.u(); perform pg_temp.fx_gp('refund', 'posted', 1000, k, null, t);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', k) ->> 'reason' = 'type_prefix_mismatch', 'F D3 type/prefix mismatch blocked');
  k := 'hq-refund:' || pg_temp.u(); perform pg_temp.fx_gp('refund', 'posted', 1000, k, null, t);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', k) ->> 'kind' = 'legacy_ginpay_refund', 'F D3 HQ refund proven');
  k := 'mystery:' || pg_temp.u(); perform pg_temp.fx_gp('charge_store', 'posted', 1000, k);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', k) ->> 'reason' = 'unknown_key_prefix', 'F D3 unknown prefix blocked');
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ginpay_tx', 'sale:checkout:' || pg_temp.u()) ->> 'verdict' = 'derived_key_requires_parent'
    and app_private.pos_op_classify_legacy_key('ginpay_tx', 'sale-void:' || pg_temp.u()) ->> 'verdict' = 'derived_key_requires_parent', 'F D3 derived keys require parent');
  t := pg_temp.fx_gp('charge_stripe', 'posted', 1000, 'stripe:' || pg_temp.u());
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('ginpay_transaction', t) ->> 'verdict' = 'foreign_domain_key', 'F D3 Stripe is foreign');

  -- D4
  k := 'ticket-issue:' || pg_temp.u(); l := pg_temp.fx_ticket_issue(3, 'discount', 500, k);
  c := app_private.pos_op_classify_legacy_key('ticket_issue', k);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and jsonb_array_length(c #> '{effects,0,s,tickets}') = 3, 'F D4 valid issue proven with ticket evidence');
  k := 'ticket-issue:' || pg_temp.u(); l := pg_temp.fx_ticket_issue(3, 'discount', 500, k, 'AUTH1.' || repeat('c', 64), 2);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ticket_issue', k) ->> 'reason' = 'ticket_issue_ids_inconsistent', 'F D4 quantity/ids mismatch blocked');
  k := 'ticket-issue:' || pg_temp.u(); l := pg_temp.fx_ticket_issue(2, 'discount', 500, k, null);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ticket_issue', k) ->> 'reason' = 'ticket_issue_request_hash_missing', 'F D4 missing request hash blocked');
  k := 'ticket-issue:' || pg_temp.u(); l := pg_temp.fx_ticket_issue(2, 'discount', 500, k);
  perform set_config('session_replication_role', 'replica', true);
  update public.tickets set amount = 400 where id = (select ticket_ids[1] from public.ticket_issue_logs where id = l);
  perform set_config('session_replication_role', 'origin', true);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ticket_issue', k) ->> 'reason' = 'ticket_issue_tickets_mismatch', 'F D4 ticket amount mismatch blocked');
  k := 'ticket-issue:' || pg_temp.u(); l := pg_temp.fx_ticket_issue(2, 'discount', 500, k);
  perform set_config('session_replication_role', 'replica', true);
  delete from public.tickets where id = (select ticket_ids[2] from public.ticket_issue_logs where id = l);
  perform set_config('session_replication_role', 'origin', true);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('ticket_issue', k) ->> 'reason' = 'ticket_issue_tickets_missing', 'F D4 missing ticket row blocked');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- G. 効果（E1）：1つの効果は永久に1つの操作
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  k1 text := 'ticket-issue:' || pg_temp.u();
  k2 text := 'ticket-issue:' || pg_temp.u();
  l uuid; r jsonb; r2 jsonb; v_hash text; v_op text; v_before text;
  ks text; s uuid; t uuid; v uuid; vk text;
  s5 uuid; t5 uuid; k5 text; ox uuid; oy uuid; c jsonb;
begin
  -- D4 のキーが K1 → K2 に変わる
  l := pg_temp.fx_ticket_issue(2, 'otoku', 1000, k1);
  r := app_private.pos_op_discover_legacy('key', 'ticket_issue', k1);
  perform pg_temp.ok(r ->> 'result' = 'discovered', 'G discover issue log by K1');
  v_op := r ->> 'operation_id';
  v_hash := (select snapshot_hash from app_private.pos_operation_effects where effect_domain = 'ticket_issue' and effect_identity = l);
  perform pg_temp.ok(app_private.pos_op_discover_legacy('key', 'ticket_issue', k1) ->> 'result' = 'existing', 'G repeated discovery idempotent');
  update public.ticket_issue_logs set idempotency_key = k2 where id = l;
  r := app_private.pos_op_discover_legacy('key', 'ticket_issue', k2);
  perform pg_temp.ok(r ->> 'result' = 'enriched' and r ->> 'operation_id' = v_op and (r ->> 'aliases_added')::int = 1, 'G renamed key K2 joins the same operation');
  perform pg_temp.ok((select count(*) from app_private.pos_operation_keys where operation_id = v_op::uuid and key_role = 'legacy_alias') = 2
    and (select count(*) from app_private.pos_operation_effects where effect_domain = 'ticket_issue' and effect_identity = l) = 1
    and (select count(*) from app_private.pos_operation_effects where operation_id = v_op::uuid) = 1
    and (select count(*) from app_private.pos_operations o join app_private.pos_operation_effects f using (operation_id) where f.effect_identity = l) = 1,
    'G two aliases, one effect, one completed operation');
  perform pg_temp.ok((select snapshot_hash from app_private.pos_operation_effects where effect_domain = 'ticket_issue' and effect_identity = l) = v_hash,
    'G snapshot unchanged after alias');
  r := app_private.pos_op_discover_legacy('key', 'ticket_issue', k1);
  perform pg_temp.ok(r ->> 'result' = 'bound' and r ->> 'operation_id' = v_op and r ->> 'note' = 'source_key_absent', 'G old key K1 still resolves after source key changed');
  perform pg_temp.ok(app_private.pos_op_discover_legacy('effect', 'ticket_issue', l::text) ->> 'result' = 'existing'
    and app_private.pos_op_discover_legacy('effect', 'ticket_issue', l::text) ->> 'operation_id' = v_op, 'G effect-id discovery converges to the same operation');
  -- 元のキーを消しても台帳で引ける
  update public.ticket_issue_logs set idempotency_key = null where id = l;
  perform pg_temp.ok(app_private.pos_op_status_by_key('ticket_issue', k1) #>> '{operation,operation_id}' = v_op
    and app_private.pos_op_status_by_key('ticket_issue', k2) #>> '{operation,operation_id}' = v_op, 'G source key removed: registry still resolves both keys');
  perform pg_temp.ok(app_private.pos_op_key_executable('ticket_issue', k1) ->> 'reason' = 'role_legacy_alias', 'G legacy alias never executable');

  -- 元の証拠が変わる → legacy_evidence_changed（スナップショットは変えない・2つ目の操作は作らない）
  update public.tickets set amount = 999 where id = (select ticket_ids[1] from public.ticket_issue_logs where id = l);
  update public.tickets set amount = 999 where id = (select ticket_ids[2] from public.ticket_issue_logs where id = l);
  update public.ticket_issue_logs set amount = 999 where id = l;
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_discover_legacy('effect', 'ticket_issue', l::text);
  perform pg_temp.ok(r ->> 'error' = 'legacy_evidence_changed' and r ->> 'operation_id' = v_op and pg_temp.registry_counts() = v_before
    and (select snapshot_hash from app_private.pos_operation_effects where effect_domain = 'ticket_issue' and effect_identity = l) = v_hash,
    'G source mutation: evidence_changed, snapshot unchanged, no new operation');
  update public.ticket_issue_logs set idempotency_key = k2 where id = l;
  r := app_private.pos_op_discover_legacy('key', 'ticket_issue', k2);
  perform pg_temp.ok(r ->> 'error' = 'legacy_evidence_changed' and pg_temp.registry_counts() = v_before, 'G mutated evidence via bound key also fails closed');

  -- 会計（GINPay 払い）と支払い：どちらから先に見つけても同じ操作
  ks := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'ginpay', 2500, ks); t := pg_temp.fx_gp('payment', 'posted', -2500, 'sale:' || ks, s);
  perform pg_temp.ok(app_private.pos_op_discover_legacy('key', 'ginpay_tx', 'sale:' || ks) ->> 'error' = 'derived_key_requires_parent', 'G derived sale:<key> discovery blocked standalone');
  r := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t::text);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and (r ->> 'effects')::int = 2, 'G payment effect-id first: parent sale owns both effects');
  r2 := app_private.pos_op_discover_legacy('key', 'acct_sale', ks);
  perform pg_temp.ok(r2 ->> 'result' = 'existing' and r2 ->> 'operation_id' = r ->> 'operation_id', 'G then sale key converges');
  perform pg_temp.ok((select count(distinct operation_id) from app_private.pos_operation_effects where effect_identity in (s, t)) = 1, 'G sale+payment one operation (payment first)');
  ks := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('completed', 'ginpay', 2600, ks); t := pg_temp.fx_gp('payment', 'posted', -2600, 'sale:' || ks, s);
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', ks);
  r2 := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t::text);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and r2 ->> 'result' = 'existing' and r2 ->> 'operation_id' = r ->> 'operation_id'
    and (select count(*) from app_private.pos_operation_keys where operation_id = (r ->> 'operation_id')::uuid) = 2, 'G sale first, then payment: same operation, both keys aliases');

  -- 取消と戻し：1つの取消の操作（会計の操作とは別）
  ks := 'checkout:' || pg_temp.u(); vk := 'hq-sale-void:' || pg_temp.u();
  s := pg_temp.fx_sale('voided', 'ginpay', 1800, ks, true, true, vk, 'AUTH1.' || repeat('d', 64));
  t := pg_temp.fx_gp('payment', 'posted', -1800, 'sale:' || ks, s);
  v := pg_temp.fx_gp('void', 'posted', 1800, 'sale-void:' || s::text, s, t, (select account_id from public.ginpay_transactions where id = t));
  r := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', v::text);
  r2 := app_private.pos_op_discover_legacy('key', 'acct_void', vk);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and r2 ->> 'result' = 'existing' and r2 ->> 'operation_id' = r ->> 'operation_id'
    and (select count(*) from app_private.pos_operation_effects where operation_id = (r ->> 'operation_id')::uuid) = 2, 'G void + reversal converge to one void operation');
  r2 := app_private.pos_op_discover_legacy('effect', 'accounting_sale', s::text);
  perform pg_temp.ok(r2 ->> 'result' = 'discovered' and r2 ->> 'operation_id' <> r ->> 'operation_id'
    and (select operation_id from app_private.pos_operation_effects where effect_domain = 'accounting_sale' and effect_identity = s)
        <> (select operation_id from app_private.pos_operation_effects where effect_domain = 'accounting_sale_void' and effect_identity = s),
    'G the sale and its void are different operations (same source id, different domain)');

  -- 壊れた台帳（効果が2つの操作に分かれている）→ legacy_effect_conflict、何も書かない
  k5 := 'checkout:' || pg_temp.u(); s5 := pg_temp.fx_sale('completed', 'ginpay', 700, k5); t5 := pg_temp.fx_gp('payment', 'posted', -700, 'sale:' || k5, s5);
  c := app_private.pos_op_classify_sale(s5);
  insert into app_private.pos_operations (kind, origin, status, result_snapshot, result_snapshot_hash)
  values ('legacy_sale', 'legacy_discovered', 'completed', pg_temp.legacy_result('legacy_sale'), app_private.pos_op_hash('LEG1', pg_temp.legacy_result('legacy_sale'))) returning operation_id into ox;
  insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, snapshot, snapshot_hash, classifier_version, registered_via)
  values ('accounting_sale', s5, ox, 'sale', c #> '{effects,0,s}', app_private.pos_op_hash('LEG1', c #> '{effects,0,s}'), 'c1-legacy-v1', 'discovery_effect');
  insert into app_private.pos_operations (kind, origin, status, result_snapshot, result_snapshot_hash)
  values ('legacy_ginpay_charge', 'legacy_discovered', 'completed', pg_temp.legacy_result('legacy_ginpay_charge'), app_private.pos_op_hash('LEG1', pg_temp.legacy_result('legacy_ginpay_charge'))) returning operation_id into oy;
  insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, snapshot, snapshot_hash, classifier_version, registered_via)
  values ('ginpay_transaction', t5, oy, 'ginpay_charge', c #> '{effects,1,s}', app_private.pos_op_hash('LEG1', c #> '{effects,1,s}'), 'c1-legacy-v1', 'discovery_effect');
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', k5);
  perform pg_temp.ok(r ->> 'error' = 'legacy_effect_conflict' and pg_temp.registry_counts() = v_before, 'G split effects fail closed (no merge, no writes)');

  -- 効果は書き換え・削除・付け替えできない
  perform pg_temp.err(format('update app_private.pos_operation_effects set operation_id = %L where effect_domain = %L and effect_identity = %L', oy, 'accounting_sale', s5),
    '%pos_registry_immutable%', 'G effect rebind blocked');
  perform pg_temp.err(format('delete from app_private.pos_operation_effects where effect_domain = %L and effect_identity = %L', 'accounting_sale', s5),
    '%pos_registry_immutable%', 'G effect delete blocked');
  perform pg_temp.err(format('insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, snapshot, snapshot_hash, classifier_version, registered_via) values (%L, %L, %L, %L, %L, %L, %L, %L)',
    'accounting_sale', s5, oy, 'sale', c #> '{effects,0,s}', app_private.pos_op_hash('LEG1', c #> '{effects,0,s}'), 'c1-legacy-v1', 'discovery_key'), '%duplicate key%', 'G effect second owner blocked');
  perform pg_temp.err(format('insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, parent_domain, parent_identity, snapshot, snapshot_hash, classifier_version, registered_via) values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    'ginpay_transaction', t5, oy, 'ginpay_sale_payment', 'accounting_sale', s5, c #> '{effects,1,s}', app_private.pos_op_hash('LEG1', c #> '{effects,1,s}'), 'c1-legacy-v1', 'discovery_key'),
    '%pos_effect_parent_unproven%', 'G child effect requires parent in the same operation (parent lives in another operation)');
  perform pg_temp.err(format('update app_private.pos_operations set result_snapshot = %L where operation_id = %L', '{"x":1}', ox),
    '%pos_operation_terminal_immutable%', 'G representative result snapshot immutable');
  perform pg_temp.err(format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, app_private.pos_op_key_ident(%1$L, %L), %L, %L)',
    'acct_sale', 'checkout:' || pg_temp.u(), ox, 'entry'), '%pos_key_role_mismatch%', 'G legacy operation cannot get an executable entry key');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- H. 読み取り専用（状態・照会・分類は何も書かない）
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.setv('h_before', pg_temp.registry_counts());
  perform pg_temp.setv('h_hash', (select md5(string_agg(x, ',' order by x)) from (
    select operation_id::text || status || coalesce(last_code, '') x from app_private.pos_operations
    union all select key_domain || encode(key_digest, 'hex') || operation_id::text from app_private.pos_operation_keys
    union all select slot_key || slot_epoch || coalesce(active_instruction_id::text, '') from app_private.pos_business_slots) z));
  perform pg_temp.setv('h_any_key', (select idempotency_key from public.ticket_issue_logs where idempotency_key is not null limit 1));
  perform pg_temp.setv('h_any_slot', (select slot_key from app_private.pos_business_slots limit 1));
  perform pg_temp.setv('h_any_sale_key', (select idempotency_key from public.accounting_sessions where idempotency_key like 'checkout:%' limit 1));
end $$;

begin transaction read only;
do $$
begin
  if not (app_private.pos_op_status_by_key('ticket_issue', pg_temp.getv('h_any_key')) is not null
      and app_private.pos_op_status_by_slot(pg_temp.getv('h_any_slot')) is not null
      and app_private.pos_op_status_by_context('ginpay_charge', jsonb_build_object('account_id', gen_random_uuid()::text, 'amount', 1)) is not null
      and app_private.pos_op_status_by_target('gpaccount:' || gen_random_uuid()) is not null
      and app_private.pos_op_status_by_effect('ticket_issue', gen_random_uuid()) is not null
      and app_private.pos_op_status_by_instruction(gen_random_uuid()) is not null
      and app_private.pos_op_unresolved(500) is not null
      and app_private.pos_op_key_executable('acct_sale', pg_temp.getv('h_any_sale_key')) is not null
      and app_private.pos_op_classify_legacy_key('acct_sale', pg_temp.getv('h_any_sale_key')) is not null
      and app_private.pos_op_classify_legacy_effect('accounting_sale', (select id from public.accounting_sessions limit 1)) is not null) then
    raise exception 'C1 FAIL: read-only helper returned null';
  end if;
end $$;
commit;

do $$
declare
  v_detail text;
begin
  perform pg_temp.ok(pg_temp.registry_counts() = pg_temp.getv('h_before'), 'H status/lookup/classify under READ ONLY: row counts unchanged');
  perform pg_temp.ok((select md5(string_agg(x, ',' order by x)) from (
    select operation_id::text || status || coalesce(last_code, '') x from app_private.pos_operations
    union all select key_domain || encode(key_digest, 'hex') || operation_id::text from app_private.pos_operation_keys
    union all select slot_key || slot_epoch || coalesce(active_instruction_id::text, '') from app_private.pos_business_slots) z) = pg_temp.getv('h_hash'),
    'H status/lookup/classify under READ ONLY: contents unchanged');
  -- 状態・照会・分類の関数は STABLE/IMMUTABLE で、discovery・lock・書き込みを呼ばない
  select string_agg(p.proname, ', ') into v_detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app_private'
    and (p.proname like 'pos\_op\_status\_%' or p.proname like 'pos\_op\_classify\_%' or p.proname in ('pos_op_operation_summary', 'pos_op_unresolved', 'pos_op_key_executable', 'pos_op_key_present'))
    and (p.provolatile not in ('s', 'i') or p.prosrc ~* '(pos_op_discover|advisory|insert\s+into|update\s+app_private|delete\s+from|pos_op_lock|for\s+update)');
  perform pg_temp.ok(v_detail is null, 'H read-only helpers are STABLE and never discover/lock/write: ' || coalesce(v_detail, 'ok'));
end $$;

-- 書き込み関数は読み取り専用のトランザクションでは動かない（status が discovery を兼ねていないこと）
begin transaction read only;
do $$
declare
  v_msg text;
begin
  begin
    perform app_private.pos_op_discover_legacy('key', 'acct_sale', 'checkout:' || gen_random_uuid());
    perform app_private.pos_op_fence_key('acct_sale', 'checkout:' || gen_random_uuid());
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like '%read-only transaction%' then raise exception 'C1 FAIL: writer ran inside READ ONLY (%)', v_msg; end if;
end $$;
commit;

-- ════════════════════════════════════════════════════════════════════════════
-- I. 不変条件（直接の書き込みでも崩れない）
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  p jsonb; q jsonb; v_slot text; v_op text;
begin
  p := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), 0);
  v_op := p ->> 'operation_id'; v_slot := p ->> 'slot_key';
  perform pg_temp.err(format('update app_private.pos_operations set status = %L where operation_id = %L', 'completed', v_op), '%pos_operation_invalid_transition%', 'I prepared -> completed (direct) blocked');
  perform pg_temp.err(format('update app_private.pos_operations set status = %L where operation_id = %L', 'rejected', v_op), '%pos_operation_invalid_transition%', 'I prepared -> rejected (direct) blocked');
  perform pg_temp.err(format('update app_private.pos_operations set kind = %L where operation_id = %L', 'ginpay_charge', v_op), '%pos_operation_identity_immutable%', 'I operation identity immutable');
  perform app_private.pos_op_claim((p ->> 'instruction_id')::uuid, array['client:' || pg_temp.u()]);
  perform pg_temp.err(format('update app_private.pos_operations set status = %L where operation_id = %L', 'prepared', v_op), '%pos_operation_invalid_transition%', 'I claimed -> prepared blocked');
  perform app_private.pos_op_finish(v_op::uuid, 'completed');
  perform pg_temp.err(format('update app_private.pos_operations set status = %L where operation_id = %L', 'claimed', v_op), '%pos_operation_terminal_immutable%', 'I terminal -> claimed blocked');
  perform pg_temp.err(format('update app_private.pos_operations set last_code = %L where operation_id = %L', 'x', v_op), '%pos_operation_terminal_immutable%', 'I terminal fields immutable');
  perform pg_temp.err(format('delete from app_private.pos_operations where operation_id = %L', v_op), '%pos_registry_immutable%', 'I operation delete blocked');
  -- 直接の作成：通常の操作は prepared で、旧データは結果つき completed で、印は abandoned でしか作れない
  perform pg_temp.err('insert into app_private.pos_operations (kind, origin, status, slot_key) values (''ginpay_charge'', ''prepared'', ''completed'', ' || quote_literal(v_slot) || ')',
    '%pos_operation_invalid_construction%', 'I prepared origin cannot be created terminal');
  perform pg_temp.err('insert into app_private.pos_operations (kind, origin, status) values (''legacy_sale'', ''legacy_discovered'', ''completed'')',
    '%pos_operation_invalid_construction%', 'I legacy completed requires snapshot');
  perform pg_temp.err('insert into app_private.pos_operations (kind, origin, status) values (''key_tombstone'', ''negative_tombstone'', ''prepared'')',
    '%pos_operation_invalid_construction%', 'I tombstone must be abandoned');

  -- 枠：版は戻らない・飛ばない、I → J は不可
  q := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', split_part(v_slot, ':', 3), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), (pg_temp.slot(v_slot) ->> 'slot_epoch')::bigint);
  perform pg_temp.ok(q ->> 'result' = 'prepared', 'I second instruction on slot');
  perform pg_temp.err(format('update app_private.pos_business_slots set slot_epoch = slot_epoch - 1 where slot_key = %L', v_slot), '%pos_slot_epoch_must_advance_by_one%', 'I epoch decrease blocked');
  perform pg_temp.err(format('update app_private.pos_business_slots set slot_epoch = slot_epoch + 2 where slot_key = %L', v_slot), '%pos_slot_epoch_must_advance_by_one%', 'I epoch jump blocked');
  perform pg_temp.err(format('update app_private.pos_business_slots set slot_epoch = slot_epoch + 1, active_instruction_id = %L where slot_key = %L', p ->> 'instruction_id', v_slot),
    '%pos_slot_invalid_pointer_transition%', 'I pointer I -> J blocked');
  perform pg_temp.err(format('update app_private.pos_business_slots set slot_kind = %L where slot_key = %L', 'ginpay_account', v_slot), '%pos_slot_identity_immutable%', 'I slot identity immutable');
  perform pg_temp.err(format('delete from app_private.pos_business_slots where slot_key = %L', v_slot), '%pos_registry_immutable%', 'I slot delete blocked');

  -- キー：付け替え・削除・2つ目の entry は不可
  perform pg_temp.err(format('update app_private.pos_operation_keys set operation_id = %L where operation_id = %L', v_op, q ->> 'operation_id'), '%pos_registry_immutable%', 'I key rebind blocked');
  perform pg_temp.err(format('delete from app_private.pos_operation_keys where operation_id = %L', v_op), '%pos_registry_immutable%', 'I key delete blocked');
  perform pg_temp.err(format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, app_private.pos_op_key_ident(%1$L, %L), %L, %L)',
    'ticket_issue', 'ticket-issue:' || pg_temp.u(), q ->> 'operation_id', 'entry'), '%duplicate key%', 'I second entry key for one operation blocked');
  perform pg_temp.err(format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, app_private.pos_op_key_ident(%1$L, %L), %L, %L)',
    'ticket_issue', 'ticket-issue:' || pg_temp.u(), q ->> 'operation_id', 'legacy_alias'), '%pos_key_role_mismatch%', 'I legacy alias on unresolved operation blocked');

  -- 履歴は消せない
  perform pg_temp.err('update app_private.pos_operation_events set detail = ''{}'' where true', '%pos_registry_immutable%', 'I event update blocked');
  perform pg_temp.err('delete from app_private.pos_operation_events where true', '%pos_registry_immutable%', 'I event delete blocked');
end $$;

-- TRUNCATE はどの表でも止まる（参照されている表は外部キーでも止まる。CASCADE を付けてもトリガーで止まる）
do $$
declare
  t text;
  v_msg text;
begin
  foreach t in array array['pos_operations', 'pos_operation_keys', 'pos_business_instructions', 'pos_business_slots',
                           'pos_operation_targets', 'pos_operation_required_targets', 'pos_operation_effects', 'pos_operation_events'] loop
    v_msg := null;
    begin
      execute format('truncate app_private.%I', t);
    exception when others then v_msg := sqlerrm;
    end;
    perform pg_temp.ok(v_msg like '%pos_registry_immutable%' or v_msg like '%referenced in a foreign key constraint%',
      'I truncate blocked: ' || t || ' (' || coalesce(v_msg, 'no error') || ')');
    perform pg_temp.err(format('truncate app_private.%I cascade', t), '%pos_registry_immutable%', 'I truncate cascade blocked: ' || t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- J. 権限（クライアントのロールからは何も見えない）
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_detail text;
begin
  select string_agg(c.relname || ':' || r.rolname, ', ') into v_detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) r(rolname)
  where n.nspname = 'app_private' and (c.relname like 'pos\_operation%' or c.relname like 'pos\_business%') and c.relkind in ('r', 'S')
    and r.rolname <> 'public'
    and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert')
         or has_table_privilege(r.rolname, c.oid, 'update') or has_table_privilege(r.rolname, c.oid, 'delete'));
  perform pg_temp.ok(v_detail is null, 'J no table privileges for client roles: ' || coalesce(v_detail, 'ok'));
  select string_agg(p.proname || ':' || r.rolname, ', ') into v_detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
  where n.nspname = 'app_private' and p.proname like 'pos\_op\_%' and has_function_privilege(r.rolname, p.oid, 'execute');
  perform pg_temp.ok(v_detail is null, 'J no execute on pos_op_* for client roles: ' || coalesce(v_detail, 'ok'));
  select string_agg(p.proname, ', ') into v_detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app_private' and p.proname like 'pos\_op\_%'
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  perform pg_temp.ok(v_detail is null, 'J fixed search_path on every pos_op_* function: ' || coalesce(v_detail, 'ok'));
  select string_agg(p.proname, ', ') into v_detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'pos\_op\_%' or p.proname like '%pos\_operation%' or p.proname like '%pos\_business%');
  perform pg_temp.ok(v_detail is null, 'J no public-schema PREPARE/CLAIM/FENCE/status API: ' || coalesce(v_detail, 'ok'));
  create temp table c1_registry_tables on commit drop as
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relkind = 'r'
      and c.relname in ('pos_operations', 'pos_operation_keys', 'pos_business_instructions', 'pos_business_slots',
                        'pos_operation_targets', 'pos_operation_required_targets', 'pos_operation_effects', 'pos_operation_events');
  select string_agg(c.conrelid::regclass::text || '->' || c.confrelid::regclass::text, ', ') into v_detail
  from pg_constraint c
  where c.contype = 'f' and c.conrelid in (select oid from c1_registry_tables)
    and c.confrelid not in (select oid from c1_registry_tables);
  perform pg_temp.ok(v_detail is null, 'J no foreign keys from registry into money tables: ' || coalesce(v_detail, 'ok'));
  select string_agg(c.conrelid::regclass::text, ', ') into v_detail
  from pg_constraint c
  where c.contype = 'f' and c.conrelid in (select oid from c1_registry_tables) and c.confdeltype not in ('r');
  perform pg_temp.ok(v_detail is null, 'J registry foreign keys are ON DELETE RESTRICT: ' || coalesce(v_detail, 'ok'));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- K. 監査の指摘への対策（B1 資源の宣言 / B2 子の効果の親 / M1 取消の証明 / M2 秘密を保存しない / M3 lock の順）
--   トリガーを止めて調べる検査は、その表に未処理の遅延イベントがあると ALTER TABLE できないので、準備とは別のトランザクションで行う
-- ════════════════════════════════════════════════════════════════════════════

-- K-B1 準備：prepared の P と、2つの資源を宣言して claimed の Q
do $$
declare
  p jsonb; q jsonb; r jsonb;
begin
  p := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0);
  q := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0);
  r := app_private.pos_op_claim((q ->> 'instruction_id')::uuid, array['client:kb1-' || pg_temp.u(), 'reservation:kb1-' || pg_temp.u()]);
  perform pg_temp.ok(r ->> 'result' = 'claimed', 'K B1 setup: claim with two declared targets');
  perform pg_temp.setv('kb1_p', p ->> 'operation_id');
  perform pg_temp.setv('kb1_q', q ->> 'operation_id');
  perform pg_temp.setv('kb1_q_t1', r #>> '{targets,0}');
  perform pg_temp.setv('kb1_tomb', app_private.pos_op_fence_key('ginpay_tx', 'staff-store-charge:' || pg_temp.u(), 'test') ->> 'operation_id');
end $$;

do $$
declare
  v_p text := pg_temp.getv('kb1_p');
  v_q text := pg_temp.getv('kb1_q');
  ka text := 'client:kb1-' || pg_temp.u();
  kb text := 'reservation:kb1-' || pg_temp.u();
  s jsonb;
begin
  s := app_private.pos_op_status_by_operation(v_q::uuid);
  perform pg_temp.ok(s -> 'required_targets' = s -> 'active_targets' and jsonb_array_length(s -> 'required_targets') = 2,
    'K B1 claimed operation: required set recorded and equal to active set');
  -- 宣言 0 件のまま prepared → claimed（直接）
  perform pg_temp.err_commit(array[format('update app_private.pos_operations set status = %L where operation_id = %L', 'claimed', v_p)],
    '%pos_invariant_required_targets_missing%', 'K B1 direct prepared->claimed with zero required targets fails at commit');
  -- claim のあとに宣言に無い資源を足す
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_targets (operation_id, target_key) values (%L, %L)', v_q, 'gpaccount:kb1-' || pg_temp.u())],
    '%pos_target_not_required%', 'K B1 arbitrary active target added after claim rejected');
  -- 宣言を消す・書き換える・あとから足す
  perform pg_temp.err_commit(array[format('delete from app_private.pos_operation_required_targets where operation_id = %L and target_key = %L', v_q, pg_temp.getv('kb1_q_t1'))],
    '%pos_registry_immutable%', 'K B1 removing one required target rejected');
  perform pg_temp.err_commit(array[format('update app_private.pos_operation_required_targets set target_key = %L where operation_id = %L', ka, v_q)],
    '%pos_registry_immutable%', 'K B1 rewriting a required target rejected');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L)', v_q, ka)],
    '%pos_required_target_invalid_construction%', 'K B1 adding a required target after claim rejected');
  -- 有効な資源を1つ早く外す（解放は終了してから）
  perform pg_temp.err_commit(array[format('update app_private.pos_operation_targets set active = false where operation_id = %L and target_key = %L', v_q, pg_temp.getv('kb1_q_t1'))],
    '%pos_target_invalid_update%', 'K B1 dropping one active target of a claimed operation rejected');
  -- prepared のまま宣言だけ（先に仕込む）
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L)', v_p, ka)],
    '%pos_invariant_unclaimed_targets%', 'K B1 required rows on a still-prepared operation fail at commit');
  -- 宣言 2 件・有効 1 件で claimed（足りない資源）
  perform pg_temp.err_commit(array[
      format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L), (%L, %L)', v_p, ka, v_p, kb),
      format('update app_private.pos_operations set status = %L where operation_id = %L', 'claimed', v_p),
      format('insert into app_private.pos_operation_targets (operation_id, target_key) values (%L, %L)', v_p, ka)],
    '%pos_invariant_claimed_targets%', 'K B1 claimed with one required target missing from the active set fails at commit');
  -- 取り消しの印には宣言できない
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L)', pg_temp.getv('kb1_tomb'), ka)],
    '%pos_required_target_invalid_construction%', 'K B1 tombstone cannot get required targets');
  perform pg_temp.err_commit(array['truncate app_private.pos_operation_required_targets cascade'], '%pos_registry_immutable%', 'K B1 required targets cannot be truncated');
end $$;

-- 行ごとのガードを止めても、コミット時の集合の一致の検査が単独で止める（有効 − 宣言 ≠ 空）
do $$
begin
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_targets (operation_id, target_key) values (%L, %L)', pg_temp.getv('kb1_q'), 'gpaccount:kb1-' || pg_temp.u())],
    '%pos_invariant_claimed_targets%', 'K B1 extra active target with row guard disabled still fails at commit (active - required)',
    array['app_private.pos_operation_targets|pos_operation_targets_guard']);
end $$;

-- 同じく（宣言 − 有効 ≠ 空）
do $$
begin
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L)', pg_temp.getv('kb1_q'), 'gpaccount:kb1-' || pg_temp.u())],
    '%pos_invariant_claimed_targets%', 'K B1 extra required target with row guard disabled still fails at commit (required - active)',
    array['app_private.pos_operation_required_targets|pos_operation_required_targets_guard']);
end $$;

-- K-B2 準備：GINPay 払いの会計（会計 + 支払いを discovery 済み）と、直接入れる検査用の行（posted の支払いは会計に1件だけなので failed で作る）
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  v_acct uuid := gen_random_uuid();
  s uuid; s3 uuid; r jsonb; o2 uuid;
begin
  s := pg_temp.fx_sale('completed', 'ginpay', 1500, k);
  perform pg_temp.fx_gp('payment', 'posted', -1500, 'sale:' || k, s, null, v_acct);
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', k);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and (r ->> 'effects')::int = 2, 'K B2 setup: sale + payment discovered into one operation');
  insert into app_private.pos_operations (kind, origin, status, result_snapshot, result_snapshot_hash)
  values ('legacy_sale', 'legacy_discovered', 'completed', pg_temp.legacy_result('legacy_sale'), app_private.pos_op_hash('LEG1', pg_temp.legacy_result('legacy_sale')))
  returning operation_id into o2;
  s3 := pg_temp.fx_sale('completed', 'ginpay', 900, 'checkout:' || pg_temp.u());
  perform pg_temp.setv('kb2_s', s::text);
  perform pg_temp.setv('kb2_o1', r ->> 'operation_id');
  perform pg_temp.setv('kb2_o2', o2::text);
  perform pg_temp.setv('kb2_t2', pg_temp.fx_gp('payment', 'failed', -1, 'kb2:' || pg_temp.u(), s, null, v_acct)::text);
  perform pg_temp.setv('kb2_t3', pg_temp.fx_gp('payment', 'posted', -900, 'kb2:' || pg_temp.u(), s3, null, v_acct)::text);
  perform pg_temp.setv('kb2_t4', pg_temp.fx_gp('payment', 'failed', -2, 'kb2:' || pg_temp.u(), s, null, v_acct)::text);
end $$;

do $$
declare
  s uuid := pg_temp.getv('kb2_s')::uuid;
  o1 uuid := pg_temp.getv('kb2_o1')::uuid;
  o2 uuid := pg_temp.getv('kb2_o2')::uuid;
  t2 uuid := pg_temp.getv('kb2_t2')::uuid;
  t3 uuid := pg_temp.getv('kb2_t3')::uuid;
  v_snap jsonb := pg_temp.gp_snap(pg_temp.getv('kb2_t2')::uuid);
begin
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_payment', null, null, v_snap)],
    '%pos_effect_parent_required%', 'K B2 child effect with NULL parent rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_payment', 'accounting_sale', null, v_snap)],
    '%pos_effect_parent_required%', 'K B2 child effect with parent domain but NULL parent id rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_reversal', null, s, v_snap)],
    '%pos_effect_parent_required%', 'K B2 reversal child with NULL parent domain rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o2, 'ginpay_sale_payment', 'accounting_sale', s, v_snap)],
    '%pos_effect_parent_unproven%', 'K B2 parent registered in another operation rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_payment', 'accounting_sale_void', s, v_snap)],
    '%pos_effect_parent_unproven%', 'K B2 payment pointing at a sale-void parent (wrong parent kind) rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_reversal', 'accounting_sale', s, v_snap)],
    '%pos_effect_parent_unproven%', 'K B2 reversal pointing at a sale (not a void) parent rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_payment', 'accounting_sale', gen_random_uuid(), v_snap)],
    '%pos_effect_parent_unproven%', 'K B2 missing parent rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t3, o1, 'ginpay_sale_payment', 'accounting_sale', s, pg_temp.gp_snap(t3))],
    '%pos_effect_parent_mismatch%', 'K B2 child whose transaction belongs to another sale rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_charge', 'accounting_sale', s, v_snap)],
    '%pos_effect_parent_forbidden%', 'K B2 root effect kind with a parent rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ticket_issue', t2, o1, 'ginpay_sale_payment', 'accounting_sale', s, v_snap)],
    '%pos_operation_effects_parent_shape%', 'K B2 child effect in the wrong effect domain rejected by CHECK');
  -- 対照：正しい形なら入る
  execute pg_temp.eff_sql('ginpay_transaction', t2, o1, 'ginpay_sale_payment', 'accounting_sale', s, v_snap);
  perform pg_temp.ok(exists (select 1 from app_private.pos_operation_effects where effect_identity = t2 and operation_id = o1 and parent_identity = s),
    'K B2 control: correctly parented child accepted');
end $$;

-- ガードを止めても CHECK だけで NULL の親を止める（NULL が CHECK を素通りしないこと）
do $$
declare
  s uuid := pg_temp.getv('kb2_s')::uuid;
  o1 uuid := pg_temp.getv('kb2_o1')::uuid;
  t4 uuid := pg_temp.getv('kb2_t4')::uuid;
  v_snap jsonb := pg_temp.gp_snap(pg_temp.getv('kb2_t4')::uuid);
  g text[] := array['app_private.pos_operation_effects|pos_operation_effects_guard'];
begin
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t4, o1, 'ginpay_sale_payment', null, null, v_snap)],
    '%pos_operation_effects_parent_shape%', 'K B2 CHECK alone: payment child with NULL parent', g);
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t4, o1, 'ginpay_sale_payment', 'accounting_sale', null, v_snap)],
    '%pos_operation_effects_parent_shape%', 'K B2 CHECK alone: payment child with NULL parent id', g);
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t4, o1, 'ginpay_sale_payment', null, s, v_snap)],
    '%pos_operation_effects_parent_shape%', 'K B2 CHECK alone: payment child with NULL parent domain', g);
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t4, o1, 'ginpay_sale_reversal', null, null, v_snap)],
    '%pos_operation_effects_parent_shape%', 'K B2 CHECK alone: reversal child with NULL parent', g);
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', t4, o1, 'ginpay_charge', 'accounting_sale', s, v_snap)],
    '%pos_operation_effects_parent_shape%', 'K B2 CHECK alone: root kind with a parent', g);
end $$;

-- K-M1 取消の証明（元の支払い T・戻し V の口座・金額・元取引・会計 ID）
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  k text; s uuid; s2 uuid; t uuid; v uuid; x uuid; c jsonb; r jsonb; v_before text;
begin
  -- 違う口座の +1（以前は proven になっていた）
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  v := pg_temp.fx_gp('void', 'posted', 1, 'sale-void:' || s, s, t, b);
  c := app_private.pos_op_classify_legacy_effect('accounting_sale_void', s);
  perform pg_temp.ok(c ->> 'verdict' = 'blocked' and c ->> 'reason' = 'sale_void_reversal_account_mismatch', 'K M1 wrong-account +1 reversal is not proof');
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('ginpay_transaction', v) ->> 'verdict' = 'blocked', 'K M1 same verdict via the reversal transaction id');
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_discover_legacy('effect', 'accounting_sale_void', s::text);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and pg_temp.registry_counts() = v_before, 'K M1 blocked void is not registered (no writes)');

  -- 正しい口座・違う金額（+999 と +1）
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  perform pg_temp.fx_gp('void', 'posted', 999, 'sale-void:' || s, s, t, a);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'sale_void_reversal_amount_mismatch', 'K M1 correct account, wrong amount (999 of 1000)');
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  perform pg_temp.fx_gp('void', 'posted', 1, 'sale-void:' || s, s, t, a);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'sale_void_reversal_amount_mismatch', 'K M1 correct account, +1 reversal');

  -- 正しい金額・違う元取引
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  x := pg_temp.fx_gp('charge_store', 'posted', 1000, 'staff-store-charge:' || pg_temp.u(), null, null, a);
  perform pg_temp.fx_gp('void', 'posted', 1000, 'sale-void:' || s, s, x, a);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'sale_void_reversal_unproven', 'K M1 correct amount, wrong original_transaction_id');

  -- 正しい元取引・違う会計 ID
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  s2 := pg_temp.fx_sale('voided', 'ginpay', 1000, 'checkout:' || pg_temp.u(), true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  perform pg_temp.fx_gp('void', 'posted', 1000, 'sale-void:' || s, s2, t, a);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'sale_void_reversal_session_mismatch', 'K M1 correct original, wrong accounting_session_id');

  -- 元の支払いを指す返金がほかにもある（取消の時点の残りを言い切れない）
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  perform pg_temp.fx_gp('void', 'posted', 1000, 'sale-void:' || s, s, t, a);
  perform pg_temp.fx_gp('refund', 'posted', 1, 'staff-refund:' || pg_temp.u(), s, t, a);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'sale_void_reversal_ambiguous', 'K M1 extra reversal of the original payment is ambiguous (blocked)');

  -- 現金の取消に GINPay の支払いがある
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'cash', 1000, k, true, true);
  perform pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  perform pg_temp.ok(app_private.pos_op_classify_legacy_effect('accounting_sale_void', s) ->> 'reason' = 'unexpected_ginpay_payment', 'K M1 cash void with a GINPay payment blocked');

  -- 正しい関係（同じ口座・同じ会計・元の支払いを指す・全額）→ proven、登録できる
  k := 'checkout:' || pg_temp.u(); s := pg_temp.fx_sale('voided', 'ginpay', 1000, k, true, true);
  t := pg_temp.fx_gp('payment', 'posted', -1000, 'sale:' || k, s, null, a);
  v := pg_temp.fx_gp('void', 'posted', 1000, 'sale-void:' || s, s, t, a);
  c := app_private.pos_op_classify_legacy_effect('accounting_sale_void', s);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and c #>> '{effects,1,i}' = v::text and c #>> '{effects,1,pd}' = 'accounting_sale_void',
    'K M1 full relationship proven');
  r := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', v::text);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and (r ->> 'effects')::int = 2, 'K M1 proven void registered with its reversal child');
end $$;

-- K-M2 秘密を保存しない（準備：claimed の GINPay 操作）
do $$
declare
  v_acct text := pg_temp.u();
  p jsonb;
begin
  p := pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', v_acct, 'amount', 1200), 'staff-store-charge:' || pg_temp.u(), 0);
  perform app_private.pos_op_claim((p ->> 'instruction_id')::uuid, array['gpaccount:' || v_acct]);
  perform pg_temp.setv('km2_op', p ->> 'operation_id');
  perform pg_temp.setv('km2_acct', v_acct);
end $$;

do $$
declare
  v_op uuid := pg_temp.getv('km2_op')::uuid;
  v_acct text := pg_temp.getv('km2_acct');
  v_before text;
  r jsonb;
  bad jsonb;
  n integer := 0;
  v_tx uuid;
  v_snap jsonb;
begin
  v_before := pg_temp.registry_counts();
  foreach bad in array array[
      '{"pin":"1234"}', '{"PIN":"1234"}', '{"APR1":"APR1.0123abcd"}', '{"approval_token":"APR1.0123abcd"}', '{"approval":"APR1.0123abcd"}',
      '{"qte1":"QTE1.0123abcd"}', '{"quote_token":"QTE1.0123abcd"}', '{"session_token":"x"}', '{"session_secret":"x"}',
      '{"auth_token":"x"}', '{"bearer":"x"}', '{"credential_hash":"x"}', '{"operator_pin_hash":"$apr1$x$y"}',
      '{"transaction_id":{"pin":"1234"}}', '{"transaction_id":"APR1.0123abcd"}', '{"amount":1200,"memo":"x"}',
      '{"amount":[1200]}', '{"amount":{"value":1200}}', '{}']::jsonb[] loop
    n := n + 1;
    r := app_private.pos_op_finish(v_op, 'completed', null, bad);
    perform pg_temp.ok(r ->> 'error' = 'invalid_result', 'K M2 finish rejects unsafe result #' || n);
  end loop;
  perform pg_temp.ok(pg_temp.registry_counts() = v_before and app_private.pos_op_status_by_operation(v_op) ->> 'status' = 'claimed',
    'K M2 rejected results persisted nothing (operation still claimed)');

  -- finish を通らない直接の書き込みもガードで止まる
  perform pg_temp.err_commit(array[format('update app_private.pos_operations set status = %L, result_snapshot = %L, result_snapshot_hash = %L where operation_id = %L',
      'completed', '{"pin":"1234"}', app_private.pos_op_hash('RES1', '{"pin":"1234"}'), v_op)],
    '%pos_operation_invalid_result%', 'K M2 direct result write with a PIN rejected');
  -- 業務コード・理由に秘密らしいものは入れられない
  perform pg_temp.ok(app_private.pos_op_finish(v_op, 'abandoned', 'pin_1234') ->> 'error' = 'invalid_request', 'K M2 secret-like status code rejected');
  perform pg_temp.ok(app_private.pos_op_fence_key('ginpay_tx', 'staff-store-charge:' || pg_temp.u(), 'APR1.0123abcd') ->> 'error' = 'invalid_request'
    and app_private.pos_op_fence_key('ginpay_tx', 'staff-store-charge:' || pg_temp.u(), 'approval_token') ->> 'error' = 'invalid_request'
    and app_private.pos_op_fence_slot('ginpay:account:' || v_acct, 'session_secret') ->> 'error' = 'invalid_request', 'K M2 secret-like fence reasons rejected');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'K M2 rejected codes/reasons persisted nothing');
  -- 依頼の事実（許可リスト）
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', v_acct, 'amount', 1, 'qte1', 'QTE1.x'), 'staff-store-charge:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts'
    and pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', jsonb_build_object('pin', '1234'), 'amount', 1), 'staff-store-charge:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts',
    'K M2 instruction facts reject QTE1 and nested secrets');
  -- 履歴の detail
  foreach bad in array array['{"pin":"1234"}', '{"approval_token":"APR1.x"}', '{"reason":{"pin":"1"}}', '{"reason":"APR1.x"}', '{"memo":"x"}']::jsonb[] loop
    perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)', v_op, 'claimed', bad)],
      '%pos_event_invalid_detail%', 'K M2 event detail rejected: ' || (select string_agg(k, ',') from jsonb_object_keys(bad) k));
  end loop;
  -- 旧データの代表・効果のスナップショット
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operations (kind, origin, status, result_snapshot, result_snapshot_hash) values (%L, %L, %L, %L, %L)',
      'legacy_sale', 'legacy_discovered', 'completed', pg_temp.legacy_result('legacy_sale') || '{"pin":"1"}', app_private.pos_op_hash('LEG1', pg_temp.legacy_result('legacy_sale') || '{"pin":"1"}'))],
    '%pos_operation_invalid_result%', 'K M2 legacy representative result with a PIN rejected');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operations (kind, origin, status, result_snapshot, result_snapshot_hash) values (%L, %L, %L, %L, %L)',
      'legacy_sale', 'legacy_discovered', 'completed', jsonb_set(pg_temp.legacy_result('legacy_sale'), '{headline}', '{"approval_token":"APR1.x"}'),
      app_private.pos_op_hash('LEG1', jsonb_set(pg_temp.legacy_result('legacy_sale'), '{headline}', '{"approval_token":"APR1.x"}')))],
    '%pos_operation_invalid_result%', 'K M2 legacy headline with a nested approval token rejected');
  v_tx := pg_temp.fx_gp('charge_store', 'posted', 700, 'staff-store-charge:' || pg_temp.u());
  v_snap := pg_temp.gp_snap(v_tx);
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', v_tx, pg_temp.getv('kb2_o2')::uuid, 'ginpay_charge', null, null, v_snap || '{"pin":"1234"}')],
    '%pos_effect_invalid_snapshot%', 'K M2 effect snapshot with an extra PIN key rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', v_tx, pg_temp.getv('kb2_o2')::uuid, 'ginpay_charge', null, null,
      jsonb_set(v_snap, '{idempotency_key}', to_jsonb('APR1.' || repeat('c', 64))))],
    '%pos_effect_invalid_snapshot%', 'K M2 effect snapshot carrying an APR1 token value rejected');
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', v_tx, pg_temp.getv('kb2_o2')::uuid, 'ginpay_charge', null, null, v_snap - 'account_id')],
    '%pos_effect_invalid_snapshot%', 'K M2 effect snapshot missing a required field rejected');

  -- 許可リストどおりの結果は保存できる
  r := app_private.pos_op_finish(v_op, 'completed', null, jsonb_build_object('transaction_id', pg_temp.u(), 'amount', 1200, 'balance_after', 3400));
  perform pg_temp.ok(r ->> 'result' = 'completed', 'K M2 approved safe result accepted');
end $$;

-- 旧データの行に秘密らしい値があれば写さない（登録しない）／会計の quote_hash は QFP1 の指紋だけ
do $$
declare
  k text := 'ticket-issue:' || pg_temp.u();
  ks text := 'checkout:' || pg_temp.u();
  s uuid; c jsonb; r jsonb; v_before text;
begin
  perform pg_temp.fx_ticket_issue(1, 'discount', 500, k, 'AUTH1.' || repeat('a', 64), null, 'QTE1.' || repeat('a', 64));
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_discover_legacy('key', 'ticket_issue', k);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'snapshot_not_representable' and pg_temp.registry_counts() = v_before,
    'K M2 source row with a QTE1-shaped value is not copied into the registry');

  s := pg_temp.fx_sale('completed', 'cash', 800, ks);
  perform set_config('session_replication_role', 'replica', true);
  update public.accounting_sessions set quote_hash = 'QTE1.' || repeat('b', 64) where id = s;
  perform set_config('session_replication_role', 'origin', true);
  c := app_private.pos_op_classify_sale(s);
  perform pg_temp.ok(c #>> '{effects,0,s,quote_fingerprint}' = app_private.pos_op_quote_fingerprint('QTE1.' || repeat('b', 64))
    and c #>> '{effects,0,s,quote_fingerprint}' like 'QFP1.%' and not ((c #> '{effects,0,s}') ? 'quote_hash') and position('QTE1' in c::text) = 0,
    'K M2 quote_hash kept only as a QFP1 fingerprint (QTE1 token never in the snapshot)');
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', ks);
  perform pg_temp.ok(r ->> 'result' = 'discovered', 'K M2 sale with quote fingerprint discovered');
  perform pg_temp.ok(not exists (
      select 1 from app_private.pos_operations where result_snapshot::text ~* '(apr1|qte1)[.$:]' or result_snapshot::text ~* '"[a-z_]*(pin|token|secret)[a-z_]*"'
      union all select 1 from app_private.pos_operation_effects where snapshot::text ~* '(apr1|qte1)[.$:]' or snapshot::text ~* '"[a-z_]*(pin|token|secret)[a-z_]*"'
      union all select 1 from app_private.pos_operation_events where detail::text ~* '(apr1|qte1)[.$:]' or detail::text ~* '"[a-z_]*(pin|token|secret)[a-z_]*"'
      union all select 1 from app_private.pos_business_instructions where facts::text ~* '(apr1|qte1)[.$:]' or facts::text ~* '"[a-z_]*(pin|token|secret)[a-z_]*"'),
    'K M2 no token-shaped value or secret-like key anywhere in stored registry JSON');
end $$;

-- K-M3 lock の順（準備：prepared の会計の操作）
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  p jsonb;
begin
  p := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0);
  perform pg_temp.setv('km3_op', p ->> 'operation_id');
  perform pg_temp.setv('km3_key', k);
end $$;

-- 終了の内部関数は、操作のキー一式の lock を持たずに呼ばれると止まる（あとからキーを取りに行かない）
do $$
begin
  perform pg_temp.err_commit(array[format('select app_private.pos_op_finish_locked(%L, %L, %L, null, false)', pg_temp.getv('km3_op'), 'abandoned', 'test')],
    '%pos_lock_order_violation%', 'K M3 terminal helper refuses to run without the operation key locks');
end $$;

-- 派生キーからの fence は、入口のキーも含めた一式を最初に lock する
do $$
declare
  k text := pg_temp.getv('km3_key');
  r jsonb;
  v_held integer;
begin
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k, 'race');
  select count(distinct l.objid) into v_held from pg_locks l
  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.classid::bigint = 71000001
    and l.objid::bigint in ((app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k))::bigint & 4294967295), (app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k))::bigint & 4294967295));
  perform pg_temp.ok(r ->> 'result' = 'abandoned' and v_held = 2, 'K M3 fence via derived key locked the full key set (entry + derived)');
end $$;

do $$
declare
  k text := 'checkout:' || pg_temp.u();
  r jsonb;
  v_held integer;
begin
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k, 'race');
  select count(distinct l.objid) into v_held from pg_locks l
  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.classid::bigint = 71000001
    and l.objid::bigint in ((app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k))::bigint & 4294967295), (app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k))::bigint & 4294967295));
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and v_held = 2, 'K M3 fence on an unbound sale:<key> also locks its checkout key');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- L. 再監査の指摘への対策（R1 依頼の事実の文字列の値 / R2 キーの lock の約束）
-- ════════════════════════════════════════════════════════════════════════════

-- L-R1 事実の文字列の値：許可された項目でも、秘密の形の値は保存の前に止める（PREPARE 経由でも直接の INSERT でも）
do $$
declare
  v_before text;
  r jsonb;
  bad text;
  n integer := 0;
  v_ok jsonb := jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1);
  v_bad jsonb;
  v_inst uuid := gen_random_uuid();
  v_user text;
begin
  v_before := pg_temp.registry_counts();
  foreach bad in array array[
      'APR1.' || repeat('ab', 32), 'QTE1.' || repeat('cd', 32), 'OPS1.' || repeat('ef', 32), '$apr1$salt$hashhashhash',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', repeat('0f', 32), repeat('a1', 24), 'x-apr1.token'] loop
    n := n + 1;
    r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_set(v_ok, '{user_id}', to_jsonb(bad)), 'ticket-issue:' || pg_temp.u(), 0);
    perform pg_temp.ok(r ->> 'error' = 'invalid_facts' and r ->> 'detail' = 'unsafe_fact_value', 'L R1 PREPARE rejects token-shaped user_id #' || n);
  end loop;
  -- ほかの文字列の項目（method）に Bearer / $apr1$、配列（ticket_ids）の中、入れ子の object
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100, 'method', 'Bearer abc.def'),
      'staff-store-charge:' || pg_temp.u(), 0) ->> 'detail' = 'unsafe_fact_value', 'L R1 PREPARE rejects Bearer value in method');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100, 'method', '$apr1$x$y'),
      'staff-store-charge:' || pg_temp.u(), 0) ->> 'detail' = 'unsafe_fact_value', 'L R1 PREPARE rejects $apr1$ value in method');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u(), 'ticket_ids', jsonb_build_array('APR1.' || repeat('ab', 32))),
      'checkout:' || pg_temp.u(), 0) ->> 'detail' = 'unsafe_fact_value', 'L R1 PREPARE rejects token inside ticket_ids array');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_set(v_ok, '{user_id}', jsonb_build_object('id', 'QTE1.' || repeat('cd', 32))),
      'ticket-issue:' || pg_temp.u(), 0) ->> 'error' = 'invalid_facts', 'L R1 PREPARE rejects nested object carrying a token');
  perform pg_temp.ok(app_private.pos_op_validate_facts('ticket_issue', jsonb_set(v_ok, '{user_id}', to_jsonb('APR1.' || repeat('ab', 32)))) = 'unsafe_fact_value',
    'L R1 shared validator flags the value shape (not the field name)');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'L R1 rejected facts persisted nothing');

  -- 直接の INSERT（PREPARE を通らない）も表のガードで止まる。安全な事実で同じ形なら、事実ではなく操作の不一致で止まる（対照）
  v_bad := jsonb_set(v_ok, '{user_id}', to_jsonb('APR1.' || repeat('ab', 32)));
  perform pg_temp.err_commit(array[format('insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, '
      || 'observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest) values (%L, %L, %L, null, %L, %L, 0, 1, %L, %L, %L, %L)',
      v_inst, gen_random_uuid(), 'accepted', 'ticket_issue', 'ticket_issue:user:' || (v_bad ->> 'user_id'), v_bad,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', 'ticket_issue:user:' || (v_bad ->> 'user_id'), 'facts', v_bad)),
      'ticket_issue', app_private.pos_op_key_ident('ticket_issue', 'ticket-issue:' || pg_temp.u()))],
    '%pos_instruction_invalid_facts: unsafe_fact_value%', 'L R1 direct INSERT of an instruction with APR1 user_id rejected by table guard');
  v_bad := jsonb_build_object('account_id', pg_temp.u(), 'amount', 100, 'method', 'Bearer abc');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, '
      || 'observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest) values (%L, %L, %L, %L, %L, %L, 0, null, %L, %L, %L, %L)',
      gen_random_uuid(), gen_random_uuid(), 'refused', 'stale_epoch', 'ginpay_charge', 'ginpay:account:' || (v_bad ->> 'account_id'), v_bad,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ginpay_charge', 'slot', 'ginpay:account:' || (v_bad ->> 'account_id'), 'facts', v_bad)),
      'ginpay_tx', app_private.pos_op_key_ident('ginpay_tx', 'staff-store-charge:' || pg_temp.u()))],
    '%pos_instruction_invalid_facts: unsafe_fact_value%', 'L R1 direct INSERT of a refused instruction with Bearer method rejected by table guard');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, '
      || 'observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest) values (%L, %L, %L, null, %L, %L, 0, 1, %L, %L, %L, %L)',
      gen_random_uuid(), gen_random_uuid(), 'accepted', 'ticket_issue', 'ticket_issue:user:' || (v_ok ->> 'user_id'), v_ok,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', 'ticket_issue:user:' || (v_ok ->> 'user_id'), 'facts', v_ok)),
      'ticket_issue', app_private.pos_op_key_ident('ticket_issue', 'ticket-issue:' || pg_temp.u()))],
    '%pos_instruction_operation_mismatch%', 'L R1 control: same direct INSERT with safe facts gets past the facts check');

  -- 正しい値はこれまでどおり通る
  foreach v_user in array array['c1-user-' || pg_temp.u(), pg_temp.u(), 'U' || repeat('0a', 16), 'u-' || repeat('9b', 12)] loop
    r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_set(v_ok, '{user_id}', to_jsonb(v_user)) || '{"ticket_type":"cut-ticket"}', 'ticket-issue:' || pg_temp.u(), 0);
    perform pg_temp.ok(r ->> 'result' = 'prepared', 'L R1 legitimate user_id accepted: ' || left(v_user, 12));
  end loop;
  r := pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'client_id', pg_temp.u(), 'amount', 2500, 'method', 'cash'),
    'staff-store-charge:' || pg_temp.u(), 0);
  perform pg_temp.ok(r ->> 'result' = 'prepared', 'L R1 legitimate account/client ids and method accepted');
  perform pg_temp.ok(not exists (select 1 from app_private.pos_business_instructions where not app_private.pos_op_json_safe(facts)),
    'L R1 no stored instruction facts violate the shared token-shape policy');
end $$;

-- L-R2 lock の約束：assert は「今のバックエンドが ExclusiveLock で持っている」ことだけを見る（スコープは見ない）
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  p jsonb;
begin
  p := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0);
  perform pg_temp.setv('lr2_op', p ->> 'operation_id');
  perform pg_temp.setv('lr2_key', k);
end $$;

-- 何も lock していない（このトランザクションの始め。前の文の xact lock は COMMIT で外れている）
do $$
begin
  perform pg_temp.ok(not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid::bigint between 71000001 and 71000003),
    'L R2 clean session: no B-2C advisory locks held at transaction start');
  perform pg_temp.err_commit(array[format('select app_private.pos_op_assert_keys_locked(app_private.pos_op_operation_keys(%L))', pg_temp.getv('lr2_op'))],
    '%pos_lock_order_violation%', 'L R2 A: no lock => possession assertion fails');
end $$;

-- ShareLock だけ：assert も中核も止まる
do $$
declare
  k text := pg_temp.getv('lr2_key');
begin
  perform pg_advisory_xact_lock_shared(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k)));
  perform pg_advisory_xact_lock_shared(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k)));
  perform pg_temp.ok((select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid::bigint = 71000001 and mode = 'ShareLock' and granted) = 2,
    'L R2 B setup: matching ShareLocks held');
  perform pg_temp.err_commit(array[format('select app_private.pos_op_assert_keys_locked(app_private.pos_op_operation_keys(%L))', pg_temp.getv('lr2_op'))],
    '%pos_lock_order_violation%', 'L R2 B: ShareLock only => possession assertion fails');
  perform pg_temp.err_commit(array[format('select app_private.pos_op_finish_locked(%L, %L, %L, null, false)', pg_temp.getv('lr2_op'), 'abandoned', 'test')],
    '%pos_lock_order_violation%', 'L R2 B: ShareLock only => terminal core refuses');
end $$;

-- 今のバックエンドの ExclusiveLock：持っていることの確認は通る（これはスコープの証明ではない）
do $$
declare
  v_msg text;
begin
  perform app_private.pos_op_lock_keys_xact(app_private.pos_op_operation_keys(pg_temp.getv('lr2_op')::uuid));
  begin
    perform app_private.pos_op_assert_keys_locked(app_private.pos_op_operation_keys(pg_temp.getv('lr2_op')::uuid));
  exception when others then v_msg := sqlerrm;
  end;
  perform pg_temp.ok(v_msg is null, 'L R2 C: current-backend ExclusiveLock => possession assertion passes (possession only, not scope) (' || coalesce(v_msg, 'ok') || ')');
end $$;

-- 正しい入口の lock はトランザクション単位：中では持っていて、COMMIT のあとは何も残らない（finish）
do $$
declare
  r jsonb;
  v_held integer;
begin
  r := app_private.pos_op_finish(pg_temp.getv('lr2_op')::uuid, 'abandoned', 'test');
  select count(*) into v_held from pg_locks l
  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.mode = 'ExclusiveLock' and l.classid::bigint = 71000001;
  perform pg_temp.ok(r ->> 'result' = 'abandoned' and v_held = 2, 'L R2 wrapper (pos_op_finish) holds the full exclusive key set while the transaction is active');
end $$;
do $$
begin
  perform pg_temp.ok(not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid::bigint between 71000001 and 71000003),
    'L R2 after COMMIT: no B-2C advisory lock acquired by pos_op_finish remains (transaction-scoped)');
end $$;

-- 同じく fence（派生キー）の入口
do $$
declare
  k text := 'checkout:' || pg_temp.u();
begin
  perform pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0);
  perform pg_temp.setv('lr2_fkey', k);
end $$;
do $$
declare
  r jsonb;
  v_held integer;
begin
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || pg_temp.getv('lr2_fkey'), 'test');
  select count(*) into v_held from pg_locks l
  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.mode = 'ExclusiveLock' and l.classid::bigint = 71000001;
  perform pg_temp.ok(r ->> 'result' = 'abandoned' and v_held = 2, 'L R2 wrapper (pos_op_fence_key) holds the full exclusive key set while the transaction is active');
end $$;
do $$
begin
  perform pg_temp.ok(not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid::bigint between 71000001 and 71000003),
    'L R2 after COMMIT: no B-2C advisory lock acquired by pos_op_fence_key remains (transaction-scoped)');
end $$;

-- セッション単位の lock と分ける：トランザクション A でテスト自身がセッションの lock を取り COMMIT、
-- トランザクション B で入口を呼ぶ。B のあと、テストが取ったセッションの lock を1回外すと何も残らない
-- （入口がセッションの lock を足していたら、もう1つ残る）。2回目の unlock は false（持っていない）
do $$
declare
  k text := 'checkout:' || pg_temp.u();
begin
  perform pg_temp.setv('lr2_sop', pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0) ->> 'operation_id');
  perform pg_temp.setv('lr2_skey', k);
end $$;
do $$
declare
  k text := pg_temp.getv('lr2_skey');
begin
  perform pg_advisory_lock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k)));
  perform pg_advisory_lock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k)));
end $$;
do $$
declare
  r jsonb;
begin
  r := app_private.pos_op_finish(pg_temp.getv('lr2_sop')::uuid, 'abandoned', 'test');
  perform pg_temp.ok(r ->> 'result' = 'abandoned', 'L R2 session test: wrapper runs in transaction B (its own xact locks taken via pos_op_lock_keys_xact)');
end $$;
do $$
declare
  k text := pg_temp.getv('lr2_skey');
  v_first boolean;
  v_second boolean;
  v_left integer;
begin
  -- B のあとに残っているのはテストが A で取ったセッションの lock だけ（入口の lock と取り違えない）
  perform pg_temp.ok((select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid::bigint = 71000001) = 2,
    'L R2 session test: after B only the two intentionally created session locks are visible');
  v_first := pg_advisory_unlock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k))) and pg_advisory_unlock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k)));
  select count(*) into v_left from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid::bigint between 71000001 and 71000003;
  set local client_min_messages = error;
  v_second := pg_advisory_unlock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k))) or pg_advisory_unlock(71000001, app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || k)));
  perform pg_temp.ok(v_first and v_left = 0 and not v_second,
    'L R2 session test: one unlock per test session lock clears everything; the wrapper added no session-level hold');
end $$;
do $$
begin
  perform pg_advisory_unlock_all();
  perform pg_temp.ok(not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()), 'L R2 session test cleanup: no advisory locks left');
  perform pg_temp.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'app_private' and p.proname like 'pos\_op\_%'
                                   and p.prosrc ~ 'pg_advisory_lock\s*\(|pg_advisory_lock_shared\s*\(|pg_try_advisory_lock\s*\('),
    'L R2 no pos_op_* function uses a session-level advisory lock');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- M. 最終の再監査への対策（F1 お客様の提示トークン GJC1 / F2 保存するコードと文字列の列 / L2 型の付いたハッシュの欄）
-- ════════════════════════════════════════════════════════════════════════════

-- 本物と同じ作り方の GJC1 トークン（20261009000100 customer_issue_presence_token と同じ式）と、- _ を含む決まった形のもの
create function pg_temp.gjc1() returns text language sql as $$
  select 'GJC1.' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=') $$;
create function pg_temp.gjc1_fixed() returns text language sql as $$
  select 'GJC1.' || repeat('A', 21) || '_-' || repeat('b', 20) $$;

-- M-F1 GJC1 の形：本物の文法（^GJC1\.[A-Za-z0-9_-]{43}$）の値は必ず秘密らしい。"GJC1" を含むだけの普通の文字列は当たらない
do $$
declare
  v_tok text := pg_temp.gjc1();
  v_ctl text;
  n integer := 0;
begin
  perform pg_temp.ok(v_tok ~ '^GJC1\.[A-Za-z0-9_-]{43}$' and length(v_tok) = 48 and pg_temp.gjc1_fixed() ~ '^GJC1\.[A-Za-z0-9_-]{43}$',
    'M F1 test tokens follow the repository GJC1 grammar (GJC1. + 43 base64url, 48 chars)');
  perform pg_temp.ok(app_private.pos_op_secret_like(v_tok) and app_private.pos_op_secret_like(pg_temp.gjc1_fixed()),
    'M F1 secret_like: real-format GJC1 tokens are secret-like');
  perform pg_temp.ok(app_private.pos_op_secret_like('x:' || v_tok) and app_private.pos_op_secret_like('note ' || pg_temp.gjc1_fixed() || ' end')
    and app_private.pos_op_secret_like('ticket_issue:user:' || v_tok),
    'M F1 secret_like: GJC1 token embedded after a prefix or inside text is secret-like');
  perform pg_temp.ok(not app_private.pos_op_json_safe(to_jsonb(v_tok)), 'M F1 json_safe rejects a bare GJC1 string');
  foreach v_ctl in array array['GJC1', 'GJC1.', 'GJC1.short', 'GJC1.too-short', 'GJC1.' || repeat('A', 42), 'GJC1-report', 'gjc1_note',
                                'my GJC1 counter', pg_temp.u(), 'c1-user-' || pg_temp.u(), 'U' || repeat('0a', 16), 'u-' || repeat('9b', 12)] loop
    n := n + 1;
    perform pg_temp.ok(not app_private.pos_op_secret_like(v_ctl), 'M F1 false-positive control not secret-like #' || n || ': ' || left(v_ctl, 16));
  end loop;
end $$;

-- M-F1 PREPARE（事実の user_id に GJC1）：保存の前に止まり、依頼・操作・枠・キー・履歴のどれも書かれない
do $$
declare
  v_tok text := pg_temp.gjc1();
  v_key text := 'ticket-issue:' || pg_temp.u();
  v_facts jsonb;
  v_before text;
  r jsonb;
begin
  v_facts := jsonb_build_object('user_id', v_tok, 'ticket_type', 'discount', 'amount', 500, 'quantity', 1);
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', v_facts, v_key, 0);
  perform pg_temp.ok(r ->> 'ok' = 'false' and r ->> 'error' = 'invalid_facts' and r ->> 'detail' = 'unsafe_fact_value',
    'M F1 PREPARE rejects ticket_issue user_id = GJC1 token (' || r::text || ')');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'M F1 rejected GJC1 PREPARE wrote nothing (all registry counts and slot epochs unchanged)');
  perform pg_temp.ok(not exists (select 1 from app_private.pos_business_slots where slot_key = 'ticket_issue:user:' || v_tok)
    and not exists (select 1 from app_private.pos_operation_keys where key_digest = app_private.pos_op_key_ident('ticket_issue', v_key))
    and not exists (select 1 from app_private.pos_operation_events where detail::text like '%GJC1.%'),
    'M F1 rejected GJC1 PREPARE: no slot row, no key binding');
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_set(v_facts, '{user_id}', to_jsonb(pg_temp.gjc1_fixed())), 'ticket-issue:' || pg_temp.u(), 0);
  perform pg_temp.ok(r ->> 'detail' = 'unsafe_fact_value', 'M F1 PREPARE rejects the fixed-shape GJC1 token too');
  -- 対照：GJC1 の形でない user_id は通る
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_set(v_facts, '{user_id}', '"GJC1.short"'), 'ticket-issue:' || pg_temp.u(), 0);
  perform pg_temp.ok(r ->> 'result' = 'prepared', 'M F1 control: user_id "GJC1.short" (not the credential grammar) is accepted');
  -- 記録者名（actor_name）に GJC1 も止まる
  r := app_private.pos_op_prepare(gen_random_uuid(), 'ticket_issue', jsonb_set(v_facts, '{user_id}', to_jsonb('c1-user-' || pg_temp.u())),
    'ticket-issue:' || pg_temp.u(), 0, null, 'test', 'scan ' || v_tok);
  perform pg_temp.ok(r ->> 'error' = 'invalid_request', 'M F1 PREPARE rejects a GJC1 token in actor_name');
end $$;

-- M-F1 直接の INSERT（受理・拒否の両方の形）も表のガードで止まる
do $$
declare
  v_tok text := pg_temp.gjc1();
  v_bad jsonb;
  v_before text := pg_temp.registry_counts();
begin
  v_bad := jsonb_build_object('user_id', v_tok, 'ticket_type', 'discount', 'amount', 500, 'quantity', 1);
  perform pg_temp.err_commit(array[format('insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, '
      || 'observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest) values (%L, %L, %L, null, %L, %L, 0, 1, %L, %L, %L, %L)',
      gen_random_uuid(), gen_random_uuid(), 'accepted', 'ticket_issue', 'ticket_issue:user:' || v_tok, v_bad,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', 'ticket_issue:user:' || v_tok, 'facts', v_bad)),
      'ticket_issue', app_private.pos_op_key_ident('ticket_issue', 'ticket-issue:' || pg_temp.u()))],
    '%pos_instruction_invalid_facts: unsafe_fact_value%', 'M F1 direct INSERT of an accepted instruction with GJC1 user_id rejected by table guard');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, '
      || 'observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest) values (%L, %L, %L, %L, %L, %L, 0, null, %L, %L, %L, %L)',
      gen_random_uuid(), gen_random_uuid(), 'refused', 'slot_busy', 'ticket_issue', 'ticket_issue:user:' || v_tok, v_bad,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', 'ticket_issue:user:' || v_tok, 'facts', v_bad)),
      'ticket_issue', app_private.pos_op_key_ident('ticket_issue', 'ticket-issue:' || pg_temp.u()))],
    '%pos_instruction_invalid_facts: unsafe_fact_value%', 'M F1 direct INSERT of a refused instruction with GJC1 user_id rejected by table guard');
  -- ガードを止めても、表の CHECK が枠の名前・記録者名の GJC1 を止める
  perform pg_temp.err_commit(array[format('insert into app_private.pos_business_slots (slot_key, slot_kind) values (%L, %L)', 'ticket_issue:user:' || v_tok, 'ticket_issue_user')],
    '%pos_business_slots_key_safe%', 'M F1 direct INSERT of a slot named after a GJC1 token rejected by CHECK');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'M F1 direct INSERT attempts left nothing behind');
  perform pg_temp.ok(not exists (select 1 from app_private.pos_business_instructions where facts::text ~ 'GJC1\.[A-Za-z0-9_-]{43}'),
    'M F1 no stored instruction facts contain a GJC1 token');
end $$;

-- M-F1 共通の JSON の検査（入れ子・配列）：どの面（事実・結果・効果・履歴）でも GJC1 は保存されない
do $$
declare
  v_tok text := pg_temp.gjc1();
  v_shape jsonb;
  v_op uuid;
  v_n integer := 0;
  r jsonb;
begin
  foreach v_shape in array array[jsonb_build_object('x', v_tok), jsonb_build_object('x', jsonb_build_array(v_tok)),
                                 jsonb_build_object('x', jsonb_build_object('y', v_tok)), jsonb_build_object('x', jsonb_build_array(jsonb_build_object('y', jsonb_build_array(v_tok))))] loop
    v_n := v_n + 1;
    perform pg_temp.ok(not app_private.pos_op_json_safe(v_shape), 'M F1 json_safe rejects nested GJC1 shape #' || v_n);
    perform pg_temp.ok(app_private.pos_op_validate_facts('ticket_issue', v_shape) = 'unsafe_fact_value', 'M F1 facts validator rejects nested GJC1 shape #' || v_n);
    perform pg_temp.ok(app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('event'), v_shape, false) = 'secret_like_value',
      'M F1 event validator rejects nested GJC1 shape #' || v_n);
    perform pg_temp.ok(app_private.pos_op_validate_result('ticket_issue', 'prepared', v_shape) = 'secret_like_value',
      'M F1 result validator rejects nested GJC1 shape #' || v_n);
    perform pg_temp.ok(app_private.pos_op_validate_effect_snapshot('ginpay_charge', v_shape) = 'secret_like_value',
      'M F1 effect validator rejects nested GJC1 shape #' || v_n);
  end loop;
  perform pg_temp.ok(app_private.pos_op_validate_facts('ticket_issue', jsonb_build_object('user_id', jsonb_build_array(v_tok), 'ticket_type', 'discount', 'amount', 1, 'quantity', 1))
    = 'unsafe_fact_value', 'M F1 facts validator rejects GJC1 inside an array under an allowed key');

  -- 結果（PREPARE → finish の completed は claimed が要るので、検査が先に走る finish の入口で見る）
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), 0);
  v_op := (r ->> 'operation_id')::uuid;
  r := app_private.pos_op_finish(v_op, 'completed', null, jsonb_build_object('log_id', v_tok));
  perform pg_temp.ok(r ->> 'error' = 'invalid_result' and r ->> 'detail' = 'secret_like_value', 'M F1 finish rejects a GJC1 token in the result snapshot');
  perform pg_temp.ok((select status from app_private.pos_operations where operation_id = v_op) = 'prepared', 'M F1 rejected result left the operation unchanged');
  perform pg_temp.setv('m_prepared_op', v_op::text);

  -- 履歴の直接の INSERT
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
      v_op, 'prepared', jsonb_build_object('code', v_tok))],
    '%pos_event_invalid_detail: secret_like_value%', 'M F1 direct INSERT of an event carrying a GJC1 token rejected');
  -- 効果の直接の INSERT（完了済みの操作に、GJC1 を二重送信防止キーの欄に入れたスナップショット）
  select operation_id into v_op from app_private.pos_operations where status = 'completed' limit 1;
  perform pg_temp.err_commit(array[pg_temp.eff_sql('ginpay_transaction', '00000000-0000-4000-8000-0000000000f1'::uuid, v_op, 'ginpay_charge', null, null,
      jsonb_build_object('transaction_id', '00000000-0000-4000-8000-0000000000f1', 'account_id', pg_temp.u(), 'type', 'charge_cash', 'amount', 100,
        'status', 'completed', 'accounting_session_id', null, 'original_transaction_id', null, 'idempotency_key', v_tok,
        'created_at', app_private.pos_op_ts(now())))],
    '%pos_effect_invalid_snapshot: secret_like_value%', 'M F1 direct INSERT of an effect snapshot carrying a GJC1 token rejected');
end $$;

-- M-F1 資源の名前：CLAIM は GJC1 の形の資源を受け付けない（表の CHECK も止める）。
-- 二重送信防止キーとして渡された GJC1 は、文字列を保存せず digest だけで扱う（CG1。N 節で確かめる）
do $$
declare
  v_tok text := pg_temp.gjc1();
  v_before text;
  r jsonb;
  v_inst uuid;
begin
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), 0);
  v_inst := (r ->> 'instruction_id')::uuid;
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_claim(v_inst, array['customer:' || v_tok]);
  perform pg_temp.ok(r ->> 'error' = 'invalid_request' and pg_temp.registry_counts() = v_before, 'M F1 CLAIM refuses a GJC1 token in a target key (nothing written)');
  perform pg_temp.setv('m_prepared_inst', v_inst::text);
end $$;

-- M-F2 保存するコードの検査は1つ（pos_op_code_ok = 形 AND 秘密らしい名前でない AND 秘密らしい値の形でない）
do $$
declare
  v_bad text;
  v_code text;
  n integer := 0;
begin
  foreach v_bad in array array['APR1.' || repeat('ab', 32), 'QTE1.' || repeat('cd', 32), 'OPS1.' || repeat('ef', 32), pg_temp.gjc1(), pg_temp.gjc1_fixed(),
                               'Bearer abc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', repeat('ab', 32), repeat('0f', 24), 'a' || repeat('0', 47),
                               'code_' || repeat('ab', 24), 'apr1_x', 'gjc1_token'] loop
    n := n + 1;
    perform pg_temp.ok(not app_private.pos_op_code_ok(v_bad), 'M F2 code_ok rejects #' || n || ': ' || left(v_bad, 14));
  end loop;
  perform pg_temp.ok(repeat('ab', 32) ~ '^[a-z][a-z0-9_]{0,63}$' and app_private.pos_op_secret_like(repeat('ab', 32)),
    'M F2 the Codex value repeat(ab,32) passes the structural grammar but is secret-like');
  foreach v_code in array array['stale_epoch', 'slot_busy', 'target_busy', 'legacy_state_blocked', 'legacy_key_present', 'key_conflict',
                                'instruction_conflict', 'fenced', 'slot_fenced', 'fence', 'operation_in_progress', 'awaiting_approval'] loop
    perform pg_temp.ok(app_private.pos_op_code_ok(v_code), 'M F2 code_ok accepts repository code: ' || v_code);
  end loop;
end $$;

-- M-F2 表の境界：last_code の直接の UPDATE / INSERT は、その文の時点で失敗する（あとで戻されるのを待たない）
do $$
declare
  v_op uuid := pg_temp.getv('m_prepared_op')::uuid;
  v_bad text;
  n integer := 0;
begin
  -- Codex の再現：prepared の操作の last_code = repeat('ab', 32)
  perform pg_temp.err(format('update app_private.pos_operations set last_code = %L where operation_id = %L', repeat('ab', 32), v_op),
    '%pos_operation_invalid_code%', 'M F2 direct UPDATE last_code = repeat(ab,32) fails at the statement (row guard)');
  perform pg_temp.err_commit(array[format('update app_private.pos_operations set last_code = %L where operation_id = %L', repeat('ab', 32), v_op)],
    '%pos_operations_last_code_safe%', 'M F2 direct UPDATE last_code = repeat(ab,32) fails by table CHECK alone (guard disabled)',
    array['app_private.pos_operations|pos_operations_guard']);
  foreach v_bad in array array['f' || repeat('0f', 24), 'z' || repeat('a1', 30), 'apr1_' || 'x', 'gjc1_x'] loop
    n := n + 1;
    perform pg_temp.err_commit(array[format('update app_private.pos_operations set last_code = %L where operation_id = %L', v_bad, v_op)],
      '%pos_operations_last_code_safe%', 'M F2 CHECK rejects secret-shaped last_code #' || n, array['app_private.pos_operations|pos_operations_guard']);
  end loop;
  -- 構造で落ちる形（APR1. / GJC1. / Bearer / JWT）も CHECK で止まる
  foreach v_bad in array array['APR1.' || repeat('ab', 32), pg_temp.gjc1(), 'Bearer abc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'] loop
    n := n + 1;
    perform pg_temp.err_commit(array[format('update app_private.pos_operations set last_code = %L where operation_id = %L', v_bad, v_op)],
      '%pos_operations%check%', 'M F2 CHECK rejects token last_code #' || n, array['app_private.pos_operations|pos_operations_guard']);
  end loop;
  -- 取り消しの印の INSERT（ガードは last_code を見ない形）も CHECK で止まる
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operations (kind, origin, status, terminal_at, last_code) values (%L, %L, %L, now(), %L)',
      'key_tombstone', 'negative_tombstone', 'abandoned', repeat('ab', 32))],
    '%pos_operations_last_code_safe%', 'M F2 direct INSERT of a tombstone with secret-shaped last_code rejected by CHECK');
  -- 対照：正しいコードへの直接の書き換えは通る（状態はそのまま、途中のコードだけ）
  update app_private.pos_operations set last_code = 'awaiting_approval' where operation_id = v_op;
  perform pg_temp.ok((select last_code from app_private.pos_operations where operation_id = v_op) = 'awaiting_approval',
    'M F2 control: direct UPDATE to a valid symbolic code is accepted');
end $$;

-- M-F2 内部の書き込み口（finish / fence_key / fence_slot）：秘密の形のコード・理由は拒否、正しいコードはこれまでどおり保存される
do $$
declare
  v_op uuid := pg_temp.getv('m_prepared_op')::uuid;
  v_inst uuid := pg_temp.getv('m_prepared_inst')::uuid;
  v_bad text;
  v_slot text;
  r jsonb;
  n integer := 0;
begin
  foreach v_bad in array array[repeat('ab', 32), 'APR1.' || repeat('ab', 32), pg_temp.gjc1(), 'Bearer abc'] loop
    n := n + 1;
    r := app_private.pos_op_finish(v_op, 'abandoned', v_bad);
    perform pg_temp.ok(r ->> 'error' = 'invalid_request', 'M F2 finish rejects secret-shaped code #' || n);
    r := app_private.pos_op_fence_key('ticket_issue', 'ticket-issue:' || pg_temp.u(), v_bad);
    perform pg_temp.ok(r ->> 'error' = 'invalid_request', 'M F2 fence_key rejects secret-shaped reason #' || n);
    r := app_private.pos_op_fence_slot('ticket_issue:user:nobody', v_bad);
    perform pg_temp.ok(r ->> 'error' = 'invalid_request', 'M F2 fence_slot rejects secret-shaped reason #' || n);
  end loop;
  perform pg_temp.ok((select status from app_private.pos_operations where operation_id = v_op) = 'prepared'
    and (select last_code from app_private.pos_operations where operation_id = v_op) = 'awaiting_approval',
    'M F2 rejected helper calls changed nothing');

  -- 正しいコード：abandoned + legacy_state_blocked、claimed → rejected + target_busy、fence_key の fenced、fence_slot の slot_fenced
  r := app_private.pos_op_finish(v_op, 'abandoned', 'legacy_state_blocked');
  perform pg_temp.ok(r ->> 'result' = 'abandoned' and (select last_code from app_private.pos_operations where operation_id = v_op) = 'legacy_state_blocked',
    'M F2 finish stores a valid code (legacy_state_blocked)');
  r := app_private.pos_op_claim(v_inst, array['customer:m-' || pg_temp.u()]);
  perform pg_temp.ok(r ->> 'result' = 'claimed', 'M F2 claim for the valid-code path');
  r := app_private.pos_op_finish((r ->> 'operation_id')::uuid, 'rejected', 'target_busy');
  perform pg_temp.ok(r ->> 'result' = 'rejected' and exists (select 1 from app_private.pos_operations where operation_id = (r ->> 'operation_id')::uuid and last_code = 'target_busy'),
    'M F2 finish stores a valid code (target_busy)');
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    pg_temp.keep('m_fence_key', 'ticket-issue:' || pg_temp.u()), 0);
  v_slot := r ->> 'slot_key';
  r := app_private.pos_op_fence_key('ticket_issue', pg_temp.getv('m_fence_key'), 'operator_cancel');
  perform pg_temp.ok(r ->> 'result' = 'abandoned' and exists (select 1 from app_private.pos_operations where operation_id = (r ->> 'operation_id')::uuid and last_code = 'fenced'),
    'M F2 fence_key stores the fenced code');
  r := app_private.pos_op_fence_slot(v_slot, 'operator_reset');
  perform pg_temp.ok(r ->> 'result' = 'slot_fenced', 'M F2 fence_slot with a valid reason');
  perform pg_temp.ok(exists (select 1 from app_private.pos_operation_events where slot_key = v_slot and event_type = 'slot_fenced' and detail ->> 'reason' = 'operator_reset'),
    'M F2 fence_slot reason stored in the event detail');
  perform pg_temp.ok(exists (select 1 from app_private.pos_business_instructions where refusal_code = 'stale_epoch')
    and exists (select 1 from app_private.pos_business_instructions where refusal_code = 'slot_busy'),
    'M F2 refusal codes stale_epoch / slot_busy still stored by PREPARE');
end $$;

-- M-F2 ほかの保存する文字列の列（キー・資源・宣言・記録者名・入口のキー・分類の版）：表の CHECK で止まる（ガードを止めても）
-- claimed の操作は別のトランザクションで用意する（同じトランザクションに遅延の検査が残っているとトリガーを止められない）
do $$
declare
  r jsonb;
begin
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), 0);
  r := app_private.pos_op_claim((r ->> 'instruction_id')::uuid, array['customer:m2-' || pg_temp.u()]);
  perform pg_temp.ok(r ->> 'result' = 'claimed', 'M F2 claimed fixture for direct column writes');
  perform pg_temp.setv('m_claimed_op', r ->> 'operation_id');
end $$;

do $$
declare
  v_tok text := pg_temp.gjc1();
  v_tomb uuid;
  v_claimed uuid := pg_temp.getv('m_claimed_op')::uuid;
  v_done uuid;
begin
  select operation_id into v_tomb from app_private.pos_operations where origin = 'negative_tombstone' limit 1;
  select operation_id into v_done from app_private.pos_operations where status = 'completed' limit 1;
  perform pg_temp.ok(v_claimed is not null and v_tomb is not null and v_done is not null, 'M F2 fixtures for direct column writes');
  -- キーの表は文字列の列を持たない（digest の bytea だけ）。長さの違う digest は CHECK で止まる
  perform pg_temp.ok(not exists (select 1 from information_schema.columns where table_schema = 'app_private' and table_name = 'pos_operation_keys'
                                 and data_type in ('text', 'character varying', 'jsonb') and column_name not in ('key_domain', 'key_role')),
    'M F2 pos_operation_keys has no free-text key column (only key_domain/key_role codes and the bytea digest)');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, %L, %L, %L)',
      'ticket_issue', '\x' || repeat('ab', 31), v_tomb, 'fence')],
    '%pos_operation_keys_key_digest_check%', 'M F2 direct INSERT of a 31-byte key digest rejected by CHECK');
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_targets (operation_id, target_key) values (%L, %L)', v_claimed, 'customer:' || v_tok)],
    '%pos_operation_targets_key_safe%', 'M F2 direct INSERT of a GJC1 target key rejected by CHECK (guard disabled)',
    array['app_private.pos_operation_targets|pos_operation_targets_guard']);
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_required_targets (operation_id, target_key) values (%L, %L)', v_claimed, 'x:OPS1.' || repeat('ef', 32))],
    '%pos_operation_required_targets_key_safe%', 'M F2 direct INSERT of an OPS1 declared target rejected by CHECK (guard disabled)',
    array['app_private.pos_operation_required_targets|pos_operation_required_targets_guard']);
  perform pg_temp.err_commit(array[format('update app_private.pos_business_instructions set actor_name = %L where instruction_id = (select instruction_id from app_private.pos_business_instructions limit 1)',
      'Bearer abc')],
    '%pos_business_instructions_text_safe%', 'M F2 direct UPDATE of actor_name to a Bearer value rejected by CHECK (immutability trigger disabled)',
    array['app_private.pos_business_instructions|pos_business_instructions_no_update_delete']);
  perform pg_temp.err_commit(array[replace(pg_temp.eff_sql('ticket_issue', gen_random_uuid(), v_done, 'ticket_issue', null, null, '{}'::jsonb), '''c1-legacy-v1''', '''apr1.x''')],
    '%pos_operation_effects_classifier_safe%', 'M F2 direct INSERT of an effect with an APR1-shaped classifier_version rejected by CHECK (guard disabled)',
    array['app_private.pos_operation_effects|pos_operation_effects_guard']);
end $$;

-- L2 型の付いたハッシュの欄：REQ1./AUTH1.（hash）と QFP1.（fp）は、その欄だけ厳密な形で通る。接頭辞の無い 64 桁の 16 進はどこでも通らない
do $$
declare
  h64 text := repeat('0123456789abcdef', 4);
  v_snap jsonb;
  ks text := 'checkout:' || pg_temp.u();
  kb text := 'checkout:' || pg_temp.u();
  s uuid;
  r jsonb;
  v_before text;
begin
  perform pg_temp.ok(app_private.pos_op_value_ok('hash', to_jsonb('REQ1.' || h64)) and app_private.pos_op_value_ok('hash', to_jsonb('AUTH1.' || h64))
    and app_private.pos_op_value_ok('fp', to_jsonb('QFP1.' || h64)), 'M L2 typed hash/fp fields accept REQ1./AUTH1./QFP1. + 64 hex');
  perform pg_temp.ok(not app_private.pos_op_value_ok('hash', to_jsonb(h64)) and app_private.pos_op_secret_like(h64),
    'M L2 bare 64-hex is rejected by both the typed hash validator and the generic rule (consistent)');
  perform pg_temp.ok(not app_private.pos_op_value_ok('hash', to_jsonb('APR1.' || h64)) and not app_private.pos_op_value_ok('hash', to_jsonb(pg_temp.gjc1()))
    and not app_private.pos_op_value_ok('hash', to_jsonb('AUTH1.' || h64 || 'x')) and not app_private.pos_op_value_ok('fp', to_jsonb('AUTH1.' || h64)),
    'M L2 typed hash/fp grammar is exact (no APR1/GJC1, no trailing data, fp only QFP1)');
  perform pg_temp.ok(not app_private.pos_op_json_safe(to_jsonb('AUTH1.' || h64)) and not app_private.pos_op_json_safe(to_jsonb('QFP1.' || h64)),
    'M L2 AUTH1/QFP1 values are still rejected as free-form strings');
  -- 会計の効果のスナップショット：request_hash は REQ1 なら通る、裸の 64 桁・APR1 は通らない。同じ値を型の無い欄（idempotency_key）に入れると通らない
  v_snap := jsonb_build_object('sale_id', pg_temp.u(), 'status_at_discovery', 'completed', 'completed_at', app_private.pos_op_ts(now()), 'total', 100,
    'subtotal', 100, 'discount_total', 0, 'payment_method', 'cash', 'reservation_id', null, 'client_id', null, 'used_ticket_ids', '[]'::jsonb,
    'request_hash', 'REQ1.' || h64, 'quote_fingerprint', 'QFP1.' || h64);
  perform pg_temp.ok(app_private.pos_op_validate_effect_snapshot('sale', v_snap) is null, 'M L2 sale snapshot with REQ1 request_hash and QFP1 fingerprint accepted');
  perform pg_temp.ok(app_private.pos_op_validate_effect_snapshot('sale', jsonb_set(v_snap, '{request_hash}', to_jsonb(h64))) = 'invalid_value',
    'M L2 sale snapshot with bare 64-hex request_hash rejected');
  perform pg_temp.ok(app_private.pos_op_validate_effect_snapshot('sale', jsonb_set(v_snap, '{request_hash}', to_jsonb('APR1.' || h64))) = 'invalid_value',
    'M L2 sale snapshot with APR1 in the hash field rejected');
  perform pg_temp.ok(app_private.pos_op_validate_effect_snapshot('sale', jsonb_set(v_snap, '{idempotency_key}', to_jsonb('REQ1.' || h64))) = 'secret_like_value',
    'M L2 the same REQ1 hash in a free-form field (idempotency_key) rejected');
  perform pg_temp.ok(app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('event'), jsonb_build_object('code', 'auth1_' || h64), false) is not null,
    'M L2 hash-like value in an event code rejected');
  -- 旧データの取り込み：REQ1 の request_hash は取り込まれ、裸の 64 桁は写さない（何も書かない）
  s := pg_temp.fx_sale('completed', 'cash', 700, ks);
  perform set_config('session_replication_role', 'replica', true);
  update public.accounting_sessions set request_hash = 'REQ1.' || h64 where id = s;
  perform set_config('session_replication_role', 'origin', true);
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', ks);
  perform pg_temp.ok(r ->> 'result' = 'discovered'
    and exists (select 1 from app_private.pos_operation_effects where effect_identity = s and snapshot ->> 'request_hash' = 'REQ1.' || h64),
    'M L2 legacy sale with REQ1 request_hash discovered; hash kept in its typed field');
  s := pg_temp.fx_sale('completed', 'cash', 700, kb);
  perform set_config('session_replication_role', 'replica', true);
  update public.accounting_sessions set request_hash = h64 where id = s;
  perform set_config('session_replication_role', 'origin', true);
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', kb);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'snapshot_not_representable' and pg_temp.registry_counts() = v_before,
    'M L2 legacy sale with bare 64-hex request_hash not copied (blocked, nothing written)');
end $$;

-- M 対応表：AUTH1 / QFP1 は型の付いた欄だけ、APR1 / QTE1 / GJC1 / OPS1 はどこでも秘密
do $$
declare
  h64 text := repeat('fedcba9876543210', 4);
  v_cred text;
  n integer := 0;
begin
  foreach v_cred in array array['APR1.' || h64, 'QTE1.' || h64, 'OPS1.' || h64, pg_temp.gjc1()] loop
    n := n + 1;
    perform pg_temp.ok(app_private.pos_op_secret_like(v_cred) and not app_private.pos_op_json_safe(to_jsonb(v_cred))
      and not app_private.pos_op_value_ok('hash', to_jsonb(v_cred)) and not app_private.pos_op_value_ok('fp', to_jsonb(v_cred))
      and not app_private.pos_op_value_ok('key', to_jsonb(v_cred)) and not app_private.pos_op_value_ok('userid', to_jsonb(v_cred))
      and not app_private.pos_op_value_ok('code', to_jsonb(v_cred)) and not app_private.pos_op_code_ok(v_cred),
      'M matrix: credential rejected in every field type #' || n || ' ' || left(v_cred, 5));
  end loop;
  perform pg_temp.ok(app_private.pos_op_value_ok('hash', to_jsonb('AUTH1.' || h64)) and not app_private.pos_op_value_ok('key', to_jsonb('AUTH1.' || h64))
    and not app_private.pos_op_value_ok('userid', to_jsonb('AUTH1.' || h64)) and not app_private.pos_op_value_ok('fp', to_jsonb('AUTH1.' || h64)),
    'M matrix: AUTH1 allowed only in the typed hash field');
  perform pg_temp.ok(app_private.pos_op_value_ok('fp', to_jsonb('QFP1.' || h64)) and not app_private.pos_op_value_ok('hash', to_jsonb('QFP1.' || h64))
    and not app_private.pos_op_value_ok('key', to_jsonb('QFP1.' || h64)) and not app_private.pos_op_value_ok('userid', to_jsonb('QFP1.' || h64)),
    'M matrix: QFP1 allowed only in the typed fingerprint field');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- N. CG1 キーは文字列ではなく digest で持つ（範囲の正規化 → SHA-256。形では断らない・生のキーは保存しない）
-- ════════════════════════════════════════════════════════════════════════════

-- 生のキーの記録（テスト側だけ。最後に台帳の全行からこれらの文字列が見つからないことを確かめる）
create temp table cg1_raw (raw text not null);
create function pg_temp.raw(p text) returns text language sql as $$ insert into cg1_raw (raw) values (p); select p $$;
create function pg_temp.hex64() returns text language sql as $$ select md5(random()::text) || md5(random()::text) $$;
-- 台帳の全行（8 表すべて、すべての列）を文字列にしたもの
create function pg_temp.registry_text() returns text language sql as $$
  select coalesce(string_agg(j, E'\n'), '') from (
    select to_jsonb(o)::text j from app_private.pos_operations o
    union all select to_jsonb(k)::text from app_private.pos_operation_keys k
    union all select to_jsonb(i)::text from app_private.pos_business_instructions i
    union all select to_jsonb(s)::text from app_private.pos_business_slots s
    union all select to_jsonb(t)::text from app_private.pos_operation_targets t
    union all select to_jsonb(r)::text from app_private.pos_operation_required_targets r
    union all select to_jsonb(e)::text from app_private.pos_operation_effects e
    union all select to_jsonb(v)::text from app_private.pos_operation_events v) x $$;

-- N-A〜D 今の正規の GINPay 店舗チャージ RPC（staff_ginpay_charge_store）が実際に作れるキー staff-store-charge:<64桁の16進>
do $$
declare
  v_staff text := 'cg1-staff-' || md5(random()::text);
  v_op_token text := 'cg1-op-' || md5(random()::text);
  v_member uuid;
  v_client uuid;
  k1 text := pg_temp.raw('staff-store-charge:' || pg_temp.hex64());
  k1b text := pg_temp.raw('staff-store-charge:' || pg_temp.hex64());
  r jsonb;
  c jsonb;
  t1 uuid;
  t1b uuid;
  v_op text;
begin
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_staff), now() + interval '1 hour');
  select id into v_member from public.staff_members where is_active order by sort_order limit 1;
  insert into app_private.pos_operator_sessions (token_hash, staff_member_id, staff_session_hash, role, expires_at)
  values (app_private.sha256_hex(v_op_token), v_member, app_private.sha256_hex(v_staff), 'staff', now() + interval '1 hour');
  v_client := app_private.create_client('CG1 Charge Client', 'staff', 'staff', 'Tester');
  perform public.staff_ginpay_open_account(v_staff, v_client, 'Tester');

  -- A. 正規の RPC がキーを受け付けて posted の行を作る（既存の書き込みは何も変えていない）
  r := public.staff_ginpay_charge_store(v_staff, v_op_token, v_client, 1200, 'cash', 'Tester', 'cg1', k1, null, null)::jsonb;
  select id into t1 from public.ginpay_transactions where idempotency_key = k1 and type = 'charge_store' and status = 'posted';
  perform pg_temp.ok(r ->> 'error' is null and t1 is not null, 'N CG1-A canonical staff_ginpay_charge_store posts staff-store-charge:<64hex>');
  r := public.staff_ginpay_charge_store(v_staff, v_op_token, v_client, 800, 'cash', 'Tester', 'cg1', k1b, null, null)::jsonb;
  select id into t1b from public.ginpay_transactions where idempotency_key = k1b and type = 'charge_store' and status = 'posted';
  perform pg_temp.ok(r ->> 'error' is null and t1b is not null, 'N CG1-A second canonical charge (for discovery by effect)');

  -- B. 分類は proven、キーからの取り込みが成功して操作に結ばれる
  c := app_private.pos_op_classify_legacy_key('ginpay_tx', k1);
  perform pg_temp.ok(c ->> 'verdict' = 'proven' and c ->> 'kind' = 'legacy_ginpay_charge', 'N CG1-B classifier proves the canonical RPC row');
  r := app_private.pos_op_discover_legacy('key', 'ginpay_tx', k1);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and (r ->> 'keys')::int = 1, 'N CG1-B discovery by the 64-hex key succeeds (' || r::text || ')');
  v_op := r ->> 'operation_id';
  perform pg_temp.ok(exists (select 1 from app_private.pos_operation_effects where effect_domain = 'ginpay_transaction' and effect_identity = t1
                             and operation_id = v_op::uuid and effect_kind = 'ginpay_charge'),
    'N CG1-B the posted row is registered as the operation''s effect');
  perform pg_temp.ok(exists (select 1 from app_private.pos_operation_keys where key_domain = 'ginpay_tx'
                             and key_digest = app_private.pos_op_key_ident('ginpay_tx', k1) and operation_id = v_op::uuid and key_role = 'legacy_alias'),
    'N CG1-B registry binds (ginpay_tx, digest(key)) -> operation');
  perform pg_temp.ok(app_private.pos_op_discover_legacy('key', 'ginpay_tx', k1) ->> 'result' = 'existing', 'N CG1-B repeated discovery is idempotent');

  -- C. 同じ生のキーで照会すると操作が分かる（D3 は btrim：前後の空白つきでも同じ）
  perform pg_temp.ok((app_private.pos_op_status_by_key('ginpay_tx', k1) ->> 'bound')::boolean
    and app_private.pos_op_status_by_key('ginpay_tx', k1) #>> '{operation,operation_id}' = v_op
    and app_private.pos_op_status_by_key('ginpay_tx', k1) #>> '{operation,status}' = 'completed'
    and app_private.pos_op_status_by_key('ginpay_tx', '  ' || k1 || ' ') #>> '{operation,operation_id}' = v_op,
    'N CG1-C status by the same raw key resolves the operation (and its btrim form)');
  perform pg_temp.ok(app_private.pos_op_key_executable('ginpay_tx', k1) ->> 'reason' = 'role_legacy_alias', 'N CG1-C legacy key is resolvable but not executable');
  -- 効果 ID からの取り込みも、そのキーを digest で結ぶ
  r := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t1b::text);
  perform pg_temp.ok(r ->> 'result' = 'discovered'
    and app_private.pos_op_status_by_key('ginpay_tx', k1b) #>> '{operation,operation_id}' = r ->> 'operation_id',
    'N CG1-C discovery by effect binds the 64-hex key; status by key resolves it');
  perform pg_temp.setv('n_k1', k1);
end $$;

-- D. 生のキー（64 桁の 16 進）は台帳のどこにも無い
do $$
declare
  v_all text := pg_temp.registry_text();
  k1 text := pg_temp.getv('n_k1');
begin
  perform pg_temp.ok(strpos(v_all, k1) = 0 and strpos(lower(v_all), substr(k1, 20)) = 0 and strpos(lower(v_all), substr(k1, 20, 24)) = 0,
    'N CG1-D raw staff-store-charge key and its 64-hex part appear nowhere in the registry');
  perform pg_temp.ok(not exists (select 1 from app_private.pos_operation_effects where snapshot ? 'idempotency_key' or snapshot ? 'void_idempotency_key'),
    'N CG1-D effect snapshots carry no idempotency key');
end $$;

-- E/F 物理に無い同じ形のキーの fence：digest だけの印、もう一度でも同じ。お金の行・枠・効果・資源は作らない
do $$
declare
  k2 text := pg_temp.raw('staff-store-charge:' || pg_temp.hex64());
  r jsonb;
  r2 jsonb;
  v_slots bigint := (select count(*) from app_private.pos_business_slots);
  v_epochs bigint := (select coalesce(sum(slot_epoch), 0) from app_private.pos_business_slots);
  v_effects bigint := (select count(*) from app_private.pos_operation_effects);
  v_targets bigint := (select count(*) from app_private.pos_operation_targets) + (select count(*) from app_private.pos_operation_required_targets);
  v_gp bigint := (select count(*) from public.ginpay_transactions);
  v_before text;
begin
  r := app_private.pos_op_fence_key('ginpay_tx', k2, 'operator_cancel');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 1, 'N CG1-E absent 64-hex key fenced (' || r::text || ')');
  perform pg_temp.ok((select count(*) from app_private.pos_operation_keys where operation_id = (r ->> 'operation_id')::uuid) = 1
    and exists (select 1 from app_private.pos_operation_keys where operation_id = (r ->> 'operation_id')::uuid and key_domain = 'ginpay_tx'
                and key_digest = app_private.pos_op_key_ident('ginpay_tx', k2) and key_role = 'fence'),
    'N CG1-E tombstone binds only the opaque digest');
  perform pg_temp.ok((select count(*) from public.ginpay_transactions) = v_gp and not exists (select 1 from public.ginpay_transactions where idempotency_key = k2),
    'N CG1-E no money row fabricated');
  perform pg_temp.ok((select count(*) from app_private.pos_business_slots) = v_slots
    and (select coalesce(sum(slot_epoch), 0) from app_private.pos_business_slots) = v_epochs
    and (select count(*) from app_private.pos_operation_effects) = v_effects
    and (select count(*) from app_private.pos_operation_targets) + (select count(*) from app_private.pos_operation_required_targets) = v_targets,
    'N CG1-E no slot / epoch / effect / target pollution');
  v_before := pg_temp.registry_counts();
  r2 := app_private.pos_op_fence_key('ginpay_tx', k2, 'operator_cancel');
  perform pg_temp.ok(r2 ->> 'result' = 'already_terminal' and r2 ->> 'operation_id' = r ->> 'operation_id' and pg_temp.registry_counts() = v_before,
    'N CG1-F repeated fence resolves to the same tombstone, no writes');
  r2 := app_private.pos_op_fence_key('ginpay_tx', ' ' || k2 || '  ', 'operator_cancel');
  perform pg_temp.ok(r2 ->> 'operation_id' = r ->> 'operation_id' and pg_temp.registry_counts() = v_before, 'N CG1-F D3 btrim form resolves to the same tombstone');
  perform pg_temp.ok(app_private.pos_op_status_by_key('ginpay_tx', k2) #>> '{operation,operation_id}' = r ->> 'operation_id'
    and app_private.pos_op_key_executable('ginpay_tx', k2) ->> 'reason' = 'role_fence', 'N CG1-F status by raw key finds the tombstone');
  -- 遅れて届いた PREPARE も同じキーでは実行できない（キーの形に関係なく、digest で衝突する）
  perform pg_temp.ok(app_private.pos_op_prepare(gen_random_uuid(), 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100), k2, 0) ->> 'error' = 'invalid_key',
    'N CG1-F PREPARE still requires the prefix+UUID grammar for new entry keys');
end $$;

-- G/H GJC1 などの資格情報の形をした文字列：キーの引数としては digest で扱える（生の値は保存しない）。
-- 同じ値を事実・記録者名・結果・履歴・コードに入れると、これまでどおり止まる
do $$
declare
  v_tok text := pg_temp.raw(pg_temp.gjc1());
  v_tok2 text := pg_temp.raw(pg_temp.gjc1());
  v_tok3 text := pg_temp.raw(pg_temp.gjc1());
  v_cred text;
  r jsonb;
  l uuid;
  n integer := 0;
  v_before text;
  v_op uuid;
begin
  -- G. キーとして
  r := app_private.pos_op_fence_key('ticket_issue', v_tok, 'operator_cancel');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (app_private.pos_op_status_by_key('ticket_issue', v_tok) #>> '{operation,operation_id}') = r ->> 'operation_id',
    'N CG1-G GJC1 token as a typed key is fenced by digest and resolvable');
  r := app_private.pos_op_fence_key('pos_virtual', pg_temp.raw('ginpay-open:' || v_tok2), 'operator_cancel');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned', 'N CG1-G key embedding a GJC1 token fenced by digest');
  foreach v_cred in array array['APR1.' || pg_temp.hex64(), 'QTE1.' || pg_temp.hex64(), 'OPS1.' || pg_temp.hex64(), 'Bearer ' || md5(random()::text),
                                'eyJhbGciOiJIUzI1NiJ9.' || md5(random()::text) || '.sig', pg_temp.hex64(), '$apr1$' || md5(random()::text)] loop
    n := n + 1;
    r := app_private.pos_op_fence_key('acct_void', pg_temp.raw(v_cred), 'operator_cancel');
    perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (app_private.pos_op_status_by_key('acct_void', v_cred) ->> 'bound')::boolean,
      'N CG1-G credential-shaped typed key #' || n || ' represented by digest only');
  end loop;
  -- 旧データのキーが GJC1 の形でも、分類・取り込み・照会ができる（生の値は写さない）
  l := pg_temp.fx_ticket_issue(1, 'discount', 500, v_tok3);
  r := app_private.pos_op_discover_legacy('key', 'ticket_issue', v_tok3);
  perform pg_temp.ok(r ->> 'result' = 'discovered'
    and app_private.pos_op_status_by_key('ticket_issue', v_tok3) #>> '{operation,operation_id}' = r ->> 'operation_id',
    'N CG1-G legacy ticket issue keyed by a GJC1 token discovered and resolvable by key');

  -- H. 同じ値を free text に入れると止まる
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(pg_temp.u(), 'ticket_issue', jsonb_build_object('user_id', v_tok, 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), 0);
  perform pg_temp.ok(r ->> 'detail' = 'unsafe_fact_value', 'N CG1-H the same GJC1 value in facts is still rejected');
  r := app_private.pos_op_prepare(gen_random_uuid(), 'ticket_issue', jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1),
    'ticket-issue:' || pg_temp.u(), 0, null, 'test', v_tok);
  perform pg_temp.ok(r ->> 'error' = 'invalid_request', 'N CG1-H the same GJC1 value in actor_name is still rejected');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'N CG1-H rejected free-text uses wrote nothing');
  perform pg_temp.ok(not app_private.pos_op_code_ok(v_tok) and not app_private.pos_op_json_safe(to_jsonb(v_tok))
    and app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('event'), jsonb_build_object('code', v_tok), false) is not null
    and app_private.pos_op_validate_result('ticket_issue', 'prepared', jsonb_build_object('log_id', v_tok)) is not null
    and app_private.pos_op_validate_effect_snapshot('ginpay_charge', jsonb_build_object('transaction_id', v_tok)) is not null,
    'N CG1-H the same GJC1 value is rejected as code / JSON / event / result / effect snapshot');
  select operation_id into v_op from app_private.pos_operations where status = 'completed' limit 1;
  perform pg_temp.err_commit(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
      v_op, 'completed', jsonb_build_object('reason', v_tok))],
    '%pos_event_invalid_detail%', 'N CG1-H direct event INSERT with the GJC1 value rejected');
end $$;

-- I/J/K 正規化と範囲
do $$
declare
  k text := 'cg1-norm-' || pg_temp.u();
  d text;
  r jsonb;
begin
  -- I. D1 / D3 は btrim：前後の空白は同じ識別子
  perform pg_temp.ok(app_private.pos_op_key_ident('acct_sale', '  ' || k || '  ') = app_private.pos_op_key_ident('acct_sale', k)
    and app_private.pos_op_key_ident('ginpay_tx', '  ' || k || '  ') = app_private.pos_op_key_ident('ginpay_tx', k),
    'N CG1-I D1/D3 btrim-equivalent keys share one identity');
  r := app_private.pos_op_fence_key('ginpay_tx', pg_temp.raw('   ' || k || ' '), 'operator_cancel');
  perform pg_temp.ok(app_private.pos_op_status_by_key('ginpay_tx', k) #>> '{operation,operation_id}' = r ->> 'operation_id',
    'N CG1-I D3 fence with surrounding spaces resolves from the trimmed key');
  -- btrim は空白だけ（タブや大文字小文字は別のキー）
  perform pg_temp.ok(app_private.pos_op_key_ident('ginpay_tx', k || E'\t') <> app_private.pos_op_key_ident('ginpay_tx', k)
    and app_private.pos_op_key_ident('acct_sale', upper(k)) <> app_private.pos_op_key_ident('acct_sale', k),
    'N CG1-I no extra normalization (tab kept, no lowercase)');
  -- J. D2 / D4 は送られたまま：前後の空白で別の識別子
  perform pg_temp.ok(app_private.pos_op_key_ident('acct_void', '  ' || k || '  ') <> app_private.pos_op_key_ident('acct_void', k)
    and app_private.pos_op_key_ident('ticket_issue', '  ' || k || '  ') <> app_private.pos_op_key_ident('ticket_issue', k),
    'N CG1-J D2/D4 raw-exact keys keep distinct identities');
  r := app_private.pos_op_fence_key('ticket_issue', pg_temp.raw(' ' || k || ' '), 'operator_cancel');
  perform pg_temp.ok((app_private.pos_op_status_by_key('ticket_issue', ' ' || k || ' ') ->> 'bound')::boolean
    and not (app_private.pos_op_status_by_key('ticket_issue', k) ->> 'bound')::boolean, 'N CG1-J D4 fence of the padded key does not bind the bare key');
  -- K. 同じ文字列でも範囲が違えば別の識別子
  perform pg_temp.ok((select count(distinct app_private.pos_op_key_ident(x, k)) from unnest(array['acct_sale', 'acct_void', 'ginpay_tx', 'ticket_issue', 'pos_virtual']) x) = 5,
    'N CG1-K same raw text in the five domains gives five identities');
  perform pg_temp.ok(app_private.pos_op_key_ident('stripe', k) is null and app_private.pos_op_key_ident('acct_sale', '   ') is null
    and app_private.pos_op_fence_key('stripe', k) ->> 'error' = 'invalid_key' and app_private.pos_op_fence_key('acct_sale', '  ') ->> 'error' = 'invalid_key',
    'N CG1-K unknown domain / empty key have no identity');
  -- 識別子の決まり：SHA-256("ginjiro-pos-key-v1" \0 範囲 \0 正規化したキー)、32 バイト
  perform pg_temp.ok(app_private.pos_op_key_ident('ginpay_tx', ' ' || k) = sha256(convert_to('ginjiro-pos-key-v1', 'UTF8') || '\x00'::bytea
        || convert_to('ginpay_tx', 'UTF8') || '\x00'::bytea || convert_to(k, 'UTF8'))
    and octet_length(app_private.pos_op_key_ident('ginpay_tx', k)) = 32,
    'N CG1-K identity = SHA-256(version \0 domain \0 canonical key), 32 bytes');
end $$;

-- L 会計のキー K と派生キー sale:K：それぞれの digest を PREPARE で保存し、lock は保存済みの digest だけで計画する
do $$
declare
  k text := pg_temp.raw('checkout:' || pg_temp.u());
  p jsonb;
  v_keys jsonb;
begin
  p := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0);
  perform pg_temp.ok(p ->> 'result' = 'prepared', 'N CG1-L checkout prepared');
  v_keys := app_private.pos_op_operation_keys((p ->> 'operation_id')::uuid);
  perform pg_temp.ok(jsonb_array_length(v_keys) = 2
    and v_keys @> jsonb_build_array(jsonb_build_object('d', 'acct_sale', 'h', encode(app_private.pos_op_key_ident('acct_sale', k), 'hex')))
    and v_keys @> jsonb_build_array(jsonb_build_object('d', 'ginpay_tx', 'h', encode(app_private.pos_op_key_ident('ginpay_tx', 'sale:' || k), 'hex'))),
    'N CG1-L operation key set = {digest(acct_sale, K), digest(ginpay_tx, sale:K)} from stored rows only');
  perform pg_temp.ok((select count(*) from app_private.pos_operation_keys where operation_id = (p ->> 'operation_id')::uuid and key_role = 'entry') = 1
    and (select count(*) from app_private.pos_operation_keys where operation_id = (p ->> 'operation_id')::uuid and key_role = 'derived') = 1,
    'N CG1-L entry and derived aliases are two bindings to the same operation');
  perform pg_temp.ok((app_private.pos_op_status_by_key('ginpay_tx', 'sale:' || k) #>> '{operation,operation_id}') = p ->> 'operation_id'
    and app_private.pos_op_key_executable('acct_sale', k) ->> 'executable' = 'true',
    'N CG1-L derived sale:K resolves to the same operation; entry K is executable');
  perform pg_temp.ok(app_private.pos_op_claim((p ->> 'instruction_id')::uuid, array['client:' || pg_temp.u()]) ->> 'result' = 'claimed',
    'N CG1-L claim locks the stored digest set');
  perform pg_temp.ok(app_private.pos_op_finish((p ->> 'operation_id')::uuid, 'completed', null,
      jsonb_build_object('sale_id', pg_temp.u(), 'total', 0)) ->> 'result' = 'completed',
    'N CG1-L finish plans its locks from stored digests (no raw key needed)');
  -- lock の単位：digest の無い要素は lock できない（null の lock id で素通りしない）
  perform pg_temp.err('select app_private.pos_op_lock_keys_xact(''[{"d":"acct_sale","v":"checkout:x"}]''::jsonb)', '%pos_key_identity_missing%',
    'N CG1-L key lock refuses an element without a digest');
end $$;

-- 入口のキーの digest は、その操作に結ばれた入口のキーと同じでなければならない（直接の INSERT）
do $$
declare
  v_f jsonb := jsonb_build_object('user_id', 'c1-user-' || pg_temp.u(), 'ticket_type', 'discount', 'amount', 500, 'quantity', 1);
  k text := 'ticket-issue:' || pg_temp.u();
  p jsonb;
  v_sql text;
begin
  p := pg_temp.prep(pg_temp.u(), 'ticket_issue', v_f, k, 0);
  perform pg_temp.ok(p ->> 'result' = 'prepared', 'N CG1 entry-digest fixture prepared');
  -- 事実・操作・枠・版・ハッシュはすべて合う形で、入口のキーの digest だけが違う
  v_sql := 'insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, '
      || 'observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest) values (%L, %L, %L, null, %L, %L, 1, 2, %L, %L, %L, %L)';
  perform pg_temp.err_commit(array[format(v_sql, gen_random_uuid(), p ->> 'operation_id', 'accepted', 'ticket_issue', p ->> 'slot_key', v_f,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', p ->> 'slot_key', 'facts', v_f)),
      'ticket_issue', app_private.pos_op_key_ident('ticket_issue', 'ticket-issue:' || pg_temp.u()))],
    '%pos_instruction_invalid_key%', 'N CG1 direct instruction INSERT whose entry digest is not the operation''s entry key rejected');
  -- 対照：同じ形で正しい digest なら入口のキーの検査は通る（その先の一意制約で止まる）
  perform pg_temp.err_commit(array[format(v_sql, gen_random_uuid(), p ->> 'operation_id', 'accepted', 'ticket_issue', p ->> 'slot_key', v_f,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', p ->> 'slot_key', 'facts', v_f)),
      'ticket_issue', app_private.pos_op_key_ident('ticket_issue', k))],
    '%duplicate key%', 'N CG1 control: the bound entry digest passes the key check');
  perform pg_temp.err_commit(array[format(v_sql, gen_random_uuid(), p ->> 'operation_id', 'accepted', 'ticket_issue', p ->> 'slot_key', v_f,
      app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'ticket_issue', 'slot', p ->> 'slot_key', 'facts', v_f)),
      'ticket_issue', '\x' || repeat('ab', 16))],
    '%entry_key_digest_check%', 'N CG1 instruction entry digest must be 32 bytes (CHECK, guard disabled)',
    array['app_private.pos_business_instructions|pos_business_instructions_guard']);
end $$;

-- 同じ依頼の正確な再送は digest で比べる：同じキーなら existing、違うキーなら instruction_conflict
do $$
declare
  v_i text := pg_temp.u();
  k text := 'ginpay-open:' || pg_temp.u();
  f jsonb := jsonb_build_object('client_id', pg_temp.u());
  r jsonb;
begin
  r := pg_temp.prep(v_i, 'ginpay_open', f, k, 0);
  perform pg_temp.ok(r ->> 'result' = 'prepared', 'N CG1 exact-retry fixture prepared');
  perform pg_temp.ok(pg_temp.prep(v_i, 'ginpay_open', f, k, 0) ->> 'result' = 'existing', 'N CG1 exact retry with the same key (same digest) = existing');
  perform pg_temp.ok(pg_temp.prep(v_i, 'ginpay_open', f, 'ginpay-open:' || pg_temp.u(), 0) ->> 'error' = 'instruction_conflict',
    'N CG1 same instruction with a different key (different digest) = instruction_conflict');
  perform pg_temp.ok(pg_temp.prep(v_i, 'ginpay_open', f || jsonb_build_object('client_id', pg_temp.u()), k, 0) ->> 'error' = 'instruction_conflict',
    'N CG1 exact retry still compares facts');
  perform pg_temp.ok(pg_temp.prep(v_i, 'ginpay_open', f, k, 3) ->> 'error' = 'instruction_conflict', 'N CG1 exact retry still compares the observed epoch');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- O. CG2 物理の照会も btrim の同値類（D1/D3）：正規でない行だけ・同じになる行が2つ以上なら、どの道でも書かずに止まる
-- （テスト用の会計・GINPay の行は、トリガー・制約を止めずに入れる）
-- ════════════════════════════════════════════════════════════════════════════

create function pg_temp.cg2_client() returns uuid language sql as $$
  select app_private.create_client('CG2 Client ' || md5(random()::text), 'staff', 'staff', 'Tester') $$;
create function pg_temp.cg2_account() returns uuid language sql as $$
  insert into public.ginpay_accounts (client_id) values (pg_temp.cg2_client()) returning id $$;
-- 確定（または取消済み）の会計。トリガー・制約は有効のまま
create function pg_temp.cg2_sale(p_key text, p_method text default 'cash', p_total integer default 1000, p_status text default 'completed')
returns uuid language sql as $$
  insert into public.accounting_sessions (customer_name, staff_name, payment_method, status, subtotal, discount_total, total,
    idempotency_key, completed_at, voided_at, client_id)
  values ('CG2', 'CG2', p_method, p_status, p_total, 0, p_total, p_key, now(), case when p_status = 'voided' then now() end, pg_temp.cg2_client())
  returning id $$;
-- posted の GINPay 取引。トリガー・制約は有効のまま
create function pg_temp.cg2_gp(p_type text, p_amount integer, p_key text, p_sale uuid default null, p_account uuid default null)
returns uuid language plpgsql as $$
declare
  v_acc uuid := coalesce(p_account, pg_temp.cg2_account());
  v_id uuid;
begin
  insert into public.ginpay_transactions (account_id, client_id, amount, type, status, accounting_session_id, operator_type, idempotency_key)
  select v_acc, a.client_id, p_amount, p_type, 'posted', p_sale, 'staff', p_key from public.ginpay_accounts a where a.id = v_acc
  returning id into v_id;
  return v_id;
end $$;
-- 物理の行（会計・GINPay）の中身。前後で変わっていないことの確認用
create function pg_temp.cg2_rows(p_ids uuid[]) returns text language sql as $$
  select coalesce(string_agg(j, '|' order by j), '') from (
    select to_jsonb(s)::text j from public.accounting_sessions s where s.id = any (p_ids)
    union all select to_jsonb(g)::text from public.ginpay_transactions g where g.id = any (p_ids)) x $$;
-- 台帳にその範囲・キーの digest が結ばれていない
create function pg_temp.cg2_unbound(p_domain text, p_key text) returns boolean language sql as $$
  select not exists (select 1 from app_private.pos_operation_keys where key_domain = p_domain and key_digest = app_private.pos_op_key_ident(p_domain, p_key)) $$;
create function pg_temp.cg2_no_effect(p_ids uuid[]) returns boolean language sql as $$
  select not exists (select 1 from app_private.pos_operation_effects where effect_identity = any (p_ids)) $$;

-- O-0 照会の関数：読むだけ（STABLE・決まった search_path・クライアントのロールに実行権なし・lock も書き込みもしない）
do $$
declare
  v_before text := pg_temp.registry_counts();
  v_locks bigint;
  r jsonb;
begin
  perform pg_temp.ok((select provolatile = 's' and proconfig::text like '%search_path=public, extensions, pg_temp%'
                      from pg_proc where oid = 'app_private.pos_op_physical_probe(text,text)'::regprocedure),
    'O CG2-0 physical probe is STABLE with a fixed search_path');
  perform pg_temp.ok(not has_function_privilege('anon', 'app_private.pos_op_physical_probe(text,text)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.pos_op_physical_probe(text,text)', 'execute')
    and not has_function_privilege('service_role', 'app_private.pos_op_physical_probe(text,text)', 'execute')
    and not has_function_privilege('anon', 'app_private.pos_op_plan_physical_check(jsonb)', 'execute')
    and not has_function_privilege('anon', 'app_private.pos_op_probe_blocked_reason(jsonb)', 'execute'),
    'O CG2-0 no client role can execute the probe helpers');
  select count(*) into v_locks from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
  r := app_private.pos_op_physical_probe('acct_sale', 'checkout:' || pg_temp.u());
  perform pg_temp.ok(r ->> 'state' = 'physical_key_absent' and pg_temp.registry_counts() = v_before
    and (select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) = v_locks,
    'O CG2-0 probe of an absent key: physical_key_absent, no lock, no write');
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', '   ') ->> 'state' = 'invalid_key'
    and app_private.pos_op_physical_probe('nope', 'x') ->> 'state' = 'invalid_key'
    and app_private.pos_op_physical_probe('pos_virtual', 'ginpay-open:' || pg_temp.u()) ->> 'state' = 'physical_key_absent',
    'O CG2-0 blank key / unknown domain are invalid; the virtual domain has no physical rows');
end $$;

-- O-19 D1 正規でない行だけ：'  checkout:<UUID>  ' の確定済みの会計（トリガー・制約は有効）
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  raw text := pg_temp.raw('  ' || k || '  ');
  a uuid;
  v_rows text;
  v_before text;
  r jsonb;
  p jsonb;
  v_i text := pg_temp.u();
  v_facts jsonb := jsonb_build_object('client_id', pg_temp.u());
begin
  perform pg_temp.raw(k);
  a := pg_temp.cg2_sale(raw);
  perform pg_temp.ok((select idempotency_key = raw and status = 'completed' from public.accounting_sessions where id = a),
    'O CG2-19 schema accepts a completed sale whose key is ''  checkout:<UUID>  '' (triggers/constraints enabled)');
  v_rows := pg_temp.cg2_rows(array[a]);
  -- 先に別のキーで依頼を作っておく（あとで同じ依頼 ID に K を送って、負けたキーの扱いを見る）
  p := pg_temp.prep(v_i, 'checkout_client', v_facts, 'checkout:' || pg_temp.u(), 0);
  perform pg_temp.ok(p ->> 'result' = 'prepared', 'O CG2-19 fixture instruction prepared with another key');
  v_before := pg_temp.registry_counts();

  r := app_private.pos_op_physical_probe('acct_sale', k);
  perform pg_temp.ok(r ->> 'state' = 'physical_key_noncanonical' and not r ? 'id'
    and app_private.pos_op_physical_probe('acct_sale', raw) ->> 'state' = 'physical_key_noncanonical',
    'O CG2-19 probe(K) and probe(''  K  '') = physical_key_noncanonical, no row id returned');
  r := app_private.pos_op_discover_legacy('effect', 'accounting_sale', a::text);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'O CG2-19 A discovery by effect id: blocked physical_key_noncanonical, zero writes (' || r::text || ')');
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', raw);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'O CG2-19 B discovery by the raw spaced key: physical_key_noncanonical, not no_physical_record (' || r::text || ')');
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', k);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'O CG2-19 C discovery by the trimmed key: physical_key_noncanonical, zero writes');
  r := app_private.pos_op_fence_key('acct_sale', raw);
  perform pg_temp.ok(r ->> 'ok' = 'false' and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical'
    and pg_temp.registry_counts() = v_before, 'O CG2-19 D fence of the spaced key: refused, zero writes (' || r::text || ')');
  r := app_private.pos_op_fence_key('acct_sale', k);
  perform pg_temp.ok(r ->> 'ok' = 'false' and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical'
    and pg_temp.registry_counts() = v_before, 'O CG2-19 E fence of the canonical key: refused, zero writes');
  r := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0);
  perform pg_temp.ok(r ->> 'error' = 'legacy_key_noncanonical' and r ->> 'key_domain' = 'acct_sale' and pg_temp.registry_counts() = v_before,
    'O CG2-19 F PREPARE with the same canonical identity: legacy_key_noncanonical, no tombstone (' || r::text || ')');
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'O CG2-19 F losing key on instruction_conflict: legacy_key_noncanonical, no tombstone (' || r::text || ')');
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_sale', k) ->> 'reason' = 'physical_key_noncanonical'
    and app_private.pos_op_classify_legacy_effect('accounting_sale', a) ->> 'reason' = 'physical_key_noncanonical',
    'O CG2-19 classifiers (key and effect) agree: physical_key_noncanonical');
  perform pg_temp.ok(pg_temp.cg2_unbound('acct_sale', k) and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k) and pg_temp.cg2_no_effect(array[a])
    and not (app_private.pos_op_status_by_key('acct_sale', k) ->> 'bound')::boolean,
    'O CG2-19 nothing bound: no key digest, no derived digest, no effect');
  perform pg_temp.ok(pg_temp.cg2_rows(array[a]) = v_rows, 'O CG2-19 the physical completed row is untouched');
end $$;

-- O-11/20 D1 同じになる2行：K（正規）と '  K  '（どちらも確定済み）
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  sp text := pg_temp.raw('  ' || k || '  ');
  a uuid;
  b uuid;
  v_rows text;
  v_before text;
  r jsonb;
  v_ok boolean := true;
  v_seen text := '';
begin
  perform pg_temp.raw(k);
  a := pg_temp.cg2_sale(k);
  b := pg_temp.cg2_sale(sp, 'cash', 700);
  perform pg_temp.ok(a is not null and b is not null, 'O CG2-20 schema accepts both K and ''  K  '' as completed sales');
  v_rows := pg_temp.cg2_rows(array[a, b]);
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_physical_probe('acct_sale', k);
  perform pg_temp.ok(r ->> 'state' = 'physical_key_ambiguous' and not r ? 'id'
    and app_private.pos_op_physical_probe('acct_sale', sp) ->> 'state' = 'physical_key_ambiguous',
    'O CG2-20 probe(K) / probe(''  K  '') = physical_key_ambiguous, no row chosen');
  for r in
    select app_private.pos_op_discover_legacy('key', 'acct_sale', k)
    union all select app_private.pos_op_discover_legacy('key', 'acct_sale', sp)
    union all select app_private.pos_op_discover_legacy('effect', 'accounting_sale', a::text)
    union all select app_private.pos_op_discover_legacy('effect', 'accounting_sale', b::text)
    union all select app_private.pos_op_fence_key('acct_sale', k)
    union all select app_private.pos_op_fence_key('acct_sale', sp)
  loop
    v_seen := v_seen || coalesce(r ->> 'reason', r ->> 'error', r ->> 'result') || ';';
    v_ok := v_ok and r ->> 'ok' = 'false' and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_ambiguous';
  end loop;
  perform pg_temp.ok(v_ok and pg_temp.registry_counts() = v_before,
    'O CG2-20 discovery K / ''  K  '' / effect A / effect B / fence K / fence ''  K  '': all physical_key_ambiguous, zero writes (' || v_seen || ')');
  r := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0);
  perform pg_temp.ok(r ->> 'error' = 'legacy_key_ambiguous' and pg_temp.registry_counts() = v_before,
    'O CG2-20 PREPARE K: legacy_key_ambiguous, no tombstone / claim of absence (' || r::text || ')');
  perform pg_temp.ok(pg_temp.cg2_unbound('acct_sale', k) and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k) and pg_temp.cg2_no_effect(array[a, b])
    and not exists (select 1 from app_private.pos_operations where origin = 'legacy_discovered'
                    and result_snapshot #>> '{headline,sale_id}' in (a::text, b::text)),
    'O CG2-20 no synthesized completed operation, no tombstone, no alias, no binding');
  perform pg_temp.ok(pg_temp.cg2_rows(array[a, b]) = v_rows, 'O CG2-20 both physical rows are untouched');
end $$;

-- O-12 正規の行が無くても、' K' と 'K ' はどちらも btrim で K：あいまい
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  a uuid := pg_temp.cg2_sale(pg_temp.raw(' ' || k));
  b uuid := pg_temp.cg2_sale(pg_temp.raw(k || ' '), 'cash', 300);
  v_before text := pg_temp.registry_counts();
  v_ok boolean := true;
  r jsonb;
begin
  perform pg_temp.raw(k);
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', k) ->> 'state' = 'physical_key_ambiguous',
    'O CG2-12 '' K'' and ''K '' (no exact K row): probe = physical_key_ambiguous');
  for r in
    select app_private.pos_op_discover_legacy('key', 'acct_sale', k)
    union all select app_private.pos_op_discover_legacy('effect', 'accounting_sale', a::text)
    union all select app_private.pos_op_discover_legacy('effect', 'accounting_sale', b::text)
    union all select app_private.pos_op_fence_key('acct_sale', k)
  loop
    v_ok := v_ok and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_ambiguous';
  end loop;
  perform pg_temp.ok(v_ok and pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k, 0) ->> 'error' = 'legacy_key_ambiguous'
    and pg_temp.registry_counts() = v_before,
    'O CG2-12 discovery / effect discovery / fence / PREPARE all fail closed as ambiguous, zero writes');
end $$;

-- O-13 btrim で違うキーは別の物理の識別子のまま（大文字小文字・中の空白・タブは同じにしない）
do $$
declare
  u text := pg_temp.u();
  k1 text := 'checkout:' || u;
  a uuid := pg_temp.cg2_sale(k1);
  b uuid := pg_temp.cg2_sale(upper(k1), 'cash', 200);
  c uuid := pg_temp.cg2_sale('checkout: ' || u, 'cash', 300);
  d uuid := pg_temp.cg2_sale(k1 || E'\t', 'cash', 400);
begin
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', k1) ->> 'state' = 'physical_key_canonical_single'
    and (app_private.pos_op_physical_probe('acct_sale', k1) ->> 'id')::uuid = a
    and (app_private.pos_op_physical_probe('acct_sale', upper(k1)) ->> 'id')::uuid = b
    and (app_private.pos_op_physical_probe('acct_sale', 'checkout: ' || u) ->> 'id')::uuid = c
    and (app_private.pos_op_physical_probe('acct_sale', k1 || E'\t') ->> 'id')::uuid = d,
    'O CG2-13 K1 / upper(K1) / inner-space / trailing-tab rows stay four distinct canonical identities');
  perform pg_temp.ok(app_private.pos_op_discover_legacy('effect', 'accounting_sale', a::text) ->> 'result' = 'discovered'
    and app_private.pos_op_discover_legacy('key', 'acct_sale', upper(k1)) ->> 'result' = 'discovered',
    'O CG2-13 distinct keys are discovered independently');
end $$;

-- O-21 D3（ginpay_transactions.idempotency_key、種類をまたいで1つの範囲）
do $$
declare
  kc text := 'staff-store-charge:' || pg_temp.hex64();
  ncs text := pg_temp.raw(' ' || kc || '  ');
  t1 uuid;
  kd text := 'staff-store-charge:' || pg_temp.u();
  t2 uuid;
  t3 uuid;
  ka text := 'hq-adjustment:' || pg_temp.u();
  t4 uuid;
  t5 uuid;
  v_rows text;
  v_before text;
  r jsonb;
  v_ok boolean := true;
begin
  perform pg_temp.raw(kc); perform pg_temp.raw(kd); perform pg_temp.raw(ka);
  -- 正規でない posted の行だけ
  t1 := pg_temp.cg2_gp('charge_store', 500, ncs);
  -- 正規の行 + 同じになる正規でない行
  t2 := pg_temp.cg2_gp('charge_store', 600, kd);
  t3 := pg_temp.cg2_gp('charge_store', 650, pg_temp.raw(kd || ' '));
  -- 種類が違っても同じ範囲：adjustment の 'hq-adjustment:U' と charge_store の '  hq-adjustment:U'
  t4 := pg_temp.cg2_gp('adjustment', 50, ka);
  t5 := pg_temp.cg2_gp('charge_store', 70, pg_temp.raw('  ' || ka));
  v_rows := pg_temp.cg2_rows(array[t1, t2, t3, t4, t5]);
  v_before := pg_temp.registry_counts();

  perform pg_temp.ok(app_private.pos_op_physical_probe('ginpay_tx', kc) ->> 'state' = 'physical_key_noncanonical'
    and app_private.pos_op_physical_probe('ginpay_tx', kd) ->> 'state' = 'physical_key_ambiguous'
    and app_private.pos_op_physical_probe('ginpay_tx', ka) ->> 'state' = 'physical_key_ambiguous',
    'O CG2-21 D3 probe: noncanonical-only / canonical+noncanonical / cross-kind equivalents');
  for r in
    select app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t1::text)
    union all select app_private.pos_op_discover_legacy('key', 'ginpay_tx', ncs)
    union all select app_private.pos_op_discover_legacy('key', 'ginpay_tx', kc)
    union all select app_private.pos_op_fence_key('ginpay_tx', ncs)
    union all select app_private.pos_op_fence_key('ginpay_tx', kc)
  loop
    v_ok := v_ok and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical';
  end loop;
  perform pg_temp.ok(v_ok and pg_temp.registry_counts() = v_before,
    'O CG2-21 D3 noncanonical-only posted charge: effect / raw key / trimmed key discovery and both fences refused, zero writes');
  v_ok := true;
  for r in
    select app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t2::text)
    union all select app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t3::text)
    union all select app_private.pos_op_discover_legacy('key', 'ginpay_tx', kd)
    union all select app_private.pos_op_fence_key('ginpay_tx', kd)
    union all select app_private.pos_op_fence_key('ginpay_tx', kd || ' ')
    union all select app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t4::text)
    union all select app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t5::text)
    union all select app_private.pos_op_discover_legacy('key', 'ginpay_tx', ka)
    union all select app_private.pos_op_fence_key('ginpay_tx', ka)
  loop
    v_ok := v_ok and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_ambiguous';
  end loop;
  perform pg_temp.ok(v_ok and pg_temp.registry_counts() = v_before,
    'O CG2-21 D3 equivalent rows (same kind and across kinds): every discovery and fence = physical_key_ambiguous, zero writes');
  r := pg_temp.prep(pg_temp.u(), 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100), kd, 0);
  perform pg_temp.ok(r ->> 'error' = 'legacy_key_ambiguous' and pg_temp.registry_counts() = v_before,
    'O CG2-21 PREPARE ginpay_charge with the ambiguous D3 key: legacy_key_ambiguous (' || (r ->> 'error') || ')');
  perform pg_temp.ok(pg_temp.cg2_unbound('ginpay_tx', kc) and pg_temp.cg2_unbound('ginpay_tx', kd) and pg_temp.cg2_unbound('ginpay_tx', ka)
    and pg_temp.cg2_no_effect(array[t1, t2, t3, t4, t5]) and pg_temp.cg2_rows(array[t1, t2, t3, t4, t5]) = v_rows,
    'O CG2-21 D3: nothing bound, no effect, physical rows untouched');
end $$;

-- O-21 D3 の派生キー：会計キー K の GINPay 支払い sale:K と、同じになる ' sale:K' がある・取消の戻し sale-void:<会計ID> が正規でない
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  acc uuid := pg_temp.cg2_account();
  s uuid;
  t uuid;
  x uuid;
  k6 text := 'checkout:' || pg_temp.u();
  x6 uuid;
  sv uuid;
  xv uuid;
  v_rows text;
  v_before text;
  r jsonb;
begin
  perform pg_temp.raw(k); perform pg_temp.raw(k6);
  s := pg_temp.cg2_sale(k, 'ginpay', 900);
  t := pg_temp.cg2_gp('payment', -900, 'sale:' || k, s, acc);
  x := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw(' sale:' || k));
  -- 物理に会計 K6 は無いが、D3 に ' sale:K6' がある
  x6 := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('sale:' || k6 || '  '));
  -- 取消済みの現金の会計と、正規でない戻しのキー
  sv := pg_temp.cg2_sale('checkout:' || pg_temp.u(), 'cash', 400, 'voided');
  xv := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('  sale-void:' || sv::text));
  v_rows := pg_temp.cg2_rows(array[s, t, x, x6, sv, xv]);
  v_before := pg_temp.registry_counts();

  r := app_private.pos_op_discover_legacy('effect', 'accounting_sale', s::text);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_ambiguous',
    'O CG2-21 GINPay-paid sale whose sale:K has an equivalent '' sale:K'' row: effect discovery = physical_key_ambiguous (' || r::text || ')');
  r := app_private.pos_op_discover_legacy('key', 'acct_sale', k);
  perform pg_temp.ok(r ->> 'reason' = 'physical_key_ambiguous', 'O CG2-21 same sale by its D1 key: derived D3 key ambiguity is detected');
  r := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t::text);
  perform pg_temp.ok(r ->> 'reason' = 'physical_key_ambiguous', 'O CG2-21 the payment by effect id: physical_key_ambiguous');
  r := app_private.pos_op_fence_key('acct_sale', k6);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical',
    'O CG2-21 fence of an absent sale key whose derived sale:K has a noncanonical D3 row: refused (' || r::text || ')');
  r := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k6, 0);
  perform pg_temp.ok(r ->> 'error' = 'legacy_key_noncanonical' and r ->> 'key_domain' = 'ginpay_tx',
    'O CG2-21 PREPARE of that sale key: legacy_key_noncanonical on the derived ginpay_tx key');
  r := app_private.pos_op_discover_legacy('effect', 'accounting_sale_void', sv::text);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical',
    'O CG2-21 voided cash sale with a noncanonical sale-void:<id> row: not proven as "no reversal" (' || r::text || ')');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before and pg_temp.cg2_rows(array[s, t, x, x6, sv, xv]) = v_rows
    and pg_temp.cg2_unbound('acct_sale', k6) and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k6),
    'O CG2-21 derived-key cases: zero writes, physical rows untouched');
end $$;

-- O-22 D2/D4 は送られたままの文字列：' K ' と 'K' は別（btrim しない）
do $$
declare
  vk text := 'void-' || pg_temp.u();
  sv uuid;
  tk text := 'ticket-' || pg_temp.u();
  l uuid;
  r jsonb;
begin
  insert into public.accounting_sessions (customer_name, staff_name, payment_method, status, subtotal, discount_total, total,
    completed_at, voided_at, void_idempotency_key, void_request_hash, client_id)
  values ('CG2', 'CG2', 'cash', 'voided', 100, 0, 100, now(), now(), vk, 'REQ1.' || repeat('b', 64), pg_temp.cg2_client())
  returning id into sv;
  l := pg_temp.fx_ticket_issue(1, 'discount', 500, tk);
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_void', vk) ->> 'state' = 'physical_key_canonical_single'
    and (app_private.pos_op_physical_probe('acct_void', vk) ->> 'id')::uuid = sv
    and app_private.pos_op_physical_probe('acct_void', ' ' || vk || ' ') ->> 'state' = 'physical_key_absent'
    and app_private.pos_op_physical_probe('ticket_issue', tk) ->> 'state' = 'physical_key_canonical_single'
    and app_private.pos_op_physical_probe('ticket_issue', ' ' || tk || ' ') ->> 'state' = 'physical_key_absent',
    'O CG2-22 D2/D4 probe is raw exact: '' K '' does not match the physical K');
  r := app_private.pos_op_fence_key('ticket_issue', ' ' || tk || ' ');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and app_private.pos_op_fence_key('ticket_issue', tk) ->> 'ok' = 'false'
    and pg_temp.cg2_unbound('ticket_issue', tk),
    'O CG2-22 D4 fence of '' K '' tombstones its own identity; fence of K is refused (physical row present), K stays unbound');
  perform pg_temp.ok(app_private.pos_op_classify_legacy_key('acct_void', ' ' || vk || ' ') ->> 'verdict' = 'no_physical_record'
    and app_private.pos_op_classify_legacy_key('acct_void', vk) ->> 'verdict' is distinct from 'no_physical_record',
    'O CG2-22 D2 classification by key keeps raw exact semantics');
end $$;

-- O-23 本当に物理に無い D1/D3 キー：これまでどおり取り消しの印を作れる
do $$
declare
  k text := pg_temp.raw('checkout:' || pg_temp.u());
  g text := pg_temp.raw('staff-store-charge:' || pg_temp.hex64());
  r jsonb;
begin
  r := app_private.pos_op_fence_key('acct_sale', '  ' || k || ' ');
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 2
    and not pg_temp.cg2_unbound('acct_sale', k) and not pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k),
    'O CG2-23 absent D1 key (no btrim-equivalent row): fence tombstones K and sale:K (' || r::text || ')');
  r := app_private.pos_op_fence_key('ginpay_tx', g);
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 1 and not pg_temp.cg2_unbound('ginpay_tx', g),
    'O CG2-23 absent D3 key: fence tombstones it');
  perform pg_temp.ok(pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0) ->> 'result' = 'prepared',
    'O CG2-23 PREPARE of an absent key is still accepted');
end $$;

-- O-24 正規の1行だけ：これまでどおり取り込める（会計・GINPay・GINPay 払いの会計、照会・digest）
do $$
declare
  k text := pg_temp.raw('checkout:' || pg_temp.u());
  s uuid := pg_temp.cg2_sale(k);
  g text := pg_temp.raw('staff-store-charge:' || pg_temp.hex64());
  t uuid := pg_temp.cg2_gp('charge_store', 1500, g);
  kp text := pg_temp.raw('checkout:' || pg_temp.u());
  acc uuid := pg_temp.cg2_account();
  sp uuid;
  tp uuid;
  vnull uuid := pg_temp.cg2_sale(null);
  r jsonb;
  v_op text;
begin
  perform pg_temp.ok((app_private.pos_op_physical_probe('acct_sale', k) ->> 'id')::uuid = s
    and app_private.pos_op_physical_probe('acct_sale', ' ' || k) ->> 'state' = 'physical_key_canonical_single',
    'O CG2-24 single canonical row: probe = canonical_single with that row id (also for the spaced lookup)');
  r := app_private.pos_op_discover_legacy('effect', 'accounting_sale', s::text);
  v_op := r ->> 'operation_id';
  perform pg_temp.ok(r ->> 'result' = 'discovered' and app_private.pos_op_discover_legacy('key', 'acct_sale', ' ' || k || ' ') ->> 'operation_id' = v_op
    and app_private.pos_op_status_by_key('acct_sale', k) #>> '{operation,operation_id}' = v_op,
    'O CG2-24 completed sale: effect discovery, key convergence (btrim form), status by key');
  r := app_private.pos_op_discover_legacy('key', 'ginpay_tx', g);
  perform pg_temp.ok(r ->> 'result' = 'discovered'
    and app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', t::text) ->> 'result' = 'existing'
    and app_private.pos_op_status_by_key('ginpay_tx', g) #>> '{operation,operation_id}' = r ->> 'operation_id',
    'O CG2-24 posted GINPay charge: key discovery, effect convergence, status');
  sp := pg_temp.cg2_sale(kp, 'ginpay', 800);
  tp := pg_temp.cg2_gp('payment', -800, 'sale:' || kp, sp, acc);
  r := app_private.pos_op_discover_legacy('effect', 'ginpay_transaction', tp::text);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and (r ->> 'effects')::int = 2 and (r ->> 'keys')::int = 2
    and app_private.pos_op_status_by_key('ginpay_tx', 'sale:' || kp) #>> '{operation,operation_id}' = r ->> 'operation_id'
    and app_private.pos_op_status_by_key('acct_sale', kp) #>> '{operation,operation_id}' = r ->> 'operation_id',
    'O CG2-24 GINPay-paid sale via its payment: sale + payment, K and sale:K digests bound to one operation');
  r := app_private.pos_op_discover_legacy('effect', 'accounting_sale', vnull::text);
  perform pg_temp.ok(r ->> 'result' = 'discovered' and (r ->> 'keys')::int = 0,
    'O CG2-24 NULL physical key: cash sale is discovered by effect with no key (no synthetic key)');
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', 'checkout:' || pg_temp.u()) ->> 'state' = 'physical_key_absent',
    'O CG2-24 NULL keys never match a non-NULL canonical key');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- P. CG2-R1 逆向きの fence（派生キー sale:K）：親の会計キー K も lock の後に物理で確かめる（lock の範囲 = 確かめる範囲）
-- ════════════════════════════════════════════════════════════════════════════

-- 逆向きの fence の結果が「書かずに断る」こと（理由・台帳の件数・sale:K / K が結ばれていない・物理の行が変わらない）
create function pg_temp.r1_refused(p_r jsonb, p_reason text, p_before text, p_k text, p_ids uuid[], p_rows text) returns boolean language sql as $$
  select p_r ->> 'ok' = 'false' and p_r ->> 'error' = 'legacy_state_blocked' and p_r ->> 'reason' = p_reason
     and p_r ->> 'result' is null and pg_temp.registry_counts() = p_before
     and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || p_k) and pg_temp.cg2_unbound('acct_sale', p_k)
     and not coalesce((app_private.pos_op_status_by_key('ginpay_tx', 'sale:' || p_k) ->> 'bound')::boolean, false)
     and pg_temp.cg2_rows(p_ids) = p_rows $$;

-- P-1 計画：sale:K の safety に親の K（D1 の正規化）が入り、bind には入らない。safety はすべて lock の範囲
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  p jsonb := app_private.pos_op_fence_plan('ginpay_tx', 'sale:' || k);
  q jsonb := app_private.pos_op_fence_plan('ginpay_tx', 'sale:  ' || k || ' ');
begin
  perform pg_temp.ok(jsonb_array_length(p -> 'bind') = 1 and p #>> '{bind,0,d}' = 'ginpay_tx'
    and jsonb_array_length(p -> 'safety') = 2 and p -> 'safety' @> jsonb_build_array(app_private.pos_op_key_elem('acct_sale', k)),
    'P CG2-R1 plan: sale:K binds only sale:K; safety = {sale:K, parent K}');
  perform pg_temp.ok(q -> 'safety' @> jsonb_build_array(app_private.pos_op_key_elem('acct_sale', k)),
    'P CG2-R1 plan: parent of sale:<spaced K> is the D1-normalized K (not the caller spelling)');
  perform pg_temp.ok(app_private.pos_op_fence_plan('acct_sale', k) -> 'safety' = app_private.pos_op_fence_plan('acct_sale', k) -> 'bind'
    and jsonb_array_length(app_private.pos_op_fence_plan('acct_sale', k) -> 'bind') = 2
    and jsonb_array_length(app_private.pos_op_fence_plan('ginpay_tx', 'sale-void:' || pg_temp.u()) -> 'safety') = 1
    and jsonb_array_length(app_private.pos_op_fence_plan('ginpay_tx', 'staff-store-charge:' || pg_temp.u()) -> 'safety') = 1,
    'P CG2-R1 plan: forward K = {K, sale:K}; sale-void:<id> and other D3 keys have no key-domain parent');
end $$;

-- P-12 親の会計が '  K  ' だけ（正規でない）。D3 に sale:K は無い
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  a uuid := pg_temp.cg2_sale(pg_temp.raw('  ' || k || '  '));
  v_rows text := pg_temp.cg2_rows(array[a]);
  v_before text := pg_temp.registry_counts();
  r jsonb;
begin
  perform pg_temp.raw(k); perform pg_temp.raw('sale:' || k);
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', k) ->> 'state' = 'physical_key_noncanonical'
    and app_private.pos_op_physical_probe('ginpay_tx', 'sale:' || k) ->> 'state' = 'physical_key_absent',
    'P CG2-R1-12 fixture: parent probe = noncanonical, sale:K absent');
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k);
  perform pg_temp.ok(pg_temp.r1_refused(r, 'physical_key_noncanonical', v_before, k, array[a], v_rows),
    'P CG2-R1-12 reverse fence sale:K with noncanonical parent: zero-write refusal (' || r::text || ')');
  r := app_private.pos_op_fence_key('ginpay_tx', pg_temp.raw('  sale:' || k || ' '));
  perform pg_temp.ok(pg_temp.r1_refused(r, 'physical_key_noncanonical', v_before, k, array[a], v_rows),
    'P CG2-R1-18 spaced caller spelling of sale:K: same refusal');
  r := app_private.pos_op_fence_key('ginpay_tx', pg_temp.raw('sale:  ' || k || '  '));
  perform pg_temp.ok(r ->> 'reason' = 'physical_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'P CG2-R1-18 sale:<spaced K> (inner spelling) still resolves its parent class: refused');
end $$;

-- P-13 親の会計が K と ' K'（あいまい）。D3 に sale:K は無い
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  a uuid := pg_temp.cg2_sale(k);
  b uuid := pg_temp.cg2_sale(pg_temp.raw(' ' || k), 'cash', 600);
  v_rows text := pg_temp.cg2_rows(array[a, b]);
  v_before text := pg_temp.registry_counts();
  r jsonb;
begin
  perform pg_temp.raw(k);
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', k) ->> 'state' = 'physical_key_ambiguous',
    'P CG2-R1-13 fixture: parent probe = ambiguous');
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k);
  perform pg_temp.ok(pg_temp.r1_refused(r, 'physical_key_ambiguous', v_before, k, array[a, b], v_rows),
    'P CG2-R1-13 reverse fence sale:K with ambiguous parent: zero-write refusal (' || r::text || ')');
  r := app_private.pos_op_fence_key('ginpay_tx', ' sale:' || k);
  perform pg_temp.ok(pg_temp.r1_refused(r, 'physical_key_ambiguous', v_before, k, array[a, b], v_rows),
    'P CG2-R1-13 spaced caller spelling: same refusal, both physical rows unchanged');
end $$;

-- P-14 親の会計が正規の1行（確定済みの現金・保留中）。D3 に sale:K は無い：sale:K だけに「無い」という印は作らない
do $$
declare
  k text := 'checkout:' || pg_temp.u();
  a uuid := pg_temp.cg2_sale(k);
  kp text := 'checkout:' || pg_temp.u();
  b uuid := pg_temp.cg2_sale(kp, 'cash', 500, 'pending');
  v_rows text := pg_temp.cg2_rows(array[a, b]);
  v_before text := pg_temp.registry_counts();
  r jsonb;
begin
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k);
  perform pg_temp.ok(r ->> 'ok' = 'false' and r ->> 'error' = 'legacy_effect_present' and r ->> 'verdict' = 'proven' and r ->> 'key_domain' = 'acct_sale'
    and pg_temp.registry_counts() = v_before and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k),
    'P CG2-R1-14 canonical completed parent: legacy_effect_present (parent proven), no negative evidence (' || r::text || ')');
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || kp);
  perform pg_temp.ok(r ->> 'ok' = 'false' and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'sale_status_pending'
    and pg_temp.registry_counts() = v_before and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || kp),
    'P CG2-R1-14 canonical non-final parent: legacy_state_blocked, zero writes (' || r::text || ')');
  perform pg_temp.ok(pg_temp.cg2_rows(array[a, b]) = v_rows, 'P CG2-R1-14 parent rows untouched');
  -- 親を取り込んだ後も同じ（sale:K は親の操作に結ばれていないので、印は作らない）
  perform app_private.pos_op_discover_legacy('effect', 'accounting_sale', a::text);
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k);
  perform pg_temp.ok(r ->> 'error' = 'legacy_effect_present' and pg_temp.registry_counts() = v_before,
    'P CG2-R1-14 after the parent is discovered: still legacy_effect_present, zero writes');
end $$;

-- P-15 両方とも物理に無い：これまでどおり sale:K だけの印（親の K は確かめるだけで結ばない）。親の lock も取っている
do $$
declare
  k text := pg_temp.raw('checkout:' || pg_temp.u());
  r jsonb;
begin
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k);
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 1
    and exists (select 1 from app_private.pos_operation_keys where key_domain = 'ginpay_tx'
                and key_digest = app_private.pos_op_key_ident('ginpay_tx', 'sale:' || k) and key_role = 'fence')
    and pg_temp.cg2_unbound('acct_sale', k),
    'P CG2-R1-15 both sides absent: sale:K tombstoned, parent K verification-only (not bound)');
  perform pg_temp.ok(exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
                             and l.mode = 'ExclusiveLock' and l.classid::bigint = 71000001
                             and l.objid::bigint = (app_private.pos_op_key_lock_id(app_private.pos_op_key_elem('acct_sale', k))::bigint & 4294967295)),
    'P CG2-R1-15 the parent K was locked (lock set includes every safety key)');
end $$;

-- P-16 派生の側が危ない：親は無い・正規の1行のどちらでも、D3 の sale:K が正規でない・あいまいなら断る
do $$
declare
  k1 text := 'checkout:' || pg_temp.u();
  x1 uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('  sale:' || k1 || '  '));
  k2 text := 'checkout:' || pg_temp.u();
  s2 uuid := pg_temp.cg2_sale(k2);
  x2 uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('sale:' || k2 || ' '));
  x3 uuid := pg_temp.cg2_gp('adjustment', 2, pg_temp.raw(' sale:' || k2));
  v_rows text := pg_temp.cg2_rows(array[x1, s2, x2, x3]);
  v_before text := pg_temp.registry_counts();
begin
  perform pg_temp.raw(k1); perform pg_temp.raw(k2);
  perform pg_temp.ok(pg_temp.r1_refused(app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k1), 'physical_key_noncanonical', v_before, k1, array[x1, s2, x2, x3], v_rows),
    'P CG2-R1-16 parent absent + noncanonical D3 sale:K: refused');
  perform pg_temp.ok(pg_temp.r1_refused(app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k2), 'physical_key_ambiguous', v_before, k2, array[x1, s2, x2, x3], v_rows),
    'P CG2-R1-16 canonical parent + ambiguous D3 sale:K: refused as ambiguous');
end $$;

-- P-17 両方とも危ない：結果はどちらを先に見たかに依らない（あいまいが優先）
do $$
declare
  k1 text := 'checkout:' || pg_temp.u();
  a1 uuid := pg_temp.cg2_sale(pg_temp.raw('  ' || k1));
  x1 uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('sale:' || k1 || ' '));
  x1b uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw(' sale:' || k1));
  k2 text := 'checkout:' || pg_temp.u();
  a2 uuid := pg_temp.cg2_sale(k2);
  a2b uuid := pg_temp.cg2_sale(pg_temp.raw(k2 || ' '), 'cash', 300);
  x2 uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('  sale:' || k2));
  k3 text := 'checkout:' || pg_temp.u();
  a3 uuid := pg_temp.cg2_sale(pg_temp.raw(k3 || '   '));
  x3 uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw('sale:' || k3 || '  '));
  v_ids uuid[] := array[a1, x1, x1b, a2, a2b, x2, a3, x3];
  v_rows text := pg_temp.cg2_rows(v_ids);
  v_before text := pg_temp.registry_counts();
begin
  perform pg_temp.raw(k1); perform pg_temp.raw(k2); perform pg_temp.raw(k3);
  perform pg_temp.ok(pg_temp.r1_refused(app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k1), 'physical_key_ambiguous', v_before, k1, v_ids, v_rows),
    'P CG2-R1-17 noncanonical parent + ambiguous D3: physical_key_ambiguous, zero writes');
  perform pg_temp.ok(pg_temp.r1_refused(app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k2), 'physical_key_ambiguous', v_before, k2, v_ids, v_rows),
    'P CG2-R1-17 ambiguous parent + noncanonical D3: physical_key_ambiguous, zero writes');
  perform pg_temp.ok(pg_temp.r1_refused(app_private.pos_op_fence_key('ginpay_tx', 'sale:' || k3), 'physical_key_noncanonical', v_before, k3, v_ids, v_rows)
    and pg_temp.r1_refused(app_private.pos_op_fence_key('acct_sale', k3), 'physical_key_noncanonical', v_before, k3, v_ids, v_rows),
    'P CG2-R1-17 both noncanonical: reverse and forward fences both refuse, zero writes');
end $$;

-- P-10 sale-void:<会計ID>：キーの範囲の親は無い（親は会計の行 ID。取消のキー void_idempotency_key は別の文字列）。D3 の同値類は確かめる
do $$
declare
  sv uuid := pg_temp.cg2_sale('checkout:' || pg_temp.u(), 'cash', 400, 'voided');
  sw uuid := pg_temp.cg2_sale('checkout:' || pg_temp.u(), 'cash', 400, 'voided');
  xw uuid := pg_temp.cg2_gp('adjustment', 1, pg_temp.raw(' sale-void:' || sw::text));
  v_before text;
  r jsonb;
begin
  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale-void:' || sw::text);
  perform pg_temp.ok(r ->> 'reason' = 'physical_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'P CG2-R1-10 sale-void:<id> with a noncanonical D3 row: refused, zero writes');
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale-void:' || sv::text);
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 1,
    'P CG2-R1-10 sale-void:<id> with no D3 row: tombstoned (no key-domain parent in the approved model)');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Q. CG2-R2 前向きの fence（会計キー K）：対の sale:K が物理にあれば、K が無くても「無い」という印は作らない
-- ════════════════════════════════════════════════════════════════════════════

-- 書かずに断ったこと：台帳の件数（操作・キー・効果・履歴…）が同じ、K / sale:K が結ばれていない、物理の行が変わらない
create function pg_temp.q_nowrite(p_before text, p_k text, p_ids uuid[], p_rows text) returns boolean language sql as $$
  select pg_temp.registry_counts() = p_before
     and pg_temp.cg2_unbound('acct_sale', p_k) and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || p_k)
     and not coalesce((app_private.pos_op_status_by_key('acct_sale', p_k) ->> 'bound')::boolean, false)
     and pg_temp.cg2_rows(p_ids) = p_rows $$;

do $$
declare
  acc uuid := pg_temp.cg2_account();
  -- A 両方無い
  ka text := pg_temp.raw('checkout:' || pg_temp.u());
  -- B D1 K は無い・D3 sale:K は正規の支払い1行（外部キーのため別のキー K2 の GINPay 会計に付く）
  kb text := pg_temp.raw('checkout:' || pg_temp.u());
  sb uuid := pg_temp.cg2_sale(pg_temp.raw('checkout:' || pg_temp.u()), 'ginpay', 900);
  tb uuid := pg_temp.cg2_gp('payment', -900, 'sale:' || kb, sb, acc);
  -- C D1 K は無い・D3 sale:K は正規だが支払いでない行（派生の名前の誤用）
  kc text := pg_temp.raw('checkout:' || pg_temp.u());
  tc uuid := pg_temp.cg2_gp('adjustment', 5, 'sale:' || kc);
  -- D '  sale:K  ' だけ / E sale:K と ' sale:K'
  kd text := pg_temp.raw('checkout:' || pg_temp.u());
  td uuid := pg_temp.cg2_gp('adjustment', 5, pg_temp.raw('  sale:' || kd || '  '));
  ke text := pg_temp.raw('checkout:' || pg_temp.u());
  te1 uuid := pg_temp.cg2_gp('adjustment', 5, 'sale:' || ke);
  te2 uuid := pg_temp.cg2_gp('adjustment', 6, pg_temp.raw(' sale:' || ke));
  -- F D1 K だけ（確定済みの現金）/ G 両方（GINPay 払いの会計 K と支払い sale:K）
  kf text := pg_temp.raw('checkout:' || pg_temp.u());
  sf uuid := pg_temp.cg2_sale(kf);
  kg text := pg_temp.raw('checkout:' || pg_temp.u());
  sg uuid := pg_temp.cg2_sale(kg, 'ginpay', 700);
  tg uuid := pg_temp.cg2_gp('payment', -700, 'sale:' || kg, sg, acc);
  v_ids uuid[];
  v_rows text;
  v_before text;
  p jsonb;
  r jsonb;
begin
  v_ids := array[sb, tb, tc, td, te1, te2, sf, sg, tg];
  v_rows := pg_temp.cg2_rows(v_ids);

  -- 計画：前向きの K は bind = safety = {K, sale:K}
  p := app_private.pos_op_fence_plan('acct_sale', kb);
  perform pg_temp.ok(p -> 'bind' = p -> 'safety' and jsonb_array_length(p -> 'safety') = 2
    and p -> 'safety' @> jsonb_build_array(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || kb)),
    'Q CG2-R2 plan: forward K bind = safety = {K, sale:K}');
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', kb) ->> 'state' = 'physical_key_absent'
    and app_private.pos_op_physical_probe('ginpay_tx', 'sale:' || kb) ->> 'state' = 'physical_key_canonical_single'
    and app_private.pos_op_classify_legacy_effect('ginpay_transaction', tb) ->> 'reason' = 'ginpay_payment_mismatch',
    'Q CG2-R2 B fixture: D1 K absent, D3 sale:K canonical single, classifier blocked (ginpay_payment_mismatch)');

  v_before := pg_temp.registry_counts();
  r := app_private.pos_op_fence_key('acct_sale', kb);
  perform pg_temp.ok(r ->> 'ok' = 'false' and r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'ginpay_payment_mismatch'
    and r ->> 'key_domain' = 'ginpay_tx' and pg_temp.q_nowrite(v_before, kb, v_ids, v_rows),
    'Q CG2-R2 B D1 absent + canonical sale:K payment: no tombstone for K, zero writes (' || r::text || ')');
  r := app_private.pos_op_fence_key('acct_sale', '  ' || kb || ' ');
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and pg_temp.q_nowrite(v_before, kb, v_ids, v_rows),
    'Q CG2-R2 B spaced caller spelling of K: same refusal');
  r := app_private.pos_op_fence_key('acct_sale', kc);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'derived_namespace_misuse'
    and pg_temp.q_nowrite(v_before, kc, v_ids, v_rows),
    'Q CG2-R2 C D1 absent + canonical but inconsistent sale:K: fail closed, zero writes (' || r::text || ')');
  r := app_private.pos_op_fence_key('acct_sale', kd);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_noncanonical'
    and pg_temp.q_nowrite(v_before, kd, v_ids, v_rows),
    'Q CG2-R2 D D1 absent + ''  sale:K  '' only: noncanonical, zero writes');
  r := app_private.pos_op_fence_key('acct_sale', ke);
  perform pg_temp.ok(r ->> 'error' = 'legacy_state_blocked' and r ->> 'reason' = 'physical_key_ambiguous'
    and pg_temp.q_nowrite(v_before, ke, v_ids, v_rows),
    'Q CG2-R2 E D1 absent + sale:K and '' sale:K'': ambiguous, zero writes');
  r := app_private.pos_op_fence_key('acct_sale', kf);
  perform pg_temp.ok(r ->> 'error' = 'legacy_effect_present' and r ->> 'verdict' = 'proven'
    and pg_temp.q_nowrite(v_before, kf, v_ids, v_rows),
    'Q CG2-R2 F D1 K canonical (completed) + sale:K absent: legacy_effect_present, zero writes');
  r := app_private.pos_op_fence_key('acct_sale', kg);
  perform pg_temp.ok(r ->> 'error' = 'legacy_effect_present' and r ->> 'verdict' = 'proven'
    and pg_temp.q_nowrite(v_before, kg, v_ids, v_rows),
    'Q CG2-R2 G both canonical (GINPay-paid sale + its payment): legacy_effect_present, zero writes');
  -- 同じ状態で逆向き（sale:K）も印を作らない
  r := app_private.pos_op_fence_key('ginpay_tx', 'sale:' || kg);
  perform pg_temp.ok(r ->> 'ok' = 'false' and pg_temp.q_nowrite(v_before, kg, v_ids, v_rows),
    'Q CG2-R2 G reverse fence of the present sale:K: refused, zero writes (' || coalesce(r ->> 'error', '') || ')');

  -- A 両方とも物理に無い：これまでどおり K と sale:K の印
  r := app_private.pos_op_fence_key('acct_sale', ka);
  perform pg_temp.ok(r ->> 'result' = 'tombstoned' and (r ->> 'keys')::int = 2
    and not pg_temp.cg2_unbound('acct_sale', ka) and not pg_temp.cg2_unbound('ginpay_tx', 'sale:' || ka)
    and pg_temp.cg2_rows(v_ids) = v_rows,
    'Q CG2-R2 A both absent: legitimate tombstone of K and sale:K');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- R. CG2-R3 負けたキー（同じ依頼 ID・違う依頼）：入口の K が無くても、対の sale:K が物理にあれば取り消しの印は作らない
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_i text := pg_temp.u();
  v_facts jsonb := jsonb_build_object('client_id', pg_temp.u());
  k1 text := pg_temp.raw('checkout:' || pg_temp.u());
  acc uuid := pg_temp.cg2_account();
  -- 11 K2 は無い・sale:K2 は正規の支払い1行（外部キーのため別のキーの GINPay 会計に付く。分類は blocked）
  k11 text := pg_temp.raw('checkout:' || pg_temp.u());
  s11 uuid := pg_temp.cg2_sale(pg_temp.raw('checkout:' || pg_temp.u()), 'ginpay', 900);
  t11 uuid := pg_temp.cg2_gp('payment', -900, 'sale:' || k11, s11, acc);
  -- 12 証明できる対：GINPay 払いの会計 K2 と支払い sale:K2 / 確定済みの現金の会計 K2 だけ
  k12 text := pg_temp.raw('checkout:' || pg_temp.u());
  s12 uuid := pg_temp.cg2_sale(k12, 'ginpay', 700);
  t12 uuid := pg_temp.cg2_gp('payment', -700, 'sale:' || k12, s12, acc);
  k12c text := pg_temp.raw('checkout:' || pg_temp.u());
  s12c uuid := pg_temp.cg2_sale(k12c);
  -- 13 sale:K2 は正規だが支払いでない行
  k13 text := pg_temp.raw('checkout:' || pg_temp.u());
  t13 uuid := pg_temp.cg2_gp('adjustment', 5, 'sale:' || k13);
  -- 14 '  sale:K2  ' だけ / 15 sale:K2 と ' sale:K2'
  k14 text := pg_temp.raw('checkout:' || pg_temp.u());
  t14 uuid := pg_temp.cg2_gp('adjustment', 5, pg_temp.raw('  sale:' || k14 || '  '));
  k15 text := pg_temp.raw('checkout:' || pg_temp.u());
  t15 uuid := pg_temp.cg2_gp('adjustment', 5, 'sale:' || k15);
  t15b uuid := pg_temp.cg2_gp('adjustment', 6, pg_temp.raw(' sale:' || k15));
  -- 17 D1 の側が危ない（D3 は無い）：'  K2' だけ / K2 と 'K2 '
  k17n text := pg_temp.raw('checkout:' || pg_temp.u());
  s17n uuid := pg_temp.cg2_sale(pg_temp.raw('  ' || k17n));
  k17a text := pg_temp.raw('checkout:' || pg_temp.u());
  s17a uuid := pg_temp.cg2_sale(k17a);
  s17b uuid := pg_temp.cg2_sale(pg_temp.raw(k17a || ' '), 'cash', 300);
  -- 16 両方とも無い
  k16 text := pg_temp.raw('checkout:' || pg_temp.u());
  v_ids uuid[];
  v_rows text;
  v_inst text;
  v_before text;
  r jsonb;
  p jsonb;
begin
  v_ids := array[s11, t11, s12, t12, s12c, t13, t14, t15, t15b, s17n, s17a, s17b];
  v_rows := pg_temp.cg2_rows(v_ids);

  -- 8 関係は1つ：会計の依頼キー一式と fence の確認の一式が同じ {K, sale:K}
  perform pg_temp.ok(app_private.pos_op_dh(app_private.pos_op_request_keys('checkout_client', k16))
                       @> app_private.pos_op_dh(app_private.pos_op_fence_plan('acct_sale', k16) -> 'safety')
    and app_private.pos_op_dh(app_private.pos_op_fence_plan('acct_sale', k16) -> 'safety')
                       @> app_private.pos_op_dh(app_private.pos_op_request_keys('checkout_client', k16))
    and jsonb_array_length(app_private.pos_op_request_keys('checkout_client', k16)) = 2,
    'R CG2-R3 checkout losing-key safety set = fence safety set = {K, sale:K}');
  perform pg_temp.ok((select bool_and(jsonb_array_length(app_private.pos_op_request_keys(x, (app_private.pos_op_kind_spec(x) ->> 'prefix') || pg_temp.u())) = 1)
                      from unnest(array['ginpay_charge', 'ginpay_refund', 'hq_ginpay_refund', 'hq_ginpay_void', 'ginpay_adjustment',
                                        'hq_sale_void', 'ticket_issue', 'ginpay_open']) x)
    and (select bool_and(jsonb_array_length(app_private.pos_op_request_keys(x, 'checkout:' || pg_temp.u())) = 2)
         from unnest(array['checkout_reservation', 'checkout_client', 'checkout_anonymous']) x),
    'R CG2-R3 inventory: only the three checkout kinds derive sale:K; every other kind has only its entry key');

  -- 依頼 I は K1 で受理済み
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k1, 0);
  perform pg_temp.ok(r ->> 'result' = 'prepared', 'R CG2-R3 fixture: instruction I prepared with K1');
  v_inst := (select to_jsonb(i)::text || to_jsonb(o)::text from app_private.pos_business_instructions i
             join app_private.pos_operations o using (operation_id) where i.instruction_id = v_i::uuid);
  v_before := pg_temp.registry_counts();

  -- 11 再現：K2 は無い・sale:K2 は正規の1行
  perform pg_temp.ok(app_private.pos_op_physical_probe('acct_sale', k11) ->> 'state' = 'physical_key_absent'
    and app_private.pos_op_physical_probe('ginpay_tx', 'sale:' || k11) ->> 'state' = 'physical_key_canonical_single'
    and pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), k11, 0) ->> 'error' = 'legacy_key_present',
    'R CG2-R3-11 fixture: K2 absent, sale:K2 canonical; a fresh PREPARE refuses with legacy_key_present');
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k11, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present'
    and r ->> 'losing_key_domain' = 'ginpay_tx' and r ->> 'losing_key_reason' = 'ginpay_payment_mismatch'
    and pg_temp.q_nowrite(v_before, k11, v_ids, v_rows),
    'R CG2-R3-11 instruction_conflict + canonical sale:K2: losing key NOT tombstoned, zero writes (' || r::text || ')');
  -- 12 証明できる対（K2 と sale:K2 の両方、または K2 だけ）
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k12, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present'
    and pg_temp.q_nowrite(v_before, k12, v_ids, v_rows),
    'R CG2-R3-12 proven GINPay-paid sale K2 + payment sale:K2: legacy_key_present, zero writes');
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k12c, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present'
    and pg_temp.q_nowrite(v_before, k12c, v_ids, v_rows),
    'R CG2-R3-12 proven completed cash sale K2: legacy_key_present, zero writes');
  -- 13 正規だが矛盾した行
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k13, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present'
    and r ->> 'losing_key_verdict' = 'blocked' and r ->> 'losing_key_reason' = 'derived_namespace_misuse'
    and pg_temp.q_nowrite(v_before, k13, v_ids, v_rows),
    'R CG2-R3-13 canonical but inconsistent sale:K2: fail closed (blocked / derived_namespace_misuse), zero writes');
  -- 14 / 15
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k14, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_noncanonical'
    and pg_temp.q_nowrite(v_before, k14, v_ids, v_rows),
    'R CG2-R3-14 only ''  sale:K2  '': legacy_key_noncanonical, zero writes');
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k15, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_ambiguous'
    and pg_temp.q_nowrite(v_before, k15, v_ids, v_rows),
    'R CG2-R3-15 sale:K2 + '' sale:K2'': legacy_key_ambiguous, zero writes');
  -- 17 D1 の側が危ない
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k17n, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_noncanonical'
    and pg_temp.q_nowrite(v_before, k17n, v_ids, v_rows),
    'R CG2-R3-17 D1 ''  K2'' only (D3 absent): legacy_key_noncanonical, zero writes');
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k17a, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_ambiguous'
    and pg_temp.q_nowrite(v_before, k17a, v_ids, v_rows),
    'R CG2-R3-17 D1 K2 + ''K2 '' (D3 absent): legacy_key_ambiguous, zero writes');
  -- 10 派生キーは入口のキーになれない（PREPARE の型の決まり）：sale:K を入口にした衝突は invalid_key で何も書かない
  perform pg_temp.ok(pg_temp.prep(v_i, 'checkout_client', v_facts, 'sale:' || k16, 0) ->> 'error' = 'invalid_key'
    and pg_temp.prep(v_i, 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100), 'sale:' || k16, 0) ->> 'error' = 'invalid_key'
    and pg_temp.prep(v_i, 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100), 'sale-void:' || pg_temp.u(), 0) ->> 'error' = 'invalid_key'
    and pg_temp.registry_counts() = v_before,
    'R CG2-R3-10 a derived key (sale:K / sale-void:<id>) can never be a losing entry key: invalid_key before the conflict path, zero writes');
  -- 18 正確な再送はこれまでどおり / 19 違う依頼 ID・同じキーは key_conflict（印は作らない）
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k1, 0);
  perform pg_temp.ok(r ->> 'result' = 'existing' and pg_temp.registry_counts() = v_before, 'R CG2-R3-18 exact retry of I is still existing');
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k1, 7);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'already_bound' and pg_temp.registry_counts() = v_before,
    'R CG2-R3-18 same key but different observed epoch: instruction_conflict, losing key already bound (no new tombstone)');
  r := pg_temp.prep(pg_temp.u(), 'checkout_client', v_facts, k1, 1);
  perform pg_temp.ok(r ->> 'error' = 'key_conflict' and pg_temp.registry_counts() = v_before,
    'R CG2-R3-19 different instruction + same key: key_conflict, zero writes');
  perform pg_temp.ok((select to_jsonb(i)::text || to_jsonb(o)::text from app_private.pos_business_instructions i
                      join app_private.pos_operations o using (operation_id) where i.instruction_id = v_i::uuid) = v_inst,
    'R CG2-R3 the winning instruction and its operation are unchanged after every losing request');

  -- 16 両方とも無い：これまでどおり conflict_tombstone（K2 と sale:K2）
  r := pg_temp.prep(v_i, 'checkout_client', v_facts, k16, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'tombstoned'
    and (app_private.pos_op_status_by_key('acct_sale', k16) #>> '{operation,origin}') = 'conflict_tombstone'
    and not pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k16) and pg_temp.cg2_rows(v_ids) = v_rows,
    'R CG2-R3-16 both absent: losing K2 and sale:K2 tombstoned as before');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- T. CG2-R5 負けたキーの印（conflict_tombstone）は、PREPARE が「同じ依頼 ID・違う依頼」と決めた分岐の中でだけ作られる。
--    独立した書き込み関数は無い（種類・入口のキー・依頼 ID だけから instruction_conflict を名乗る印は作れない）
-- ════════════════════════════════════════════════════════════════════════════

-- 1 / 12 呼び出しの形：独立した関数は無い。conflict_tombstone を書く関数は PREPARE だけで、その書き込みは完全一致の比較の後
do $$
declare
  v_src text := (select prosrc from pg_proc where oid = 'app_private.pos_op_prepare(uuid,text,jsonb,text,bigint,text,text,text)'::regprocedure);
begin
  perform pg_temp.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'app_private' and p.proname = 'pos_op_tombstone_request_keys'),
    'T CG2-R5-1 no pos_op_tombstone_request_keys function exists (no standalone conflict writer)');
  perform pg_temp.ok((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'app_private' and p.prosrc like '%''conflict_tombstone'', ''abandoned''%') = array['pos_op_prepare']
    and (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app_private' and p.prosrc like '%''reason'', ''instruction_conflict''%') = array['pos_op_prepare'],
    'T CG2-R5-12 the only function that writes a conflict_tombstone operation / instruction_conflict event is pos_op_prepare');
  perform pg_temp.ok(strpos(v_src, 'v_inst.observed_epoch = p_expected_epoch') > 0
    and strpos(v_src, '''conflict_tombstone'', ''abandoned''') > strpos(v_src, 'v_inst.observed_epoch = p_expected_epoch')
    and strpos(v_src, 'pos_op_conflict_losing_status(v_keys)') > strpos(v_src, 'v_inst.observed_epoch = p_expected_epoch'),
    'T CG2-R5-12 inside PREPARE the losing-key evaluation and the tombstone write come after the exact-retry comparison');
  perform pg_temp.ok((select provolatile = 's' from pg_proc where oid = 'app_private.pos_op_conflict_losing_status(jsonb)'::regprocedure)
    and not has_function_privilege('public', 'app_private.pos_op_conflict_losing_status(jsonb)', 'execute')
    and not has_function_privilege('anon', 'app_private.pos_op_conflict_losing_status(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.pos_op_conflict_losing_status(jsonb)', 'execute')
    and not has_function_privilege('service_role', 'app_private.pos_op_conflict_losing_status(jsonb)', 'execute')
    and not has_function_privilege('anon', 'app_private.pos_op_prepare(uuid,text,jsonb,text,bigint,text,text,text)', 'execute'),
    'T CG2-R5 the losing-key status check is STABLE (cannot write) and no client role can execute it or PREPARE');
end $$;

-- 2 / 3 / 4 ランダムな依頼 ID・関係のない依頼 ID・衝突の無い依頼：直接は何も作れない（関数が無い）。STABLE の確認は書けない
do $$
declare
  k text := pg_temp.raw('checkout:' || pg_temp.u());
  v_i text := pg_temp.u();
  v_before text;
  r jsonb;
begin
  r := pg_temp.prep(v_i, 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0);
  perform pg_temp.ok(r ->> 'result' = 'prepared', 'T CG2-R5 fixture: an unrelated instruction I1 exists');
  v_before := pg_temp.registry_counts();
  perform pg_temp.err(format('select app_private.pos_op_tombstone_request_keys(%L, %L, %L::uuid)', 'checkout_client', k, pg_temp.u()),
    '%does not exist%', 'T CG2-R5-2 random instruction UUID + absent checkout key: no writer to call');
  perform pg_temp.err(format('select app_private.pos_op_tombstone_request_keys(%L, %L, %L::uuid)', 'checkout_client', k, v_i),
    '%does not exist%', 'T CG2-R5-3 unrelated existing instruction I1 + unrelated K2: no writer to call');
  perform pg_temp.err(format('select app_private.pos_op_tombstone_request_keys(%L::jsonb, %L, %L, %L::uuid, %L)',
                             app_private.pos_op_request_keys('checkout_client', k), 'conflict_tombstone', 'checkout_client', v_i, 'instruction_conflict'),
    '%does not exist%', 'T CG2-R5-3 the old jsonb key-plan signature does not exist either');
  -- 状態の確認（STABLE）は lock を持っていても印を作らない：null（作ってよい）を返すだけで、何も書かない
  perform app_private.pos_op_lock_keys_xact(app_private.pos_op_request_keys('checkout_client', k));
  perform pg_temp.ok(app_private.pos_op_conflict_losing_status(app_private.pos_op_request_keys('checkout_client', k)) is null
    and pg_temp.registry_counts() = v_before and pg_temp.cg2_unbound('acct_sale', k) and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k),
    'T CG2-R5-4 the read-only status check on an absent K writes nothing (no conflict evidence without PREPARE)');
  perform pg_temp.err(format('select app_private.pos_op_conflict_losing_status(%L::jsonb)', app_private.pos_op_request_keys('checkout_client', 'checkout:' || pg_temp.u())),
    '%pos_lock_order_violation%', 'T CG2-R5 the status check refuses keys that are not locked');
  -- digest を別の範囲のもの（ginpay_tx の K）にした要素：lock を持たせても、範囲と値から計算した digest と違うので止まる
  perform app_private.pos_op_lock_keys_xact(jsonb_build_array(jsonb_build_object('d', 'acct_sale', 'h', encode(app_private.pos_op_key_ident('ginpay_tx', k), 'hex'))));
  perform pg_temp.err(format('select app_private.pos_op_conflict_losing_status(%L::jsonb)',
                             jsonb_build_array(jsonb_build_object('d', 'acct_sale', 'v', k, 'r', 'entry', 'h', encode(app_private.pos_op_key_ident('ginpay_tx', k), 'hex')))),
    '%pos_key_plan_invalid%', 'T CG2-R5 the status check refuses a digest that does not belong to its domain and value (even when locked)');
  perform pg_temp.ok(pg_temp.registry_counts() = v_before, 'T CG2-R5-2/3/4 zero writes (operations, keys, instructions, slots, targets, effects, events)');
end $$;

-- 5〜11 PREPARE を通る本当の衝突（受理済み・拒否済み・終了済みの依頼、種類の違い、版の違い）
do $$
declare
  acc uuid := pg_temp.cg2_account();
  f1 jsonb := jsonb_build_object('client_id', pg_temp.u());
  i1 text := pg_temp.u();
  k1 text := pg_temp.raw('checkout:' || pg_temp.u());
  -- 物理の状態ごとの負けたキー
  ka text := pg_temp.raw('checkout:' || pg_temp.u());
  kp text := pg_temp.raw('checkout:' || pg_temp.u());
  sp uuid := pg_temp.cg2_sale(pg_temp.raw('checkout:' || pg_temp.u()), 'ginpay', 900);
  tp uuid := pg_temp.cg2_gp('payment', -900, 'sale:' || kp, sp, acc);
  kn text := pg_temp.raw('checkout:' || pg_temp.u());
  sn uuid := pg_temp.cg2_sale(pg_temp.raw('  ' || kn || ' '));
  km text := pg_temp.raw('checkout:' || pg_temp.u());
  tm1 uuid := pg_temp.cg2_gp('adjustment', 5, 'sale:' || km);
  tm2 uuid := pg_temp.cg2_gp('adjustment', 6, pg_temp.raw('sale:' || km || '  '));
  -- 拒否済み（stale_epoch）の依頼 / 終了済み（fence で abandoned）の依頼
  i2 text := pg_temp.u();
  f2 jsonb := jsonb_build_object('client_id', pg_temp.u());
  k2 text := pg_temp.raw('checkout:' || pg_temp.u());
  i3 text := pg_temp.u();
  f3 jsonb := jsonb_build_object('client_id', pg_temp.u());
  k3 text := pg_temp.raw('checkout:' || pg_temp.u());
  kg text := pg_temp.raw('staff-store-charge:' || pg_temp.u());
  v_ids uuid[];
  v_rows text;
  v_before text;
  r jsonb;
  v_op uuid;
begin
  v_ids := array[sp, tp, sn, tm1, tm2];
  v_rows := pg_temp.cg2_rows(v_ids);
  perform pg_temp.ok(pg_temp.prep(i1, 'checkout_client', f1, k1, 0) ->> 'result' = 'prepared', 'T CG2-R5 fixture: I prepared with request R1 (K1)');
  v_before := pg_temp.registry_counts();

  -- 9 完全一致の再送 / 10 版だけ違う（観察した版は依頼の一部：instruction_conflict、入口のキーは登録済みなので印は作らない）
  r := pg_temp.prep(i1, 'checkout_client', f1, k1, 0);
  perform pg_temp.ok(r ->> 'result' = 'existing' and not r ? 'losing_key' and pg_temp.registry_counts() = v_before,
    'T CG2-R5-9 exact retry: existing, no losing-key evaluation, zero writes');
  r := pg_temp.prep(i1, 'checkout_client', f1, k1, 3);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'already_bound' and pg_temp.registry_counts() = v_before,
    'T CG2-R5-10 same request, different observed epoch: instruction_conflict (epoch is part of the request), losing key already bound, zero writes');
  -- 11 違う依頼 ID・同じキー
  r := pg_temp.prep(pg_temp.u(), 'checkout_client', f1, k1, 1);
  perform pg_temp.ok(r ->> 'error' = 'key_conflict' and not r ? 'losing_key' and pg_temp.registry_counts() = v_before,
    'T CG2-R5-11 different instruction + same key: key_conflict, no instruction-conflict path, zero writes');

  -- 6 / 7 / 8 本当の衝突だが、負けたキーの物理が無いとは言えない
  r := pg_temp.prep(i1, 'checkout_client', f1, kp, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present' and r ->> 'losing_key_domain' = 'ginpay_tx'
    and pg_temp.q_nowrite(v_before, kp, v_ids, v_rows),
    'T CG2-R5-6 true conflict + canonical sale:K2 present: instruction_conflict, legacy_key_present, zero writes');
  r := pg_temp.prep(i1, 'checkout_client', f1, kn, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_noncanonical'
    and pg_temp.q_nowrite(v_before, kn, v_ids, v_rows),
    'T CG2-R5-7 true conflict + noncanonical D1 K2: legacy_key_noncanonical, zero writes');
  r := pg_temp.prep(i1, 'checkout_client', f1, km, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_ambiguous'
    and pg_temp.q_nowrite(v_before, km, v_ids, v_rows),
    'T CG2-R5-8 true conflict + ambiguous D3 sale:K2: legacy_key_ambiguous, zero writes');

  -- 5 本当の衝突・負けたキーは物理に無い：conflict_tombstone（結ぶのは digest(K2) と digest(sale:K2) だけ）
  r := pg_temp.prep(i1, 'checkout_client', f1, ka, 0);
  v_op := (r ->> 'tombstone_operation_id')::uuid;
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'tombstoned'
    and (select origin = 'conflict_tombstone' and refused_instruction_id = i1::uuid from app_private.pos_operations where operation_id = v_op)
    and (select array_agg(key_domain || ':' || encode(key_digest, 'hex') order by key_domain) from app_private.pos_operation_keys where operation_id = v_op)
        = array['acct_sale:' || encode(app_private.pos_op_key_ident('acct_sale', ka), 'hex'), 'ginpay_tx:' || encode(app_private.pos_op_key_ident('ginpay_tx', 'sale:' || ka), 'hex')]
    and (select detail ->> 'reason' from app_private.pos_operation_events where operation_id = v_op) = 'instruction_conflict'
    and pg_temp.cg2_rows(v_ids) = v_rows,
    'T CG2-R5-5 true conflict + absent K2 / sale:K2: conflict_tombstone binds exactly digest(K2) and digest(sale:K2)');

  -- 種類が違う（同じ依頼 ID に GINPay のチャージ）：PREPARE の比較で instruction_conflict。印はその依頼のキー（1つ）だけ
  r := pg_temp.prep(i1, 'ginpay_charge', jsonb_build_object('account_id', pg_temp.u(), 'amount', 100), kg, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'tombstoned'
    and (select array_agg(key_domain) from app_private.pos_operation_keys where operation_id = (r ->> 'tombstone_operation_id')::uuid) = array['ginpay_tx']
    and not pg_temp.cg2_unbound('ginpay_tx', kg),
    'T CG2-R5 kind change on the same instruction: instruction_conflict by the PREPARE comparison; only the incoming kind''s entry key is tombstoned');

  -- 20 拒否済み（stale_epoch）の依頼：完全一致は保存済みの拒否を返し、違う依頼は instruction_conflict
  r := pg_temp.prep(i2, 'checkout_client', f2, k2, 5);
  perform pg_temp.ok(r ->> 'error' = 'stale_epoch', 'T CG2-R5-20 fixture: refused instruction (stale_epoch) stored');
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(i2, 'checkout_client', f2, k2, 5);
  perform pg_temp.ok(r ->> 'error' = 'stale_epoch' and (r ->> 'replay')::boolean and pg_temp.registry_counts() = v_before,
    'T CG2-R5-20 refused instruction, exact same request: stored refusal replayed, zero writes');
  r := pg_temp.prep(i2, 'checkout_client', f2, kp, 5);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_present' and pg_temp.registry_counts() = v_before,
    'T CG2-R5-20 refused instruction, different request with sale:K present: instruction_conflict, no tombstone');
  r := pg_temp.prep(i2, 'checkout_client', f2, pg_temp.raw('checkout:' || pg_temp.u()), 5);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'tombstoned',
    'T CG2-R5-20 refused instruction, different request with absent keys: instruction_conflict, tombstoned');

  -- 20 終了済み（fence で abandoned）の依頼：完全一致は existing（abandoned）、違う依頼は instruction_conflict
  perform pg_temp.ok(pg_temp.prep(i3, 'checkout_client', f3, k3, 0) ->> 'result' = 'prepared'
    and app_private.pos_op_fence_key('acct_sale', k3) ->> 'status' is distinct from 'prepared',
    'T CG2-R5-20 fixture: accepted instruction whose operation was fenced (terminal)');
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(i3, 'checkout_client', f3, k3, 0);
  perform pg_temp.ok(r ->> 'result' = 'existing' and r ->> 'status' = 'abandoned' and pg_temp.registry_counts() = v_before,
    'T CG2-R5-20 terminal instruction, exact same request: existing (abandoned), zero writes');
  r := pg_temp.prep(i3, 'checkout_client', f3, kn, 0);
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'legacy_key_noncanonical' and pg_temp.registry_counts() = v_before,
    'T CG2-R5-20 terminal instruction, different request with noncanonical K: instruction_conflict, no tombstone');
end $$;

-- 12 台帳の全体：conflict_tombstone の操作はすべて、保存済みの依頼（衝突の相手）を指し、その依頼と違うキーを持つ
do $$
begin
  perform pg_temp.ok(not exists (select 1 from app_private.pos_operations o where o.origin = 'conflict_tombstone'
                                 and not exists (select 1 from app_private.pos_business_instructions i where i.instruction_id = o.refused_instruction_id))
    and not exists (select 1 from app_private.pos_operations o join app_private.pos_business_instructions i on i.instruction_id = o.refused_instruction_id
                    join app_private.pos_operation_keys k on k.operation_id = o.operation_id
                    where o.origin = 'conflict_tombstone' and k.key_domain = i.entry_key_domain and k.key_digest = i.entry_key_digest)
    and not exists (select 1 from app_private.pos_operation_events v join app_private.pos_operations o using (operation_id)
                    where v.detail ->> 'reason' = 'instruction_conflict' and o.origin <> 'conflict_tombstone'),
    'T CG2-R5-12 every conflict_tombstone points at a stored instruction, never binds that instruction''s own key, and only conflict tombstones carry reason instruction_conflict');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- U. G1 / G2 表の境界での意味の不変条件（トリガー・制約はすべて有効のまま。止めるのは「その層だけで効く」ことを見るときだけ）
--   G1 拒否・衝突の印の refused_instruction_id は依頼の表の行を指す（遅延の外部キー、RESTRICT）。衝突の印は必ず依頼を指す（CHECK）
--   G2 instruction_conflict（と stale_epoch / slot_busy）は予約されたコード：その origin の決まった履歴にだけ書ける
--   本当の COMMIT は dblink の別セッションで確かめる（最後に dblink は外す）
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists dblink schema extensions;

-- p_sqls を実行 → SET CONSTRAINTS ALL IMMEDIATE。どこで止まったかを返す（stmt:… / immediate:… / ok）。どの場合も最後に戻す
create function pg_temp.u_try(p_sqls text[], p_disable text[] default '{}') returns text language plpgsql as $$
declare
  v_stage text := 'stmt';
  v_msg text;
  v_s text;
begin
  begin
    foreach v_s in array p_disable loop
      execute format('alter table %s disable trigger %I', split_part(v_s, '|', 1), split_part(v_s, '|', 2));
    end loop;
    foreach v_s in array p_sqls loop
      execute v_s;
    end loop;
    v_stage := 'immediate';
    set constraints all immediate;
    v_stage := 'ok';
    raise exception 'u_rollback';
  exception when others then
    v_msg := sqlerrm;
  end;
  return v_stage || case when v_stage = 'ok' then '' else ':' || v_msg end;
end $$;

-- Codex G1 の再現の形：操作（印）＋ キー2つ（K と sale:K の digest、fence）＋ tombstoned の履歴。省略せずに全部書く
create function pg_temp.u_tomb_sqls(p_op uuid, p_origin text, p_ref uuid, p_k text, p_reason text default 'instruction_conflict')
returns text[] language sql as $$
  select array[
    format('insert into app_private.pos_operations (operation_id, kind, origin, status, refused_instruction_id, terminal_at) values (%L, %L, %L, %L, %L, now())',
           p_op, case when p_origin = 'negative_tombstone' then 'key_tombstone' else 'checkout_client' end, p_origin, 'abandoned', p_ref),
    format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, %L, %L, %L), (%L, %L, %L, %L)',
           'acct_sale', app_private.pos_op_key_ident('acct_sale', p_k), p_op, 'fence',
           'ginpay_tx', app_private.pos_op_key_ident('ginpay_tx', 'sale:' || p_k), p_op, 'fence'),
    format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
           p_op, 'tombstoned', jsonb_build_object('reason', p_reason, 'keys', 2))] $$;

-- 別セッション（dblink）で 1 つのトランザクションを本当に COMMIT する
create function pg_temp.u_remote(p_sqls text[]) returns void language plpgsql as $$
begin
  if 'u' = any (coalesce(extensions.dblink_get_connections(), '{}')) then perform extensions.dblink_disconnect('u'); end if;
  perform extensions.dblink_connect('u', format('host=%s port=%s dbname=%s user=%s', 'localhost', current_setting('port'), current_database(), current_user));
  perform extensions.dblink_exec('u', 'set client_min_messages = error');
  perform extensions.dblink_exec('u', 'begin; ' || array_to_string(p_sqls, '; ') || '; commit');
end $$;

-- 0 形：外部キーは依頼の主キーへ、遅延（INITIALLY DEFERRED）、ON UPDATE / ON DELETE は RESTRICT（CASCADE / SET NULL ではない）
do $$
begin
  perform pg_temp.ok((select confrelid = 'app_private.pos_business_instructions'::regclass and condeferrable and condeferred
                             and confupdtype = 'r' and confdeltype = 'r' and contype = 'f'
                             and conkey = array[(select attnum from pg_attribute where attrelid = 'app_private.pos_operations'::regclass and attname = 'refused_instruction_id')]
                             and confkey = array[(select attnum from pg_attribute where attrelid = 'app_private.pos_business_instructions'::regclass and attname = 'instruction_id')]
                      from pg_constraint where conname = 'pos_operations_refused_instruction_fkey' and conrelid = 'app_private.pos_operations'::regclass),
    'U G1 FK pos_operations.refused_instruction_id -> pos_business_instructions.instruction_id, DEFERRABLE INITIALLY DEFERRED, ON UPDATE/DELETE RESTRICT');
  perform pg_temp.ok(exists (select 1 from pg_constraint where conrelid = 'app_private.pos_operations'::regclass and contype = 'c'
                             and pg_get_constraintdef(oid) like '%stale_prepare%busy_prepare%conflict_tombstone%refused_instruction_id IS NOT NULL%'),
    'U G1 CHECK: origin in (stale_prepare, busy_prepare, conflict_tombstone) <=> refused_instruction_id IS NOT NULL');
  perform pg_temp.ok(app_private.pos_op_reserved_code('instruction_conflict') = 'conflict_tombstone'
    and app_private.pos_op_reserved_code('stale_epoch') = 'stale_prepare' and app_private.pos_op_reserved_code('slot_busy') = 'busy_prepare'
    and app_private.pos_op_reserved_code('target_busy') is null and app_private.pos_op_reserved_code('fenced') is null
    and app_private.pos_op_reserved_code('Instruction_Conflict') is null and app_private.pos_op_reserved_code(null) is null,
    'U G2 reserved codes: instruction_conflict -> conflict_tombstone, stale_epoch -> stale_prepare, slot_busy -> busy_prepare (codes are lowercase-only by grammar)');
  perform pg_temp.ok(not has_function_privilege('public', 'app_private.pos_op_reserved_code(text)', 'execute')
    and not has_function_privilege('anon', 'app_private.pos_op_reserved_code(text)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.pos_op_reserved_code(text)', 'execute')
    and not has_function_privilege('service_role', 'app_private.pos_op_reserved_code(text)', 'execute')
    and (select not prosecdef and proconfig::text like '%search_path=public, extensions, pg_temp%' from pg_proc
         where oid = 'app_private.pos_op_reserved_code(text)'::regprocedure),
    'U G2 helper: SECURITY INVOKER, fixed search_path, no PUBLIC/anon/authenticated/service_role execute');
end $$;

-- U1 / U2 / U12 / 20 Codex G1 の再現（操作＋キー2つ＋履歴、依頼 ID は存在しない UUID）
do $$
declare
  v_op uuid := gen_random_uuid();
  v_ref uuid := gen_random_uuid();
  k text := 'checkout:' || pg_temp.u();
  r text;
begin
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(v_op, 'conflict_tombstone', v_ref, k));
  perform pg_temp.ok(r like 'immediate:%pos_operations_refused_instruction_fkey%',
    'U2/U12 Codex G1 reproduction (conflict_tombstone + 2 fence keys + instruction_conflict event + nonexistent instruction): every statement passes, SET CONSTRAINTS ALL IMMEDIATE rejects by the FK (' || r || ')');
  -- U1 本当の COMMIT（別セッション）：COMMIT で失敗し、何も残らない
  perform pg_temp.err(format('select pg_temp.u_remote(%L::text[])', pg_temp.u_tomb_sqls(v_op, 'conflict_tombstone', v_ref, k)),
    '%pos_operations_refused_instruction_fkey%', 'U1 the same reproduction in another session: real COMMIT fails on the FK');
  perform pg_temp.ok(not exists (select 1 from app_private.pos_operations where operation_id = v_op)
    and not exists (select 1 from app_private.pos_operation_events where operation_id = v_op)
    and pg_temp.cg2_unbound('acct_sale', k) and pg_temp.cg2_unbound('ginpay_tx', 'sale:' || k),
    'U1 after the failed COMMIT no operation, key or event of the orphan tombstone is durable');
  -- 履歴なし（操作＋キーだけ）でも同じ外部キーで止まる
  r := pg_temp.u_try((pg_temp.u_tomb_sqls(v_op, 'conflict_tombstone', v_ref, k))[1:2]);
  perform pg_temp.ok(r like 'immediate:%pos_operations_refused_instruction_fkey%', 'U1 orphan conflict_tombstone without an event: rejected at commit by the FK (' || r || ')');
end $$;

-- U4 / U3 NULL の参照・遅延の前方参照（今の stale / busy の書き方：印の操作 → キー → 依頼）
do $$
declare
  v_op uuid := gen_random_uuid();
  v_inst uuid := gen_random_uuid();
  k text := 'checkout:' || pg_temp.u();
  f jsonb := jsonb_build_object('client_id', pg_temp.u());
  v_slot text := app_private.pos_op_slot_key('checkout_client', f, null);
  v_sqls text[];
  r text;
begin
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(v_op, 'conflict_tombstone', null, k));
  perform pg_temp.ok(r like 'stmt:%pos_operations_check%', 'U4 conflict_tombstone with NULL instruction reference: rejected by the CHECK at the INSERT (' || r || ')');
  v_sqls := array[
    format('insert into app_private.pos_business_slots (slot_key, slot_kind) values (%L, %L) on conflict do nothing', v_slot, 'checkout_client'),
    format('insert into app_private.pos_operations (operation_id, kind, origin, status, refused_instruction_id, terminal_at) values (%L, %L, %L, %L, %L, now())',
           v_op, 'checkout_client', 'stale_prepare', 'abandoned', v_inst),
    format('insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role) values (%L, %L, %L, %L), (%L, %L, %L, %L)',
           'acct_sale', app_private.pos_op_key_ident('acct_sale', k), v_op, 'fence', 'ginpay_tx', app_private.pos_op_key_ident('ginpay_tx', 'sale:' || k), v_op, 'fence'),
    format('insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key, observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest, actor_type, actor_name) values (%L, %L, %L, %L, %L, %L, 7, null, %L, %L, %L, %L, %L, %L)',
           v_inst, v_op, 'refused', 'stale_epoch', 'checkout_client', v_slot, f,
           app_private.pos_op_hash('PREP1', jsonb_build_object('kind', 'checkout_client', 'slot', v_slot, 'facts', f)),
           'acct_sale', app_private.pos_op_key_ident('acct_sale', k), 'test', 'U'),
    format('insert into app_private.pos_operation_events (operation_id, slot_key, event_type, detail) values (%L, %L, %L, %L)',
           v_op, v_slot, 'refused', jsonb_build_object('code', 'stale_epoch', 'observed_epoch', 7, 'slot_epoch', 0))];
  r := pg_temp.u_try(v_sqls);
  perform pg_temp.ok(r = 'ok', 'U3 deferred forward reference: stale_prepare operation referencing instruction I, then I inserted later in the same transaction, SET CONSTRAINTS ALL IMMEDIATE passes (' || r || ')');
  r := pg_temp.u_try(v_sqls[1:3]);
  perform pg_temp.ok(r like 'immediate:%pos_operations_refused_instruction_fkey%', 'U3 control: the same forward reference whose instruction never arrives fails at commit (' || r || ')');
  -- 本当の COMMIT（別セッション）：前方参照の正しい形はコミットできる
  perform pg_temp.u_remote(v_sqls);
  perform pg_temp.ok((select o.origin = 'stale_prepare' and i.instruction_id = v_inst from app_private.pos_operations o
                      join app_private.pos_business_instructions i on i.instruction_id = o.refused_instruction_id where o.operation_id = v_op),
    'U3 the valid forward-reference transaction commits for real in another session');
end $$;

-- U5 / U10 / U18 / 18 本当の衝突（PREPARE）：参照は実在の依頼、instruction_conflict の履歴は1件、即時の検査も通る。完全一致の再送は印を作らない
do $$
declare
  i1 text := pg_temp.u();
  f jsonb := jsonb_build_object('client_id', pg_temp.u());
  k1 text := 'checkout:' || pg_temp.u();
  k2 text := 'checkout:' || pg_temp.u();
  r jsonb;
  v_op uuid;
  v_before text;
begin
  perform pg_temp.ok(pg_temp.prep(i1, 'checkout_client', f, k1, 0) ->> 'result' = 'prepared', 'U5 fixture: accepted instruction I1');
  r := pg_temp.prep(i1, 'checkout_client', f, k2, 0);
  v_op := (r ->> 'tombstone_operation_id')::uuid;
  set constraints all immediate;
  perform pg_temp.ok(r ->> 'error' = 'instruction_conflict' and r ->> 'losing_key' = 'tombstoned'
    and (select origin = 'conflict_tombstone' and refused_instruction_id = i1::uuid from app_private.pos_operations where operation_id = v_op)
    and exists (select 1 from app_private.pos_business_instructions where instruction_id = i1::uuid)
    and (select count(*) from app_private.pos_operation_events where operation_id = v_op) = 1
    and (select event_type = 'tombstoned' and detail ->> 'reason' = 'instruction_conflict' from app_private.pos_operation_events where operation_id = v_op),
    'U5/U10 true conflict via PREPARE: conflict_tombstone references the real I1, exactly one instruction_conflict event, SET CONSTRAINTS ALL IMMEDIATE passes');
  v_before := pg_temp.registry_counts();
  r := pg_temp.prep(i1, 'checkout_client', f, k1, 0);
  perform pg_temp.ok(r ->> 'result' = 'existing' and pg_temp.registry_counts() = v_before,
    'U18 exact retry of I1: existing, no new conflict tombstone, zero writes');
  perform pg_temp.setv('u_i1', i1);
  perform pg_temp.setv('u_i1_op', (select operation_id::text from app_private.pos_business_instructions where instruction_id = i1::uuid));
  perform pg_temp.setv('u_conf_op', v_op::text);
  perform pg_temp.setv('u_k1', k1);
end $$;

-- U5 本当の COMMIT（別セッション）：受理 → 本当の衝突をコミットでき、衝突の印は実在の依頼を指す
do $$
declare
  i text := pg_temp.u();
  f jsonb := jsonb_build_object('client_id', pg_temp.u());
  k1 text := 'checkout:' || pg_temp.u();
  k2 text := 'checkout:' || pg_temp.u();
begin
  perform pg_temp.u_remote(array[
    format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 0, null, %L, %L)', i, 'checkout_client', f, k1, 'test', 'U'),
    format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 0, null, %L, %L)', i, 'checkout_client', f, k2, 'test', 'U')]);
  perform pg_temp.ok(app_private.pos_op_status_by_key('acct_sale', k2) #>> '{operation,origin}' = 'conflict_tombstone'
    and exists (select 1 from app_private.pos_operations o join app_private.pos_business_instructions x on x.instruction_id = o.refused_instruction_id
                where o.origin = 'conflict_tombstone' and x.instruction_id = i::uuid),
    'U5 accepted + true conflict committed for real in another session: durable conflict_tombstone referencing the real instruction');
end $$;

-- U17 今の正しい流れ（受理・stale_epoch・slot_busy・本当の衝突）は即時の検査でも通り、本当の COMMIT もできる
do $$
declare
  f jsonb := jsonb_build_object('client_id', pg_temp.u());
  a jsonb;
  s jsonb;
  b jsonb;
begin
  a := pg_temp.prep(pg_temp.u(), 'checkout_client', f, 'checkout:' || pg_temp.u(), 0);
  s := pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 3);
  b := pg_temp.prep(pg_temp.u(), 'checkout_client', f, 'checkout:' || pg_temp.u(), 1);
  set constraints all immediate;
  perform pg_temp.ok(a ->> 'result' = 'prepared' and s ->> 'error' = 'stale_epoch' and b ->> 'error' = 'slot_busy'
    and (select origin from app_private.pos_operations where operation_id = (s ->> 'operation_id')::uuid) = 'stale_prepare'
    and (select origin from app_private.pos_operations where operation_id = (b ->> 'operation_id')::uuid) = 'busy_prepare',
    'U17 accepted / stale_epoch / slot_busy through PREPARE: SET CONSTRAINTS ALL IMMEDIATE passes (deferred FK satisfied)');
end $$;
do $$
declare
  f jsonb := jsonb_build_object('client_id', pg_temp.u());
  i1 text := pg_temp.u();
  i2 text := pg_temp.u();
  i3 text := pg_temp.u();
begin
  perform pg_temp.u_remote(array[
    format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 0, null, %L, %L)', i1, 'checkout_client', f, 'checkout:' || pg_temp.u(), 'test', 'U'),
    format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 9, null, %L, %L)', i2, 'checkout_client', f, 'checkout:' || pg_temp.u(), 'test', 'U'),
    format('select app_private.pos_op_prepare(%L::uuid, %L, %L::jsonb, %L, 1, null, %L, %L)', i3, 'checkout_client', f, 'checkout:' || pg_temp.u(), 'test', 'U')]);
  perform pg_temp.ok((select array_agg(coalesce(refusal_code, disposition) order by refusal_code nulls first) from app_private.pos_business_instructions
                      where instruction_id in (i1::uuid, i2::uuid, i3::uuid)) = array['accepted', 'slot_busy', 'stale_epoch'],
    'U17 accepted + stale_epoch + slot_busy in one real COMMIT in another session: all durable');
end $$;

-- U6 / U7 参照された依頼は消せない・印の参照は書き換えられない
do $$
declare
  i1 uuid := pg_temp.getv('u_i1')::uuid;
  v_conf uuid := pg_temp.getv('u_conf_op')::uuid;
  v_other uuid;
  r text;
begin
  -- 依頼 I1 の操作を終えて枠の指す先を外す（外部キーで残るのは衝突の印からの参照だけ）
  perform app_private.pos_op_finish(pg_temp.getv('u_i1_op')::uuid, 'abandoned', 'test');
  r := pg_temp.u_try(array[format('delete from app_private.pos_business_instructions where instruction_id = %L', i1)]);
  perform pg_temp.ok(r like 'stmt:%pos_registry_immutable%', 'U6 DELETE of the instruction referenced by a conflict tombstone: rejected (append-only trigger) (' || r || ')');
  r := pg_temp.u_try(array[format('delete from app_private.pos_business_instructions where instruction_id = %L', i1)],
                     array['app_private.pos_business_instructions|pos_business_instructions_no_update_delete']);
  perform pg_temp.ok(r like 'stmt:%pos_operations_refused_instruction_fkey%',
    'U6 the same DELETE with the append-only trigger disabled: rejected immediately by the FK (ON DELETE RESTRICT, no cascade / set null) (' || r || ')');
  r := pg_temp.u_try(array[format('update app_private.pos_business_instructions set instruction_id = %L where instruction_id = %L', gen_random_uuid(), i1)],
                     array['app_private.pos_business_instructions|pos_business_instructions_no_update_delete']);
  perform pg_temp.ok(r like 'stmt:%pos_operations_refused_instruction_fkey%',
    'U6 changing the referenced instruction_id (append-only trigger disabled): rejected by the FK (ON UPDATE RESTRICT) (' || r || ')');
  perform pg_temp.ok((select refused_instruction_id from app_private.pos_operations where operation_id = v_conf) = i1
    and exists (select 1 from app_private.pos_business_instructions where instruction_id = i1),
    'U6 the conflict tombstone still references I1 and I1 still exists');

  select instruction_id into v_other from app_private.pos_business_instructions where instruction_id <> i1 limit 1;
  foreach r in array array[format('%L', v_other), 'null', format('%L', gen_random_uuid())] loop
    perform pg_temp.ok(pg_temp.u_try(array[format('update app_private.pos_operations set refused_instruction_id = %s where operation_id = %L', r, v_conf)])
                       like 'stmt:%pos_operation_terminal_immutable%',
      'U7 UPDATE conflict tombstone refused_instruction_id -> ' || case r when 'null' then 'NULL' else 'other/nonexistent UUID' end || ': rejected (terminal immutable)');
  end loop;
end $$;

-- U7 行のガードを止めても（別のトランザクション：止めるには保留中のトリガーが無いこと）、CHECK と外部キーがそれぞれ単独で止める
do $$
declare
  v_conf uuid := pg_temp.getv('u_conf_op')::uuid;
  r text;
begin
  r := pg_temp.u_try(array[format('update app_private.pos_operations set refused_instruction_id = null where operation_id = %L', v_conf)],
                     array['app_private.pos_operations|pos_operations_guard']);
  perform pg_temp.ok(r like 'stmt:%pos_operations_check%', 'U7 -> NULL with the row guard disabled: rejected by the CHECK alone (' || r || ')');
  r := pg_temp.u_try(array[format('update app_private.pos_operations set refused_instruction_id = %L where operation_id = %L', gen_random_uuid(), v_conf)],
                     array['app_private.pos_operations|pos_operations_guard']);
  perform pg_temp.ok(r like 'immediate:%pos_operations_refused_instruction_fkey%', 'U7 -> nonexistent UUID with the row guard disabled: rejected by the FK alone (' || r || ')');
end $$;

-- U8 / U9 / U11 / U13 / 16 / 19 予約された instruction_conflict（G2）と G1 との直交
do $$
declare
  i1 uuid := pg_temp.getv('u_i1')::uuid;
  k text := 'staff-store-charge:' || pg_temp.u();
  kc text := 'checkout:' || pg_temp.u();
  v_neg uuid;
  v_before text;
  r text;
  j jsonb;
begin
  -- U9 fence の理由に予約されたコードは使えない（書き換えずに断る。何も書かない）
  v_before := pg_temp.registry_counts();
  j := app_private.pos_op_fence_key('ginpay_tx', k, 'instruction_conflict');
  perform pg_temp.ok(j ->> 'error' = 'invalid_request' and j ->> 'reason' = 'reserved_code' and pg_temp.registry_counts() = v_before
    and pg_temp.cg2_unbound('ginpay_tx', k),
    'U9 fence_key(..., instruction_conflict): invalid_request / reserved_code, zero writes');
  perform pg_temp.ok(app_private.pos_op_fence_key('ginpay_tx', k, 'stale_epoch') ->> 'reason' = 'reserved_code'
    and app_private.pos_op_fence_key('ginpay_tx', k, 'slot_busy') ->> 'reason' = 'reserved_code'
    and app_private.pos_op_fence_slot('checkout:client:' || pg_temp.u(), 'instruction_conflict') ->> 'reason' = 'reserved_code'
    and pg_temp.registry_counts() = v_before,
    'U9 fence_key(stale_epoch / slot_busy) and fence_slot(instruction_conflict) rejected too, zero writes');
  -- U8 正しい negative_tombstone に instruction_conflict の履歴を直接足す
  j := app_private.pos_op_fence_key('ginpay_tx', k, 'test');
  v_neg := (j ->> 'operation_id')::uuid;
  perform pg_temp.ok(j ->> 'result' = 'tombstoned', 'U8 fixture: a valid negative_tombstone');
  r := pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                  v_neg, 'tombstoned', '{"reason":"instruction_conflict","keys":1}')]);
  perform pg_temp.ok(r like 'stmt:%pos_event_reserved_code%', 'U8 direct INSERT of an instruction_conflict event on a negative_tombstone: rejected (' || r || ')');
  foreach r in array array['{"code":"instruction_conflict"}', '{"via":"instruction_conflict"}', '{"reason":"fence","code":"instruction_conflict"}'] loop
    perform pg_temp.ok(pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                                  v_neg, 'tombstoned', r)]) like 'stmt:%pos_event_reserved_code%',
      'U8 instruction_conflict in any machine-readable event field on a negative_tombstone rejected: ' || r);
  end loop;
  perform pg_temp.ok(pg_temp.u_try(array[format('insert into app_private.pos_operation_events (slot_key, event_type, detail) values ((select slot_key from app_private.pos_business_slots limit 1), %L, %L)',
                                                'slot_fenced', '{"reason":"instruction_conflict"}')]) like 'stmt:%pos_event_reserved_code%',
    'U8 slot event (no operation) with reason instruction_conflict rejected');
  -- stale_epoch / slot_busy も同じ：その origin の refused の code だけ
  perform pg_temp.ok(pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                                v_neg, 'refused', '{"code":"stale_epoch"}')]) like 'stmt:%pos_event_reserved_code%'
    and pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                   (select operation_id from app_private.pos_operations where origin = 'stale_prepare' limit 1), 'refused', '{"code":"slot_busy"}')]) like 'stmt:%pos_event_reserved_code%'
    and pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                   (select operation_id from app_private.pos_operations where origin = 'prepared' limit 1), 'refused', '{"code":"fenced"}')]) like 'stmt:%pos_event_origin_mismatch%'
    and pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                   (select operation_id from app_private.pos_operations where origin = 'prepared' limit 1), 'tombstoned', '{"reason":"fence"}')]) like 'stmt:%pos_event_origin_mismatch%',
    'U8 stale_epoch / slot_busy only on their own refused origin; refused / tombstoned events only on refusal / tombstone origins');

  -- U11 / U12 / 19 組み合わせ（G1 と G2 の検査は独立に効く）
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(gen_random_uuid(), 'negative_tombstone', gen_random_uuid(), kc));
  perform pg_temp.ok(r like 'stmt:%pos_operations_check%', '19-a negative_tombstone + nonexistent instruction ref + instruction_conflict: rejected at the INSERT (CHECK) (' || r || ')');
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(gen_random_uuid(), 'conflict_tombstone', gen_random_uuid(), kc));
  perform pg_temp.ok(r like 'immediate:%pos_operations_refused_instruction_fkey%', 'U12 / 19-b conflict_tombstone + nonexistent instruction + instruction_conflict: rejected by the reference FK (' || r || ')');
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(gen_random_uuid(), 'negative_tombstone', i1, kc));
  perform pg_temp.ok(r like 'stmt:%pos_operations_check%', 'U11 / 19-c negative_tombstone + valid instruction ref + instruction_conflict: rejected (CHECK: negative tombstones carry no instruction ref) (' || r || ')');
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(gen_random_uuid(), 'negative_tombstone', null, kc));
  perform pg_temp.ok(r like 'stmt:%pos_event_reserved_code%', 'U11 / 19-d negative_tombstone (no ref) + instruction_conflict event: rejected by the reserved-code guard (' || r || ')');
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(gen_random_uuid(), 'conflict_tombstone', i1, kc, 'fence'));
  perform pg_temp.ok(r like 'stmt:%pos_event_origin_mismatch%', '19-e conflict_tombstone + valid ref + non-conflict reason: rejected (' || r || ')');
  r := pg_temp.u_try((pg_temp.u_tomb_sqls(gen_random_uuid(), 'conflict_tombstone', i1, kc))[1:2]);
  perform pg_temp.ok(r like 'immediate:%pos_invariant_conflict_event%', '13 conflict_tombstone without its instruction_conflict event: rejected at commit (converse invariant) (' || r || ')');
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(gen_random_uuid(), 'conflict_tombstone', i1, kc));
  perform pg_temp.ok(r = 'ok', 'U10 positive control: direct conflict_tombstone + real instruction + fresh keys + one instruction_conflict event passes every DB invariant (existence only; the conflict proof is PREPARE''s) (' || r || ')');

  -- U13 / U14 履歴は書き換え・削除できない（instruction_conflict へ / から）
  r := pg_temp.u_try(array[format('update app_private.pos_operation_events set detail = %L where operation_id = %L', '{"reason":"instruction_conflict","keys":1}', v_neg)]);
  perform pg_temp.ok(r like 'stmt:%pos_registry_immutable%', 'U13 UPDATE of a negative_tombstone event into instruction_conflict: rejected (' || r || ')');
  r := pg_temp.u_try(array[format('update app_private.pos_operation_events set detail = %L where operation_id = %L', '{"reason":"fence","keys":2}', pg_temp.getv('u_conf_op'))]);
  perform pg_temp.ok(r like 'stmt:%pos_registry_immutable%', 'U14 UPDATE of the conflict event instruction_conflict -> fence: rejected (' || r || ')');
  r := pg_temp.u_try(array[format('delete from app_private.pos_operation_events where operation_id = %L', pg_temp.getv('u_conf_op'))]);
  perform pg_temp.ok(r like 'stmt:%pos_registry_immutable%', 'U14 DELETE of the conflict event: rejected (' || r || ')');
  r := pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                  pg_temp.getv('u_conf_op'), 'tombstoned', '{"reason":"instruction_conflict","keys":0}')]);
  perform pg_temp.ok(r like 'stmt:%pos_operation_events_conflict_uidx%', 'U14 a second instruction_conflict event on the same conflict tombstone: rejected (unique) (' || r || ')');
  r := pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                  pg_temp.getv('u_conf_op'), 'abandoned', '{"code":"test"}')]);
  perform pg_temp.ok(r like 'stmt:%pos_event_origin_mismatch%', 'U14 any other event on a conflict tombstone: rejected (' || r || ')');
end $$;

-- U14 / 25 TRUNCATE は 8 表すべてで止まる（別のトランザクション：保留中のトリガーが無いこと）
do $$
begin
  perform pg_temp.ok(pg_temp.u_try(array['truncate app_private.pos_operation_events']) like 'stmt:%pos_registry_immutable%'
    and pg_temp.u_try(array['truncate app_private.pos_business_instructions cascade']) like 'stmt:%pos_registry_immutable%'
    and pg_temp.u_try(array['truncate app_private.pos_operations cascade']) like 'stmt:%pos_registry_immutable%'
    and pg_temp.u_try(array['truncate app_private.pos_operation_keys']) like 'stmt:%pos_registry_immutable%'
    and (select count(*) from pg_trigger where tgname like 'pos\_%\_no\_truncate' and tgenabled = 'O'
         and tgrelid in (select oid from pg_class where relnamespace = 'app_private'::regnamespace and (relname like 'pos\_operation%' or relname like 'pos\_business%'))) = 8,
    'U14 / 25 TRUNCATE of operations / keys / instructions / events rejected; all 8 registry tables carry an enabled no_truncate trigger');
end $$;

-- U15 last_code（操作の業務コード）に予約されたコードは書けない
do $$
begin
  perform pg_temp.setv('u_prep_op', pg_temp.prep(pg_temp.u(), 'checkout_client', jsonb_build_object('client_id', pg_temp.u()), 'checkout:' || pg_temp.u(), 0) ->> 'operation_id');
end $$;
do $$
declare
  v_op uuid := pg_temp.getv('u_prep_op')::uuid;
  v_code text;
  r text;
begin
  foreach v_code in array array['instruction_conflict', 'stale_epoch', 'slot_busy'] loop
    perform pg_temp.ok(app_private.pos_op_finish(v_op, 'abandoned', v_code) ->> 'error' = 'invalid_request'
      and (select status = 'prepared' and last_code is null from app_private.pos_operations where operation_id = v_op),
      'U15 pos_op_finish(..., ' || v_code || '): invalid_request, nothing written');
    r := pg_temp.u_try(array[format('update app_private.pos_operations set last_code = %L where operation_id = %L', v_code, v_op)]);
    perform pg_temp.ok(r like 'stmt:%pos_operation_reserved_code%', 'U15 direct UPDATE last_code = ' || v_code || ': rejected by the row guard (' || r || ')');
    r := pg_temp.u_try(array[format('update app_private.pos_operations set last_code = %L where operation_id = %L', v_code, v_op)],
                       array['app_private.pos_operations|pos_operations_guard']);
    perform pg_temp.ok(r like 'stmt:%pos_operations_last_code_not_reserved%', 'U15 the same UPDATE with the guard disabled: rejected by the CHECK alone (' || r || ')');
  end loop;
  r := pg_temp.u_try(array[format('insert into app_private.pos_operations (kind, origin, status, terminal_at, last_code) values (%L, %L, %L, now(), %L)',
                                  'key_tombstone', 'negative_tombstone', 'abandoned', 'instruction_conflict')]);
  perform pg_temp.ok(r like 'stmt:%pos_operations_last_code_not_reserved%', 'U15 direct INSERT of a tombstone with last_code instruction_conflict: rejected by the CHECK (' || r || ')');
  perform pg_temp.ok(app_private.pos_op_finish(v_op, 'abandoned', 'staff_cancelled') ->> 'result' = 'abandoned',
    'U15 control: a normal workflow code is still accepted');
end $$;

-- U16 / 21 / 22 / 23 キーの持ち主は1つ（主キー）：衝突の印は依頼自身のキーを取れない。履歴は実在の操作だけ
do $$
declare
  i1 uuid := pg_temp.getv('u_i1')::uuid;
  k1 text := pg_temp.getv('u_k1');
  v_op uuid := gen_random_uuid();
  r text;
begin
  r := pg_temp.u_try(pg_temp.u_tomb_sqls(v_op, 'conflict_tombstone', i1, k1));
  perform pg_temp.ok(r like 'stmt:%pos_operation_keys_pkey%',
    'U16 / 21 direct conflict_tombstone + valid ref I1 binding I1''s own keys K1 / sale:K1: rejected (primary key (key_domain, key_digest): one owner per key) (' || r || ')');
  perform pg_temp.ok((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'app_private.pos_operation_keys'::regclass and contype = 'p') = 'PRIMARY KEY (key_domain, key_digest)'
    and (select confdeltype = 'r' from pg_constraint where conrelid = 'app_private.pos_operation_keys'::regclass and contype = 'f'),
    'U16 / 22 pos_operation_keys: PRIMARY KEY (key_domain, key_digest) and operation_id FK (RESTRICT): one key row, one operation');
  r := pg_temp.u_try(array[format('insert into app_private.pos_operation_events (operation_id, event_type, detail) values (%L, %L, %L)',
                                  gen_random_uuid(), 'claimed', '{"targets":1}')]);
  perform pg_temp.ok(r like 'stmt:%pos_operation_events_operation_id_fkey%', 'U23 event referencing a nonexistent operation: rejected by the FK (' || r || ')');
end $$;

-- 34 台帳の全体（多重の守り）：衝突の印はすべて実在の依頼を指し、instruction_conflict は衝突の印の tombstoned だけ、1件ずつ
do $$
begin
  perform pg_temp.ok(not exists (select 1 from app_private.pos_operations o where o.origin = 'conflict_tombstone'
                                 and (o.refused_instruction_id is null
                                      or not exists (select 1 from app_private.pos_business_instructions i where i.instruction_id = o.refused_instruction_id)
                                      or (select count(*) from app_private.pos_operation_events v where v.operation_id = o.operation_id
                                          and v.event_type = 'tombstoned' and v.detail ->> 'reason' = 'instruction_conflict') <> 1))
    and not exists (select 1 from app_private.pos_operation_events v left join app_private.pos_operations o using (operation_id)
                    cross join lateral jsonb_each_text(v.detail) d
                    where d.value = 'instruction_conflict'
                      and (o.origin is distinct from 'conflict_tombstone' or d.key <> 'reason' or v.event_type <> 'tombstoned'
                           or not exists (select 1 from app_private.pos_business_instructions i where i.instruction_id = o.refused_instruction_id)))
    and not exists (select 1 from app_private.pos_operations where app_private.pos_op_reserved_code(last_code) is not null)
    and (select count(*) from app_private.pos_operations where origin = 'conflict_tombstone') >= 5,
    'U 34 global scan: every conflict_tombstone has a non-NULL existing instruction and exactly one instruction_conflict event; every persisted instruction_conflict is that event; no reserved last_code');
end $$;

do $$ begin perform extensions.dblink_disconnect(c) from unnest(extensions.dblink_get_connections()) c; end $$;
drop extension dblink;

-- N. 台帳の全行を走査：テストで使った生のキーの文字列（資格情報の形・長い 16 進・GJC1・空白つき）はどこにも無い
do $$
declare
  v_all text := pg_temp.registry_text();
  v_hit text;
  v_n integer;
begin
  select count(*) into v_n from cg1_raw;
  select string_agg(left(raw, 12), ', ') into v_hit from cg1_raw
  where strpos(v_all, raw) > 0 or strpos(v_all, btrim(raw)) > 0 or strpos(v_all, to_jsonb(btrim(raw))::text) > 0;
  perform pg_temp.ok(v_n >= 15 and v_hit is null, 'N CG1-N exact raw-key scan: none of ' || v_n || ' supplied raw keys appears in any registry row (' || coalesce(v_hit, 'none') || ')');
  -- 秘密の形の走査（台帳の digest の列 bytea は除く。キーは文字列として保存されていない）
  perform pg_temp.ok(not exists (select 1 from information_schema.columns where table_schema = 'app_private'
                                 and table_name in ('pos_operation_keys', 'pos_business_instructions') and column_name in ('key_value', 'entry_key_value')),
    'N CG1-N no raw key column exists in the registry');
end $$;

-- M 登録簿全体の走査（多重の守り）：保存されたすべての文字列・JSON に、秘密の形の値が無いこと。
-- 例外は型の付いた欄の REQ1./AUTH1./QFP1. と、決まった形のダイジェストの列（facts_hash / result_snapshot_hash / snapshot_hash）だけ
do $$
declare
  v_re text := '(apr1|qte1|ops1)[.$:]|\$apr1\$|bearer\s|eyJ[A-Za-z0-9_-]{4,}\.|gjc1\.[a-z0-9_-]{43}|[0-9a-f]{48}';
  v_hits text;
begin
  perform pg_temp.ok((select count(*) from app_private.pos_business_instructions where facts_hash !~ '^PREP1\.[0-9a-f]{64}$') = 0
    and (select count(*) from app_private.pos_operations where result_snapshot_hash is not null and result_snapshot_hash !~ '^(LEG1|RES1)\.[0-9a-f]{64}$') = 0
    and (select count(*) from app_private.pos_operation_effects where snapshot_hash !~ '^LEG1\.[0-9a-f]{64}$') = 0
    and (select count(*) from app_private.pos_operation_keys where octet_length(key_digest) <> 32) = 0
    and (select count(*) from app_private.pos_business_instructions where octet_length(entry_key_digest) <> 32) = 0,
    'M scan: digest columns hold only their fixed digest formats (key digests are 32-byte bytea)');
  with rows as (
    select 'operations' t, to_jsonb(o) - 'result_snapshot_hash' j from app_private.pos_operations o
    union all select 'keys', to_jsonb(k) - 'key_digest' from app_private.pos_operation_keys k
    union all select 'instructions', to_jsonb(i) - 'facts_hash' - 'entry_key_digest' from app_private.pos_business_instructions i
    union all select 'slots', to_jsonb(s) from app_private.pos_business_slots s
    union all select 'targets', to_jsonb(t) from app_private.pos_operation_targets t
    union all select 'required_targets', to_jsonb(r) from app_private.pos_operation_required_targets r
    union all select 'effects', to_jsonb(e) - 'snapshot_hash' from app_private.pos_operation_effects e
    union all select 'events', to_jsonb(v) from app_private.pos_operation_events v
  ), stripped as (
    select t, regexp_replace(regexp_replace(j::text,
             '"(request_hash|void_request_hash)": "(REQ1|AUTH1)\.[0-9a-f]{64}"', '"\1": ""', 'g'),
             '"quote_fingerprint": "QFP1\.[0-9a-f]{64}"', '"quote_fingerprint": ""', 'g') x
    from rows
  )
  select string_agg(distinct t, ',') into v_hits from stripped where x ~* v_re;
  perform pg_temp.ok(v_hits is null, 'M scan: no APR1/QTE1/OPS1/GJC1/Bearer/JWT/long-hex value in any stored registry row (' || coalesce(v_hits, 'none') || ')');
  perform pg_temp.ok((select count(*) from app_private.pos_operation_effects where snapshot ->> 'request_hash' like 'REQ1.%') >= 1,
    'M scan: the scan covered at least one stored typed REQ1 hash (exception path exercised)');
end $$;

do $$
begin
  raise warning 'POS B-2C-1 registry single-session checks passed: %', (select count(*) from c1_results);
end $$;
