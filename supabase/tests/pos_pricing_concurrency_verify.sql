-- POS Pricing finalize 同時実行検証
do $$
declare
  v_run         uuid;
  v_count       integer;
  v_sale_id     uuid;
  v_items_count integer;
  v_pmt_count   integer;
begin
  select run_id into v_run from public.__pos_pricing_latest where id = 1;
  if v_run is null then raise exception 'pos pricing concurrency run_id missing'; end if;

  -- 1. accounting_sessions がちょうど 1 件だけ作成されていること (重複なし)
  select count(*), min(id::text)::uuid into v_count, v_sale_id
  from public.accounting_sessions
  where idempotency_key = 'pos-pricing-conc-idem-' || v_run::text;

  if v_count <> 1 then
    raise exception 'pos pricing concurrency failed: session count % <> 1', v_count;
  end if;

  -- 2. 明細行が重複なく正しく 1 件登録されていること
  select count(*) into v_items_count
  from public.accounting_session_items
  where session_id = v_sale_id;

  if v_items_count <> 1 then
    raise exception 'pos pricing concurrency failed: item count % <> 1', v_items_count;
  end if;

  -- 3. 支払いレコードが重複なく正しく 1 件登録されていること
  select count(*) into v_pmt_count
  from public.accounting_payments
  where session_id = v_sale_id;

  if v_pmt_count <> 1 then
    raise exception 'pos pricing concurrency failed: payment count % <> 1', v_pmt_count;
  end if;
end $$;
