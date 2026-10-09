-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Replay Concurrency Verification
-- (preflight_replay_concurrency_verify.sql)
--
-- Verifies that concurrent calls with identical idempotency keys on Refund
-- and Sale resulted in:
-- - Exactly 1 refund row created, 1 balance reduction (4,000 yen), no double refund
-- - Exactly 1 sale created, ticket marked used once, ticket_usage_logs = 1
-- - All concurrent workers completed without leaking unique_violation exceptions
-- ============================================================================

do $$
declare
  l             public.__preflight_replay_latest;
  v_refund_count integer;
  v_balance     integer;
  v_sale_count  integer;
  v_sale_id     uuid;
  v_ticket_used boolean;
  v_usage_count integer;
  v_items_count integer;
  v_pmt_count   integer;
  v_kind text;
  v_counts record;
  v_expected_id uuid;
begin
  select * into l from public.__preflight_replay_latest where id = 1;
  if l.run_id is null then raise exception 'replay concurrency run_id missing'; end if;

  -- ── 1. Refund Concurrency 検証 ─────────────────────────────────────────────
  -- ginpay_transactions に該当キーの返金行が厳密に 1 件のみ存在すること
  select count(*) into v_refund_count
  from public.ginpay_transactions
  where idempotency_key = l.refund_key and type = 'refund' and status = 'posted';

  if v_refund_count <> 1 then
    raise exception 'refund concurrency failed: refund count % <> 1', v_refund_count;
  end if;

  -- 残高が 10,000 - 4,000 = 6,000 円に厳密に1回だけ減額されていること
  select balance_cached into v_balance
  from public.ginpay_accounts
  where id = l.account_id;

  if v_balance is distinct from 6000 then
    raise exception 'refund concurrency failed: account balance % <> 6000', v_balance;
  end if;

  -- ── 2. Sale Concurrency 検証 ───────────────────────────────────────────────
  -- accounting_sessions に該当キーの確定セッションが厳密に 1 件のみ存在すること
  select count(*), min(id::text)::uuid into v_sale_count, v_sale_id
  from public.accounting_sessions
  where idempotency_key = l.sale_key and status = 'completed';

  if v_sale_count <> 1 then
    raise exception 'sale concurrency failed: accounting session count % <> 1', v_sale_count;
  end if;

  -- チケットが used = true であること
  select used into v_ticket_used
  from public.tickets
  where id = l.sale_ticket_id;

  if v_ticket_used is distinct from true then
    raise exception 'sale concurrency failed: ticket % was not marked used', l.sale_ticket_id;
  end if;

  -- ticket_usage_logs が厳密に 1 件のみ記録されていること (二重消費なし)
  select count(*) into v_usage_count
  from public.ticket_usage_logs
  where ticket_id = l.sale_ticket_id::text;

  if v_usage_count <> 1 then
    raise exception 'sale concurrency failed: ticket usage logs count % <> 1', v_usage_count;
  end if;

  -- 明細行が重複なく正しく 1 件登録されていること
  select count(*) into v_items_count
  from public.accounting_session_items
  where session_id = v_sale_id;

  if v_items_count <> 1 then
    raise exception 'sale concurrency failed: item count % <> 1', v_items_count;
  end if;

  -- 支払いレコードが重複なく正しく 1 件登録されていること
  select count(*) into v_pmt_count
  from public.accounting_payments
  where session_id = v_sale_id;

  if v_pmt_count <> 1 then
    raise exception 'sale concurrency failed: payment count % <> 1', v_pmt_count;
  end if;

  if (select count(*) from public.accounting_events where session_id = v_sale_id
      and event_type = 'completed' and detail->'pos_replay_v1'->>'version' = 'POS_REPLAY_V1') <> 1
     or not exists (select 1 from public.accounting_events where session_id = v_sale_id
       and detail->'pos_replay_v1'->>'client_id' = l.client_id::text
       and detail->'pos_replay_v1'->'ticket_ids' = jsonb_build_array(l.sale_ticket_id)
       and detail->'pos_replay_v1'->'items'->0->>'pricing_mode' = 'fixed_master') then
    raise exception 'sale concurrency failed: atomic canonical snapshot missing';
  end if;

  foreach v_kind in array array['refund', 'sale'] loop
    if v_kind = 'refund' then
      select id into v_expected_id from public.ginpay_transactions where idempotency_key = l.refund_key;
    else
      v_expected_id := v_sale_id;
    end if;
    select count(*) total,
      count(*) filter (where response ? 'error') errors,
      count(*) filter (where coalesce((response->>'idempotent')::boolean, false) = false) normal,
      count(*) filter (where (response->>'idempotent')::boolean is true) replays,
      count(*) filter (where (response->>'id')::uuid is distinct from v_expected_id
        or (v_kind = 'refund' and (response->>'type' is distinct from 'refund'
          or response->>'status' is distinct from 'posted'
          or response->>'original_transaction_id' is distinct from l.refund_tx_id::text))
        or (v_kind = 'sale' and (response->>'status' is distinct from 'completed'
          or (response->>'total')::integer is distinct from 4000))) wrong_identity
    into v_counts from public.__preflight_replay_responses where run_id = l.run_id and kind = v_kind;
    if v_expected_id is null or v_counts.total <> 10 or v_counts.errors <> 0
       or v_counts.normal <> 1 or v_counts.replays <> 9 or v_counts.wrong_identity <> 0 then
      raise exception '% caller results failed: %', v_kind, row_to_json(v_counts);
    end if;
    raise notice '% responses=10 normal=1 idempotent=9 errors=0 same_identity=10', v_kind;
  end loop;

  raise notice 'Replay concurrency verification passed: refund=1, sale=1, ticket_usage=1';
end $$;
