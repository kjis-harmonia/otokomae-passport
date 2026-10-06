-- pgbench worker for pos pricing finalize concurrency
-- :client_id (0-9) で割り当てられたケースを取得して finalize を同時実行
select public.staff_finalize_sale(c.staff_token, c.payload, 'ConcurrencyTester', c.payload->>'operator_token', null)
from public.__pos_pricing_cases c
join public.__pos_pricing_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
