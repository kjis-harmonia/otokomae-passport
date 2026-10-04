-- pgbench worker for approval consumption concurrency
-- :client_id (0-9) で割り当てられたケースを取得して消費を試行
select app_private.consume_pos_approval(c.staff_token, c.operator_token, c.approval_token, c.action, c.request_hash)
from public.__pos_approval_cases c
join public.__pos_approval_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
