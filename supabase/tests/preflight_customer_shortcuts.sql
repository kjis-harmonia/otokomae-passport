begin;
do $$
declare
  m jsonb; other jsonb; r jsonb; p jsonb; booked jsonb;
  token text:='gjsc_'||repeat('A',43); other_token text:='gjsc_'||repeat('B',43);
  v_staff uuid; v_menu uuid; v_code text:='shortcut-'||substr(gen_random_uuid()::text,1,8);
  v_start timestamptz:=date_trunc('hour',now()+interval '3 hours'); denied boolean:=false;
begin
  m:=public.customer_register('ショートカット検証',true)::jsonb;
  other:=public.customer_register('ショートカット別会員',true)::jsonb;
  r:=public.customer_set_contact(m->>'session','検証本名','09000000000')::jsonb;
  if r ? 'error' then raise exception 'contact setup failed'; end if;
  r:=public.shortcut_pair_device(m->>'session',token,'v1.'||repeat('x',80));
  if not(r ? 'device_id') then raise exception 'pair failed'; end if;
  r:=public.shortcut_pair_device(other->>'session',other_token,'v1.'||repeat('x',80));
  if not(r ? 'device_id') then raise exception 'other pair failed'; end if;
  if exists(select 1 from app_private.shortcut_devices where token_hash=token) then raise exception 'raw token persisted'; end if;
  insert into public.maintenance_visits(user_id,last_visit_date) values(m->>'user_id',app_private.today_jst()-3);
  r:=public.shortcut_auth_device(token);
  if (r->>'days_remaining')::int<>11 then raise exception 'maintenance counter mismatch'; end if;
  insert into public.staff_members(display_name,booking_capacity) values('検証ショートカット',3) returning id into v_staff;
  insert into public.service_menus(code,name,duration_min,price,is_active,booking_enabled) values(v_code,'検証カット',30,5000,false,false) returning id into v_menu;
  insert into public.staff_menu_capabilities(staff_id,menu_id) values(v_staff,v_menu);
  update public.service_menus set is_active=true,booking_enabled=true where id=v_menu;
  insert into public.staff_shift_templates(staff_id,weekday,start_time,end_time) select v_staff,i,'00:00'::time,'23:59'::time from generate_series(0,6) i;
  p:=public.shortcut_prepare_booking(token,m->>'session',v_start,v_code,v_staff);
  if not(p ? 'proposal_id') or (p->'quote'->>'total_price')::int<>5000 then raise exception 'preview failed: %',p->>'error'; end if;
  if exists(select 1 from public.reservations where staff_id=v_staff) then raise exception 'preview committed a booking'; end if;
  r:=public.shortcut_confirm_booking(other_token,other->>'session',(p->>'proposal_id')::uuid);
  if r->>'error' is distinct from 'proposal_not_found' then raise exception 'foreign device accepted'; end if;
  update public.service_menus set price=6000 where id=v_menu;
  r:=public.shortcut_confirm_booking(token,m->>'session',(p->>'proposal_id')::uuid);
  if r->>'error' is distinct from 'quote_changed' then raise exception 'changed price accepted'; end if;
  update public.service_menus set price=5000 where id=v_menu;
  booked:=public.shortcut_confirm_booking(token,m->>'session',(p->>'proposal_id')::uuid);
  if not(booked ? 'id') or booked ? 'error' then raise exception 'confirmation failed: %',booked->>'error'; end if;
  r:=public.shortcut_confirm_booking(token,m->>'session',(p->>'proposal_id')::uuid);
  if r->>'id' is distinct from booked->>'id' or r->>'idempotent' is distinct from 'true' then raise exception 'confirmation replay mismatch'; end if;
  if (select count(*) from public.reservations where staff_id=v_staff)<>1 then raise exception 'duplicate booking'; end if;
  if not exists(select 1 from public.reservations where staff_id=v_staff and customer_name='検証本名' and source='app') then raise exception 'canonical member booking missing'; end if;
  if has_function_privilege('anon','public.shortcut_auth_device(text)','execute')
    or has_function_privilege('authenticated','public.shortcut_confirm_booking(text,text,uuid)','execute')
    or has_table_privilege('anon','app_private.shortcut_devices','select') then raise exception 'private access allowed'; end if;
  perform public.customer_revoke_shortcut_devices(m->>'session');
  begin perform public.shortcut_auth_device(token); exception when sqlstate '28000' then denied:=true; end;
  if not denied then raise exception 'revocation failed'; end if;
end $$;
rollback;
select 'shortcut preflight ok: pairing, maintenance, quote validation, explicit confirmation, replay, ownership, grants, revocation; rolled back' as result;
