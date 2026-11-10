-- 1人1件をサーバーでも守る（11/10 Codex 検査 高：画面の確認だけでは、別の端末から同時に確定すると2件になっていた）
-- 20261109045326 の confirm_customer_hold と同じ。★の所だけ足した。戻し方：supabase/rollback/20261110_one_per_person_off.sql
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

  -- ★1人1件（11/10 慶一郎さん「原則、1名につき一回の予約まで」・Codex 検査 高）：施術を受ける人ごとに、これからの予約は1件まで。
  --   lock_all_staff のあとで確かめるので、別の端末から同時に確定しても2件にならない。グループ予約は1人ずつ別の人なので通る
  if p_explicit_new and exists (
    select 1 from public.reservations r
    where r.user_id = v_user and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment') and r.ends_at > now()
      and case when p_companion is not null then r.companion_id = p_companion
               else r.companion_id is null and not app_private.res_is_companion(r.companion_id, r.companion_of, r.note) end
  ) then
    return jsonb_build_object('error', 'person_has_reservation');
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
revoke all on function app_private.confirm_customer_hold(text, uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
