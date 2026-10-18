-- Staging rollout only. Store verification is independent from self-declared visit history or passkey possession.
create table app_private.customer_store_verifications (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  verified_at timestamptz not null default now(), verified_by text not null,
  staff_session_hash text not null
);
create table app_private.customer_store_requests (
  id uuid primary key default gen_random_uuid(), proof_hash text not null,
  customer_id uuid references public.customers(id) on delete cascade, original_user_id text not null,
  state text not null default 'pending' check(state in ('pending','approved','claimed')),
  expires_at timestamptz not null default now()+interval '5 minutes',
  approved_by text, staff_session_hash text, response_ciphertext bytea
);
create index customer_store_requests_expiry_idx on app_private.customer_store_requests(expires_at);
create table app_private.customer_store_limits (
  subject text not null, bucket timestamptz not null, hits integer not null default 1, primary key(subject,bucket)
);
alter table app_private.customer_store_verifications enable row level security;
alter table app_private.customer_store_requests enable row level security;
alter table app_private.customer_store_limits enable row level security;
revoke all on app_private.customer_store_verifications,app_private.customer_store_requests,app_private.customer_store_limits from public,anon,authenticated;

create function app_private.require_store_verified(p_session text)
returns text language plpgsql security definer set search_path='' as $$
declare uid text;
begin
  uid:=app_private.session_user_id(p_session);
  if not exists(select 1 from app_private.customer_store_verifications v join public.customers c on c.id=v.customer_id where c.user_id=uid) then
    raise exception 'store_verification_required' using errcode='42501';
  end if;
  return uid;
end;
$$;
revoke all on function app_private.require_store_verified(text) from public,anon,authenticated;

create function public.customer_store_access_status(p_session text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid text;
begin
  uid:=app_private.session_user_id(p_session);
  return jsonb_build_object('verified',exists(select 1 from app_private.customer_store_verifications v join public.customers c on c.id=v.customer_id where c.user_id=uid));
end;
$$;
revoke all on function public.customer_store_access_status(text) from public;
grant execute on function public.customer_store_access_status(text) to anon,authenticated,service_role;

create function public.customer_store_access_start(p_user_id text,p_session text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid text; cid uuid; proof text; request_id uuid; n integer;
begin
  -- A display-only legacy ID can request approval, never authorize or change a member by itself.
  if nullif(p_session,'') is not null then uid:=app_private.session_user_id(p_session); else uid:=p_user_id; end if;
  if uid is null or length(uid) not between 1 and 100 then raise exception 'invalid_request'; end if;
  delete from app_private.customer_store_requests where expires_at<now();
  delete from app_private.customer_store_limits where bucket<now()-interval '1 day';
  insert into app_private.customer_store_limits(subject,bucket) values('all',date_trunc('minute',now()))
    on conflict(subject,bucket) do update set hits=app_private.customer_store_limits.hits+1 returning hits into n;
  if n>200 then return '{"error":"rate_limited"}'; end if;
  insert into app_private.customer_store_limits(subject,bucket) values(app_private.sha256_hex(uid),date_trunc('hour',now()))
    on conflict(subject,bucket) do update set hits=app_private.customer_store_limits.hits+1 returning hits into n;
  if n>30 then return '{"error":"rate_limited"}'; end if;
  select id into cid from public.customers where user_id=uid;
  proof:=encode(extensions.gen_random_bytes(32),'hex');
  insert into app_private.customer_store_requests(proof_hash,customer_id,original_user_id)
    values(app_private.sha256_hex(proof),cid,uid) returning id into request_id;
  -- Unknown and known legacy IDs return the same shape, without exposing names or phone numbers.
  return jsonb_build_object('id',request_id,'proof',proof,'user_id',uid,'expires_in',300);
end;
$$;
revoke all on function public.customer_store_access_start(text,text) from public;
grant execute on function public.customer_store_access_start(text,text) to anon,authenticated,service_role;

create function public.staff_approve_store_access(p_staff text,p_request_id uuid,p_user_id text,p_staff_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r app_private.customer_store_requests; c public.customers;
begin
  perform app_private.assert_staff(p_staff);
  if nullif(btrim(p_staff_name),'') is null or length(p_staff_name)>100 then raise exception 'staff_name_required'; end if;
  select * into r from app_private.customer_store_requests where id=p_request_id and expires_at>now() for update;
  select * into c from public.customers where id=r.customer_id for update;
  if r.id is null or c.id is null or c.user_id is distinct from r.original_user_id or c.user_id is distinct from p_user_id then raise exception 'store_request_invalid'; end if;
  if r.state in ('approved','claimed') then return '{"ok":true}'; end if;
  insert into app_private.customer_store_verifications(customer_id,verified_by,staff_session_hash)
    values(c.id,btrim(p_staff_name),app_private.sha256_hex(p_staff)) on conflict(customer_id) do nothing;
  update app_private.customer_store_requests set state='approved',approved_by=btrim(p_staff_name),staff_session_hash=app_private.sha256_hex(p_staff) where id=r.id;
  return '{"ok":true}';
end;
$$;
revoke all on function public.staff_approve_store_access(text,uuid,text,text) from public;
grant execute on function public.staff_approve_store_access(text,uuid,text,text) to anon,authenticated,service_role;

create function public.customer_store_access_claim(p_request_id uuid,p_proof text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r app_private.customer_store_requests; c public.customers; token text; answer jsonb;
begin
  if coalesce(p_proof,'') !~ '^[0-9a-f]{64}$' then return '{"error":"store_request_invalid"}'; end if;
  select * into r from app_private.customer_store_requests where id=p_request_id and proof_hash=app_private.sha256_hex(p_proof) and expires_at>now() for update;
  if r.id is null then return '{"error":"store_request_invalid"}'; end if;
  if r.state='pending' then return '{"pending":true}'; end if;
  select * into c from public.customers where id=r.customer_id for update;
  if c.id is null or c.user_id is distinct from r.original_user_id or not exists(select 1 from app_private.customer_store_verifications where customer_id=c.id) then return '{"error":"store_request_invalid"}'; end if;
  if r.state='claimed' then
    -- Safe network retry: same browser proof, same response, no additional session or customer.
    answer:=extensions.pgp_sym_decrypt(r.response_ciphertext,p_proof)::jsonb;
    perform app_private.session_user_id(answer->>'session');
    return answer;
  end if;
  if not exists(select 1 from app_private.staff_sessions where token_hash=r.staff_session_hash and revoked_at is null and expires_at>now()) then return '{"error":"store_request_invalid"}'; end if;
  token:=app_private.new_customer_session(c.user_id,'store_verified');
  answer:=jsonb_build_object('user_id',c.user_id,'name',c.name,'session',token);
  update app_private.customer_store_requests set state='claimed',response_ciphertext=extensions.pgp_sym_encrypt(answer::text,p_proof,'cipher-algo=aes256') where id=r.id;
  return answer;
end;
$$;
revoke all on function public.customer_store_access_claim(uuid,text) from public;
grant execute on function public.customer_store_access_claim(uuid,text) to anon,authenticated,service_role;

-- Keep the current booking engine intact; preserve defaults, signatures, and results.
-- Original implementations move to the private schema and lose all client execute privileges.
-- Public wrappers need SECURITY DEFINER because anon has no USAGE on app_private.
do $migration$
declare f record; original_name text; args text; call_args text; result_type text; guarded integer:=0;
begin
  for f in select p.oid,p.proname,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('customer_booking_options','customer_available_slots','customer_next_slots','customer_day_overview','customer_create_hold','customer_confirm_reservation') order by p.proname loop
    original_name:='store_original_'||f.proname;
    guarded:=guarded+1;
    args:=pg_get_function_arguments(f.oid); result_type:=pg_get_function_result(f.oid);
    if result_type not in ('json','jsonb') then raise exception 'unexpected booking result: %',f.proname; end if;
    select string_agg('$'||i,',' order by i) into call_args from generate_series(1,f.pronargs) i;
    execute format('alter function %s rename to %I',f.oid::regprocedure,original_name);
    execute format('alter function %s set schema app_private',f.oid::regprocedure);
    execute format('revoke all on function %s from public,anon,authenticated',f.oid::regprocedure);
    execute format('create function public.%I(%s) returns %s language plpgsql security definer set search_path='''' as $wrapper$ begin perform app_private.require_store_verified(p_session); return app_private.%I(%s); end; $wrapper$',f.proname,args,result_type,original_name,call_args);
    execute format('revoke all on function public.%I(%s) from public',f.proname,pg_get_function_identity_arguments(f.oid));
    execute format('grant execute on function public.%I(%s) to anon,authenticated,service_role',f.proname,pg_get_function_identity_arguments(f.oid));
  end loop;
  if guarded<>6 then raise exception 'expected six booking entry points, found %',guarded; end if;
end;
$migration$;

-- Never infer verification from customers.has_visited_before (self-declared) or a locally displayed ID.
-- Identity moves performed by legacy recovery must not carry a store approval to a different identity.
create function app_private.store_verification_on_member_move()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.user_id is distinct from old.user_id then
    delete from app_private.customer_store_verifications where customer_id=old.id;
    delete from app_private.customer_store_requests where customer_id=old.id;
  end if;
  return new;
end;
$$;
revoke all on function app_private.store_verification_on_member_move() from public,anon,authenticated;
create trigger store_verification_on_member_move before update of user_id on public.customers for each row execute function app_private.store_verification_on_member_move();
