-- Run the cutover with customer reservation writes drained. Keep the old signatures
-- as guarded entry points because an installed app can keep executing old JavaScript.

create or replace function app_private.confirm_customer_hold(
  p_session text, p_hold_id uuid, p_companion uuid, p_note text, p_explicit_new boolean
)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare
  v_user text;
  v_hold public.booking_holds;
  v_person app_private.customer_companions;
  v_customer uuid;
  v_client uuid;
  v_result jsonb;
begin
  v_user := app_private.session_user_id(p_session);
  perform app_private.require_store_verified(p_session);
  if p_hold_id is null then return jsonb_build_object('error', 'hold_expired'); end if;

  -- Match the lock order of reservation_mutate: request identity, then booking locks.
  perform app_private.lock_all_staff();
  select * into v_hold from public.booking_holds where id = p_hold_id and holder_user_id = v_user;
  if v_hold.id is null then return jsonb_build_object('error', 'hold_expired'); end if;
  if v_hold.companion_id is distinct from p_companion then return jsonb_build_object('error', 'companion_mismatch'); end if;
  if v_hold.converted_reservation_id is not null then
    return jsonb_build_object('error', case when p_explicit_new then 'legacy_confirmation_unresolved' else 'booking_update_required' end);
  end if;
  if v_hold.released_at is not null or v_hold.expires_at <= now() then return jsonb_build_object('error', 'hold_expired'); end if;

  if p_companion is not null then
    v_person := app_private.own_companion(v_user, p_companion);
    if v_person.id is null then return jsonb_build_object('error', 'companion_not_found'); end if;
    if 'maintenance' = any(v_hold.menu_codes) and not app_private.person_maintenance_ok(v_user, p_companion) then
      return jsonb_build_object('error', 'menu_not_available');
    end if;
  elsif app_private.res_is_companion(null, null, btrim(p_note)) then
    return jsonb_build_object('error', 'companion_id_required');
  end if;

  if not p_explicit_new then
    select id into v_customer from public.customers where user_id = v_user;
    select app_private.client_root(i.client_id) into v_client
      from public.client_identifiers i
      where i.kind = 'app_member' and i.value = v_customer::text and i.removed_at is null;
    while v_client is not null loop
      perform 1 from public.clients where id = v_client for share;
      if not found then return jsonb_build_object('error', 'client_not_found'); end if;
      exit when (select merged_into from public.clients where id = v_client) is null;
      v_client := app_private.client_root(v_client);
    end loop;
    if exists (
      select 1 from public.reservations r
      where r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment') and r.ends_at > now()
        and (
          (p_companion is not null and r.companion_id = p_companion)
          or (r.companion_id is null
            and (r.user_id = v_user or r.customer_id = v_customer or r.client_id = v_client)
            and (p_companion is null or r.treatment_person_unresolved))
        )
    ) then
      return jsonb_build_object('error', 'booking_update_required');
    end if;
  end if;

  v_result := app_private.ai_booking_gate(p_session)::jsonb;
  if v_result is not null then return v_result; end if;
  v_result := app_private.store_original_customer_confirm_reservation(
    p_session, p_hold_id, case when p_companion is null then p_note else 'お連れ様：' || btrim(v_person.name) || '様' end
  )::jsonb;
  if v_result ? 'error' then return v_result; end if;
  if v_result->>'id' is null then raise exception 'invalid_booking_confirmation'; end if;

  return v_result;
end;
$$;

create or replace function public.customer_confirm_reservation(p_session text, p_hold_id uuid, p_note text default null)
returns json language sql volatile security definer set search_path = '' as $$
  select app_private.confirm_customer_hold(p_session, p_hold_id, null, p_note, false)::json
$$;

create or replace function public.customer_confirm_for(p_session text, p_hold_id uuid, p_companion uuid)
returns json language sql volatile security definer set search_path = '' as $$
  select app_private.confirm_customer_hold(p_session, p_hold_id, p_companion, null, false)::json
$$;

create or replace function public.customer_confirm_new_reservation(p_session text, p_hold_id uuid, p_companion uuid, p_note text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user text := app_private.session_user_id(p_session);
  v_key text := 'explicit-create:' || p_hold_id::text;
  v_request jsonb := jsonb_build_object('kind', 'create', 'hold_id', p_hold_id, 'companion_id', p_companion, 'note', p_note);
  v_prior app_private.reservation_mutation_requests;
  v_result jsonb;
begin
  perform app_private.require_store_verified(p_session);
  if p_hold_id is null then return json_build_object('error', 'hold_expired'); end if;
  perform pg_advisory_xact_lock(hashtextextended('reservation-mutation:' || v_user || ':' || v_key, 0));
  select * into v_prior from app_private.reservation_mutation_requests where user_id = v_user and idem_key = v_key;
  if found then
    if v_prior.request is distinct from v_request then return json_build_object('error', 'idempotency_conflict'); end if;
    return (v_prior.receipt->'result')::json;
  end if;
  -- Only the owner of the immutable hold can claim its key or create a receipt.
  if not exists (select 1 from public.booking_holds where id = p_hold_id and holder_user_id = v_user) then
    return json_build_object('error', 'hold_expired');
  end if;
  v_result := app_private.confirm_customer_hold(p_session, p_hold_id, p_companion, p_note, true);
  insert into app_private.reservation_mutation_requests(user_id, idem_key, request, receipt)
  values (v_user, v_key, v_request, jsonb_build_object(
    'state', case when v_result ? 'error' then 'rejected' else 'completed' end, 'request', v_request, 'result', v_result
  ));
  return v_result::json;
end;
$$;

-- Preserve the pre-existing standalone cancellation authorization, deadline and penalty.
create or replace function app_private.cutover_cancel_customer_reservation(p_session text, p_reservation_id uuid)
returns json language plpgsql volatile set search_path = '' as $$
declare
  v_user text := app_private.session_user_id(p_session);
  v_reservation public.reservations;
  v_name text;
  v_result jsonb;
  v_resume date;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select * into v_reservation from public.reservations where id = p_reservation_id and user_id = v_user for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if v_reservation.starts_at < now() + make_interval(mins => (select customer_cancel_deadline_minutes from public.booking_settings where id = 1)) then
    return json_build_object('error', 'cancel_deadline_passed');
  end if;
  select name into v_name from public.customers where user_id = v_user;
  v_result := app_private.set_reservation_status(p_reservation_id, 'cancelled', 'customer', coalesce(v_name, v_user), 'お客様アプリからキャンセル');
  if v_result ? 'error' then return v_result::json; end if;
  if v_reservation.status = 'confirmed'
    and v_reservation.starts_at < now() + make_interval(mins => (select ai_late_cancel_minutes from public.booking_settings where id = 1)) then
    v_resume := app_private.ai_penalty_add(p_reservation_id, 'late_cancel');
  end if;
  return (app_private.reservation_json_customer(p_reservation_id)
    || case when v_resume is not null then jsonb_build_object('ai_paused_until', v_resume) else '{}'::jsonb end)::json;
end;
$$;

create or replace function public.customer_cancel_reservation(p_session text, p_reservation_id uuid)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if not exists (select 1 from public.reservations where id = p_reservation_id and user_id = v_user) then
    return json_build_object('error', 'not_found');
  end if;
  -- The same call was used for both standalone cancellation and the second half of a legacy replacement.
  return json_build_object('error', 'booking_update_required');
end;
$$;

create or replace function public.customer_cancel_reservation_explicit(p_session text, p_reservation_id uuid)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user text := app_private.session_user_id(p_session);
  v_key text := 'explicit-cancel:' || p_reservation_id::text;
  v_request jsonb := jsonb_build_object('kind', 'standalone_cancel', 'reservation_id', p_reservation_id);
  v_prior app_private.reservation_mutation_requests;
  v_result jsonb;
begin
  if p_reservation_id is null then return json_build_object('error', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('reservation-mutation:' || v_user || ':' || v_key, 0));
  select * into v_prior from app_private.reservation_mutation_requests where user_id = v_user and idem_key = v_key;
  if found then
    if v_prior.request is distinct from v_request then return json_build_object('error', 'idempotency_conflict'); end if;
    return (v_prior.receipt->'result')::json;
  end if;
  perform app_private.lock_all_staff();
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  v_result := app_private.cutover_cancel_customer_reservation(p_session, p_reservation_id)::jsonb;
  if v_result ? 'error' then return v_result::json; end if;
  if v_result->>'status' is distinct from 'cancelled' then raise exception 'invalid_booking_cancellation'; end if;
  insert into app_private.reservation_mutation_requests(user_id, idem_key, request, receipt)
  values (v_user, v_key, v_request, jsonb_build_object('state', 'completed', 'request', v_request, 'result', v_result));
  return v_result::json;
end;
$$;

revoke all on function app_private.confirm_customer_hold(text, uuid, uuid, text, boolean),
  app_private.cutover_cancel_customer_reservation(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.customer_confirm_reservation(text, uuid, text), public.customer_confirm_for(text, uuid, uuid),
  public.customer_confirm_new_reservation(text, uuid, uuid, text), public.customer_cancel_reservation(text, uuid),
  public.customer_cancel_reservation_explicit(text, uuid) from public;
grant execute on function public.customer_confirm_reservation(text, uuid, text), public.customer_confirm_for(text, uuid, uuid),
  public.customer_confirm_new_reservation(text, uuid, uuid, text), public.customer_cancel_reservation(text, uuid),
  public.customer_cancel_reservation_explicit(text, uuid) to anon, authenticated, service_role;
