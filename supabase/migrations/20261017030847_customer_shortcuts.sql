-- Scoped iPhone Shortcuts credentials. Existing customer sessions and Johnny stay unchanged.
create table if not exists app_private.shortcut_devices (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  parent_session_hash text not null references app_private.customer_sessions(token_hash) on delete cascade,
  token_hash text not null unique,
  session_ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '30 days'),
  revoked_at timestamptz,
  request_window timestamptz not null default now(),
  request_count integer not null default 0
);
create index if not exists shortcut_devices_owner_idx on app_private.shortcut_devices(user_id);
create table if not exists app_private.shortcut_proposals (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references app_private.shortcut_devices(id) on delete cascade,
  hold_id uuid not null references public.booking_holds(id) on delete cascade,
  quote jsonb not null,
  expires_at timestamptz not null,
  result jsonb,
  discarded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists shortcut_proposals_device_idx on app_private.shortcut_proposals(device_id);
alter table app_private.shortcut_devices enable row level security;
alter table app_private.shortcut_proposals enable row level security;
revoke all on app_private.shortcut_devices,app_private.shortcut_proposals from public,anon,authenticated;

create or replace function app_private.shortcut_device(p_token text) returns app_private.shortcut_devices
language plpgsql set search_path=pg_catalog,public,extensions,pg_temp as $$
declare d app_private.shortcut_devices;
begin
  if p_token is null or p_token !~ '^gjsc_[A-Za-z0-9_-]{43}$' then
    raise exception 'shortcut_auth_required' using errcode='28000';
  end if;
  select x.* into d from app_private.shortcut_devices x
  join app_private.customer_sessions s on s.token_hash=x.parent_session_hash and s.user_id=x.user_id
  where x.token_hash=app_private.sha256_hex(p_token) and x.revoked_at is null and x.expires_at>now() and s.revoked_at is null;
  if d.id is null then raise exception 'shortcut_auth_required' using errcode='28000'; end if;
  return d;
end $$;

-- Called only by the bridge, after encrypting the original session with its server-side key.
create or replace function public.shortcut_pair_device(p_session text,p_token text,p_ciphertext text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions,pg_temp as $$
declare uid text:=app_private.session_user_id(p_session); device uuid;
begin
  if p_token is null or p_token !~ '^gjsc_[A-Za-z0-9_-]{43}$' or p_ciphertext is null or length(p_ciphertext) not between 40 and 1024 then
    return jsonb_build_object('error','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('shortcut-pair:'||uid,0));
  if (select count(*) from app_private.shortcut_devices where user_id=uid and revoked_at is null and expires_at>now())>=5 then
    return jsonb_build_object('error','too_many_devices');
  end if;
  insert into app_private.shortcut_devices(user_id,parent_session_hash,token_hash,session_ciphertext)
  values(uid,app_private.sha256_hex(p_session),app_private.sha256_hex(p_token),p_ciphertext) returning id into device;
  return jsonb_build_object('device_id',device,'expires_at',now()+interval '30 days');
end $$;

create or replace function public.customer_revoke_shortcut_devices(p_session text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions,pg_temp as $$
declare uid text:=app_private.session_user_id(p_session); n integer;
begin
  update app_private.shortcut_devices set revoked_at=now() where user_id=uid and revoked_at is null;
  get diagnostics n=row_count;
  update public.booking_holds h set released_at=coalesce(h.released_at,now())
  where h.converted_reservation_id is null and exists(select 1 from app_private.shortcut_proposals p
    join app_private.shortcut_devices d on d.id=p.device_id where d.user_id=uid and p.hold_id=h.id and p.result is null);
  return jsonb_build_object('ok',true,'revoked',n);
end $$;

create or replace function public.shortcut_auth_device(p_token text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions,pg_temp as $$
declare d app_private.shortcut_devices:=app_private.shortcut_device(p_token); v_day date; next_booking jsonb;
begin
  select * into d from app_private.shortcut_devices where id=d.id for update;
  if d.request_window<=now()-interval '1 minute' then d.request_window:=now(); d.request_count:=0; end if;
  if d.request_count>=20 then return jsonb_build_object('error','rate_limited'); end if;
  update app_private.shortcut_devices set request_window=d.request_window,request_count=d.request_count+1 where id=d.id;
  select last_visit_date into v_day from public.maintenance_visits where user_id=d.user_id;
  select jsonb_build_object('starts_at',r.starts_at,'staff_name',s.display_name,'status',r.status) into next_booking
  from public.reservations r join public.staff_members s on s.id=r.staff_id
  where r.user_id=d.user_id and r.status in ('confirmed','checked_in','in_service','awaiting_payment') and r.ends_at>now()
  order by r.starts_at limit 1;
  return jsonb_build_object('device_id',d.id,'session_ciphertext',d.session_ciphertext,'last_visit_date',v_day,
    'days_remaining',case when v_day is not null then 14-(app_private.today_jst()-v_day) end,'next_booking',next_booking);
end $$;

create or replace function public.shortcut_prepare_booking(p_token text,p_session text,p_starts_at timestamptz,p_menu_code text,p_staff_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions,pg_temp as $$
declare d app_private.shortcut_devices:=app_private.shortcut_device(p_token); h public.booking_holds;
  uid text:=app_private.session_user_id(p_session); c public.customers; held jsonb; plan jsonb; quote jsonb; proposal uuid;
begin
  if app_private.sha256_hex(p_session)<>d.parent_session_hash or uid<>d.user_id then raise exception 'shortcut_auth_required' using errcode='28000'; end if;
  select * into c from public.customers where user_id=uid;
  if nullif(btrim(c.contact_name),'') is null or nullif(btrim(c.contact_phone),'') is null then return jsonb_build_object('error','contact_required'); end if;
  held:=public.customer_create_hold(p_session,p_starts_at,array[p_menu_code],p_staff_id)::jsonb;
  if held ? 'error' then return held; end if;
  select * into h from public.booking_holds where id=(held->>'hold_id')::uuid;
  plan:=app_private.booking_plan(h.staff_id,h.menu_codes);
  quote:=jsonb_build_object('starts_at',h.starts_at,'ends_at',h.ends_at,'staff_id',h.staff_id,
    'staff_name',(select display_name from public.staff_members where id=h.staff_id),'nominated',h.nominated,
    'items',plan->'items','total_price',plan->'total_price','expires_at',h.expires_at);
  insert into app_private.shortcut_proposals(device_id,hold_id,quote,expires_at) values(d.id,h.id,quote,h.expires_at) returning id into proposal;
  return jsonb_build_object('proposal_id',proposal,'quote',quote);
end $$;

create or replace function public.shortcut_confirm_booking(p_token text,p_session text,p_proposal_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions,pg_temp as $$
declare d app_private.shortcut_devices:=app_private.shortcut_device(p_token); p app_private.shortcut_proposals;
  uid text:=app_private.session_user_id(p_session); h public.booking_holds; plan jsonb; v_result jsonb;
begin
  if app_private.sha256_hex(p_session)<>d.parent_session_hash or uid<>d.user_id then raise exception 'shortcut_auth_required' using errcode='28000'; end if;
  -- Lock in the same order as customer booking code before taking proposal/hold locks.
  perform app_private.lock_all_staff();
  select * into p from app_private.shortcut_proposals where id=p_proposal_id and device_id=d.id for update;
  if p.id is null then return jsonb_build_object('error','proposal_not_found'); end if;
  if p.result is not null then return p.result||jsonb_build_object('idempotent',true); end if;
  if p.discarded_at is not null or p.expires_at<=now() then return jsonb_build_object('error','proposal_expired'); end if;
  select * into h from public.booking_holds where id=p.hold_id;
  plan:=app_private.booking_plan(h.staff_id,h.menu_codes);
  if plan is null or plan->'items' is distinct from p.quote->'items' or plan->'total_price' is distinct from p.quote->'total_price' then
    return jsonb_build_object('error','quote_changed');
  end if;
  v_result:=public.customer_confirm_reservation(p_session,p.hold_id,null)::jsonb;
  if v_result ? 'error' then return v_result; end if;
  update app_private.shortcut_proposals set result=v_result where id=p.id;
  return v_result;
end $$;

revoke all on function app_private.shortcut_device(text) from public,anon,authenticated;
revoke all on function public.shortcut_pair_device(text,text,text),public.shortcut_auth_device(text),
  public.shortcut_prepare_booking(text,text,timestamptz,text,uuid),public.shortcut_confirm_booking(text,text,uuid) from public,anon,authenticated;
grant execute on function public.shortcut_pair_device(text,text,text),public.shortcut_auth_device(text),
  public.shortcut_prepare_booking(text,text,timestamptz,text,uuid),public.shortcut_confirm_booking(text,text,uuid) to service_role;
revoke all on function public.customer_revoke_shortcut_devices(text) from public;
grant execute on function public.customer_revoke_shortcut_devices(text) to anon,authenticated;
