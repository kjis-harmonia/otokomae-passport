-- Disposable DB or Staging only. Every change below is rolled back.
begin;
do $$
declare
  member jsonb; answer jsonb; login jsonb; cid text:=encode(extensions.gen_random_bytes(32),'hex'); challenge_id uuid:=gen_random_uuid();
  person text; moved_person text; role_name text;
begin
  member:=public.customer_register('Passkey rollback fixture',true);
  person:=member->>'user_id';
  answer:=public.customer_passkey_service('register_context',jsonb_build_object('session',member->>'session'));
  if answer->>'user_id'<>person then raise exception 'wrong member context'; end if;
  perform public.customer_passkey_service('put_challenge',jsonb_build_object('id',challenge_id,'kind','register','challenge',repeat('x',43),'session',member->>'session'));
  answer:=public.customer_passkey_service('consume_challenge',jsonb_build_object('id',challenge_id,'kind','register','session',member->>'session'));
  if answer->>'user_id'<>person then raise exception 'wrong challenge binding'; end if;
  begin
    perform public.customer_passkey_service('consume_challenge',jsonb_build_object('id',challenge_id,'kind','register','session',member->>'session'));
    raise exception 'replay accepted';
  exception when others then if sqlerrm<>'invalid_challenge' then raise; end if; end;
  perform public.customer_passkey_service('finish_register',jsonb_build_object('session',member->>'session','credential_id',cid,'public_key',repeat('x',64),'counter',1,'transports','[]'::jsonb));
  login:=public.customer_passkey_service('finish_login',jsonb_build_object('credential_id',cid,'old_counter',1,'new_counter',2));
  if login->>'user_id'<>person or app_private.session_user_id(login->>'session')<>person then raise exception 'wrong restored member'; end if;
  begin
    perform public.customer_passkey_service('finish_login',jsonb_build_object('credential_id',cid,'old_counter',1,'new_counter',2));
    raise exception 'counter race accepted';
  exception when others then if sqlerrm<>'passkey_auth_failed' then raise; end if; end;
  foreach role_name in array array['anon','authenticated'] loop
    if has_function_privilege(role_name,'public.customer_passkey_service(text,jsonb)','execute') or has_function_privilege(role_name,'app_private.customer_passkey_service(text,jsonb)','execute') then raise exception 'public service access'; end if;
    if has_table_privilege(role_name,'app_private.customer_passkeys','select') or has_table_privilege(role_name,'app_private.customer_passkey_challenges','select') or has_table_privilege(role_name,'app_private.customer_passkey_identities','select') or has_table_privilege(role_name,'app_private.customer_passkey_limits','select') then raise exception 'public credential access'; end if;
  end loop;
  perform public.customer_passkey_service('revoke',jsonb_build_object('session',login->>'session'));
  if exists(select 1 from app_private.customer_sessions where user_id=person and revoked_at is null) then raise exception 'session survived revocation'; end if;
  member:=public.customer_register('Passkey legacy move fixture',true);
  person:=member->>'user_id'; moved_person:='passkey-moved-'||gen_random_uuid()::text; cid:=encode(extensions.gen_random_bytes(32),'hex');
  perform public.customer_passkey_service('register_context',jsonb_build_object('session',member->>'session'));
  perform public.customer_passkey_service('finish_register',jsonb_build_object('session',member->>'session','credential_id',cid,'public_key',repeat('x',64),'counter',0));
  update public.customers set user_id=moved_person where user_id=person;
  if not exists(select 1 from app_private.customer_passkeys where credential_id=cid and user_id=moved_person and revoked_at is not null) then raise exception 'legacy member move blocked or old passkey remained active'; end if;
  if exists(select 1 from app_private.customer_sessions where user_id=person and revoked_at is null) then raise exception 'old member session survived identity move'; end if;
  raise notice 'customer passkeys ok';
  raise notice 'passkey grants ok';
end;
$$;
rollback;
