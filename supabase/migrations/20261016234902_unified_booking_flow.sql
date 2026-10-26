-- Generated with the Supabase CLI. All channels share the configured capacity.
alter table public.booking_holds add column if not exists booking_lane smallint not null default 0
  check (booking_lane between 0 and 2);

create or replace function app_private.booking_free_lane(
  p_staff uuid, p_start timestamptz, p_until timestamptz,
  p_exclude_reservation uuid default null, p_exclude_hold uuid default null
) returns smallint language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select l::smallint from public.staff_members s
  cross join lateral generate_series(0, s.booking_capacity - 1) l
  where s.id = p_staff and s.is_active and s.is_bookable and p_until > p_start
    and exists (select 1 from app_private.effective_shifts(s.id,(p_start at time zone 'Asia/Tokyo')::date) sh
                where sh.st <= p_start and sh.en >= p_until)
    and not exists (select 1 from public.time_blocks b where (b.staff_id = s.id or b.staff_id is null)
                    and tstzrange(b.starts_at,b.ends_at) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.reservations r where r.staff_id=s.id and r.booking_lane=l
                    and r.id is distinct from p_exclude_reservation
                    and r.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
                    and tstzrange(r.starts_at,r.occupied_until) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.booking_holds h where h.staff_id=s.id and h.booking_lane=l
                    and h.id is distinct from p_exclude_hold
                    and h.released_at is null and h.converted_reservation_id is null and h.expires_at>now()
                    and tstzrange(h.starts_at,h.occupied_until) && tstzrange(p_start,p_until))
  order by l limit 1
$$;

create or replace function app_private.sb_free_lane(p_staff uuid,p_start timestamptz,p_until timestamptz,p_exclude uuid default null)
returns smallint language sql stable set search_path = pg_catalog, public, extensions, pg_temp
as $$ select app_private.booking_free_lane(p_staff,p_start,p_until,p_exclude,null) $$;

create or replace function app_private.slot_is_free(p_staff_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,
  p_occupied_until timestamptz,p_exclude_reservation uuid default null,p_exclude_hold uuid default null)
returns boolean language sql stable set search_path = pg_catalog, public, extensions, pg_temp
as $$ select p_ends_at>p_starts_at and p_occupied_until>=p_ends_at
  and app_private.booking_free_lane(p_staff_id,p_starts_at,p_occupied_until,p_exclude_reservation,p_exclude_hold) is not null $$;

CREATE OR REPLACE FUNCTION app_private.create_hold(p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid, p_source text, p_holder_user_id text, p_min_lead_minutes integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_staff uuid := p_staff_id; v_plan jsonb; v_end timestamptz; v_occ timestamptz; v_id uuid; v_exp timestamptz; v_lane smallint;
begin
  perform app_private.lock_all_staff();
  if p_starts_at is null or not app_private.on_slot_grid(p_starts_at) then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  if not app_private.booking_date_open((p_starts_at at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error', 'date_not_open'); end if;
  if p_starts_at < now() + make_interval(mins => greatest(p_min_lead_minutes, 0)) then return jsonb_build_object('error', 'too_late'); end if;
  -- 同じ人の未確定の仮確保は1件まで（新しい仮確保で古いものを解放）
  if p_holder_user_id is not null then
    update public.booking_holds set released_at = now()
    where holder_user_id = p_holder_user_id and released_at is null and converted_reservation_id is null;
  end if;
  if v_staff is null then
    v_staff := app_private.pick_staff(p_starts_at, p_menu_codes);
    if v_staff is null then return jsonb_build_object('error', 'slot_taken'); end if;
  end if;
  v_plan := app_private.booking_plan(v_staff, p_menu_codes);
  if v_plan is null then return jsonb_build_object('error', 'menu_not_available'); end if;
  v_end := p_starts_at + make_interval(mins => (v_plan->>'duration_min')::int);
  v_occ := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
  v_lane := app_private.booking_free_lane(v_staff,p_starts_at,v_occ);
  if v_lane is null then return jsonb_build_object('error', 'slot_taken'); end if;
  v_exp := now() + make_interval(mins => (select hold_minutes from public.booking_settings where id = 1));
  insert into public.booking_holds (staff_id, booking_lane, nominated, starts_at, ends_at, occupied_until, menu_codes, source, holder_user_id, expires_at)
  values (v_staff, v_lane, p_staff_id is not null, p_starts_at, v_end, v_occ, p_menu_codes, p_source, p_holder_user_id, v_exp)
  returning id into v_id;
  -- 古い仮確保の掃除
  delete from public.booking_holds where expires_at < now() - interval '1 day' and converted_reservation_id is null;
  return jsonb_build_object('hold_id', v_id, 'staff_id', v_staff, 'staff_name', (select display_name from public.staff_members where id = v_staff),
    'starts_at', p_starts_at, 'ends_at', v_end, 'expires_at', v_exp, 'total_price', v_plan->'total_price');
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.create_reservation(p jsonb, p_actor_type text, p_actor_name text, p_min_lead_minutes integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_start timestamptz; v_codes text[]; v_staff uuid; v_nominated boolean; v_plan jsonb; v_hold public.booking_holds;
        v_end timestamptz; v_occ timestamptz; v_id uuid; v_source text; v_name text; v_customer uuid; v_user text; v_item jsonb; v_client uuid; v_lane smallint;
begin
  begin
    v_start := (p->>'starts_at')::timestamptz;
  exception when others then
    return jsonb_build_object('error', 'invalid_starts_at');
  end;
  select array_agg(x) into v_codes from jsonb_array_elements_text(coalesce(p->'menu_codes', '[]'::jsonb)) x;
  v_source := p->>'source';
  if v_source is null or v_source not in ('app', 'hotpepper', 'phone', 'staff') then return jsonb_build_object('error', 'invalid_source'); end if;
  v_name := btrim(coalesce(p->>'customer_name', ''));
  if v_name = '' or length(v_name) > 60 then return jsonb_build_object('error', 'invalid_customer_name'); end if;
  if p->>'customer_phone' is not null and length(p->>'customer_phone') > 20 then return jsonb_build_object('error', 'invalid_phone'); end if;
  if p->>'note' is not null and length(p->>'note') > 500 then return jsonb_build_object('error', 'invalid_note'); end if;

  -- 仮確保からの確定
  if p->>'hold_id' is not null then
    -- 行ロックはスタッフ単位ロックの後（ロック順を固定してデッドロックを避ける）。有効性はロック後に再確認する
    select * into v_hold from public.booking_holds where id = (p->>'hold_id')::uuid;
    if v_hold.id is null or v_hold.released_at is not null or v_hold.converted_reservation_id is not null or v_hold.expires_at <= now() then
      return jsonb_build_object('error', 'hold_expired');
    end if;
    if p->>'holder_user_id' is distinct from v_hold.holder_user_id then return jsonb_build_object('error', 'hold_not_found'); end if;
    v_start := v_hold.starts_at; v_codes := v_hold.menu_codes; v_staff := v_hold.staff_id; v_nominated := v_hold.nominated;
  else
    v_staff := nullif(p->>'staff_id', '')::uuid;
    v_nominated := v_staff is not null;
  end if;
  -- 書き込みロック：担当が決まっていればそのスタッフ、指名なしは担当決めの前に全員分
  perform app_private.lock_all_staff();

  if v_hold.id is not null and exists (select 1 from public.booking_holds h where h.id = v_hold.id
      and (h.released_at is not null or h.converted_reservation_id is not null or h.expires_at <= now())) then
    return jsonb_build_object('error', 'hold_expired');
  end if;
  if v_start is null then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  if v_codes is null then return jsonb_build_object('error', 'invalid_menu'); end if;
  if not app_private.booking_date_open((v_start at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error', 'date_not_open'); end if;
  if not app_private.on_slot_grid(v_start) then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  -- 仮確保からの確定は、仮確保した時点で最短開始を確認済み（確定時は開始前であればよい）
  if v_start < now() + make_interval(mins => case when v_hold.id is null then greatest(p_min_lead_minutes, 0) else 0 end) then
    return jsonb_build_object('error', 'too_late');
  end if;

  if v_staff is null then
    v_staff := app_private.pick_staff(v_start, v_codes, v_hold.id);
    if v_staff is null then return jsonb_build_object('error', 'slot_taken'); end if;
  end if;
  v_plan := app_private.booking_plan(v_staff, v_codes);
  if v_plan is null then return jsonb_build_object('error', 'menu_not_available'); end if;
  v_end := v_start + make_interval(mins => (v_plan->>'duration_min')::int);
  v_occ := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
  v_lane := app_private.booking_free_lane(v_staff,v_start,v_occ,null,v_hold.id);
  if v_lane is null then
    return jsonb_build_object('error', 'slot_taken');
  end if;

  v_customer := nullif(p->>'customer_id', '')::uuid;
  v_user := nullif(p->>'user_id', '');
  if v_customer is null and v_user is not null then
    select id into v_customer from public.customers where user_id = v_user;
  end if;

  begin
    v_client := app_private.booking_client(p, v_customer, v_name, v_source, p_actor_type, p_actor_name);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
    insert into public.reservations (staff_id, booking_lane, nominated, staff_confirmed, client_id, customer_id, user_id, customer_name, customer_phone,
      starts_at, ends_at, occupied_until, source, external_ref, total_price, note, created_by)
    values (v_staff, v_lane, v_nominated, v_nominated, v_client, v_customer, v_user, v_name, nullif(btrim(coalesce(p->>'customer_phone', '')), ''),
      v_start, v_end, v_occ, v_source, nullif(btrim(coalesce(p->>'external_ref', '')), ''),
      (v_plan->>'total_price')::int, nullif(btrim(coalesce(p->>'note', '')), ''), p_actor_name)
    returning id into v_id;
  exception
    when exclusion_violation then return jsonb_build_object('error', 'slot_taken');
    when unique_violation then return jsonb_build_object('error', 'duplicate_external_ref');
  end;
  for v_item in select * from jsonb_array_elements(v_plan->'items') loop
    insert into public.reservation_items (reservation_id, menu_id, menu_code, name, duration_min, buffer_after_min, price, sort_order)
    values (v_id, (v_item->>'menu_id')::uuid, v_item->>'menu_code', v_item->>'name', (v_item->>'duration_min')::int,
            (v_item->>'buffer_after_min')::int, (v_item->>'price')::int, (v_item->>'sort_order')::int);
  end loop;
  if v_hold.id is not null then
    update public.booking_holds set converted_reservation_id = v_id where id = v_hold.id;
  end if;
  perform app_private.log_reservation_event(v_id, 'created', p_actor_type, p_actor_name, null, app_private.reservation_json(v_id));
  return app_private.reservation_json(v_id);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.reschedule_reservation(p_id uuid, p_starts_at timestamp with time zone, p_staff_id uuid, p_actor_type text, p_actor_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_before jsonb; v_codes text[]; v_staff uuid; v_plan jsonb; v_end timestamptz; v_occ timestamptz; v_locked uuid; v_lane smallint;
begin
  select * into r from public.reservations where id = p_id;
  if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
  perform app_private.lock_all_staff();
  v_locked := r.staff_id;
  select * into r from public.reservations where id = p_id for update;
  -- ロック前に他の操作で担当が変わっていたら、ロックしたスタッフと一致しないため取り直してもらう
  if r.staff_id <> v_locked then return jsonb_build_object('error', 'try_again'); end if;
  if r.status not in ('confirmed', 'checked_in') then return jsonb_build_object('error', 'invalid_status'); end if;
  if r.status = 'checked_in' and p_starts_at is distinct from r.starts_at then return jsonb_build_object('error', 'invalid_status'); end if;
  if p_starts_at is null or not app_private.on_slot_grid(p_starts_at) then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  if not app_private.booking_date_open((p_starts_at at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error', 'date_not_open'); end if;
  if p_starts_at < now() and p_starts_at is distinct from r.starts_at then return jsonb_build_object('error', 'too_late'); end if;
  v_staff := coalesce(p_staff_id, r.staff_id);
  select array_agg(menu_code order by sort_order) into v_codes from public.reservation_items where reservation_id = p_id;
  v_plan := app_private.booking_plan(v_staff, v_codes);
  if v_plan is null then return jsonb_build_object('error', 'menu_not_available'); end if;
  v_end := p_starts_at + make_interval(mins => (v_plan->>'duration_min')::int);
  v_occ := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
  v_lane := app_private.booking_free_lane(v_staff,p_starts_at,v_occ,p_id);
  if v_lane is null then return jsonb_build_object('error', 'slot_taken'); end if;
  v_before := app_private.reservation_json(p_id);
  begin
    update public.reservations
    set booking_lane = v_lane, starts_at = p_starts_at, ends_at = v_end, occupied_until = v_occ, staff_id = v_staff,
        -- 担当を指定した変更＝店舗が担当を決めた（フリー予約の担当確定）。お客様の指名あり／フリーは変えない
        staff_confirmed = case when p_staff_id is not null then true else staff_confirmed end,
        updated_at = now()
    where id = p_id;
  exception when exclusion_violation then return jsonb_build_object('error', 'slot_taken');
  end;
  if p_starts_at <> r.starts_at then
    perform app_private.log_reservation_event(p_id, 'rescheduled', p_actor_type, p_actor_name,
      jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at), jsonb_build_object('starts_at', p_starts_at, 'ends_at', v_end));
  end if;
  if v_staff = r.staff_id and p_staff_id is not null and not r.staff_confirmed then
    perform app_private.log_reservation_event(p_id, 'staff_confirmed', p_actor_type, p_actor_name,
      null, jsonb_build_object('staff_id', v_staff, 'staff_name', v_before->>'staff_name'));
  end if;
  if v_staff <> r.staff_id then
    perform app_private.log_reservation_event(p_id, 'staff_changed', p_actor_type, p_actor_name,
      jsonb_build_object('staff_id', r.staff_id, 'staff_name', v_before->>'staff_name'),
      jsonb_build_object('staff_id', v_staff, 'staff_name', (select display_name from public.staff_members where id = v_staff)));
  end if;
  return app_private.reservation_json(p_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.customer_confirm_reservation(p_session text, p_hold_id uuid, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_uid text := app_private.session_user_id(p_session); v_c public.customers; v_r jsonb;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select * into v_c from public.customers where user_id = v_uid;
  if v_c.id is null then return json_build_object('error', 'customer_not_found'); end if;
  v_r := app_private.create_reservation(
    jsonb_build_object('hold_id', p_hold_id, 'holder_user_id', v_uid, 'customer_name', coalesce(nullif(btrim(v_c.contact_name),''),v_c.name), 'customer_phone', v_c.contact_phone, 'customer_id', v_c.id,
                       'user_id', v_uid, 'source', 'app', 'note', p_note),
    'customer', v_c.name, (select min_lead_minutes from public.booking_settings where id = 1));
  if v_r ? 'error' then return v_r::json; end if;
  return app_private.reservation_json_customer((v_r->>'id')::uuid)::json;
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.set_reservation_status(p_id uuid, p_status text, p_actor_type text, p_actor_name text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_ok boolean;
begin
  select * into r from public.reservations where id = p_id for update;
  if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_ok := (r.status = 'confirmed' and p_status in ('checked_in', 'no_show', 'cancelled', 'completed'))
       or (r.status = 'checked_in' and p_status in ('in_service', 'awaiting_payment', 'completed'))
       or (r.status = 'in_service' and p_status in ('awaiting_payment', 'completed'))
       or (r.status = 'awaiting_payment' and p_status = 'completed');
  if not v_ok then return jsonb_build_object('error', 'invalid_status'); end if;
  if p_status = 'no_show' and r.starts_at > now() then return jsonb_build_object('error', 'not_started'); end if;
  update public.reservations
  set status = p_status, updated_at = now(),
      -- 施術を始めた時点で担当は確定（フリー予約の仮の担当のまま完了させない）
      staff_confirmed = staff_confirmed or p_status in ('in_service', 'awaiting_payment', 'completed'),
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
      cancel_reason = case when p_status = 'cancelled' then nullif(btrim(coalesce(p_reason, '')), '') else cancel_reason end
  where id = p_id;
  if p_status = 'checked_in' and r.user_id is not null then perform app_private.touch_visit(r.user_id); end if;
  perform app_private.log_reservation_event(p_id, p_status, p_actor_type, p_actor_name,
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status), nullif(btrim(coalesce(p_reason, '')), ''));
  return app_private.reservation_json(p_id);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.sb_apply(p_command jsonb, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
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
        starts_at = v_start,ends_at = v_end,occupied_until = v_until,source = case when r.source='app' then 'app' else p->>'source' end,
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
end $function$;

-- Staff resolves the scanned member on the server. Names in QR are never a linkage key.
create or replace function public.staff_member_booking_context(p_staff text,p_user_id text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions,pg_temp as $$
declare v_customer uuid; v_client uuid;
begin
  perform app_private.assert_staff(p_staff);
  select id into v_customer from public.customers where user_id=p_user_id;
  if v_customer is null then return jsonb_build_object('error','customer_not_found'); end if;
  v_client := app_private.member_client(v_customer);
  return jsonb_build_object('client_id',v_client,'reservations',
    (select coalesce(jsonb_agg(app_private.reservation_json(r.id) order by r.starts_at),'[]'::jsonb)
     from public.reservations r where (r.starts_at at time zone 'Asia/Tokyo')::date=app_private.today_jst()
       and app_private.client_root(r.client_id)=v_client and r.status not in ('cancelled','no_show')));
end $$;

-- Verify both member and selected reservation. A retry is safe; no automatic candidate selection.
create or replace function public.staff_check_in_reservation(p_staff text,p_user_id text,p_reservation_id uuid,p_staff_name text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions,pg_temp as $$
declare v_context jsonb; r public.reservations; v_result jsonb;
begin
  perform app_private.assert_staff(p_staff);
  perform app_private.require_actor(p_staff_name);
  v_context:=public.staff_member_booking_context(p_staff,p_user_id);
  if v_context ? 'error' then return v_context; end if;
  select * into r from public.reservations where id=p_reservation_id for update;
  if r.id is null or app_private.client_root(r.client_id)::text is distinct from v_context->>'client_id'
     or (r.starts_at at time zone 'Asia/Tokyo')::date<>app_private.today_jst() then
    return jsonb_build_object('error','reservation_mismatch');
  end if;
  if r.status='confirmed' then
    v_result:=app_private.set_reservation_status(r.id,'checked_in','staff',btrim(p_staff_name));
    if v_result ? 'error' then return v_result; end if;
  elsif r.status not in ('checked_in','in_service','awaiting_payment') then
    return jsonb_build_object('error','invalid_status');
  end if;
  perform app_private.touch_visit(p_user_id);
  return app_private.reservation_json(r.id);
end $$;

revoke all on function app_private.booking_free_lane(uuid,timestamptz,timestamptz,uuid,uuid) from public,anon,authenticated;
revoke all on function public.staff_member_booking_context(text,text) from public;
revoke all on function public.staff_check_in_reservation(text,text,uuid,text) from public;
grant execute on function public.staff_member_booking_context(text,text),public.staff_check_in_reservation(text,text,uuid,text) to anon,authenticated;
-- Existing private-function revocations are retained by CREATE OR REPLACE.
