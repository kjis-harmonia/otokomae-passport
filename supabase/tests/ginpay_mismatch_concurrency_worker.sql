-- pgbench worker（ginpay_mismatch_concurrency_setup.sql の後、ちょうど 10 クライアントで実行）。
-- :client_id（0-9）で操作を選ぶ：GINPay 払いの会計／店頭チャージ／調整。どれも結果は { error }（例外にしない）。
select case c.op
  when 'sale' then public.staff_finalize_sale(c.staff_token, jsonb_build_object(
      'client_id', c.client_id, 'scan_session_id', c.scan_session_id, 'stylist_id', c.stylist_id,
      'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
      'payment_method', 'ginpay', 'expected_total', 1000, 'quote_hash', c.quote_hash, 'idempotency_key', c.idempotency_key), 'Concurrency', c.operator_token, null)
  when 'charge' then public.staff_ginpay_charge_store(c.staff_token, c.operator_token, c.client_id, 1000, 'cash', 'Concurrency', null, c.idempotency_key, null, null)
  else public.hq_ginpay_adjustment(c.hq_token, c.client_id, -100, 'test', c.idempotency_key)
  end
from public.__ginpay_mismatch_cases c join public.__ginpay_mismatch_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
