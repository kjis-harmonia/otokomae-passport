-- Staging：migration の記録をファイルと実際の適用に合わせる（中身はすでに適用済み。記録だけ直す）
begin;
-- customer_contact は本番と同じ 20261015100000 に（20261015000200 は sb_hotpepper_mail）
update supabase_migrations.schema_migrations set version = '20261015100000' where version = '20261015000200' and name = 'customer_contact';
insert into supabase_migrations.schema_migrations (version, name) values
  ('20261015000200', 'sb_hotpepper_mail'),
  ('20261016000000', 'hq_app_booking_switch'),
  ('20261016000100', 'customer_availability_overview'),
  ('20261017000000', 'visit_log'),
  ('20261017000100', 'visit_log_maintenance'),
  ('20261017000200', 'ticket_rules_checkin_price'),
  ('20261017000300', 'johnny_push'),
  ('20261018000110', 'hq_tasks'),
  ('20261018000210', 'open_slot_push')
on conflict (version) do nothing;
commit;
