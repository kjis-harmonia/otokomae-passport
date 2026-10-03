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
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into app_private.hq_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_hq), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;
  if v_stylist is null then raise exception 'staff seed data missing'; end if;

  insert into public.customers (user_id, name, phone_last4, recovery_code, normalized_name)
  values ('preflight-coupon-user', 'Preflight Coupon', '0001', 'PREFLIGHT-COUPON', app_private.norm_name('Preflight Coupon'))
  returning id into v_customer;
  v_client := app_private.member_client(v_customer);

  v_tickets := public.staff_issue_tickets(v_staff, 'preflight-coupon-user', 'discount', 300, 1, 'Preflight', 'Preflight Coupon');
  v_ticket := (v_tickets->'tickets'->0->>'id')::uuid;
  if v_ticket is null then raise exception 'ticket issue failed: %', v_tickets; end if;

  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object(
    'client_id', v_client,
    'stylist_id', v_stylist,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 1000, 'quantity', 1)),
    'ticket_ids', jsonb_build_array(v_ticket),
    'payment_method', 'cash',
    'expected_total', 700,
    'idempotency_key', 'preflight-checkout-coupon'
  ), 'Preflight');
  if v_sale->>'error' is not null then raise exception 'checkout coupon sale failed: %', v_sale; end if;
  if (v_sale->>'total')::int <> 700 then raise exception 'checkout total mismatch: %', v_sale; end if;
  if not exists (select 1 from public.tickets where id = v_ticket and used) then raise exception 'coupon was not marked used'; end if;

  v_sale := public.hq_void_sale(v_hq, (v_sale->>'id')::uuid, 'preflight void');
  if v_sale->>'status' <> 'voided' then raise exception 'sale void failed: %', v_sale; end if;
  if exists (select 1 from public.tickets where id = v_ticket and used) then raise exception 'void did not restore coupon'; end if;
end $$;

rollback;
