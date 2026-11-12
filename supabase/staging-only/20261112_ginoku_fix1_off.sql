-- 20261112_ginoku_fix1.sql を戻す（Staging だけ）。銀オクの関数は 20261112_ginoku.sql をもう一度流すと元に戻る
drop trigger if exists ginoku_block_reverse on public.ginpay_transactions;
drop function if exists app_private.ginoku_block_reverse();
-- 予約に券を付ける関数：Staging の元の定義
CREATE OR REPLACE FUNCTION public.customer_set_ticket_plan(p_session text, p_reservation_id uuid, p_ticket_ids uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user text := app_private.session_user_id(p_session); v_ids uuid[];
begin
  if not exists (select 1 from public.reservations r where r.id = p_reservation_id and r.user_id = v_user and r.status = 'confirmed' for no key update) then
    return json_build_object('error', 'not_found');
  end if;
  select coalesce(array_agg(distinct t.id), '{}') into v_ids from public.tickets t
  where t.id = any(coalesce(p_ticket_ids, '{}')) and t.user_id = any(app_private.ticket_family_uids(v_user)) and not t.used
    and cardinality(p_ticket_ids) <= 30;
  if cardinality(v_ids) = 0 then
    delete from app_private.reservation_ticket_plans where reservation_id = p_reservation_id;
    return json_build_object('ok', true, 'count', 0);
  end if;
  insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) values (p_reservation_id, v_user, v_ids)
  on conflict (reservation_id) do update set ticket_ids = excluded.ticket_ids, user_id = excluded.user_id, created_at = now();
  return json_build_object('ok', true, 'count', cardinality(v_ids));
end;
$function$;
drop function if exists app_private.ginoku_weekday_ticket(uuid);
drop function if exists app_private.ginoku_offday(timestamptz);
notify pgrst, 'reload schema';
