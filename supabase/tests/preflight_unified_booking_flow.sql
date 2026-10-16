-- Staging only: synthetic identities, bookings and sales; every change is rolled back.
begin;
create temporary table unified_checks(label text);
create function pg_temp.unified_assert(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'unified preflight failed: %', label; end if;
  insert into unified_checks values(label);
end $$;
do $$
<<test>>
declare
  tag text := 'integration-' || gen_random_uuid()::text;
  staff_token text := gen_random_uuid()::text;
  hq_token text := gen_random_uuid()::text;
  actor text;
  staff_id uuid; menu_id uuid; ticket_id uuid;
  starts timestamptz := to_timestamp(ceil(extract(epoch from (now()+interval '2 hours'))/900)*900);
  members jsonb[] := '{}'; holds jsonb[] := '{}'; bookings jsonb[] := '{}';
  r jsonb; ctx jsonb; payload jsonb; sale jsonb; i int; n int;
begin
  if (starts at time zone 'Asia/Tokyo')::date <> app_private.today_jst() then
    raise exception 'run this check earlier in the JST day';
  end if;
  if not (select app_booking_enabled from public.booking_settings where id=1) then
    raise exception 'booking disabled; test will not change this setting';
  end if;
  actor := left(tag,40);
  insert into app_private.staff_sessions(token_hash,expires_at)
    values(app_private.sha256_hex(staff_token),now()+interval '1 hour');
  insert into app_private.hq_sessions(token_hash,expires_at)
    values(app_private.sha256_hex(hq_token),now()+interval '1 hour');
  insert into public.staff_members(display_name,booking_capacity) values(actor,3) returning id into staff_id;
  insert into public.service_menus(code,name,duration_min,price,is_active,booking_enabled,checkout_enabled)
    values(tag,'統合検証カット',30,5000,false,false,true) returning id into menu_id;
  insert into public.staff_menu_capabilities(staff_id,menu_id) values(staff_id,menu_id);
  update public.service_menus set is_active=true,booking_enabled=true where id=menu_id;
  for i in 0..6 loop
    insert into public.staff_shift_templates(staff_id,weekday,start_time,end_time)
      values(staff_id,i,'00:00','23:59');
  end loop;
  for i in 1..4 loop
    r := public.customer_register('統合検証顧客' || i,true)::jsonb;
    if r ? 'error' then raise exception 'customer setup failed: %',r; end if;
    members := array_append(members,r);
    r := public.customer_set_contact(members[i]->>'session','統合検証本名' || i,'0900000000' || i)::jsonb;
    if r ? 'error' then raise exception 'contact setup failed: %',r; end if;
  end loop;
  for i in 1..3 loop
    r := public.customer_create_hold(members[i]->>'session',starts,array[tag],staff_id)::jsonb;
    if r ? 'error' then raise exception 'hold failed: %',r; end if;
    holds := array_append(holds,r);
  end loop;
  r := public.customer_create_hold(members[4]->>'session',starts,array[tag],staff_id)::jsonb;
  perform pg_temp.unified_assert(r->>'error'='slot_taken','three overlapping holds accepted; fourth rejected');
  select count(distinct h.booking_lane) into n from public.booking_holds h where h.staff_id=test.staff_id;
  perform pg_temp.unified_assert(n=3,'holds occupy three distinct lanes');
  for i in 1..3 loop
    r := public.customer_confirm_reservation(members[i]->>'session',(holds[i]->>'hold_id')::uuid,null)::jsonb;
    if r ? 'error' then raise exception 'confirmation failed: %',r; end if;
    bookings := array_append(bookings,r);
  end loop;
  select count(distinct b.booking_lane) into n from public.reservations b where b.staff_id=test.staff_id;
  perform pg_temp.unified_assert(n=3,'confirmed bookings retain lanes 0/1/2');
  select count(*) into n from public.reservations b where b.staff_id=test.staff_id
    and b.customer_name like '統合検証本名%' and b.customer_phone is not null;
  perform pg_temp.unified_assert(n=3,'verified contact name and phone reach bookings');
  ctx := public.staff_member_booking_context(staff_token,members[1]->>'user_id');
  perform pg_temp.unified_assert(exists(select 1 from jsonb_array_elements(ctx->'reservations') item(value)
    where item.value->>'id'=bookings[1]->>'id'),'member QR context resolves the original booking');
  r := public.staff_check_in_reservation(staff_token,members[2]->>'user_id',(bookings[1]->>'id')::uuid,actor);
  perform pg_temp.unified_assert(r->>'error'='reservation_mismatch','another member cannot check in this booking');
  r := public.staff_check_in_reservation(staff_token,members[1]->>'user_id',(bookings[1]->>'id')::uuid,actor);
  if r ? 'error' then raise exception 'check-in failed: %',r; end if;
  r := public.staff_check_in_reservation(staff_token,members[1]->>'user_id',(bookings[1]->>'id')::uuid,actor);
  perform pg_temp.unified_assert(r->>'status'='checked_in','check-in replay is safe');
  perform pg_temp.unified_assert(exists(select 1 from public.maintenance_visits
    where user_id=members[1]->>'user_id' and last_visit_date=app_private.today_jst()),'check-in updates member visit date');
  insert into public.tickets(user_id,type,title,amount,issued_by)
    values(members[1]->>'user_id','discount','統合検証割引',1000,actor) returning id into ticket_id;
  ctx := public.staff_checkout_context(staff_token,(bookings[1]->>'id')::uuid,null)::jsonb;
  perform pg_temp.unified_assert(ctx->'reservation'->>'id'=bookings[1]->>'id'
    and exists(select 1 from jsonb_array_elements(ctx->'tickets') t where t->>'id'=ticket_id::text),
    'checkout receives the same booking, client and ticket');
  payload := jsonb_build_object('reservation_id',bookings[1]->>'id','stylist_id',staff_id,
    'items',jsonb_build_array(jsonb_build_object('source','reservation','ref_id',tag,'name','統合検証カット',
      'category','menu','unit_price',5000,'quantity',1,'discount',0)),
    'ticket_ids',jsonb_build_array(ticket_id),'payment_method','cash','expected_total',4000,'idempotency_key',tag || '-sale');
  sale := public.staff_finalize_sale(staff_token,payload,actor)::jsonb;
  if sale ? 'error' then raise exception 'checkout failed: %',sale; end if;
  r := public.staff_finalize_sale(staff_token,payload,actor)::jsonb;
  perform pg_temp.unified_assert(sale->>'total'='4000' and r->>'id'=sale->>'id'
    and (select count(*) from public.accounting_sessions s where s.client_id=(ctx->'client'->>'id')::uuid)=1,
    'discounted checkout replay creates exactly one sale');
  perform pg_temp.unified_assert((select used from public.tickets where id=ticket_id),'ticket is consumed by finalized checkout');
  perform pg_temp.unified_assert((select status='completed' from public.reservations where id=(bookings[1]->>'id')::uuid),
    'checkout completes the original booking');
  r := public.hq_sales(hq_token,app_private.today_jst())::jsonb;
  perform pg_temp.unified_assert((r->>'total')::int>=4000,'HQ sales includes the completed sale');
  r := public.customer_list_reservations(members[1]->>'session')::jsonb;
  perform pg_temp.unified_assert(exists(select 1 from jsonb_array_elements(r) x
    where x->>'id'=bookings[1]->>'id' and x->>'status'='completed'),'customer sees the same completed booking');
  r := public.staff_ginpay_open_account(staff_token,(ctx->'client'->>'id')::uuid,actor)::jsonb;
  if r ? 'error' then raise exception 'GINPay account failed: %',r; end if;
  r := public.staff_ginpay_charge_store(staff_token,(ctx->'client'->>'id')::uuid,10000,'cash',actor,null,tag || '-charge',null)::jsonb;
  if r ? 'error' then raise exception 'GINPay charge failed: %',r; end if;
  payload := (payload - 'reservation_id') || jsonb_build_object('client_id',ctx->'client'->>'id',
    'ticket_ids','[]'::jsonb,'payment_method','ginpay','expected_total',5000,'idempotency_key',tag || '-ginpay');
  r := public.staff_finalize_sale(staff_token,payload,actor)::jsonb;
  if r ? 'error' then raise exception 'GINPay checkout failed: %',r; end if;
  r := public.staff_finalize_sale(staff_token,payload,actor)::jsonb;
  if r ? 'error' then raise exception 'GINPay replay failed: %',r; end if;
  r := public.customer_ginpay_ledger(members[1]->>'session',20)::jsonb;
  perform pg_temp.unified_assert(r->>'balance'='5000','GINPay sale replay debits once and customer balance matches');
  if (select count(*) from unified_checks)<>15 then raise exception 'preflight check count mismatch'; end if;
end $$;
rollback;
select 'unified booking flow: 15 assertions passed; transaction rolled back' as result;
