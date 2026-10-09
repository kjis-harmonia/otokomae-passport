-- pgbench worker for ticket-used sale exact replay concurrency
-- :client_id (0-9) で割り当てられたケースを取得して同一 key / 同一 payload の確定を同時実行
insert into public.__preflight_replay_responses(run_id, kind, worker_no, response)
select c.run_id, 'sale', c.worker_no, public.staff_finalize_sale(
  c.staff_token,
  c.payload,
  'ConcurrencyTester',
  c.operator_token,
  null
)::jsonb
from public.__preflight_replay_sale_cases c
join public.__preflight_replay_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
