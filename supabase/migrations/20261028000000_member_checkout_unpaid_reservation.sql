-- 会員QR の会計（staff_client_for_member）：来店の記録に付いている予約が会計済みなら拾わず、今日のまだ会計していない予約を使う（10/28 慶一郎さん：同じ日の2回目の予約が入らなかった）
--   中身は本番の定義（20261027000100 適用後）のまま、来店の記録の予約から会計済みを外すだけ

CREATE OR REPLACE FUNCTION public.staff_client_for_member(p_staff text, p_user_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_client uuid; v_reservation uuid;
begin
  perform app_private.assert_staff(p_staff);
  v_client := app_private.client_root(app_private.user_client(p_user_id));
  if v_client is null then return json_build_object('error', 'client_not_found'); end if;
  select v.reservation_id into v_reservation
  from public.visit_log v join public.reservations r on r.id = v.reservation_id
  where v.user_id = p_user_id and v.visit_date = app_private.today_jst()
    and r.status not in ('cancelled', 'no_show', 'completed');  -- 会計済みの予約は拾わない（同じ日に2回目の予約があると、会計済みの方を拾って予約なしの会計になっていた・10/28）
  -- 来店登録に予約が付いていない（来店の直前に AI予約した など）：今日のこのお客様の、まだ会計していない予約（いちばん近い時刻）を使う（10/27）
  if v_reservation is null then
    select r.id into v_reservation from public.reservations r
    where app_private.client_root(r.client_id) = v_client
      and (r.starts_at at time zone 'Asia/Tokyo')::date = app_private.today_jst()
      and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment')
    order by abs(extract(epoch from r.starts_at - now()))
    limit 1;
  end if;
  return (
    select json_build_object('client_id', c.id, 'name', c.display_name,
                             'phone_last4', (app_private.client_last4(app_private.client_family(c.id)))[1],
                             'reservation_id', v_reservation)
    from public.clients c where c.id = v_client
  );
end;
$function$;
