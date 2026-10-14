-- pgbench worker for POS B-2C-1 operation registry concurrency
-- :client_id (0-9) のケースを、開始時刻をそろえて同時に実行する
insert into public.__pos_op_conc_responses (worker_no, response)
select :client_id, public.__pos_op_conc_run(:client_id);
