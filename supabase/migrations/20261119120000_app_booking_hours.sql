-- アプリの新しい予約は、営業日の 8:00〜21:00（日本時間）だけ受け付ける（11/19 慶一郎さん）
--   営業日でない日（お正月などの休業日 business_closures・定休日 business_hours.is_closed）は、一日じゅう受け付けない
--   アプリの予約はお店の人が HOT PEPPER（サロンボード）へ手で入れる。夜のあいだに入ると、朝まで HOT PEPPER 側が空いたままで二重予約になる。
--   止めるのは「新しい予約の枠を押さえる」所だけ。変更・取り消し・キャンセル待ちの申し込みはそのまま（キャンセル待ちのお知らせはもともと 8:00〜21:00）
--   押さえた枠の確定（2分以内）は止めない（20:59 に押さえた方が確定できなくならないように）

create or replace function app_private.app_booking_hours_ok()
returns boolean
language sql
stable
set search_path to 'pg_catalog'
as $$
  with n as (select (now() at time zone 'Asia/Tokyo') t)
  select n.t::time >= time '08:00' and n.t::time < time '21:00'
    and not exists (select 1 from public.business_closures c where c.closure_date = n.t::date)
    and not exists (select 1 from public.business_hours b where b.weekday = extract(dow from n.t)::int and b.is_closed)
  from n
$$;
revoke all on function app_private.app_booking_hours_ok() from public;

-- 銀ちゃんが予約を始める時に「いま受け付けているか」を聞く（日時を選んでから断られないように。本当に止めるのは下の押さえ）
create or replace function public.customer_app_booking_open()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$ select app_private.app_booking_hours_ok() $$;

create or replace function public.customer_create_hold(p_session text, p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid default null::uuid)
 returns json
 language plpgsql
 security definer
 set search_path to ''
as $function$ begin
  perform app_private.require_store_verified(p_session);
  if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if;
  -- 21:00〜8:00 はアプリの新しい予約を受けない（HOT PEPPER への転記が朝までできない）
  if not app_private.app_booking_hours_ok() then return json_build_object('error', 'app_booking_hours'); end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.maintenance_ok(app_private.session_user_id(p_session)) then
    -- 画面からは来ない（14日を過ぎたら出さない）ので、既にある言葉を使う
    return json_build_object('error', 'menu_not_available');
  end if;
  return app_private.store_original_customer_create_hold($1,$2,$3,$4);
end; $function$;

create or replace function public.customer_create_hold_for(p_session text, p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid, p_companion uuid)
 returns json
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_user text; v_res json;
begin
  perform app_private.require_store_verified(p_session);
  if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if;
  -- 21:00〜8:00 はアプリの新しい予約を受けない（HOT PEPPER への転記が朝までできない）
  if not app_private.app_booking_hours_ok() then return json_build_object('error', 'app_booking_hours'); end if;
  v_user := app_private.session_user_id(p_session);
  if p_companion is not null and (app_private.own_companion(v_user, p_companion)).id is null then
    return json_build_object('error', 'companion_not_found');
  end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.person_maintenance_ok(v_user, p_companion) then
    return json_build_object('error', 'menu_not_available');
  end if;
  v_res := app_private.store_original_customer_create_hold(p_session, p_starts_at, p_menu_codes, p_staff_id);
  if (v_res->>'hold_id') is not null then
    update public.booking_holds set companion_id = p_companion where id = (v_res->>'hold_id')::uuid and holder_user_id = v_user;
  end if;
  return v_res;
end;
$function$;

-- 押さえた枠の確定でも、出勤時間などを確かめ直す（11/19 慶一郎さん「厳重に」。押さえる時は booking_free_lane で確かめ済み）
CREATE OR REPLACE FUNCTION app_private.confirm_customer_hold(p_session text, p_hold_id uuid, p_companion uuid, p_note text, p_explicit_new boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  -- 確定の時にも、担当の出勤時間（片付けまで）・お店の営業時間・休み・ほかの予約を確かめ直す（11/19 慶一郎さん「厳重に」）
  --   押さえてから確定までの間（キャンセル待ちは10分）に出勤表が変わっても、出勤の外の予約にならないように
  if app_private.booking_free_lane(v_hold.staff_id, v_hold.starts_at, v_hold.occupied_until, null, v_hold.id) is null then
    return jsonb_build_object('error', 'slot_taken');
  end if;

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
$function$;
