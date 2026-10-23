-- Disposable DB or Staging only. All fixtures and approvals are rolled back.
begin;
do $$
declare
  member jsonb; pending jsonb; restored jsonb; answer jsonb; person text;
  staff text:=encode(extensions.gen_random_bytes(32),'hex'); role_name text; ticket uuid:=gen_random_uuid();
begin
  insert into app_private.staff_sessions(token_hash,expires_at) values(app_private.sha256_hex(staff),now()+interval '1 hour');
  member:=public.customer_register('Store access rollback fixture',true);person:=member->>'user_id';
  insert into public.tickets(id,user_id,type,title,issued_by) values(ticket,person,'cut-ticket','Store access fixture','qa');
  answer:=public.customer_store_access_status(member->>'session');
  if answer->>'verified' is distinct from 'false' then raise exception 'self registration granted access'; end if;
  begin
    perform public.customer_booking_options(member->>'session');
    raise exception 'unverified booking accepted';
  exception when insufficient_privilege then if sqlerrm<>'store_verification_required' then raise; end if; end;
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
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'app_private.customer_store_requests','select') or has_table_privilege(role_name,'app_private.customer_store_verifications','insert') or has_table_privilege(role_name,'app_private.customer_store_limits','select') then raise exception 'public approval data access'; end if;
    if has_function_privilege(role_name,'app_private.store_original_customer_booking_options(text)','execute') or has_function_privilege(role_name,'app_private.require_store_verified(text)','execute') then raise exception 'public booking bypass'; end if;
  end loop;
  raise notice 'customer store access ok';
  raise notice 'store access grants ok';
end;
$$;
rollback;
