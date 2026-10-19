-- 本番：Claude の 2 本の番号を、会計側（checkout_ticket_mix・sales_day_breakdown）と重ならない番号へ（記録だけ。中身は適用済み）
begin;
update supabase_migrations.schema_migrations set version = '20261018000110' where version = '20261018000100' and name = 'hq_tasks';
update supabase_migrations.schema_migrations set version = '20261018000210' where version = '20261018000200' and name = 'open_slot_push';
commit;
