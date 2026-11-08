-- Disposable DB or Staging only. All fixtures and approvals are rolled back.
begin;
do $$
declare
  member jsonb; other_member jsonb; pending jsonb; restored jsonb; answer jsonb; person text;
  staff text:=encode(extensions.gen_random_bytes(32),'hex'); role_name text; ticket uuid:=gen_random_uuid();
  fixture text:=replace(gen_random_uuid()::text,'-','');
  menu_code text:='qa-store-'||fixture; menu_id uuid; hidden_menu_id uuid;
  public_staff uuid; hidden_staff uuid; inactive_staff uuid; starts timestamptz; hold_id uuid;
  booking_call text; own_client uuid; sale_id uuid; other_options jsonb;
begin
  update public.booking_settings set app_booking_enabled=true where id=1 and not app_booking_enabled;
  insert into app_private.staff_sessions(token_hash,expires_at) values(app_private.sha256_hex(staff),now()+interval '1 hour');
  member:=public.customer_register('Store access rollback fixture',true);person:=member->>'user_id';
  other_member:=public.customer_register('Private customer '||left(fixture,8),true);
  insert into public.tickets(id,user_id,type,title,issued_by) values(ticket,person,'cut-ticket','Store access fixture','qa');
  answer:=public.customer_store_access_status(member->>'session');
  if answer->>'verified' is distinct from 'false' then raise exception 'self registration granted access'; end if;

  insert into public.staff_members(display_name) values ('Public '||fixture) returning id into public_staff;
  insert into public.staff_members(display_name,is_bookable)
    values ('Staff only '||left(fixture,16),false) returning id into hidden_staff;
  insert into public.staff_members(display_name,is_active)
    values ('Inactive '||left(fixture,16),false) returning id into inactive_staff;
  insert into public.service_menus(code,name,duration_min,price,normal_price,is_active,booking_enabled)
    values (menu_code,'Public QA menu',30,4321,4500,true,true) returning id into menu_id;
  insert into public.service_menus(code,name,duration_min,price,is_active,booking_enabled)
    values (menu_code||'-internal','Staff-only QA menu',30,9876,true,true) returning id into hidden_menu_id;
  insert into public.staff_menu_capabilities(staff_id,menu_id)
    values (public_staff,menu_id),(hidden_staff,hidden_menu_id),(inactive_staff,hidden_menu_id);
  insert into public.staff_shift_templates(staff_id,weekday,start_time,end_time)
    select public_staff,d,'08:00','18:00' from generate_series(0,6) d;

  -- A signed-in customer may browse before QR approval. Check the full response shape
  -- and verify that staff-only rows and their menus are absent.
  answer:=public.customer_booking_options(member->>'session');
  if (answer ?& array['settings','menus','staff']) is distinct from true
    or (answer - array['settings','menus','staff']) is distinct from '{}'::jsonb
    or ((answer->'settings') ?& array['slot_minutes','booking_window_days','min_lead_minutes','hold_minutes']) is distinct from true
    or ((answer->'settings') - array['slot_minutes','booking_window_days','min_lead_minutes','hold_minutes']) is distinct from '{}'::jsonb
    or jsonb_typeof(answer->'menus') is distinct from 'array'
    or jsonb_typeof(answer->'staff') is distinct from 'array' then
    raise exception 'unexpected pre-verification catalog response';
  end if;
  if not exists(select 1 from jsonb_array_elements(answer->'menus') m where m->>'code'=menu_code and m->>'name'='Public QA menu' and m->'price'='4321'::jsonb)
    or not exists(select 1 from jsonb_array_elements(answer->'staff') s where s=jsonb_build_object('id',public_staff,'name','Public '||fixture))
    or exists(select 1 from jsonb_array_elements(answer->'menus') m where m->>'code'=menu_code||'-internal')
    or exists(select 1 from jsonb_array_elements(answer->'staff') s where s->>'id' in (hidden_staff::text,inactive_staff::text)) then
    raise exception 'pre-verification catalog visibility incorrect';
  end if;
  if exists(select 1 from jsonb_array_elements(answer->'menus') m
      where (m ?& array['code','name','duration_min','price','normal_price','price_from','maintenance']) is distinct from true
        or (m - array['code','name','duration_min','price','normal_price','price_from','maintenance']) is distinct from '{}'::jsonb)
    or exists(select 1 from jsonb_array_elements(answer->'staff') s
      where (s ?& array['id','name']) is distinct from true or (s - array['id','name']) is distinct from '{}'::jsonb) then
    raise exception 'catalog exposed a field outside its customer response contract';
  end if;
  raise notice 'pre-QR catalog fields and staff visibility ok';

  select a.starts_at into starts
  from generate_series(1,least(14,(select booking_window_days from public.booking_settings where id=1))) d
  cross join lateral app_private.available_slots(app_private.today_jst()+d,array[menu_code],public_staff,
    (select min_lead_minutes from public.booking_settings where id=1)) a
  order by a.starts_at limit 1;
  if starts is null then raise exception 'no valid slot for store access fixture'; end if;
  -- Seed a valid hold through the internal helper so the confirmation tests reach
  -- the auth gate even when the customer supplies a real hold they own.
  answer:=app_private.create_hold(starts,array[menu_code],public_staff,'app',person,0);
  hold_id:=(answer->>'hold_id')::uuid;
  if hold_id is null then raise exception 'could not seed a valid confirmation fixture'; end if;
  foreach booking_call in array array[
    'select public.customer_available_slots($1,$2,$4,$5)',
    'select public.customer_join_waitlist($1,$2,time ''08:00'',time ''18:00'',$4,$5)',
    'select public.customer_create_hold($1,$3,$4,$5)',
    'select public.customer_create_hold_for($1,$3,$4,$5,null)',
    'select public.customer_confirm_reservation($1,$6,null)',
    'select public.customer_confirm_for($1,$6,null)'
  ] loop
    begin
      execute booking_call using member->>'session',(starts at time zone 'Asia/Tokyo')::date,starts,array[menu_code],public_staff,hold_id;
      raise exception 'unverified session passed gate: %',booking_call;
    exception when insufficient_privilege then if sqlerrm<>'store_verification_required' then raise; end if; end;
  end loop;
  if (select count(*) from public.booking_holds where holder_user_id=person)<>1
    or not exists(select 1 from public.booking_holds where id=hold_id and released_at is null and converted_reservation_id is null)
    or exists(select 1 from public.reservations where user_id=person)
    or exists(select 1 from public.booking_waitlist where user_id=person) then
    raise exception 'pre-QR request changed booking state';
  end if;
  raise notice 'pre-QR slot lookup, waitlist, holds and confirmation rejected';
  pending:=public.customer_store_access_start(person,null);
  answer:=public.customer_store_access_claim((pending->>'id')::uuid,pending->>'proof');
  if answer->>'pending' is distinct from 'true' then raise exception 'request authorized itself'; end if;
  begin
    perform public.staff_approve_store_access('invalid',(pending->>'id')::uuid,person,'Fixture');
    raise exception 'invalid staff accepted';
  exception when invalid_authorization_specification then if sqlerrm<>'staff_auth_required' then raise; end if; end;
  perform public.staff_approve_store_access(staff,(pending->>'id')::uuid,person,'Fixture');
  answer:=public.customer_store_access_claim((pending->>'id')::uuid,repeat('0',64));
  if answer->>'error' is distinct from 'store_request_invalid' then raise exception 'QR without private browser proof accepted'; end if;
  restored:=public.customer_store_access_claim((pending->>'id')::uuid,pending->>'proof');
  if restored->>'user_id' is distinct from person or app_private.session_user_id(restored->>'session') is distinct from person then raise exception 'restored a different member'; end if;
  if not exists(select 1 from public.tickets where id=ticket and user_id=person) then raise exception 'ticket ownership changed'; end if;
  if public.customer_store_access_claim((pending->>'id')::uuid,pending->>'proof') is distinct from restored then raise exception 'network retry changed session'; end if;
  answer:=public.customer_confirm_for(restored->>'session',hold_id,null);
  if not exists(select 1 from public.reservations where id=(answer->>'id')::uuid and user_id=person and status='confirmed')
    or not exists(select 1 from public.booking_holds where id=hold_id and converted_reservation_id=(answer->>'id')::uuid) then
    raise exception 'QR-approved customer could not confirm the same hold: %',answer->>'error';
  end if;
  raise notice 'same valid hold confirms after QR approval';

  -- A real personal-price fixture proves that another signed-in customer still sees
  -- only the catalog price and receives no receipt or customer information.
  own_client:=app_private.user_client(person);
  if own_client is null then raise exception 'missing customer ledger fixture'; end if;
  insert into public.accounting_sessions(user_id,client_id,customer_name,staff_name,status,subtotal,total,payment_method)
    values(person,own_client,'Private receipt '||fixture,'Private operator '||fixture,'pending',5678,5678,'cash') returning id into sale_id;
  insert into public.accounting_session_items(session_id,item_name,category,price,source,ref_id)
    values(sale_id,'Public QA menu','menu',5678,'service_menu',menu_code);
  update public.accounting_sessions set status='completed',completed_at=now() where id=sale_id;
  answer:=public.customer_booking_options(restored->>'session');
  other_options:=public.customer_booking_options(other_member->>'session');
  if not exists(select 1 from jsonb_array_elements(answer->'menus') m where m->>'code'=menu_code and m->'price'='5678'::jsonb)
    or not exists(select 1 from jsonb_array_elements(other_options->'menus') m where m->>'code'=menu_code and m->'price'='4321'::jsonb)
    or strpos(other_options::text,person)>0 or strpos(other_options::text,own_client::text)>0 or strpos(other_options::text,sale_id::text)>0
    or strpos(other_options::text,'Private receipt '||fixture)>0 or strpos(other_options::text,'Private operator '||fixture)>0 then
    raise exception 'catalog leaked another customer''s data or personal price';
  end if;
  raise notice 'catalog personal price isolated to owning customer';
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'app_private.customer_store_requests','select') or has_table_privilege(role_name,'app_private.customer_store_verifications','insert') or has_table_privilege(role_name,'app_private.customer_store_limits','select') then raise exception 'public approval data access'; end if;
    if has_function_privilege(role_name,'app_private.store_original_customer_booking_options(text)','execute') or has_function_privilege(role_name,'app_private.require_store_verified(text)','execute') then raise exception 'public booking bypass'; end if;
    if has_table_privilege(role_name,'public.booking_holds','insert') or has_table_privilege(role_name,'public.reservations','insert')
      or has_function_privilege(role_name,'app_private.store_original_customer_create_hold(text,timestamptz,text[],uuid)','execute')
      or has_function_privilege(role_name,'app_private.store_original_customer_confirm_reservation(text,uuid,text)','execute') then raise exception 'customer can bypass booking RPCs'; end if;
  end loop;
  raise notice 'customer store access ok';
  raise notice 'store access grants ok';
end;
$$;
rollback;
