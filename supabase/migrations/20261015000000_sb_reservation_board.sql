-- Staff-only reservation board. No money RPC, AI, or operation-registry changes.
-- Existing customer/legacy booking paths remain conservative (one appointment).
-- Capacity is explicitly configured by HQ; migration never increases reception.

alter table public.staff_members add column if not exists booking_capacity smallint not null default 1
  check (booking_capacity between 1 and 3);
alter table public.reservations add column if not exists booking_lane smallint not null default 0
  check (booking_lane between 0 and 2);
alter table public.reservations add column if not exists transfer_status text not null default 'pending'
  check (transfer_status in ('pending', 'done', 'not_required'));

alter table public.reservations drop constraint if exists reservations_no_overlap;
alter table public.reservations add constraint reservations_no_overlap exclude using gist (
  staff_id with =, booking_lane with =, tstzrange(starts_at, occupied_until) with &&
) where (status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'));

alter table public.reservation_events drop constraint if exists reservation_events_event_type_check;
alter table public.reservation_events add constraint reservation_events_event_type_check check (event_type in (
  'created','rescheduled','staff_changed','staff_confirmed','cancelled','checked_in','in_service',
  'awaiting_payment','completed','no_show','edited','transfer_updated'
));

create table if not exists app_private.sb_requests (
  request_id uuid primary key,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now()
);
alter table app_private.sb_requests enable row level security;
revoke all on app_private.sb_requests from public, anon, authenticated, service_role;

create or replace function app_private.sb_capacity_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if new.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
     and new.occupied_until > now()
     and new.booking_lane >= (select booking_capacity from public.staff_members where id = new.staff_id) then
    raise exception 'booking_capacity_exceeded' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists sb_capacity_guard on public.reservations;
create trigger sb_capacity_guard before insert or update on public.reservations
for each row execute function app_private.sb_capacity_guard();

-- Holds made by the existing customer engine reserve lane zero. That engine
-- still requires the whole stylist to be free; SB must respect its live hold.
create or replace function app_private.sb_free_lane(p_staff uuid, p_start timestamptz, p_until timestamptz, p_exclude uuid default null)
returns smallint language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select l::smallint from public.staff_members s
  cross join lateral generate_series(0, s.booking_capacity - 1) l
  where s.id = p_staff and s.is_active and s.is_bookable and p_until > p_start
    and exists (select 1 from app_private.effective_shifts(s.id, (p_start at time zone 'Asia/Tokyo')::date) sh
                where sh.st <= p_start and sh.en >= p_until)
    and not exists (select 1 from public.time_blocks b where (b.staff_id = s.id or b.staff_id is null)
                    and tstzrange(b.starts_at,b.ends_at) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.reservations r where r.staff_id = s.id and r.booking_lane = l
                    and r.id is distinct from p_exclude
                    and r.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
                    and tstzrange(r.starts_at,r.occupied_until) && tstzrange(p_start,p_until))
    and (l <> 0 or not exists (select 1 from public.booking_holds h where h.staff_id = s.id
                    and h.released_at is null and h.converted_reservation_id is null and h.expires_at > now()
                    and tstzrange(h.starts_at,h.occupied_until) && tstzrange(p_start,p_until)))
  order by l limit 1
$$;

create or replace function app_private.sb_reservation(p_id uuid)
returns jsonb language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select app_private.reservation_json(r.id) || jsonb_build_object(
    'booking_lane',r.booking_lane,'transfer_status',r.transfer_status,'updated_at',r.updated_at)
  from public.reservations r where r.id = p_id
$$;

create or replace function app_private.sb_options()
returns jsonb language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select app_private.booking_options_json()::jsonb || jsonb_build_object(
    'actors', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name) order by sort_order,display_name),'[]')
               from public.staff_members where is_active),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name,'capacity',booking_capacity)
                         order by sort_order,display_name),'[]') from public.staff_members where is_active and is_bookable),
    'menus', (select coalesce(jsonb_agg(m.item || jsonb_build_object('category',s.category,'price_from',s.price_from)
                         order by s.sort_order,s.name),'[]')
              from jsonb_array_elements(app_private.booking_options_json()::jsonb->'menus') m(item)
              join public.service_menus s on s.code = m.item->>'code'))
$$;

create or replace function app_private.sb_ledger(p_date date)
returns jsonb language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select app_private.day_ledger_json(p_date)::jsonb || jsonb_build_object(
    'staff', (select coalesce(jsonb_agg(s.item || jsonb_build_object('capacity',m.booking_capacity)
                          order by s.ord),'[]')
              from jsonb_array_elements(app_private.day_ledger_json(p_date)::jsonb->'staff') with ordinality s(item,ord)
              join public.staff_members m on m.id = (s.item->>'id')::uuid),
    'reservations', (select coalesce(jsonb_agg(app_private.sb_reservation(r.id) order by r.starts_at,r.id),'[]')
                     from public.reservations r where (r.starts_at at time zone 'Asia/Tokyo')::date = p_date))
$$;

-- Same stylist/menu edits preserve the booked item snapshot (including price
-- and duration). Explicit menu/stylist changes use the current HQ master and
-- require the exact server preview hash at commit.
create or replace function app_private.sb_plan(p_input jsonb, p_reservation uuid default null)
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare r public.reservations; s record; v_start timestamptz; v_staff uuid; v_codes text[];
        v_old_codes text[]; v_plan jsonb; v_until timestamptz; v_lane smallint; v_result jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'menu_codes') is distinct from 'array' then
    return jsonb_build_object('error','invalid_request');
  end if;
  v_start := (p_input->>'starts_at')::timestamptz;
  v_staff := nullif(p_input->>'staff_id','')::uuid;
  select array_agg(c order by ord) into v_codes from jsonb_array_elements_text(p_input->'menu_codes') with ordinality x(c,ord);
  if v_codes is null or cardinality(v_codes) not between 1 and 5
     or (select count(distinct c) from unnest(v_codes) c) <> cardinality(v_codes) then
    return jsonb_build_object('error','invalid_menu');
  end if;
  if v_start is null or not app_private.on_slot_grid(v_start) then return jsonb_build_object('error','invalid_starts_at'); end if;
  if not app_private.booking_date_open((v_start at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error','date_not_open'); end if;
  if p_reservation is not null then
    select * into r from public.reservations where id = p_reservation;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if r.status not in ('confirmed','checked_in') then return jsonb_build_object('error','invalid_status'); end if;
    if r.status = 'checked_in' and v_start is distinct from r.starts_at then return jsonb_build_object('error','invalid_status'); end if;
    select array_agg(menu_code order by sort_order) into v_old_codes from public.reservation_items where reservation_id = r.id;
  end if;
  if v_start < now() and v_start is distinct from r.starts_at then return jsonb_build_object('error','too_late'); end if;
  for s in select * from public.staff_members where is_active and is_bookable and (v_staff is null or id = v_staff)
           order by case when id = r.staff_id then 0 else 1 end,
                    app_private.booked_minutes(id,(v_start at time zone 'Asia/Tokyo')::date),sort_order,display_name,id loop
    if r.id is not null and s.id = r.staff_id and v_codes = v_old_codes then
      select jsonb_build_object('duration_min',sum(i.duration_min),'buffer_min',max(i.buffer_after_min),'total_price',r.total_price,
               'items',jsonb_agg(jsonb_build_object('menu_id',i.menu_id,'menu_code',i.menu_code,'name',i.name,
                    'duration_min',i.duration_min,'buffer_after_min',i.buffer_after_min,'price',i.price,'sort_order',i.sort_order) order by i.sort_order))
      into v_plan from public.reservation_items i where i.reservation_id = r.id;
    else
      v_plan := app_private.booking_plan(s.id,v_codes);
    end if;
    continue when v_plan is null or (v_plan->>'duration_min') is null;
    v_until := v_start + make_interval(mins => (v_plan->>'duration_min')::int + (v_plan->>'buffer_min')::int);
    v_lane := app_private.sb_free_lane(s.id,v_start,v_until,r.id);
    continue when v_lane is null;
    v_result := v_plan || jsonb_build_object('staff_id',s.id);
    return v_result || jsonb_build_object('plan_hash',app_private.sha256_hex(jsonb_build_object(
      'preview',v_result,'starts_at',v_start,'reservation_id',r.id,'updated_at',r.updated_at)::text));
  end loop;
  return jsonb_build_object('error','slot_taken');
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  return jsonb_build_object('error','invalid_request');
end $$;

create or replace function app_private.sb_apply(p_command jsonb, p_actor text)
returns jsonb language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_kind text := p_command->>'kind'; p jsonb := p_command->'input'; r public.reservations;
        v_plan jsonb; v_start timestamptz; v_staff uuid; v_lane smallint; v_id uuid; v_client uuid;
        v_end timestamptz; v_until timestamptz; v_before jsonb; i jsonb; v_result jsonb;
begin
  if not exists (select 1 from public.staff_members where is_active and display_name = p_actor) then
    return jsonb_build_object('error','staff_name_required');
  end if;
  perform app_private.lock_all_staff();
  if v_kind <> 'create' then
    select * into r from public.reservations where id = (p_command->>'reservation_id')::uuid for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if (p_command->>'expected_updated_at')::timestamptz is distinct from r.updated_at then
      return jsonb_build_object('error','reservation_changed');
    end if;
  end if;
  if v_kind in ('create','edit') then
    if nullif(btrim(p->>'customer_name'),'') is null or length(p->>'customer_name') > 60 then
      return jsonb_build_object('error','invalid_customer_name');
    end if;
    if length(p->>'customer_phone') > 20 then return jsonb_build_object('error','invalid_phone'); end if;
    if length(p->>'note') > 500 then return jsonb_build_object('error','invalid_note'); end if;
    if p->>'source' is null or p->>'source' not in ('phone','hotpepper','staff') then return jsonb_build_object('error','invalid_source'); end if;
    if p->>'source' = 'hotpepper' and (nullif(btrim(p->>'external_ref'),'') is null or length(p->>'external_ref') > 40) then
      return jsonb_build_object('error','invalid_external_ref');
    end if;
    if v_kind = 'edit' and (p->>'client_id')::uuid is distinct from r.client_id then
      return jsonb_build_object('error','client_mismatch');
    end if;
    v_plan := app_private.sb_plan(p,r.id);
    if v_plan ? 'error' then return v_plan; end if;
    if p_command->>'plan_hash' is distinct from v_plan->>'plan_hash' then return jsonb_build_object('error','preview_changed'); end if;
    v_start := (p->>'starts_at')::timestamptz;
    v_staff := (v_plan->>'staff_id')::uuid;
    v_end := v_start + make_interval(mins => (v_plan->>'duration_min')::int);
    v_until := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
    v_lane := app_private.sb_free_lane(v_staff,v_start,v_until,r.id);
    if v_lane is null then return jsonb_build_object('error','slot_taken'); end if;
    if v_kind = 'create' then
      -- Never accept App identity/hold/token fields from a staff booking draft.
      v_client := app_private.booking_client(jsonb_build_object('client_id',p->'client_id',
        'customer_phone',p->'customer_phone','external_ref',p->'external_ref'),null,btrim(p->>'customer_name'),p->>'source','staff',p_actor);
      if v_client is null then return jsonb_build_object('error','client_not_found'); end if;
      insert into public.reservations(staff_id,booking_lane,nominated,staff_confirmed,client_id,customer_name,customer_phone,
        starts_at,ends_at,occupied_until,source,external_ref,total_price,note,created_by,transfer_status)
      values(v_staff,v_lane,nullif(p->>'staff_id','') is not null,nullif(p->>'staff_id','') is not null,v_client,
        btrim(p->>'customer_name'),nullif(btrim(p->>'customer_phone'),''),v_start,v_end,v_until,p->>'source',
        case when p->>'source' = 'hotpepper' then btrim(p->>'external_ref') end,(v_plan->>'total_price')::int,
        nullif(btrim(p->>'note'),''),p_actor,case when p->>'source' = 'hotpepper' then 'not_required' else 'pending' end)
      returning id into v_id;
    else
      v_id := r.id; v_before := app_private.sb_reservation(r.id);
      update public.reservations set staff_id = v_staff, booking_lane = v_lane,
        nominated = nullif(p->>'staff_id','') is not null,
        staff_confirmed = case when nullif(p->>'staff_id','') is not null then true else staff_confirmed and staff_id = v_staff end,
        customer_name = btrim(p->>'customer_name'),customer_phone = nullif(btrim(p->>'customer_phone'),''),
        starts_at = v_start,ends_at = v_end,occupied_until = v_until,source = p->>'source',
        external_ref = case when p->>'source' = 'hotpepper' then btrim(p->>'external_ref') end,
        total_price = (v_plan->>'total_price')::int,note = nullif(btrim(p->>'note'),''),
        transfer_status = 'pending',updated_at = clock_timestamp() where id = v_id;
      delete from public.reservation_items where reservation_id = v_id;
    end if;
    for i in select * from jsonb_array_elements(v_plan->'items') loop
      insert into public.reservation_items(reservation_id,menu_id,menu_code,name,duration_min,buffer_after_min,price,sort_order)
      values(v_id,(i->>'menu_id')::uuid,i->>'menu_code',i->>'name',(i->>'duration_min')::int,
        (i->>'buffer_after_min')::int,(i->>'price')::int,(i->>'sort_order')::int);
    end loop;
    v_result := app_private.sb_reservation(v_id);
    perform app_private.log_reservation_event(v_id,case when v_kind = 'create' then 'created' else 'edited' end,'staff',p_actor,v_before,v_result);
    return v_result;
  elsif v_kind = 'cancel' then
    if r.status <> 'confirmed' then return jsonb_build_object('error','invalid_status'); end if;
    if length(p_command->>'reason') > 100 then return jsonb_build_object('error','invalid_request'); end if;
    v_result := app_private.store_set_status(r.id,'cancelled','staff',p_actor,p_command->>'reason')::jsonb;
    if v_result ? 'error' then return v_result; end if;
    update public.reservations set transfer_status = 'pending' where id = r.id;
    return app_private.sb_reservation(r.id);
  elsif v_kind = 'transfer' then
    if p_command->>'transfer_status' is null or p_command->>'transfer_status' not in ('pending','done','not_required') then
      return jsonb_build_object('error','invalid_request');
    end if;
    v_before := app_private.sb_reservation(r.id);
    update public.reservations set transfer_status = p_command->>'transfer_status',updated_at = clock_timestamp() where id = r.id;
    v_result := app_private.sb_reservation(r.id);
    perform app_private.log_reservation_event(r.id,'transfer_updated','staff',p_actor,v_before,v_result);
    return v_result;
  elsif v_kind = 'status' then
    if p_command->>'status' is null or p_command->>'status' not in ('checked_in','completed','no_show') then
      return jsonb_build_object('error','invalid_status');
    end if;
    v_result := app_private.store_set_status(r.id,p_command->>'status','staff',p_actor,null)::jsonb;
    if v_result ? 'error' then return v_result; end if;
    return app_private.sb_reservation(r.id);
  end if;
  return jsonb_build_object('error','invalid_request');
exception
  when exclusion_violation then return jsonb_build_object('error','slot_taken');
  when unique_violation then return jsonb_build_object('error','duplicate_external_ref');
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('error','invalid_request');
end $$;

-- Serializes the *request* before all business validations. Both success and
-- refusal are terminal receipts, so a delayed original cannot later execute
-- after a same-ID retry reports a business refusal.
create or replace function public.staff_sb_mutate(p_staff text, p_request_id uuid, p_command jsonb, p_staff_name text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_hash text; v_existing app_private.sb_requests; v_result jsonb;
begin
  perform app_private.assert_staff(p_staff);
  if p_request_id is null or jsonb_typeof(p_command) is distinct from 'object'
     or p_staff_name is null then return jsonb_build_object('error','invalid_request'); end if;
  v_hash := app_private.sha256_hex(jsonb_build_object('actor',p_staff_name,'command',p_command)::text);
  perform pg_advisory_xact_lock(hashtextextended('ginjiro_sb_request:' || p_request_id::text,0));
  select * into v_existing from app_private.sb_requests where request_id = p_request_id;
  if found then
    if v_existing.request_hash <> v_hash then return jsonb_build_object('error','idempotency_conflict'); end if;
    return v_existing.result;
  end if;
  v_result := app_private.sb_apply(p_command,p_staff_name);
  insert into app_private.sb_requests(request_id,request_hash,result) values(p_request_id,v_hash,v_result);
  return v_result;
end $$;

create or replace function public.staff_sb_options(p_staff text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.sb_options(); end $$;

create or replace function public.staff_sb_ledger(p_staff text, p_date date)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.sb_ledger(p_date); end $$;

create or replace function public.staff_sb_preview(p_staff text, p_input jsonb, p_reservation_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.sb_plan(p_input,p_reservation_id); end $$;

create or replace function public.staff_sb_slots(p_staff text, p_date date, p_menu_codes text[], p_staff_id uuid default null, p_reservation_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_step int; v_t timestamptz; v_end timestamptz; v_plan jsonb; v_out jsonb := '[]';
begin
  perform app_private.assert_staff(p_staff);
  if not app_private.booking_date_open(p_date) then return v_out; end if;
  select slot_minutes into v_step from public.booking_settings where id = 1;
  v_t := app_private.jst_ts(p_date,'00:00'); v_end := v_t + interval '1 day';
  while v_t < v_end loop
    v_plan := app_private.sb_plan(jsonb_build_object('starts_at',v_t,'menu_codes',p_menu_codes,'staff_id',p_staff_id),p_reservation_id);
    if not (v_plan ? 'error') then
      v_out := v_out || jsonb_build_object('starts_at',v_t,'staff_id',v_plan->'staff_id');
    end if;
    v_t := v_t + make_interval(mins => v_step);
  end loop;
  return v_out;
end $$;

create or replace function public.hq_set_booking_capacity(p_hq text, p_staff_id uuid, p_capacity integer)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  if p_capacity is null or p_capacity not between 1 and 3 then return jsonb_build_object('error','invalid_capacity'); end if;
  perform app_private.lock_staff(array[p_staff_id]);
  if exists (select 1 from public.reservations where staff_id = p_staff_id and booking_lane >= p_capacity
     and status in ('confirmed','checked_in','in_service','awaiting_payment','completed') and occupied_until > now()) then
    return jsonb_build_object('error','has_reservations');
  end if;
  update public.staff_members set booking_capacity = p_capacity,updated_at = clock_timestamp() where id = p_staff_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  return jsonb_build_object('ok',true);
end $$;

do $$ declare r record;
begin
  for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'app_private' and p.proname in ('sb_capacity_guard','sb_free_lane','sb_reservation','sb_options','sb_ledger','sb_plan','sb_apply'))
       or (n.nspname = 'public' and p.proname in ('staff_sb_mutate','staff_sb_options','staff_sb_ledger','staff_sb_preview','staff_sb_slots','hq_set_booking_capacity')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',r.sig);
    if r.sig::text like 'staff_sb_%' or r.sig::text like 'hq_set_booking_capacity%' then
      execute format('grant execute on function %s to anon, authenticated',r.sig);
    end if;
  end loop;
end $$;
