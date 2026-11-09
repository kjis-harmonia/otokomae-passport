-- Treatment capacity is independent of stylist capacity and cleanup time.
-- Use the existing canonical client ID for the member or a known store client.
-- Use the actual companion ID for a registered companion. Never infer it from a name.
do $$
begin
  if exists (select 1 from pg_catalog.pg_constraint
             where conrelid = 'public.reservations'::regclass and conname = 'reservations_treatment_person_no_overlap') then
    return;
  end if;

  -- ALTER takes the table lock before classifying old rows. The block is atomic:
  -- an existing overlap aborts the constraint build and leaves the original rows untouched.
  alter table public.reservations add column treatment_person_unresolved boolean not null default false;
  update public.reservations
  set treatment_person_unresolved = true
  where companion_id is null and app_private.res_is_companion(companion_id, companion_of, note);

  alter table public.reservations add constraint reservations_treatment_person_no_overlap exclude using gist (
    (case when companion_id is not null then 'companion:' || companion_id::text
          when not treatment_person_unresolved then 'client:' || client_id::text end) extensions.gist_text_ops with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'));
end;
$$;

-- Keep a shared lock on the final client root until its reservation is written.
-- The existing merge/unmerge RPCs move reservation client IDs in the same transaction.
create or replace function app_private.booking_client(
  p jsonb, p_customer_id uuid, p_name text, p_source text, p_actor_type text, p_actor_name text
)
returns uuid language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_id uuid; v_phone text := app_private.norm_phone(p->>'customer_phone'); v_ref text := nullif(btrim(coalesce(p->>'external_ref', '')), '');
begin
  if nullif(p->>'client_id', '') is not null then
    v_id := app_private.client_root((p->>'client_id')::uuid);
    if v_id is null then return null; end if;
  elsif p_customer_id is not null then
    v_id := app_private.member_client(p_customer_id);
  end if;
  if v_id is not null then
    -- 統合と同時の予約に備え、顧客行を共有ロックしてから統合済みでないか確かめる
    loop
      perform 1 from public.clients where id = v_id for share;
      if not found then return null; end if;
      exit when (select merged_into from public.clients where id = v_id) is null;
      v_id := app_private.client_root(v_id);
    end loop;
  else
    v_id := app_private.create_client(p_name, p_source, p_actor_type, p_actor_name);
  end if;
  if v_phone is not null and length(v_phone) >= 8 then
    perform app_private.add_client_identifier(v_id, 'phone', v_phone, btrim(p->>'customer_phone'), p_actor_name);
  end if;
  if p_source = 'hotpepper' and v_ref is not null then
    perform app_private.add_client_identifier(v_id, 'hotpepper_ref', v_ref, v_ref, p_actor_name);
  end if;
  return v_id;
end;
$$;

CREATE OR REPLACE FUNCTION app_private.create_reservation(p jsonb, p_actor_type text, p_actor_name text, p_min_lead_minutes integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_start timestamptz; v_codes text[]; v_staff uuid; v_nominated boolean; v_plan jsonb; v_hold public.booking_holds;
        v_end timestamptz; v_occ timestamptz; v_id uuid; v_source text; v_name text; v_customer uuid; v_user text; v_item jsonb; v_client uuid; v_lane smallint;
        v_person uuid; v_previous public.reservations; v_constraint text;
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
    v_person := v_hold.companion_id;
    if v_person is not null then
      if (app_private.own_companion(v_hold.holder_user_id, v_person)).id is null then
        return jsonb_build_object('error', 'companion_not_found');
      end if;
      if 'maintenance' = any(v_hold.menu_codes) and not app_private.person_maintenance_ok(v_hold.holder_user_id, v_person) then
        return jsonb_build_object('error', 'menu_not_available');
      end if;
    end if;
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

  -- Only the internal change transaction supplies a previous reservation.
  -- Public confirmation supplies a hold, whose companion was validated when it was issued.
  if v_hold.id is null and v_source = 'app' and p_actor_type = 'customer' and p->>'replaces_reservation_id' is not null then
    select * into v_previous from public.reservations
    where id = (p->>'replaces_reservation_id')::uuid and user_id = v_user and status = 'cancelled';
    if not found then return jsonb_build_object('error', 'not_found'); end if;
    v_person := v_previous.companion_id;
  end if;

  begin
    v_client := app_private.booking_client(p, v_customer, v_name, v_source, p_actor_type, p_actor_name);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
    insert into public.reservations (staff_id, booking_lane, nominated, staff_confirmed, client_id, customer_id, user_id, customer_name, customer_phone,
      starts_at, ends_at, occupied_until, source, external_ref, total_price, note, created_by,
      companion_id, treatment_person_unresolved)
    values (v_staff, v_lane, v_nominated, v_nominated, v_client, v_customer, v_user, v_name, nullif(btrim(coalesce(p->>'customer_phone', '')), ''),
      v_start, v_end, v_occ, v_source, nullif(btrim(coalesce(p->>'external_ref', '')), ''),
      (v_plan->>'total_price')::int, nullif(btrim(coalesce(p->>'note', '')), ''), p_actor_name,
      v_person, v_person is null and coalesce(v_previous.treatment_person_unresolved, false))
    returning id into v_id;
  exception
    when exclusion_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if p_actor_type = 'customer' and v_constraint = 'reservations_treatment_person_no_overlap' then
        return jsonb_build_object('error', 'reservation_person_overlap');
      end if;
      return jsonb_build_object('error', 'slot_taken');
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

create or replace function app_private.reservation_mutate(p_session text, p_kind text, p_old uuid,
  p_starts timestamptz, p_codes text[], p_key text, p_confirmation jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare u text; req jsonb; prior app_private.reservation_mutation_requests; r public.reservations;
  q jsonb; reply jsonb; out_res jsonb; new_id uuid; old_result jsonb; eff jsonb; keep_ids uuid[];
  acc public.ginpay_accounts; after_amount int; resume_on date; code text; c public.customers; cfg public.booking_settings;
begin
  u:=app_private.session_user_id(p_session);
  perform app_private.require_store_verified(p_session);
  if p_kind not in ('change','cancel') or p_key is null or length(p_key) not between 8 and 100 then
    return jsonb_build_object('state','unknown','code','invalid_request');
  end if;
  req:=app_private.reservation_mutation_request(p_kind,p_old,p_starts,p_codes,p_confirmation);
  -- Same-key serialization happens before the global booking lock. No supported path takes these in reverse order.
  perform pg_advisory_xact_lock(hashtextextended('reservation-mutation:'||u||':'||p_key,0));
  select * into prior from app_private.reservation_mutation_requests where user_id=u and idem_key=p_key;
  if found then
    if prior.request is distinct from req then return jsonb_build_object('state','conflict','code','idempotency_conflict'); end if;
    return prior.receipt;
  end if;
  if exists (select 1 from app_private.reservation_changes where user_id=u and idem_key=p_key) then
    return jsonb_build_object('state','conflict','code','idempotency_conflict');
  end if;
  if p_old is null or p_confirmation->>'version' is distinct from 'RESERVATION_REVIEW_V1'
    or p_confirmation->'old'->>'id' is distinct from p_old::text
    or (p_kind='change' and (p_starts is null or not isfinite(p_starts) or date_trunc('milliseconds',p_starts) is distinct from p_starts
      or p_codes is null or cardinality(p_codes) not between 1 and 5
      or cardinality(p_codes)<>(select count(distinct x) from unnest(p_codes) x))) then
    return jsonb_build_object('state','unknown','code','invalid_request');
  end if;
  perform app_private.lock_all_staff();
  perform pg_advisory_xact_lock(hashtext('gacha:'||u));
  select * into r from public.reservations where id=p_old and user_id=u for no key update;
  select * into cfg from public.booking_settings where id=1 for share;
  if r.id is null then code:='not_found';
  elsif r.companion_id::text is distinct from p_confirmation->'old'->>'companion_id' then code:='person_changed';
  elsif r.status<>'confirmed' then code:='reservation_not_confirmed';
  elsif p_kind='change' and app_private.ai_booking_gate(p_session) is not null then code:='ai_booking_paused';
  elsif cfg.app_booking_enabled is distinct from true then code:='booking_disabled';
  elsif p_kind='change' and p_starts=r.starts_at and p_codes=
    (select array_agg(menu_code order by sort_order) from public.reservation_items where reservation_id=r.id) then code:='no_change';
  end if;
  if code is null then
    -- Lock the price/condition rows before validating the approved snapshot.
    perform 1 from public.service_menus m where m.code=any(p_codes) order by m.id for share;
    perform 1 from public.staff_menu_capabilities cap where cap.menu_id in (select m.id from public.service_menus m where m.code=any(p_codes)) order by cap.staff_id,cap.menu_id for share;
    perform 1 from public.tickets where id=any(coalesce((select ticket_ids from app_private.reservation_ticket_plans where reservation_id=r.id),'{}')) order by id for update;
    perform 1 from app_private.gacha_holdings where user_id=u for update;
    perform 1 from public.ginpay_accounts where id in (select account_id from app_private.ginpay_holds where reservation_id=r.id and status='held') order by id for update;
    perform 1 from app_private.ginpay_holds where reservation_id=r.id and status='held' order by id for update;
    if p_kind='cancel' then select array_agg(menu_code order by sort_order) into p_codes from public.reservation_items where reservation_id=r.id; p_starts:=r.starts_at; end if;
    q:=app_private.reservation_review(r.id,p_starts,p_codes,p_kind='cancel');
    if (q->>'call_shop')::boolean is distinct from false then code:='call_shop';
    elsif (q->>'slot_ok')::boolean is distinct from true then code:='slot_taken';
    elsif q is distinct from p_confirmation then code:='conditions_changed'; end if;
  end if;
  if code is null then
    begin
      select * into c from public.customers where user_id=u;
      if p_kind='cancel' then
        out_res:=app_private.set_reservation_status(r.id,'cancelled','customer',coalesce(c.name,u),'お客様アプリからキャンセル');
        if out_res ? 'error' then raise exception '%',out_res->>'error'; end if;
        if (select status from public.reservations where id=r.id) is distinct from 'cancelled' then raise exception 'cancel_failed'; end if;
        if (q->>'cancel_late')::boolean then resume_on:=app_private.ai_penalty_add(r.id,'late_cancel'); end if;
        out_res:=app_private.reservation_json_customer(r.id) || jsonb_build_object('ginpay_released',
          q->'impact'->'ginpay_before','ai_paused_until',resume_on);
      else
        eff:=q->'impact';
        old_result:=app_private.set_reservation_status(r.id,'cancelled','customer',coalesce(c.name,u),'お客様アプリで予約を変更（新しい予約へ）');
        if old_result ? 'error' then raise exception '%',old_result->>'error'; end if;
        out_res:=app_private.create_reservation(jsonb_build_object('starts_at',p_starts,'menu_codes',to_jsonb(p_codes),
          'staff_id',q->'new'->'staff_id','customer_name',r.customer_name,'customer_phone',r.customer_phone,
          'customer_id',r.customer_id,'user_id',u,'source','app','note',r.note,'replaces_reservation_id',r.id),'customer',coalesce(c.name,u),cfg.min_lead_minutes);
        if out_res ? 'error' then raise exception '%',out_res->>'error'; end if;
        new_id:=(out_res->>'id')::uuid;
        update public.reservations set nominated=r.nominated,staff_confirmed=r.nominated,
          companion_of=r.companion_of where id=new_id;
        if (select total_price from public.reservations where id=new_id) is distinct from (q->'new'->>'total_price')::int
          or (select extract(epoch from ends_at-starts_at)/60 from public.reservations where id=new_id) is distinct from (q->'new'->>'duration_min')::numeric
          or (select jsonb_agg(jsonb_build_array(menu_code, name, price, duration_min) order by sort_order)
              from public.reservation_items where reservation_id=new_id) is distinct from
             (select jsonb_agg(jsonb_build_array(i->>'menu_code',i->>'name',i->'price',i->'duration_min') order by n)
              from jsonb_array_elements(q->'new'->'items') with ordinality x(i,n)) then
          raise exception 'conditions_changed';
        end if;
        update public.reservations set companion_of=new_id where companion_of=r.id and status='confirmed';
        select array_agg(x::uuid) into keep_ids from jsonb_array_elements_text(eff->'tickets_keep') x;
        delete from app_private.reservation_ticket_plans where reservation_id=r.id;
        if cardinality(coalesce(keep_ids,'{}'))>0 then insert into app_private.reservation_ticket_plans(reservation_id,user_id,ticket_ids) values(new_id,u,keep_ids); end if;
        update app_private.gacha_holdings set reservation_id=case when coalesce((eff->'gacha'->>'keep')::boolean,false) then new_id else null end where reservation_id=r.id and used_at is null;
        after_amount:=coalesce((eff->>'ginpay_after')::int,0);
        if after_amount>0 then
          select * into acc from public.ginpay_accounts where id=(eff->>'ginpay_account')::uuid for update;
          if acc.id is null or acc.status<>'active' then raise exception 'ginpay_account_not_active'; end if;
          if acc.balance_cached-app_private.ginpay_held_sum(acc.id,new_id)<after_amount then raise exception 'insufficient_balance'; end if;
          insert into app_private.ginpay_holds(reservation_id,account_id,amount) values(new_id,acc.id,after_amount);
        end if;
        if (q->>'late_penalty')::boolean then resume_on:=app_private.ai_penalty_add(r.id,'late_cancel'); end if;
        out_res:=app_private.reservation_json_customer(new_id) || jsonb_build_object('changed_from',r.id,
          'kind',case when p_starts=r.starts_at then 'menu' else 'time' end,'tickets_drop',eff->'tickets_drop',
          'gacha',eff->'gacha','ginpay_before',eff->'ginpay_before','ginpay_after',after_amount)
          || case when resume_on is null then '{}'::jsonb else jsonb_build_object('ai_paused_until',resume_on) end;
      end if;
    exception when others then
      code:=case when sqlerrm in ('slot_taken','reservation_person_overlap','menu_not_available','date_not_open','too_late','invalid_starts_at','insufficient_balance',
        'ginpay_account_not_active','conditions_changed','cancel_deadline_passed','invalid_status') then sqlerrm else 'mutation_failed' end;
    end;
  end if;
  reply:=case when code is null then jsonb_build_object('state','completed','request',req,'result',out_res)
    else jsonb_build_object('state','rejected','request',req,'code',code) end;
  insert into app_private.reservation_mutation_requests(user_id,idem_key,request,receipt) values(u,p_key,req,reply);
  return reply;
end;
$$;

CREATE OR REPLACE FUNCTION app_private.hpb_import(p_text text, p_via text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
declare v_hash text; v_mail uuid; p jsonb; v_kind text; v_ref text; r public.reservations; s record;
        v_start timestamptz; v_dur int; v_until timestamptz; v_staff uuid; v_lane smallint; v_nominated boolean;
        v_status text := 'needs_review'; v_reason text; v_warn text[] := '{}'; v_res uuid; v_client uuid;
        v_menu public.service_menus; v_item_name text; v_price int; v_note text; v_before jsonb; v_after jsonb;
        v_date date; v_constraint text; v_actor_type text := case when p_via = 'paste' then 'staff' else 'system' end;
begin
  if p_text is null or length(p_text) not between 20 and 20000 then return jsonb_build_object('error', 'invalid_mail'); end if;
  v_hash := app_private.sha256_hex(p_text);
  perform pg_advisory_xact_lock(hashtextextended('ginjiro_hpb_mail', 0));
  select id into v_mail from app_private.hpb_mails where text_hash = v_hash;
  if found then return app_private.hpb_mail_json(v_mail) || jsonb_build_object('repeat', true); end if;

  p := app_private.hpb_parse(p_text);
  v_kind := p->>'kind'; v_ref := p->>'external_ref';
  v_start := (p->>'starts_at')::timestamptz; v_dur := (p->>'duration_min')::int;
  perform app_private.lock_all_staff();
  if v_ref is not null then
    select * into r from public.reservations where source = 'hotpepper' and external_ref = v_ref for update;
  end if;

  if v_kind = 'unknown' and p_text ~ '未対応予約のお知らせ' then
    v_status := 'ignored'; v_reason := 'notice';
  elsif v_ref is null or v_kind = 'unknown' then
    v_reason := 'unreadable';
  elsif v_kind = 'cancel' then
    v_res := r.id;
    if r.id is null then v_status := 'ignored'; v_reason := 'not_found';
    elsif r.status = 'cancelled' then v_status := 'duplicate';
    elsif r.status <> 'confirmed' then v_reason := 'invalid_status';
    else
      perform app_private.set_reservation_status(r.id, 'cancelled', v_actor_type, p_actor, 'HOT PEPPERでキャンセル');
      update public.reservations set transfer_status = 'not_required' where id = r.id;
      v_status := 'applied';
    end if;
  elsif v_kind = 'booking' and r.id is not null then
    v_status := 'duplicate'; v_res := r.id;
  elsif v_kind = 'booking' and exists (select 1 from app_private.hpb_mails where external_ref = v_ref and kind = 'cancel') then
    -- キャンセルのメールが先に届いていた予約は入れない（そのキャンセルも片付いたことにする）
    v_status := 'duplicate'; v_reason := 'already_cancelled';
    update app_private.hpb_mails set status = 'applied', reason = null
    where external_ref = v_ref and kind = 'cancel' and status = 'needs_review';
  elsif r.id is not null and r.status <> 'confirmed' then
    v_reason := 'invalid_status'; v_res := r.id;
  elsif v_start is null or v_dur is null or p->>'customer_name' is null then
    v_reason := 'unreadable'; v_res := r.id;
  else
    v_until := v_start + make_interval(mins => v_dur);
    v_date := (v_start at time zone 'Asia/Tokyo')::date;
    select id into v_staff from public.staff_members
    where is_active and regexp_replace(display_name, '\s', '', 'g') = regexp_replace(coalesce(p->>'stylist', ''), '\s', '', 'g')
    limit 1;
    v_nominated := v_staff is not null;
    if v_staff is not null then
      v_lane := app_private.hpb_lane(v_staff, v_start, v_until, r.id);
    else
      if p->>'stylist' is not null and p->>'stylist' !~ '指名なし|なし|フリー' then v_warn := v_warn || 'unknown_stylist'::text; end if;
      for s in select id from public.staff_members where is_active and is_bookable
               order by case when id = r.staff_id then 0 else 1 end, app_private.booked_minutes(id, v_date), sort_order, display_name loop
        v_lane := app_private.hpb_lane(s.id, v_start, v_until, r.id);
        if v_lane is not null then v_staff := s.id; exit; end if;
      end loop;
    end if;
    if v_lane is null then
      -- 同時枠が埋まっていても、HOT PEPPER の予約はお客様に確定済み。枠の外（4本目〜）に入れて SB で赤く出す（11/1 慶一郎さん）
      if v_staff is null then
        select id into v_staff from public.staff_members where is_active and is_bookable
        order by case when id = r.staff_id then 0 else 1 end, app_private.booked_minutes(id, v_date), sort_order, display_name limit 1;
      end if;
      if v_staff is not null then
        v_lane := app_private.hpb_overflow_lane(v_staff, v_start, v_until, r.id);
        if v_lane is not null then v_warn := v_warn || 'over_capacity'::text; end if;
      end if;
    end if;
    if v_lane is null then
      v_reason := 'slot_taken'; v_res := r.id;
    else
      if not exists (select 1 from app_private.effective_shifts(v_staff, v_date) e where e.st <= v_start and e.en >= v_until) then
        v_warn := v_warn || 'out_of_hours'::text;
      end if;
      select * into v_menu from public.service_menus
      where regexp_replace(name, '\s', '', 'g') = regexp_replace(coalesce(p->>'menu', ''), '\s', '', 'g') limit 1;
      v_item_name := left(coalesce(p->>'coupon', p->>'menu', 'HOT PEPPER予約'), 80);
      v_price := coalesce((p->>'total_price')::int, (p->>'menu_price')::int);
      v_note := left(concat_ws(E'\n',
        'HOT PEPPER予約' || coalesce('（' || (p->>'customer_kana') || '）', ''),
        case when p->>'coupon' is not null then 'クーポン：' || (p->>'coupon') end,
        case when p->>'coupon' is not null and p->>'menu' is not null then 'メニュー：' || (p->>'menu') end,
        case when p->>'request' is not null then 'ご要望：' || (p->>'request') end), 500);
      begin
        if r.id is null then
          v_client := app_private.booking_client(jsonb_build_object('external_ref', v_ref, 'customer_phone', p->>'phone'),
            null, p->>'customer_name', 'hotpepper', v_actor_type, p_actor);
          insert into public.reservations(staff_id, booking_lane, nominated, staff_confirmed, client_id, customer_name, customer_phone,
            starts_at, ends_at, occupied_until, source, external_ref, total_price, note, created_by, transfer_status)
          values (v_staff, v_lane, v_nominated, v_nominated, v_client, p->>'customer_name', p->>'phone',
            v_start, v_until, v_until, 'hotpepper', v_ref, v_price, v_note, p_actor, 'not_required')
          returning id into v_res;
          if v_kind = 'change' then v_warn := v_warn || 'created_from_change'::text; end if;
        else
          v_res := r.id; v_before := app_private.sb_reservation(r.id);
          update public.reservations set staff_id = v_staff, booking_lane = v_lane, nominated = v_nominated,
            staff_confirmed = v_nominated or (staff_confirmed and staff_id = v_staff),
            starts_at = v_start, ends_at = v_until, occupied_until = v_until, total_price = v_price, note = v_note,
            transfer_status = 'not_required', updated_at = clock_timestamp()
          where id = r.id;
          delete from public.reservation_items where reservation_id = r.id;
        end if;
        insert into public.reservation_items(reservation_id, menu_id, menu_code, name, duration_min, buffer_after_min, price, sort_order)
        values (v_res, v_menu.id, coalesce(v_menu.code, 'hotpepper'), v_item_name, v_dur, 0, v_price, 0);
        v_after := app_private.sb_reservation(v_res);
        perform app_private.log_reservation_event(v_res, case when v_before is null then 'created' else 'rescheduled' end,
          v_actor_type, p_actor, v_before, v_after, 'HOT PEPPERのメールから取込');
        v_status := 'applied';
      exception when exclusion_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'reservations_treatment_person_no_overlap' then raise; end if;
        -- Keep the external notification reviewable and the original reservation unchanged.
        v_reason := 'slot_taken'; v_res := r.id;
      end;
    end if;
  end if;

  insert into app_private.hpb_mails(text_hash, via, kind, external_ref, parsed, raw_text, status, reason, warnings, reservation_id, created_by)
  values (v_hash, p_via, v_kind, v_ref, p, p_text, v_status, v_reason, v_warn, v_res, p_actor)
  returning id into v_mail;
  return app_private.hpb_mail_json(v_mail);
end $function$;
