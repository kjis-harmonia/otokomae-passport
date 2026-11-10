-- 9本目（20261109045326_customer_booking_cutover）を戻すとき：本番の 11/9 時点の関数そのまま（本番から読み取り）
-- 新しいアプリが使う customer_confirm_new_reservation / customer_cancel_reservation_explicit は残る（消さない）
begin;
CREATE OR REPLACE FUNCTION public.customer_confirm_reservation(p_session text, p_hold_id uuid, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ begin perform app_private.require_store_verified(p_session); if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if; return app_private.store_original_customer_confirm_reservation($1,$2,$3); end; $function$
;
CREATE OR REPLACE FUNCTION public.customer_cancel_reservation(p_session text, p_reservation_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_uid text := app_private.session_user_id(p_session); r public.reservations; v_c public.customers; v_res jsonb; v_late boolean; v_resume date;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select * into r from public.reservations where id = p_reservation_id and user_id = v_uid;
  if r.id is null then return json_build_object('error', 'not_found'); end if;
  if r.starts_at < now() + make_interval(mins => (select customer_cancel_deadline_minutes from public.booking_settings where id = 1)) then
    return json_build_object('error', 'cancel_deadline_passed');
  end if;
  v_late := r.status = 'confirmed' and r.starts_at < now() + make_interval(mins => (select ai_late_cancel_minutes from public.booking_settings where id = 1));
  select * into v_c from public.customers where user_id = v_uid;
  v_res := app_private.set_reservation_status(p_reservation_id, 'cancelled', 'customer', coalesce(v_c.name, v_uid), 'お客様アプリからキャンセル');
  if v_res ? 'error' then return v_res::json; end if;
  if v_late then v_resume := app_private.ai_penalty_add(p_reservation_id, 'late_cancel'); end if;
  return (app_private.reservation_json_customer(p_reservation_id)::jsonb
    || case when v_resume is not null then jsonb_build_object('ai_paused_until', v_resume) else '{}'::jsonb end)::json;
end;
$function$
;
commit;
