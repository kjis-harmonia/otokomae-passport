-- SB の「施術完了」で、会計の前に銀Pay の押さえが閉じていた（11/18 Codex 監査 SR-02）。
--   完了にすると押さえが閉じ（引き落としは0件）、会員QRの会計も完了の予約を拾わないので、ガチャ券・予約に付けた券・
--   Black Monday も会計に乗らなかった。会計の要る未会計の予約は「会計待ち」にし、完了は会計の確定でだけにする。
--   会計で使うものが無い予約（お店の会計を通さない予約）は、今までどおり完了にできる

-- 会計が確定しているか
create or replace function app_private.reservation_paid(p_id uuid)
 returns boolean
 language sql
 stable
 set search_path to ''
as $function$
  select exists (select 1 from public.accounting_sessions a where a.reservation_id = p_id and a.status = 'completed')
$function$;

-- まだ会計しておらず、会計で使うもの（銀Pay の押さえ・期限内のガチャ券・予約に付けた期限内の未使用の券・Black Monday）がある予約か
create or replace function app_private.reservation_needs_checkout(p_id uuid)
 returns boolean
 language sql
 stable
 set search_path to ''
as $function$
  select not app_private.reservation_paid(p_id)
    and (exists (select 1 from app_private.ginpay_holds h where h.reservation_id = p_id and h.status = 'held')
      or exists (select 1 from app_private.gacha_holdings g where g.reservation_id = p_id and g.used_at is null and g.expires_at > now())
      or exists (select 1 from app_private.reservation_ticket_plans tp join public.tickets t on t.id = any(tp.ticket_ids)
                 where tp.reservation_id = p_id and not t.used and (t.expires_at is null or t.expires_at > now()))
      or exists (select 1 from app_private.black_monday_marks k where k.reservation_id = p_id and k.amount > 0))
$function$;
revoke all on function app_private.reservation_paid(uuid) from public, anon, authenticated;
revoke all on function app_private.reservation_needs_checkout(uuid) from public, anon, authenticated;

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
  -- 会計の要る未会計の予約は、会計の確定（finalize_sale：先に会計を確定してからここへ来る）でだけ完了にする。
  --   会計待ちの予約・会計で使うもの（押さえ・券・Black Monday）がある予約を、SB・旧スタッフ RPC などで完了にすると、
  --   会計0件のまま押さえが閉じ、会員QRの会計からも消えていた（11/18 Codex 監査 SR-02）。行ロックの中で確かめる
  if p_status = 'completed' and not app_private.reservation_paid(p_id)
     and (r.status = 'awaiting_payment' or app_private.reservation_needs_checkout(p_id)) then
    return jsonb_build_object('error', 'checkout_required');
  end if;
  if p_status = 'no_show' and r.starts_at > now() then return jsonb_build_object('error', 'not_started'); end if;
  update public.reservations
  set status = p_status, updated_at = now(),
      -- 施術を始めた時点で担当は確定（フリー予約の仮の担当のまま完了させない）
      staff_confirmed = staff_confirmed or p_status in ('in_service', 'awaiting_payment', 'completed'),
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
      cancel_reason = case when p_status = 'cancelled' then nullif(btrim(coalesce(p_reason, '')), '') else cancel_reason end
  where id = p_id;
  -- お連れ様の予約の受付は、会員本人の来店にしない（11/8）
  if p_status = 'checked_in' and r.user_id is not null and not app_private.res_is_companion(r.companion_id, r.companion_of, r.note) then
    perform app_private.touch_visit(r.user_id);
  elsif p_status = 'checked_in' and app_private.res_is_companion(r.companion_id, r.companion_of, r.note) then
    -- お連れ様の予約の受付は、その方の来店（11/8：14日は受ける人ごとの QR チェックイン日から）
    perform app_private.touch_companion_visit(r.id);
  end if;
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
        v_end timestamptz; v_until timestamptz; v_before jsonb; i jsonb; v_result jsonb; v_status text;
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
    v_status := p_command->>'status';
    -- 施術完了（11/18 Codex 監査 SR-02）：まだ会計していない予約は、会計で使うもの（銀Pay の押さえ・ガチャ券・予約に付けた券・
    --   Black Monday）があれば「完了」にせず「会計待ち」にする。完了は会計の確定（finalize_sale）でだけ。
    --   予約の行はこの関数の最初にロック済み（会計の確定と同じ行ロック）なので、会計済みかどうかはその中で確かめている
    if v_status = 'completed' and not app_private.reservation_paid(r.id) then
      -- 会計待ちは、押し直しても会計待ちのまま（あとから券や押さえが外れても、会計の確定で完了にする）
      if r.status = 'awaiting_payment' then return app_private.sb_reservation(r.id); end if;
      if app_private.reservation_needs_checkout(r.id) then
        -- 受付前の予約は、施術完了で受付（来店の記録）を自動でしない。先に受付してもらう
        if r.status = 'confirmed' then return jsonb_build_object('error','check_in_required'); end if;
        v_status := 'awaiting_payment';
      end if;
    end if;
    v_result := app_private.store_set_status(r.id,v_status,'staff',p_actor,null)::jsonb;
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
