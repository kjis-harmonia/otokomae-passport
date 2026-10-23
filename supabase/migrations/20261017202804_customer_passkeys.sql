-- Customer passkeys. Staging rollout only; existing customer sessions stay valid.
create table if not exists app_private.customer_passkey_identities (
  user_id text primary key references public.customers(user_id) on update cascade on delete cascade,
  handle text not null unique default encode(extensions.gen_random_bytes(32),'hex')
);
create table if not exists app_private.customer_passkeys (
  credential_id text primary key check(length(credential_id) between 16 and 2048),
  user_id text not null references app_private.customer_passkey_identities(user_id) on update cascade on delete cascade,
  public_key text not null check(length(public_key) between 16 and 8192),
  counter bigint not null check(counter>=0),
  transports jsonb not null default '[]',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists customer_passkeys_user_idx on app_private.customer_passkeys(user_id) where revoked_at is null;
create table if not exists app_private.customer_passkey_challenges (
  id uuid primary key,
  kind text not null check(kind in ('register','login')),
  challenge text not null check(length(challenge) between 32 and 128),
  user_id text references app_private.customer_passkey_identities(user_id) on update cascade on delete cascade,
  session_hash text,
  expires_at timestamptz not null default now()+interval '3 minutes'
);
create index if not exists customer_passkey_challenges_expiry_idx on app_private.customer_passkey_challenges(expires_at);
create table if not exists app_private.customer_passkey_limits (
  subject text not null,
  bucket timestamptz not null,
  hits integer not null default 1,
  primary key(subject,bucket)
);
create index if not exists customer_passkey_limits_expiry_idx on app_private.customer_passkey_limits(bucket);
alter table app_private.customer_passkey_identities enable row level security;
alter table app_private.customer_passkeys enable row level security;
alter table app_private.customer_passkey_challenges enable row level security;
alter table app_private.customer_passkey_limits enable row level security;
revoke all on app_private.customer_passkey_identities, app_private.customer_passkeys, app_private.customer_passkey_challenges, app_private.customer_passkey_limits from public,anon,authenticated;

-- Legacy staff-assisted recovery changes a customer's user_id. Do not block it,
-- and do not let an authenticator from the former identity sign back in afterward.
create or replace function app_private.customer_passkeys_on_member_move()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update app_private.customer_passkeys set revoked_at=now() where user_id in (old.user_id,new.user_id) and revoked_at is null;
  delete from app_private.customer_passkey_challenges where user_id in (old.user_id,new.user_id);
  update app_private.customer_sessions set revoked_at=now() where user_id=old.user_id and revoked_at is null;
  return new;
end;
$$;
revoke all on function app_private.customer_passkeys_on_member_move() from public,anon,authenticated;
drop trigger if exists customer_passkeys_member_move on public.customers;
create trigger customer_passkeys_member_move before update of user_id on public.customers
for each row when(old.user_id is distinct from new.user_id) execute function app_private.customer_passkeys_on_member_move();

create or replace function app_private.customer_passkey_service(p_action text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uid text; member_name text; ch app_private.customer_passkey_challenges;
  credential app_private.customer_passkeys; session_row app_private.customer_sessions;
  n integer; token text; result jsonb;
begin
  if p_action='limit' then
    if coalesce(p_input->>'subject','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request'; end if;
    delete from app_private.customer_passkey_limits where bucket<now()-interval '5 minutes';
    delete from app_private.customer_passkey_challenges where expires_at<now();
    insert into app_private.customer_passkey_limits(subject,bucket) values(p_input->>'subject',date_trunc('minute',now()))
    on conflict(subject,bucket) do update set hits=app_private.customer_passkey_limits.hits+1 returning hits into n;
    return jsonb_build_object('allowed',n<=30);
  end if;
  if p_action in ('status','register_context','finish_register','revoke') then
    uid:=app_private.session_user_id(p_input->>'session');
    select name into member_name from public.customers where user_id=uid;
    if not found then raise exception 'customer_auth_required' using errcode='28000'; end if;
  end if;
  if p_action='status' then
    return jsonb_build_object('user_id',uid,'name',member_name,'registered',exists(select 1 from app_private.customer_passkeys where user_id=uid and revoked_at is null));
  elsif p_action='register_context' then
    -- Serialize first enrollment, without changing any customer or ticket data.
    insert into app_private.customer_passkey_identities(user_id) values(uid) on conflict do nothing;
    perform 1 from app_private.customer_passkey_identities where user_id=uid for update;
    if exists(select 1 from app_private.customer_passkeys where user_id=uid and revoked_at is null) then raise exception 'already_registered'; end if;
    return jsonb_build_object('user_id',uid,'name',member_name,'handle',(select handle from app_private.customer_passkey_identities where user_id=uid));
  elsif p_action='put_challenge' then
    if p_input->>'kind'='register' then uid:=app_private.session_user_id(p_input->>'session'); end if;
    insert into app_private.customer_passkey_challenges(id,kind,challenge,user_id,session_hash)
    values((p_input->>'id')::uuid,p_input->>'kind',p_input->>'challenge',uid,case when uid is not null then app_private.sha256_hex(p_input->>'session') end);
    return '{"ok":true}';
  elsif p_action='consume_challenge' then
    delete from app_private.customer_passkey_challenges
    where id=(p_input->>'id')::uuid and kind=p_input->>'kind' and expires_at>now()
      and (kind='login' or session_hash=app_private.sha256_hex(p_input->>'session')) returning * into ch;
    if ch.id is null then raise exception 'invalid_challenge'; end if;
    if ch.kind='register' and app_private.session_user_id(p_input->>'session')<>ch.user_id then raise exception 'customer_auth_required'; end if;
    return to_jsonb(ch)-'session_hash';
  elsif p_action='credential' then
    select * into credential from app_private.customer_passkeys where credential_id=p_input->>'credential_id' and revoked_at is null;
    if credential.credential_id is null then raise exception 'passkey_auth_failed'; end if;
    return (to_jsonb(credential)-'created_at'-'last_used_at'-'revoked_at')||jsonb_build_object('handle',(select handle from app_private.customer_passkey_identities where user_id=credential.user_id));
  elsif p_action='finish_register' then
    perform 1 from app_private.customer_passkey_identities where user_id=uid for update;
    if not found or exists(select 1 from app_private.customer_passkeys where user_id=uid and revoked_at is null) then raise exception 'already_registered'; end if;
    insert into app_private.customer_passkeys(credential_id,user_id,public_key,counter,transports)
    values(p_input->>'credential_id',uid,p_input->>'public_key',(p_input->>'counter')::bigint,coalesce(p_input->'transports','[]'));
    return '{"ok":true}';
  elsif p_action='finish_login' then
    select * into credential from app_private.customer_passkeys where credential_id=p_input->>'credential_id' and revoked_at is null for update;
    if credential.credential_id is null or credential.counter<>(p_input->>'old_counter')::bigint
      or ((credential.counter>0 or (p_input->>'new_counter')::bigint>0) and (p_input->>'new_counter')::bigint<=credential.counter)
      then raise exception 'passkey_auth_failed'; end if;
    select name into member_name from public.customers where user_id=credential.user_id;
    if not found then raise exception 'passkey_auth_failed'; end if;
    update app_private.customer_passkeys set counter=(p_input->>'new_counter')::bigint,last_used_at=now() where credential_id=credential.credential_id;
    token:=app_private.new_customer_session(credential.user_id,'passkey');
    return jsonb_build_object('user_id',credential.user_id,'name',member_name,'session',token);
  elsif p_action='revoke' then
    select * into session_row from app_private.customer_sessions where token_hash=app_private.sha256_hex(p_input->>'session') and revoked_at is null;
    if session_row.created_via<>'passkey' or session_row.created_at<now()-interval '5 minutes' then raise exception 'fresh_passkey_required'; end if;
    update app_private.customer_passkeys set revoked_at=now() where user_id=uid and revoked_at is null;
    delete from app_private.customer_passkey_challenges where user_id=uid;
    update app_private.customer_sessions set revoked_at=now() where user_id=uid and revoked_at is null;
    return '{"ok":true}';
  end if;
  raise exception 'invalid_action';
end;
$$;
revoke all on function app_private.customer_passkey_service(text,jsonb) from public,anon,authenticated;
grant usage on schema app_private to service_role;
grant execute on function app_private.customer_passkey_service(text,jsonb) to service_role;
create or replace function public.customer_passkey_service(p_action text,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select app_private.customer_passkey_service(p_action,p_input)
$$;
revoke all on function public.customer_passkey_service(text,jsonb) from public,anon,authenticated;
grant execute on function public.customer_passkey_service(text,jsonb) to service_role;
