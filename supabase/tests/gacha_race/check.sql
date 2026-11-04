select json_build_object(
  'sales_A', (select count(*) from public.accounting_sessions where reservation_id = 'ac3d008f-e09e-4d7e-8656-dc5661c8829e' and status = 'completed'),
  'paid_A', (select coalesce(sum(total), 0) from public.accounting_sessions where reservation_id = 'ac3d008f-e09e-4d7e-8656-dc5661c8829e' and status = 'completed'),
  'gacha_used_in_sales', (select count(*) from public.accounting_discounts d join public.accounting_sessions s on s.id = d.session_id where s.reservation_id in ('ac3d008f-e09e-4d7e-8656-dc5661c8829e', 'b2bc72d8-862d-48e0-9325-0d8c92e3c625') and s.status = 'completed' and d.ticket_type = 'gacha'),
  'holding', (select prize_code || ' used=' || (used_at is not null) || ' res=' || coalesce(left(reservation_id::text, 8), '-') from app_private.gacha_holdings where user_id = 'u-v2qa-claude-1024'),
  'status_A', (select status from public.reservations where id = 'ac3d008f-e09e-4d7e-8656-dc5661c8829e'),
  'draws_today', (select count(*) from app_private.gacha_draws where user_id = 'u-v2qa-claude-1024' and draw_date = app_private.today_jst())
)::text as r;
