-- 銀二郎SB：銀Pay で前もって支払い済み（仮支払い中・会計で確定済み）の予約に印を出す（10/28 慶一郎さん）
--   SB の予約に ginpay_paid（true/false）を足すだけ。仮支払いが取り消し・返金されたものは出さない

CREATE OR REPLACE FUNCTION app_private.sb_reservation(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
  select app_private.reservation_json(r.id) || jsonb_build_object(
    'booking_lane',r.booking_lane,'transfer_status',r.transfer_status,'updated_at',r.updated_at,
    'ginpay_paid', exists (select 1 from app_private.ginpay_holds h
                           where h.reservation_id = r.id and (h.status = 'closed' or app_private.ginpay_hold_active(h))))
  from public.reservations r where r.id = p_id
$function$;
