-- Run only on a disposable local DB. Every fixture is rolled back.
begin;
do $$
<<fixture>>
declare
  member jsonb; session_token text; member_id text; customer_id uuid; client_id uuid;
  staff_id uuid; second_staff uuid; old_id uuid; mate_id uuid; companion_id uuid; moved_id uuid;
  account_id uuid; ticket_id uuid; draw_id uuid; sale_id uuid; prize text;
  codes text[]:=array['perm-qa-change-safety','cut-qa-change-safety'];
  day date:=app_private.today_jst()+2;
  old_time timestamptz; new_time timestamptz; backup_time timestamptz;
  request_key text:=gen_random_uuid()::text;
  key_try text; preview jsonb; review jsonb; reply jsonb; retry jsonb; wrong jsonb;
begin
  while extract(isodow from day)>5 loop day:=day+1; end loop;
  old_time:=app_private.jst_ts(day,time '10:00');
  new_time:=app_private.jst_ts(day,time '12:00');
  backup_time:=app_private.jst_ts(day,time '15:00');
  update public.booking_settings set app_booking_enabled=true, slot_minutes=30, min_lead_minutes=30,
    ai_late_cancel_minutes=120, customer_cancel_deadline_minutes=30 where id=1;
  insert into public.business_hours(weekday,is_closed,open_time,close_time)
    values (extract(dow from day)::int,false,'08:00','19:00')
    on conflict(weekday) do update set is_closed=false,open_time='08:00',close_time='19:00';
  insert into public.staff_members(display_name) values ('QA change safety') returning id into staff_id;
  insert into public.staff_members(display_name) values ('QA change companion') returning id into second_staff;
  insert into public.staff_shift_templates(staff_id,weekday,start_time,end_time)
    values (staff_id,extract(dow from day)::int,'08:00','19:00'), (second_staff,extract(dow from day)::int,'08:00','19:00');
  insert into public.service_menus(code,name,duration_min,price,is_active,booking_enabled)
    values (codes[1],'QA perm',60,6000,true,true), (codes[2],'QA cut',30,3000,true,true);
  insert into public.staff_menu_capabilities(staff_id,menu_id)
    select s.id,m.id from public.service_menus m cross join public.staff_members s where m.code=any(codes) and s.id in (staff_id,second_staff);

  member:=public.customer_register('QA reservation safety',true);
  session_token:=member->>'session'; member_id:=member->>'user_id';
  select id into customer_id from public.customers where user_id=member_id;
  begin
    perform public.customer_reservation_mutation_result(session_token,request_key,'{}');
    raise exception 'unverified member accessed mutation receipts';
  exception when insufficient_privilege then
    if sqlerrm<>'store_verification_required' then raise; end if;
  end;
  insert into app_private.customer_store_verifications values(customer_id,now(),'qa','qa');
  reply:=app_private.create_reservation(jsonb_build_object('source','app','customer_name','QA reservation safety',
    'user_id',member_id,'staff_id',staff_id,'starts_at',old_time,'menu_codes',codes),'customer','qa',0);
  if reply ? 'error' then raise exception 'old fixture: %',reply; end if;
  old_id:=(reply->>'id')::uuid;
  select r.client_id into client_id from public.reservations r where id=old_id;
  reply:=app_private.create_reservation(jsonb_build_object('source','app','customer_name','QA companion',
    'user_id',member_id,'staff_id',second_staff,'starts_at',new_time,'menu_codes',codes),'customer','qa',0);
  if reply ? 'error' then raise exception 'companion fixture: %',reply; end if;
  mate_id:=(reply->>'id')::uuid;
  insert into app_private.customer_companions(customer_id,name) values(customer_id,'QA companion') returning id into companion_id;
  update public.reservations set companion_id=fixture.companion_id, companion_of=old_id where id=mate_id;

  insert into public.ginpay_accounts(client_id,balance_cached) values(client_id,12000) returning id into account_id;
  reply:=public.customer_ginpay_hold(session_token,old_id,9000);
  if reply->>'amount' is distinct from '9000' then raise exception 'hold fixture: %',reply; end if;
  insert into public.tickets(user_id,type,title,amount,issued_by,expires_at)
    values(member_id,'cut-ticket','QA discount',500,'qa',new_time+interval '1 day') returning id into ticket_id;
  reply:=public.customer_set_ticket_plan(session_token,old_id,array[ticket_id]);
  if reply->>'count' is distinct from '1' then raise exception 'ticket fixture: %',reply; end if;
  select code into prize from app_private.gacha_prizes where amount is not null order by code limit 1;
  insert into app_private.gacha_draws(user_id,draw_date,prize_code) values(member_id,app_private.today_jst(),prize) returning id into draw_id;
  insert into app_private.gacha_holdings(user_id,draw_id,prize_code,title,amount,weekday_only,rank,expires_at,menu_codes,reservation_id)
    values(member_id,draw_id,prize,'QA gacha',100,false,'normal',new_time+interval '1 day',array[codes[2]],old_id);

  -- H1: even an indistinguishable upcoming companion booking is not a receipt.
  reply:=public.customer_reservation_mutation_result(session_token,request_key,'{}');
  if reply->>'state' is distinct from 'unknown' then raise exception 'missing receipt treated as a result: %',reply; end if;
  preview:=public.customer_cancel_preview(session_token,mate_id);
  review:=preview->'confirmation';
  perform app_private.set_reservation_status(mate_id,'checked_in','staff','qa');
  reply:=public.customer_cancel_reservation_checked(session_token,mate_id,gen_random_uuid()::text,review);
  if reply->>'code' is distinct from 'reservation_not_confirmed'
    or (select status from public.reservations where id=mate_id) is distinct from 'checked_in' then raise exception 'check-in misreported as cancellation: %',reply; end if;
  raise notice 'H1 missing receipt and checked-in cancellation passed';

  -- H3: reject each isolated change, and retain all effects on the old reservation.
  preview:=public.customer_change_preview(session_token,old_id,new_time,codes);
  review:=preview->'confirmation';
  if preview->>'price_after' is distinct from '9000' or preview->>'duration_after' is distinct from '90'
    or preview->>'slot_ok' is distinct from 'true' then raise exception 'unexpected initial preview: %',preview; end if;
  update public.service_menus set price=5000 where code=codes[1];
  key_try:=gen_random_uuid()::text;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,key_try,review);
  if reply->>'code' is distinct from 'conditions_changed' then raise exception 'stale master price accepted: %',reply; end if;
  update public.service_menus set price=6000 where code=codes[1];
  retry:=public.customer_change_reservation(session_token,old_id,new_time,codes,key_try,review);
  if retry is distinct from reply then raise exception 'delayed rejected request became executable: %',retry; end if;
  update public.tickets set expires_at=new_time where id=ticket_id;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,gen_random_uuid()::text,review);
  if reply->>'code' is distinct from 'conditions_changed' then raise exception 'stale coupon terms accepted: %',reply; end if;
  update public.tickets set expires_at=new_time+interval '1 day' where id=ticket_id;
  update app_private.gacha_holdings set menu_codes=array['different-menu'] where user_id=member_id;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,gen_random_uuid()::text,review);
  if reply->>'code' is distinct from 'conditions_changed' then raise exception 'stale gacha terms accepted: %',reply; end if;
  update app_private.gacha_holdings set menu_codes=array[codes[2]] where user_id=member_id;
  update public.ginpay_accounts set status='suspended' where id=account_id;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,gen_random_uuid()::text,review);
  if reply->>'code' is distinct from 'ginpay_account_not_active' then raise exception 'post-cancel failure did not roll back: %',reply; end if;
  update public.ginpay_accounts set status='active' where id=account_id;
  if (select status from public.reservations where id=old_id) is distinct from 'confirmed'
    or (select amount from app_private.ginpay_holds where reservation_id=old_id and status='held') is distinct from 9000
    or (select ticket_ids from app_private.reservation_ticket_plans where reservation_id=old_id) is distinct from array[ticket_id]
    or (select reservation_id from app_private.gacha_holdings where user_id=member_id) is distinct from old_id
    or (select count(*) from public.reservations where user_id=member_id)<>2 then raise exception 'stale or failed request changed booking, ticket, or hold'; end if;

  -- The actual finalization trigger uses the last completed sale's personal price.
  insert into public.accounting_sessions(user_id,client_id,status,subtotal,total,payment_method)
    values(member_id,client_id,'pending',5000,5000,'cash') returning id into sale_id;
  insert into public.accounting_session_items(session_id,item_name,category,price,source,ref_id)
    values(sale_id,'QA perm','menu',5000,'service_menu',codes[1]);
  update public.accounting_sessions set status='completed',completed_at=now() where id=sale_id;
  preview:=public.customer_change_preview(session_token,old_id,new_time,codes);
  if preview->>'price_after' is distinct from '8000' then raise exception 'personal price missing from preview: %',preview; end if;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,gen_random_uuid()::text,review);
  if reply->>'code' is distinct from 'conditions_changed' then raise exception 'stale personal price accepted: %',reply; end if;

  -- Deterministically cross the penalty threshold by moving only the fixture policy.
  old_time:=clock_timestamp()+interval '90 minutes';
  update public.reservations set starts_at=old_time, ends_at=old_time+interval '90 minutes',occupied_until=old_time+interval '90 minutes' where id=old_id;
  update public.booking_settings set ai_late_cancel_minutes=60 where id=1;
  preview:=public.customer_change_preview(session_token,old_id,new_time,codes);
  if preview->>'late_penalty' is distinct from 'false' then raise exception 'pre-boundary fixture invalid: %',preview; end if;
  update public.booking_settings set customer_cancel_deadline_minutes=100 where id=1;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,gen_random_uuid()::text,preview->'confirmation');
  if reply->>'code' is distinct from 'call_shop' then raise exception 'call-shop boundary bypassed: %',reply; end if;
  update public.booking_settings set customer_cancel_deadline_minutes=30 where id=1;
  update public.booking_settings set ai_late_cancel_minutes=120 where id=1;
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,gen_random_uuid()::text,preview->'confirmation');
  if reply->>'code' is distinct from 'conditions_changed' then raise exception 'late boundary silently accepted: %',reply; end if;
  raise notice 'H3 master/personal price, ticket/gacha rules, penalty and rollback passed';

  -- M2: a time-only change keeps all menus and real prices, times, and eligible coupons.
  preview:=public.customer_change_preview(session_token,old_id,new_time,codes);
  review:=preview->'confirmation';
  reply:=public.customer_change_reservation(session_token,old_id,new_time,codes,request_key,review);
  if reply->>'state' is distinct from 'completed' then raise exception 'approved change failed: %',reply; end if;
  moved_id:=(reply->'result'->>'id')::uuid;
  if reply->'result'->>'changed_from' is distinct from old_id::text
    or reply->'result'->>'companion_id' is not null
    or (select array_agg(i.menu_code order by i.sort_order) from public.reservation_items i where i.reservation_id=moved_id) is distinct from codes
    or (select total_price from public.reservations where id=moved_id) is distinct from 8000
    or (select ends_at-starts_at from public.reservations where id=moved_id) is distinct from interval '90 minutes'
    or (select amount from app_private.ginpay_holds where reservation_id=moved_id and status='held') is distinct from 8000
    or (select status from app_private.ginpay_holds where reservation_id=old_id) is distinct from 'released'
    or (select ticket_ids from app_private.reservation_ticket_plans where reservation_id=moved_id) is distinct from array[ticket_id]
    or (select reservation_id from app_private.gacha_holdings where user_id=member_id) is distinct from moved_id
    or (select status from public.reservations where id=mate_id) is distinct from 'checked_in'
    or (select balance_cached from public.ginpay_accounts where id=account_id) is distinct from 12000
    or exists(select 1 from public.ginpay_transactions t where t.account_id=fixture.account_id) then raise exception 'incorrect booking or side effects: %',reply; end if;
  raise notice 'M2 all ordered items, effective price/duration, ticket, gacha and GINPay passed';

  -- H2: the request key alone never identifies an operation.
  for wrong in select x from unnest(array[
    public.customer_change_reservation(session_token,mate_id,new_time,codes,request_key,review)::jsonb,
    public.customer_change_reservation(session_token,old_id,backup_time,codes,request_key,review)::jsonb,
    public.customer_change_reservation(session_token,old_id,new_time,array[codes[1]],request_key,review)::jsonb,
    public.customer_cancel_reservation_checked(session_token,old_id,request_key,review)::jsonb
  ]) x loop
    if wrong->>'code' is distinct from 'idempotency_conflict' then raise exception 'altered request replay: %',wrong; end if;
  end loop;
  raise notice 'H2 request ID, time, menu and kind binding passed';

  -- M1: exact retry resolves the receipt despite the new restriction.
  if app_private.ai_booking_gate(session_token) is null then raise exception 'late-change penalty missing'; end if;
  retry:=public.customer_change_reservation(session_token,old_id,new_time,codes,request_key,review);
  if retry is distinct from reply or public.customer_reservation_mutation_result(session_token,request_key,reply->'request')::jsonb is distinct from reply
    or (select count(*) from public.reservations where user_id=member_id)<>3 then raise exception 'exact replay changed effect or was blocked: %',retry; end if;
  preview:=public.customer_change_preview(session_token,moved_id,backup_time,codes);
  retry:=public.customer_change_reservation(session_token,moved_id,backup_time,codes,gen_random_uuid()::text,preview->'confirmation');
  if retry->>'code' is distinct from 'ai_booking_paused' then raise exception 'new change bypassed restriction: %',retry; end if;
  raise notice 'M1 exact replay succeeds and new change remains restricted';

  reply:=app_private.create_reservation(jsonb_build_object('source','app','customer_name','QA companion',
    'user_id',member_id,'staff_id',second_staff,'starts_at',backup_time,'menu_codes',codes),'customer','qa',0);
  if reply ? 'error' then raise exception 'cancel fixture: %',reply; end if;
  mate_id:=(reply->>'id')::uuid;
  update public.reservations set companion_id=fixture.companion_id,companion_of=moved_id where id=mate_id;
  preview:=public.customer_cancel_preview(session_token,mate_id);
  key_try:=gen_random_uuid()::text;
  reply:=public.customer_cancel_reservation_checked(session_token,mate_id,key_try,preview->'confirmation');
  retry:=public.customer_cancel_reservation_checked(session_token,mate_id,key_try,preview->'confirmation');
  if reply->>'state' is distinct from 'completed' or retry is distinct from reply
    or reply->'result'->>'id' is distinct from mate_id::text
    or reply->'result'->>'companion_id' is distinct from companion_id::text
    or reply->'result'->>'status' is distinct from 'cancelled' or reply->'result'->>'ginpay_released' is distinct from '0'
    or (select status from public.reservations where id=moved_id) is distinct from 'confirmed'
    or (select amount from app_private.ginpay_holds where reservation_id=moved_id and status='held') is distinct from 8000 then
    raise exception 'companion cancellation leaked into owner booking: %',reply;
  end if;
  raise notice 'companion-only cancel and exact cancel replay passed';
end;
$$;
rollback;
