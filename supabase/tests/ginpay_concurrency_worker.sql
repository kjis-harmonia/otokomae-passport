-- pgbench worker script for GINPay concurrent payment.
--
-- Must be run after supabase/tests/ginpay_concurrency_setup.sql with exactly
-- ten clients:
--   pgbench "$DATABASE_URL" -n -c 10 -j 10 -t 1 -f supabase/tests/ginpay_concurrency_worker.sql
--
-- GINPay payments are recorded only inside staff_finalize_sale (one transaction with the sale).
-- pgbench substitutes only :client_id (0-9), so the other parameters are read from the cases table.

select public.staff_finalize_sale(
  c.staff_token,
  jsonb_build_object(
    'client_id', c.client_id,
    'scan_session_id', c.scan_session_id,
    'stylist_id', c.stylist_id,
    'operator_token', c.operator_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'accounting_item', 'ref_id', ai.id::text, 'quantity', 1)),
    'payment_method', 'ginpay',
    'expected_total', c.amount,
    'quote_hash', c.quote_hash,
    'idempotency_key', c.idempotency_key
  ),
  'Concurrency',
  c.operator_token,
  null
)
from public.__ginpay_concurrency_cases c
join public.__ginpay_concurrency_latest l on l.run_id = c.run_id
cross join lateral (select id from public.accounting_items where name = 'ginpay-concurrency-700' limit 1) ai
where c.worker_no = :client_id;
