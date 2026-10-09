-- pgbench worker for refund exact replay concurrency
-- :client_id (0-9) で割り当てられたケースを取得して同一 key / 同一 payload の返金を同時実行
insert into public.__preflight_replay_responses(run_id, kind, worker_no, response)
select c.run_id, 'refund', c.worker_no, public.staff_ginpay_refund(
  c.staff_token,
  c.operator_token,
  c.tx_id,
  c.amount,
  'ConcurrencyTester',
  c.reason,
  c.idempotency_key,
  c.approval_token
)::jsonb
from public.__preflight_replay_refund_cases c
join public.__preflight_replay_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
