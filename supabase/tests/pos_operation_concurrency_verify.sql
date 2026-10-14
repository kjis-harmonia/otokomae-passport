-- ============================================================================
-- GINJIRO POS B-2C-1: 操作レジストリの同時実行（確認）(pos_operation_concurrency_verify.sql)
--
-- 応答が欠けている・空・形が違う（{} / null / 結果も error も無い）ときは必ず失敗にする。
-- 比較はすべて NULL で「不明」にならない形（IS [NOT] DISTINCT FROM・coalesce・count(*) FILTER）で書く。
-- ============================================================================

\set ON_ERROR_STOP on

do $$
declare
  l public.__pos_op_conc_latest;
  v_n integer;
  v_detail text;
  v_claimed integer;
  v_busy integer;
begin
  select * into l from public.__pos_op_conc_latest;
  if l.run_id is null then raise exception 'C1 concurrency: setup row missing'; end if;

  -- すべての worker（0〜9）がちょうど1行ずつ、JSON の object で、ok が true/false で返していること
  select string_agg(w::text, ',') into v_detail
  from generate_series(0, 9) w
  where (select count(*) from public.__pos_op_conc_responses r where r.worker_no = w) <> 1;
  if v_detail is not null then raise exception 'C1 concurrency: missing or duplicate worker results: %', v_detail; end if;
  select count(*) into v_n from public.__pos_op_conc_responses;
  if v_n <> 10 then raise exception 'C1 concurrency: expected exactly 10 responses, got %', v_n; end if;
  select string_agg(worker_no::text || ':' || coalesce(response::text, 'NULL'), '; ') into v_detail
  from public.__pos_op_conc_responses
  where response is null or jsonb_typeof(response) is distinct from 'object'
     or jsonb_typeof(response -> 'ok') is distinct from 'boolean'
     -- 成功は result が文字列で error が無い、失敗は error が文字列で result が無い
     or (response -> 'ok' = 'true'::jsonb) and (jsonb_typeof(response -> 'result') is distinct from 'string' or response ? 'error')
     or (response -> 'ok' = 'false'::jsonb) and (jsonb_typeof(response -> 'error') is distinct from 'string' or response ? 'result');
  if v_detail is not null then raise exception 'C1 concurrency: malformed worker responses: %', v_detail; end if;

  -- 0-3 同じ依頼・違うキー：受理 1、instruction_conflict（キーは印）3、それ以外 0
  select count(*) filter (where response ->> 'result' is not distinct from 'prepared'),
         count(*) filter (where response ->> 'error' is not distinct from 'instruction_conflict' and response ->> 'losing_key' is not distinct from 'tombstoned'),
         count(*)
  into v_claimed, v_busy, v_n
  from public.__pos_op_conc_responses where worker_no between 0 and 3;
  if v_claimed is distinct from 1 or v_busy is distinct from 3 or v_n is distinct from 4 then
    raise exception 'C1 concurrency: same-instruction race: prepared=%, conflict+tombstone=%, total=%', v_claimed, v_busy, v_n;
  end if;
  if (select count(*) from app_private.pos_business_instructions where slot_key = l.slot1) is distinct from 1::bigint
     or (select count(*) from app_private.pos_business_instructions where instruction_id = l.inst1) is distinct from 1::bigint
     or (select slot_epoch from app_private.pos_business_slots where slot_key = l.slot1) is distinct from 1::bigint then
    raise exception 'C1 concurrency: same-instruction race left wrong slot/instruction state';
  end if;
  if (select count(*) from app_private.pos_operations o join app_private.pos_operation_keys k using (operation_id)
      where o.origin = 'conflict_tombstone' and o.refused_instruction_id = l.inst1 and k.key_role = 'fence') is distinct from 3::bigint then
    raise exception 'C1 concurrency: losing keys were not all fenced';
  end if;

  -- 4-6 違う依頼・同じキー：受理 1、key_conflict 2、それ以外 0
  select count(*) filter (where response ->> 'result' is not distinct from 'prepared'),
         count(*) filter (where response ->> 'error' is not distinct from 'key_conflict'),
         count(*)
  into v_claimed, v_busy, v_n
  from public.__pos_op_conc_responses where worker_no between 4 and 6;
  if v_claimed is distinct from 1 or v_busy is distinct from 2 or v_n is distinct from 3 then
    raise exception 'C1 concurrency: shared-key race: prepared=%, key_conflict=%, total=%', v_claimed, v_busy, v_n;
  end if;
  if (select count(*) from app_private.pos_business_instructions where slot_key = l.slot2) is distinct from 1::bigint
     or (select count(*) from app_private.pos_operation_keys where key_domain = 'ginpay_tx' and key_digest = app_private.pos_op_key_ident('ginpay_tx', l.shared_key)) is distinct from 1::bigint
     or (select slot_epoch from app_private.pos_business_slots where slot_key = l.slot2) is distinct from 1::bigint then
    raise exception 'C1 concurrency: shared-key race left wrong state';
  end if;

  -- 7-9 重なる資源の claim（どの2つも資源が重なる）：claimed ちょうど 1、target_busy ちょうど 2、それ以外 0
  select count(*) filter (where response ->> 'result' is not distinct from 'claimed'),
         count(*) filter (where response ->> 'error' is not distinct from 'target_busy'),
         count(*)
  into v_claimed, v_busy, v_n
  from public.__pos_op_conc_responses where worker_no between 7 and 9;
  if v_claimed is distinct from 1 or v_busy is distinct from 2 or v_n is distinct from 3 then
    select string_agg(worker_no::text || ':' || response::text, '; ') into v_detail
    from public.__pos_op_conc_responses where worker_no between 7 and 9;
    raise exception 'C1 concurrency: overlapping claims: claimed=%, target_busy=%, total=% (%)', v_claimed, v_busy, v_n, v_detail;
  end if;
  -- 成功は1つの操作だけ（同じ操作の二重の成功も無い）
  if (select count(distinct response ->> 'operation_id') from public.__pos_op_conc_responses
      where worker_no between 7 and 9 and response ->> 'result' is not distinct from 'claimed') is distinct from 1::bigint then
    raise exception 'C1 concurrency: duplicate or anonymous claim success';
  end if;
  if exists (select target_key from app_private.pos_operation_targets where target_key = any (l.targets) and active
             group by target_key having count(*) > 1) then
    raise exception 'C1 concurrency: a target is held twice';
  end if;
  -- 負けた claim は宣言も資源も残さない（operation_id が無い応答は上の形の検査で落ちている）
  if exists (select 1 from public.__pos_op_conc_responses r
             where r.worker_no between 7 and 9 and r.response ->> 'error' is not distinct from 'target_busy'
               and (r.response ->> 'operation_id' is null
                    or exists (select 1 from app_private.pos_operation_targets t where t.operation_id = (r.response ->> 'operation_id')::uuid)
                    or exists (select 1 from app_private.pos_operation_required_targets t where t.operation_id = (r.response ->> 'operation_id')::uuid))) then
    raise exception 'C1 concurrency: a failed claim kept partial targets (or has no operation id)';
  end if;
  -- 勝った claim は宣言 2 件 = 有効 2 件
  if (select count(*) from app_private.pos_operation_targets where target_key = any (l.targets) and active) is distinct from 2::bigint
     or (select count(*) from app_private.pos_operation_required_targets where target_key = any (l.targets)) is distinct from 2::bigint then
    raise exception 'C1 concurrency: the winning claim does not hold exactly its declared target set';
  end if;

  raise notice 'C1 registry concurrency verification passed: same-instruction 1/4, shared-key 1/3, claims 1 of 3';
end $$;

drop function if exists public.__pos_op_conc_run(integer);
drop table if exists public.__pos_op_conc_responses;
drop table if exists public.__pos_op_conc_cases;
drop table if exists public.__pos_op_conc_latest;
