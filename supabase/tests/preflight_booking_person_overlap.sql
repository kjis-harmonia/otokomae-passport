-- Run against a migrated disposable DB. Synthetic fixtures are rolled back.
begin;

do $$
<<fixture>>
declare
  member jsonb; session_token text; member_id text; customer_id uuid; client_id uuid;
  staff_token text := gen_random_uuid()::text;
  stylist_a uuid; stylist_b uuid; stylist_c uuid; person_a uuid; person_b uuid; unrelated uuid;
  old_id uuid; conflict_id uuid; companion_booking uuid; account_id uuid; ticket_id uuid; draw_id uuid; hpb_id uuid;
  extra_hold uuid; extra_id uuid;
  at_10 timestamptz; at_13 timestamptz; day date := app_private.today_jst()+2;
  codes text[] := array['qa-person-perm','qa-person-cut'];
  draft jsonb; result jsonb; retry jsonb; review jsonb; prize text; constraint_hit text;
begin
  while extract(isodow from day) > 4 loop day := day+1; end loop;
  at_10 := app_private.jst_ts(day,'10:00');
  at_13 := app_private.jst_ts(day,'13:00');
  update public.booking_settings set app_booking_enabled=true, slot_minutes=30, min_lead_minutes=0 where id=1;
  insert into public.business_hours(weekday,is_closed,open_time,close_time)
    select extract(dow from d)::int,false,'08:00','19:00' from (values (day),(day+1)) days(d)
    on conflict (weekday) do update set is_closed=false,open_time='08:00',close_time='19:00';
  insert into public.staff_members(display_name) values ('QA Person A') returning id into stylist_a;
  insert into public.staff_members(display_name) values ('QA Person B') returning id into stylist_b;
  insert into public.staff_members(display_name) values ('QA Person C') returning id into stylist_c;
  insert into public.staff_shift_templates(staff_id,weekday,start_time,end_time)
    select s,extract(dow from d)::int,'08:00','19:00'
    from unnest(array[stylist_a,stylist_b,stylist_c]) s cross join (values (day),(day+1)) days(d);
  insert into public.service_menus(code,name,duration_min,buffer_after_min,price,is_active,booking_enabled)
    values(codes[1],'QA Person Perm',60,30,6000,true,true),(codes[2],'QA Person Cut',30,0,3000,true,true);
  insert into public.staff_menu_capabilities(staff_id,menu_id)
    select s,m.id from unnest(array[stylist_a,stylist_b,stylist_c]) s cross join public.service_menus m where m.code=any(codes);
  insert into app_private.staff_sessions(token_hash,expires_at)
    values(app_private.sha256_hex(staff_token),now()+interval '1 hour');

  member := public.customer_register('QA Person Member',true);
  session_token := member->>'session'; member_id := member->>'user_id';
  select id into customer_id from public.customers where user_id=member_id;
  insert into app_private.customer_store_verifications values(customer_id,now(),'qa','qa');
  insert into app_private.customer_companions(customer_id,name) values(customer_id,'QA Companion A') returning id into person_a;
  insert into app_private.customer_companions(customer_id,name) values(customer_id,'QA Companion B') returning id into person_b;

  result := public.customer_create_hold(session_token,at_10,codes,stylist_a);
  result := public.customer_confirm_reservation(session_token,(result->>'hold_id')::uuid,null);
  old_id := (result->>'id')::uuid;
  select r.client_id into client_id from public.reservations r where r.id=old_id;
  if client_id is null or (select ends_at from public.reservations where id=old_id) is distinct from at_10+interval '90 minutes'
    or (select occupied_until from public.reservations where id=old_id) is distinct from at_10+interval '120 minutes'
    or (select count(*) from public.reservation_items where reservation_id=old_id)<>2 then
    raise exception 'Owner multi-menu fixture did not use the full plan: %',result;
  end if;

  -- Starting at the same time and a partial overlap in the second menu both fail.
  -- A customer-controlled note cannot switch the treatment identity.
  foreach at_13 in array array[at_10,at_10+interval '1 hour'] loop
    result := public.customer_create_hold(session_token,at_13,array[codes[2]],stylist_b);
    if result->>'hold_id' is null then raise exception 'The second stylist should be free: %',result; end if;
    if public.customer_confirm_reservation(session_token,(result->>'hold_id')::uuid,'お連れ様：任意')->>'error'
      is distinct from 'companion_id_required' then raise exception 'A note bypassed the companion ID'; end if;
    result := public.customer_confirm_new_reservation(session_token,(result->>'hold_id')::uuid,null,null);
    if result->>'error' is distinct from 'reservation_person_overlap' then raise exception 'Same owner overlap was not identified: %',result; end if;
    update public.booking_holds set released_at=now() where holder_user_id=member_id and staff_id=stylist_b and starts_at=at_13;
  end loop;
  at_13 := app_private.jst_ts(day,'13:00');

  -- One companion can share the owner's time. The same companion cannot use two stylists.
  result := public.customer_create_hold_for(session_token,at_10,array[codes[2]],stylist_b,person_a);
  result := public.customer_confirm_for(session_token,(result->>'hold_id')::uuid,person_a);
  companion_booking := (result->>'id')::uuid;
  if companion_booking is null or (select companion_id from public.reservations where id=companion_booking) is distinct from person_a then
    raise exception 'Distinct companion was rejected: %',result;
  end if;
  result := public.customer_create_hold_for(session_token,at_10,array[codes[2]],stylist_c,person_a);
  if result->>'hold_id' is null then raise exception 'Companion duplicate fixture failed: %',result; end if;
  result := public.customer_confirm_reservation(session_token,(result->>'hold_id')::uuid,null);
  if result->>'error' is distinct from 'companion_mismatch' then raise exception 'Legacy confirmation bypassed companion identity: %',result; end if;
  update public.booking_holds set released_at=now() where holder_user_id=member_id and staff_id=stylist_c and starts_at=at_10;
  result := public.customer_create_hold_for(session_token,at_10,array[codes[2]],stylist_c,person_b);
  result := public.customer_confirm_for(session_token,(result->>'hold_id')::uuid,person_b);
  if result->>'id' is null or result->>'companion_id' is distinct from person_b::text then
    raise exception 'Second companion was treated as the first: %',result;
  end if;
  raise notice 'owner/companion IDs, full multi-menu duration and cross-stylist overlap passed';

  draft := jsonb_build_object('source','phone','client_id',client_id,'customer_name','QA Person Member',
    'staff_id',stylist_b,'starts_at',at_10+interval '1 hour','menu_codes',array[codes[2]]);
  result := public.staff_create_reservation(staff_token,draft,'QA');
  if result->>'error' is distinct from 'slot_taken' then raise exception 'Store create bypassed app identity: %',result; end if;
  result := public.staff_sb_preview(staff_token,draft);
  if result->>'plan_hash' is null then raise exception 'SB fixture preview failed: %',result; end if;
  result := public.staff_sb_mutate(staff_token,gen_random_uuid(),jsonb_build_object('kind','create','input',draft,
    'plan_hash',result->>'plan_hash'),'QA Person A');
  if result->>'error' is distinct from 'slot_taken' then raise exception 'SB create bypassed app identity: %',result; end if;

  -- Exact end/start boundary is valid even during the previous stylist's cleanup.
  result := public.staff_create_reservation(staff_token,draft || jsonb_build_object('starts_at',at_10+interval '90 minutes'),'QA');
  if result->>'id' is null then raise exception 'Treatment end boundary failed: %',result; end if;
  result := public.staff_create_reservation(staff_token,draft || jsonb_build_object('starts_at',at_10+interval '1 day'),'QA');
  if result->>'id' is null then raise exception 'Other day was blocked: %',result; end if;
  unrelated := app_private.create_client('QA Person Member','staff','staff','QA');
  result := public.staff_create_reservation(staff_token,draft || jsonb_build_object('client_id',unrelated),'QA');
  if result->>'id' is null then raise exception 'Matched two clients by name: %',result; end if;
  raise notice 'public staff and SB writers, exact boundary, other day and unrelated same-name client passed';

  result := public.staff_create_reservation(staff_token,draft || jsonb_build_object('staff_id',stylist_c,'starts_at',at_13),'QA');
  conflict_id := (result->>'id')::uuid;
  if conflict_id is null then raise exception 'Later store booking fixture failed: %',result; end if;
  result := public.staff_reschedule_reservation(staff_token,conflict_id,at_10+interval '30 minutes',stylist_c,'QA');
  if result->>'error' is distinct from 'slot_taken' or (select starts_at from public.reservations where id=conflict_id) is distinct from at_13 then
    raise exception 'Rejected staff reschedule changed the reservation: %',result;
  end if;

  insert into public.ginpay_accounts(client_id,balance_cached) values(client_id,12000) returning id into account_id;
  result := public.customer_ginpay_hold(session_token,old_id,9000);
  if result->>'amount' is distinct from '9000' then raise exception 'GINPay fixture failed: %',result; end if;
  insert into public.tickets(user_id,type,title,amount,issued_by,expires_at)
    values(member_id,'cut-ticket','QA discount',500,'qa',at_13+interval '1 day') returning id into ticket_id;
  result := public.customer_set_ticket_plan(session_token,old_id,array[ticket_id]);
  if result->>'count' is distinct from '1' then raise exception 'Ticket fixture failed: %',result; end if;
  select code into prize from app_private.gacha_prizes where amount is not null order by code limit 1;
  insert into app_private.gacha_draws(user_id,draw_date,prize_code) values(member_id,app_private.today_jst(),prize) returning id into draw_id;
  insert into app_private.gacha_holdings(user_id,draw_id,prize_code,title,amount,weekday_only,rank,expires_at,menu_codes,reservation_id)
    values(member_id,draw_id,prize,'QA gacha',100,false,'normal',at_13+interval '1 day',array[codes[2]],old_id);

  review := public.customer_change_preview(session_token,old_id,at_13,codes)::jsonb->'confirmation';
  if review->>'slot_ok' is distinct from 'true' then raise exception 'Expected the original stylist to be free: %',review; end if;
  draft := jsonb_build_object('key',gen_random_uuid(),'review',review);
  result := public.customer_change_reservation(session_token,old_id,at_13,codes,draft->>'key',review);
  retry := public.customer_change_reservation(session_token,old_id,at_13,codes,draft->>'key',review);
  if result->>'code' is distinct from 'reservation_person_overlap' or retry is distinct from result
    or (select status from public.reservations where id=old_id) is distinct from 'confirmed'
    or (select starts_at from public.reservations where id=old_id) is distinct from at_10
    or (select amount from app_private.ginpay_holds where reservation_id=old_id and status='held') is distinct from 9000
    or (select balance_cached from public.ginpay_accounts where id=fixture.account_id) is distinct from 12000
    or exists(select 1 from public.ginpay_transactions t where t.account_id=fixture.account_id)
    or (select ticket_ids from app_private.reservation_ticket_plans where reservation_id=old_id) is distinct from array[ticket_id]
    or (select reservation_id from app_private.gacha_holdings where user_id=member_id) is distinct from old_id
    or (select count(*) from public.reservations where user_id=member_id)<>3 then
    raise exception 'Overlap rejection mutated the original reservation or benefits: %',result;
  end if;

  perform app_private.set_reservation_status(conflict_id,'cancelled','staff','QA');
  result := public.customer_change_reservation(session_token,old_id,at_13,codes,gen_random_uuid()::text,review);
  conflict_id := (result->'result'->>'id')::uuid;
  if result->>'state' is distinct from 'completed' or conflict_id is null
    or (select status from public.reservations where id=old_id) is distinct from 'cancelled'
    or (select amount from app_private.ginpay_holds where reservation_id=conflict_id and status='held') is distinct from 9000
    or (select ticket_ids from app_private.reservation_ticket_plans where reservation_id=conflict_id) is distinct from array[ticket_id]
    or (select reservation_id from app_private.gacha_holdings where user_id=member_id) is distinct from conflict_id
    or (select status from public.reservations where id=companion_booking) is distinct from 'confirmed' then
    raise exception 'Cancelled time did not become reusable or benefits were lost: %',result;
  end if;

  -- Even SQL without the RPCs or their advisory locks reaches the exclusion constraint.
  begin
    update public.reservations r set client_id=fixture.client_id,starts_at=at_13,ends_at=at_13+interval '30 min',
      occupied_until=at_13+interval '30 min' where r.client_id=unrelated;
    raise exception 'Direct write bypassed person exclusion';
  exception when exclusion_violation then
    get stacked diagnostics constraint_hit = constraint_name;
    if constraint_hit is distinct from 'reservations_treatment_person_no_overlap' then raise; end if;
  end;
  raise notice 'reschedule rollback, exact rejected replay, benefit preservation and cancel/reuse passed';

  review := public.customer_change_preview(session_token,companion_booking,at_13,array[codes[2]])::jsonb->'confirmation';
  result := public.customer_change_reservation(session_token,companion_booking,at_13,array[codes[2]],gen_random_uuid()::text,review);
  if result->>'state' is distinct from 'completed' or result->'result'->>'companion_id' is distinct from person_a::text
    or (select status from public.reservations where id=conflict_id) is distinct from 'confirmed' then
    raise exception 'Companion move incorrectly used the owner identity: %',result;
  end if;

  -- A recognized HPB reservation cannot be moved into another booking for its linked client.
  result := public.staff_create_reservation(staff_token,jsonb_build_object('source','hotpepper','external_ref','QA96735',
    'client_id',client_id,'customer_name','QA Person Member','staff_id',stylist_c,'starts_at',at_13+interval '2 hours',
    'menu_codes',array[codes[2]]),'QA Person C');
  hpb_id := (result->>'id')::uuid;
  if hpb_id is null then raise exception 'HPB fixture failed: %',result; end if;
  result := public.staff_sb_hpb_import(staff_token,concat_ws(E'\n','予約内容の変更がありました',
    '■予約番号','QA96735','■来店日時',to_char(day,'YYYY"年"MM"月"DD"日"') || ' 13:00',
    '■氏名','QA Person Member','■スタイリスト','QA Person C',
    '■メニュー','QA Person Cut','施術時間目安:30分','メニュー金額:3000円'),'QA Person C');
  if result->>'status' is distinct from 'needs_review' or result->>'reason' is distinct from 'slot_taken'
    or (select starts_at from public.reservations where id=hpb_id) is distinct from at_13+interval '2 hours'
    or (select count(*) from public.reservation_items where reservation_id=hpb_id)<>1 then
    raise exception 'HPB collision was not retained for review with the old booking intact: %',result;
  end if;
  raise notice 'companion move and HPB collision inbox passed';

  -- A legacy replacement is indistinguishable from a legacy extra booking until it sends the cancel.
  result := public.customer_create_hold_for(session_token, app_private.jst_ts(day+1,'16:00'), array[codes[2]], stylist_b, person_a);
  extra_hold := (result->>'hold_id')::uuid;
  if extra_hold is null then raise exception 'Cutover hold was not created: %', result; end if;
  result := public.customer_confirm_for(session_token, extra_hold, person_a);
  if result->>'error' is distinct from 'booking_update_required'
    or (select converted_reservation_id from public.booking_holds where id=extra_hold) is not null then
    raise exception 'Legacy replacement was not stopped at confirmation: %', result;
  end if;
  result := public.customer_cancel_reservation(session_token, conflict_id);
  if result->>'error' is distinct from 'booking_update_required'
    or (select status from public.reservations where id=conflict_id) is distinct from 'confirmed'
    or (select amount from app_private.ginpay_holds where reservation_id=conflict_id and status='held') is distinct from 9000
    or (select ticket_ids from app_private.reservation_ticket_plans where reservation_id=conflict_id) is distinct from array[ticket_id]
    or (select reservation_id from app_private.gacha_holdings where user_id=member_id) is distinct from conflict_id then
    raise exception 'Legacy delayed cancel changed the booking or its benefits: %', result;
  end if;

  result := public.customer_confirm_new_reservation(session_token, extra_hold, person_a, null);
  extra_id := (result->>'id')::uuid;
  retry := public.customer_confirm_new_reservation(session_token, extra_hold, person_a, null);
  if extra_id is null or retry is distinct from result or result->>'companion_id' is distinct from person_a::text
    or public.customer_confirm_new_reservation(session_token, extra_hold, person_b, null)->>'error' is distinct from 'idempotency_conflict'
    or public.customer_confirm_for(session_token, extra_hold, person_a)->>'error' is distinct from 'booking_update_required'
    or (select count(*) from public.reservations where companion_id=person_a and status='confirmed')<>2 then
    raise exception 'Explicit extra booking or exact replay failed: % / %', result, retry;
  end if;
  result := public.customer_cancel_reservation_explicit(session_token, extra_id);
  retry := public.customer_cancel_reservation_explicit(session_token, extra_id);
  if result->>'status' is distinct from 'cancelled' or retry is distinct from result
    or (select status from public.reservations where id=conflict_id) is distinct from 'confirmed' then
    raise exception 'Explicit standalone cancellation or replay failed: % / %', result, retry;
  end if;
  if has_function_privilege('anon','app_private.confirm_customer_hold(text,uuid,uuid,text,boolean)','execute')
    or has_function_privilege('anon','app_private.cutover_cancel_customer_reservation(text,uuid)','execute') then
    raise exception 'An anonymous role can call an internal cutover function';
  end if;
  raise notice 'legacy confirm and cancel blocked, explicit addition and cancel replay passed';
end;
$$;

rollback;
