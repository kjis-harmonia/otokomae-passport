-- Verify the latest pgbench GINPay concurrent payment run.

do $$
declare
  v_run uuid;
  v_client uuid;
  v_account uuid;
  v_balance integer;
  v_ledger integer;
  v_success integer;
begin
  select run_id into v_run from public.__ginpay_concurrency_latest where id = 1;
  if v_run is null then raise exception 'run_id missing'; end if;

  select client_id into v_client
  from public.__ginpay_concurrency_cases
  where run_id = v_run
  limit 1;

  select id, balance_cached into v_account, v_balance
  from public.ginpay_accounts
  where client_id = v_client and status = 'active';

  select app_private.ginpay_posted_sum(v_account) into v_ledger;
  select count(*) into v_success
  from public.ginpay_transactions
  where client_id = v_client
    and type = 'payment'
    and status = 'posted'
    and idempotency_key like 'sale:ginpay-concurrency-payment:' || v_run::text || ':%';

  if (select count(*) from public.accounting_sessions
      where idempotency_key like 'ginpay-concurrency-payment:' || v_run::text || ':%' and status = 'completed') <> 1 then
    raise exception 'expected one completed sale';
  end if;

  if v_success <> 1 then
    raise exception 'expected one successful concurrent payment, got %', v_success;
  end if;
  if v_balance <> 300 or v_ledger <> 300 then
    raise exception 'balance mismatch after concurrent payments: cached %, ledger %', v_balance, v_ledger;
  end if;
end $$;
