-- pgbench worker（pos_presence_concurrency_setup.sql の後、ちょうど 10 クライアントで実行）。
-- :client_id（0-9）で自分の端末セッションを選ぶ。トークン A は別々の端末から、トークン B は同じ端末から読む。
select public.staff_resolve_presence_token(c.staff_token, c.token_a)
from public.__pos_presence_cases c join public.__pos_presence_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
select public.staff_resolve_presence_token(c.shared_staff_token, c.token_b)
from public.__pos_presence_cases c join public.__pos_presence_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
