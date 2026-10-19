-- GINPay ledger regression tests.
--
-- Run against a disposable PostgreSQL/Supabase database after applying migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ginpay_ledger.sql
--
-- This file wraps test data in a transaction and rolls it back.

begin;

do $$
declare
  v_staff text := 'staff-test-token';
  v_hq text := 'hq-test-token';
  v_customer_session text := 'customer-test-token-0123456789abcdef'; -- お客様セッションは32文字以上
  v_app_customer uuid;
  v_app_client uuid;
  v_non_app_client uuid;
  v_merge_source uuid;
  v_account uuid;
  v_tx json;
  v_payment json;
  v_payment_id uuid;
  v_session uuid;
  v_ledger json;
  v_balance integer;
  v_source_before integer;
  v_target_balance integer;
  v_event bigint;
  v_stylist uuid := (select id from public.staff_members order by sort_order limit 1);
  v_sale json;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into app_private.hq_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_hq), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values ('ginpay-app-user', 'GINPay App', '1234', 'GIN-TEST-APP', app_private.norm_name('GINPay App'))
  returning id into v_app_customer;

  v_app_client := app_private.member_client(v_app_customer);

  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex(v_customer_session), 'ginpay-app-user', 'register');

  v_non_app_client := app_private.create_client('GINPay Non App', 'staff', 'staff', 'Tester');
  v_merge_source := app_private.create_client('GINPay Merge Source', 'staff', 'staff', 'Tester');

  -- 新規口座 / 店舗チャージ / 複数チャージ
  perform public.staff_ginpay_open_account(v_staff, v_non_app_client, 'Tester');
  v_tx := public.staff_ginpay_charge_store(v_staff, v_non_app_client, 5000, 'cash', 'Tester', 'first charge', 'test-charge-1');
  if v_tx->>'error' is not null then raise exception 'store charge failed: %', v_tx; end if;
  perform public.staff_ginpay_charge_store(v_staff, v_non_app_client, 2500, 'cash', 'Tester', 'second charge', 'test-charge-2');
  v_ledger := public.staff_ginpay_ledger(v_staff, v_non_app_client, 20);
  if (v_ledger->>'balance')::int <> 7500 then raise exception 'multiple charge balance mismatch: %', v_ledger; end if;

  -- 会計支払い（GINPay 払いは会計の確定の中でだけ記録される） / 残高不足
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object('client_id', v_non_app_client, 'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 3000, 'quantity', 1)),
    'payment_method', 'ginpay', 'expected_total', 3000, 'idempotency_key', 'test-payment-1'), 'Tester');
  if v_sale->>'error' is not null then raise exception 'payment failed: %', v_sale; end if;
  v_session := (v_sale->>'id')::uuid;
  v_payment_id := (v_sale->'ginpay'->0->>'id')::uuid;
  v_tx := public.staff_finalize_sale(v_staff, jsonb_build_object('client_id', v_non_app_client, 'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 9000, 'quantity', 1)),
    'payment_method', 'ginpay', 'expected_total', 9000, 'idempotency_key', 'test-payment-insufficient'), 'Tester');
  if v_tx->>'error' <> 'insufficient_balance' then raise exception 'insufficient balance was not blocked: %', v_tx; end if;

  -- 二重送信 / idempotency
  -- 同じキー・同じ内容の再送は既存の取引を返す。同じキーで内容が違う送信は idempotency_conflict（別の取引を黙って返さない）
  v_tx := public.staff_ginpay_charge_store(v_staff, v_non_app_client, 5000, 'cash', 'Tester', 'first charge', 'test-charge-1');
  if coalesce((v_tx->>'idempotent')::boolean, false) is not true then raise exception 'idempotency did not return existing transaction: %', v_tx; end if;
  v_tx := public.staff_ginpay_charge_store(v_staff, v_non_app_client, 1000, 'cash', 'Tester', 'duplicate', 'test-charge-1');
  if v_tx->>'error' <> 'idempotency_conflict' then raise exception 'same key with different amount was not rejected: %', v_tx; end if;

  -- 返金 / 取消 / adjustment
  -- 会計に紐付いた支払いは GINPay 側だけでは返金できない（会計の取消で、会計と GINPay を一緒に戻す）
  v_tx := public.staff_ginpay_refund(v_staff, v_payment_id, 1000, 'Tester', 'refund test', 'test-refund-1');
  if v_tx->>'error' <> 'use_sale_void' then raise exception 'sale payment refund outside the sale was not blocked: %', v_tx; end if;
  v_tx := public.hq_void_sale(v_hq, v_session, 'void test');
  if v_tx->>'status' <> 'voided' or json_array_length(v_tx->'ginpay') <> 2 then raise exception 'sale void did not reverse GINPay: %', v_tx; end if;
  v_tx := public.staff_ginpay_refund(v_staff, v_payment_id, 2500, 'Tester', 'over refund test', 'test-refund-over');
  if v_tx->>'error' <> 'amount_exceeds_refundable' then raise exception 'over refund was not blocked: %', v_tx; end if;
  v_tx := public.staff_ginpay_void(v_staff, (select id from public.ginpay_transactions where idempotency_key = 'test-charge-2'), 'Tester', 'void test', 'test-void-1');
  if v_tx->>'error' is not null then raise exception 'void failed: %', v_tx; end if;
  v_tx := public.staff_ginpay_adjustment(v_staff, v_non_app_client, 300, 'Tester', 'adjustment test', 'test-adjustment-1', null);
  if v_tx->>'error' is not null then raise exception 'adjustment failed: %', v_tx; end if;

  v_ledger := public.staff_ginpay_ledger(v_staff, v_non_app_client, 50);
  if (v_ledger->>'balance')::int <> (v_ledger->>'ledger_balance')::int then raise exception 'ledger/cache mismatch: %', v_ledger; end if;
  if (v_ledger->>'consistent')::boolean is not true then raise exception 'ledger marked inconsistent: %', v_ledger; end if;

  -- App顧客 / 非App顧客
  perform public.staff_ginpay_charge_store(v_staff, v_app_client, 1200, 'cash', 'Tester', 'app charge', 'test-app-charge-1');
  v_ledger := public.customer_ginpay_ledger(v_customer_session, 20);
  if (v_ledger->>'balance')::int <> 1200 then raise exception 'customer app ledger mismatch: %', v_ledger; end if;
  v_ledger := public.staff_ginpay_ledger(v_staff, v_non_app_client, 20);
  if (v_ledger->>'app_linked')::boolean is not false then raise exception 'non-app client marked app-linked: %', v_ledger; end if;

  -- 顧客統合後のGINPay口座：自動合算・履歴移動はしない。family表示では複数口座になる。
  perform public.staff_ginpay_charge_store(v_staff, v_merge_source, 2200, 'cash', 'Tester', 'source charge', 'test-source-charge-1');
  select (public.staff_ginpay_ledger(v_staff, v_merge_source, 20)->>'balance')::int into v_source_before;
  v_tx := public.staff_merge_clients(v_staff, v_non_app_client, v_merge_source, 'Tester');
  if v_tx->>'error' is not null then raise exception 'merge failed: %', v_tx; end if;
  v_event := (v_tx->>'event_id')::bigint;
  v_ledger := public.staff_ginpay_ledger(v_staff, v_non_app_client, 50);
  if (v_ledger->>'multiple_accounts')::boolean is not true then raise exception 'merged accounts were not visible separately: %', v_ledger; end if;
  v_target_balance := (v_ledger->>'balance')::int;
  if v_target_balance < v_source_before then raise exception 'merged family balance did not include source account: %', v_ledger; end if;
  if not exists (select 1 from public.ginpay_transactions where client_id = v_merge_source and idempotency_key = 'test-source-charge-1') then
    raise exception 'source transaction client_id was not preserved';
  end if;

  -- 顧客統合解除時の扱い：source口座はsourceへ戻って見える。
  v_tx := public.staff_unmerge_client(v_staff, v_event, 'Tester');
  if v_tx->>'error' is not null then raise exception 'unmerge failed: %', v_tx; end if;
  v_ledger := public.staff_ginpay_ledger(v_staff, v_merge_source, 20);
  if (v_ledger->>'balance')::int <> v_source_before then raise exception 'unmerged source balance mismatch: %', v_ledger; end if;

  -- Stripe webhook成功 / 重複 / 失敗
  v_tx := public.ginpay_apply_stripe_webhook(
    'evt_test_success_1', 'payment_intent.succeeded', v_app_client, 3300, 'pi_test_1', null, 'ch_test_1',
    jsonb_build_object('id', 'evt_test_success_1', 'data', jsonb_build_object('object', jsonb_build_object('currency', 'jpy')))
  );
  if (v_tx->>'ok')::boolean is not true then raise exception 'stripe success failed: %', v_tx; end if;
  v_tx := public.ginpay_apply_stripe_webhook(
    'evt_test_success_1', 'payment_intent.succeeded', v_app_client, 3300, 'pi_test_1', null, 'ch_test_1',
    jsonb_build_object('id', 'evt_test_success_1', 'data', jsonb_build_object('object', jsonb_build_object('currency', 'jpy')))
  );
  if (v_tx->>'idempotent')::boolean is not true then raise exception 'stripe duplicate was not idempotent: %', v_tx; end if;
  v_tx := public.ginpay_apply_stripe_webhook(
    'evt_test_failed_1', 'payment_intent.payment_failed', v_app_client, 4400, 'pi_failed_1', null, null,
    jsonb_build_object('id', 'evt_test_failed_1')
  );
  if v_tx->>'status' <> 'ignored' then raise exception 'stripe failure changed balance: %', v_tx; end if;

  -- 不正session
  begin
    perform public.staff_ginpay_ledger('bad-token', v_non_app_client, 20);
    raise exception 'bad staff session was accepted';
  exception when invalid_authorization_specification then
    null;
  end;

  -- RLS / lockdown: anon からの直接参照は失敗する。
  begin
    execute 'set local role anon';
    perform count(*) from public.ginpay_accounts;
    raise exception 'anon direct table access was allowed';
  exception when insufficient_privilege then
    execute 'reset role';
  end;

  -- 本部監査 / 台帳合計と残高の一致
  v_ledger := public.hq_ginpay_reconcile(v_hq);
  if (v_ledger->>'consistent')::boolean is not true then raise exception 'hq reconcile mismatch: %', v_ledger; end if;
  if json_array_length(public.hq_ginpay_audit(v_hq, null, null, null, null, 100, 0)) = 0 then
    raise exception 'hq audit returned no rows';
  end if;
end $$;

rollback;
