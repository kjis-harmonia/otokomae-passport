-- 台帳と一致しない口座への同時書き込みの検証
do $$
declare v_run uuid; v_account uuid; v_tx int; v_sales int; v_events int; v_cached int; v_ledger int;
begin
  select run_id, account_id into v_run, v_account from public.__ginpay_mismatch_latest where id = 1;
  if v_run is null then raise exception 'run_id missing'; end if;
  select count(*) into v_tx from public.ginpay_transactions where account_id = v_account;
  select count(*) into v_sales from public.accounting_sessions where idempotency_key like 'ginpay-mismatch:' || v_run::text || ':%';
  select count(*) into v_events from public.ginpay_account_events where account_id = v_account and event_type = 'ledger_mismatch_blocked';
  select balance_cached into v_cached from public.ginpay_accounts where id = v_account;
  v_ledger := app_private.ginpay_posted_sum(v_account);
  if v_tx <> 1 or v_sales <> 0 or v_events <> 10 or v_cached <> 5300 or v_ledger <> 5000 then
    raise exception 'mismatch concurrency: tx=% sales=% audit=% cached=% ledger=% (expected 1/0/10/5300/5000)', v_tx, v_sales, v_events, v_cached, v_ledger;
  end if;
  raise notice 'ginpay mismatch concurrency ok: 10 concurrent writes blocked, 10 audits committed, no money written';
end $$;
