-- pgbench worker: all clients try to finalize the same reservation.

select public.staff_finalize_sale(
  c.staff_token,
  jsonb_build_object(
    'reservation_id', c.reservation_id,
    'stylist_id', c.stylist_id,
    'operator_token', c.operator_token,
    'items', jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', 'maintenance-ginjiro', 'quantity', 1)),
    'payment_method', 'cash',
    'expected_total', 1000,
    'quote_hash', c.quote_hash,
    'idempotency_key', c.idempotency_key
  ),
  'Preflight',
  c.operator_token,
  null
)
from public.__preflight_checkout_concurrency_cases c
join public.__preflight_checkout_concurrency_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
