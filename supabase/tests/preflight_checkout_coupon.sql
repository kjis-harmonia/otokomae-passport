-- Staging preflight: checkout + coupon smoke test.

begin;

do $$
declare
  v_staff text := 'preflight-staff-token';
  v_hq text := 'preflight-hq-token';
  v_customer uuid;
  v_client uuid;
  v_stylist uuid;
  v_ticket uuid;
  v_tickets json;
  v_sale json;
  v_op_token text := 'preflight-op-token-0123456789abcdef';
  v_op_member uuid;
  v_scan_session uuid;
  v_quote jsonb;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into app_private.hq_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_hq), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;
  if v_stylist is null then raise exception 'staff seed data missing'; end if;

  v_op_member := v_stylist;
  perform app_private.set_staff_operator_credentials(v_op_member, '1234', 'staff');
  insert into app_private.pos_operator_sessions (token_hash, staff_member_id, staff_session_hash, role, expires_at)
  values (app_private.sha256_hex(v_op_token), v_op_member, app_private.sha256_hex(v_staff), 'staff', now() + interval '8 hours');

  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values ('preflight-coupon-user', 'Preflight Coupon', '0001', 'PREFLIGHT-COUPON', app_private.norm_name('Preflight Coupon'))
  returning id into v_customer;
  v_client := app_private.member_client(v_customer);

  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex('cust-tok-coupon-0123456789abcdef'), 'preflight-coupon-user', 'register');

  v_scan_session := (public.staff_resolve_presence_token(v_staff,
    (public.customer_issue_presence_token('cust-tok-coupon-0123456789abcdef')->>'token')
  )->>'scan_session_id')::uuid;

  insert into public.tickets (user_id, type, title, amount, used, issued_by)
  values ('preflight-coupon-user', 'discount', '割引券', 300, false, 'Preflight')
  returning id into v_ticket;

  v_quote := public.staff_pos_quote(v_staff, v_op_token, v_scan_session, jsonb_build_object(
    'client_id', v_client,
    'scan_session_id', v_scan_session,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
    'ticket_ids', jsonb_build_array(v_ticket)
  ))::jsonb;
  if v_quote ? 'error' then raise exception 'checkout quote failed: %', v_quote; end if;

  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client,
    'stylist_id', v_stylist,
    'scan_session_id', v_scan_session,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', 'opt-shampoo', 'quantity', 1)),
    'ticket_ids', jsonb_build_array(v_ticket),
    'payment_method', 'cash',
    'expected_total', 700,
    'quote_hash', v_quote->>'quote_hash',
    'idempotency_key', 'preflight-checkout-coupon'
  ), 'Preflight', v_op_token, null);
  if v_sale->>'error' is not null then raise exception 'checkout coupon sale failed: %', v_sale; end if;
  if (v_sale->>'total')::int <> 700 then raise exception 'checkout total mismatch: %', v_sale; end if;
  if not exists (select 1 from public.tickets where id = v_ticket and used) then raise exception 'coupon was not marked used'; end if;

  v_sale := public.hq_void_sale(v_hq, (v_sale->>'id')::uuid, 'preflight void');
  if v_sale->>'status' <> 'voided' then raise exception 'sale void failed: %', v_sale; end if;
  if exists (select 1 from public.tickets where id = v_ticket and used) then raise exception 'void did not restore coupon'; end if;
end $$;

rollback;
