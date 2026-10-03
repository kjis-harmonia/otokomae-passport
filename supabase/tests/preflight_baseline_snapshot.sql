-- Staging preflight: fingerprint of existing production data (run on a local copy of a production backup).
-- Run before and after applying the migrations; every value must be identical.
-- Only counts, totals and md5 digests are returned (no personal data is printed).
-- Uses only columns that exist before the migrations, so the same query works on both sides.

select json_build_object(
  'customers', (select json_build_object('n', count(*), 'md5', md5(coalesce(string_agg(
      concat_ws('|', id, user_id, name, phone_last4, recovery_code, normalized_name, created_at, updated_at,
                first_visit_answered_at, first_visit_has_visited_before, welcome_coupon_issued_at), ',' order by id), '')))
    from public.customers),
  'customer_user_aliases', (select json_build_object('n', count(*), 'md5', md5(coalesce(string_agg(
      concat_ws('|', id, customer_id, user_id, is_current, created_at), ',' order by id), '')))
    from public.customer_user_aliases),
  'customer_recovery_logs', (select json_build_object('n', count(*), 'md5', md5(coalesce(string_agg(
      concat_ws('|', id, customer_id, old_user_id, new_user_id, recovered_at), ',' order by id), '')))
    from public.customer_recovery_logs),
  'accounting_sessions', (select json_build_object('n', count(*),
      'completed_total', coalesce(sum(total) filter (where status = 'completed'), 0),
      'md5', md5(coalesce(string_agg(concat_ws('|', id, user_id, customer_name, staff_name, subtotal, discount_total, total,
                used_ticket_ids, created_at, status, stylist_name, payment_method), ',' order by id), '')))
    from public.accounting_sessions),
  'accounting_session_items', (select json_build_object('n', count(*), 'sum', coalesce(sum(price * quantity), 0),
      'md5', md5(coalesce(string_agg(concat_ws('|', id, session_id, item_id, item_name, category, price, quantity, created_at), ',' order by id), '')))
    from public.accounting_session_items),
  'tickets', (select json_build_object('n', count(*), 'used', count(*) filter (where used),
      'md5', md5(coalesce(string_agg(concat_ws('|', id, user_id, type, title, amount, used, issued_by, created_at, used_at, expires_at), ',' order by id), '')))
    from public.tickets),
  'ticket_usage_logs', (select json_build_object('n', count(*), 'md5', md5(coalesce(string_agg(
      concat_ws('|', id, user_id, ticket_id, ticket_type, amount, status, used_at), ',' order by id), '')))
    from public.ticket_usage_logs),
  'ticket_transfers', (select json_build_object('n', count(*), 'md5', md5(coalesce(string_agg(
      concat_ws('|', id, ticket_id, from_user_id, to_user_id, status, claimed_at), ',' order by id), '')))
    from public.ticket_transfers),
  'maintenance_visits', (select json_build_object('n', count(*), 'md5', md5(coalesce(string_agg(
      concat_ws('|', user_id, last_visit_date, updated_at), ',' order by user_id), '')))
    from public.maintenance_visits)
)::text;
