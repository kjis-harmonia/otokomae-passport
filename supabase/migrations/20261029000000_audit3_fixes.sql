-- Codex 監査（10/29・main bb41b31）の要対応
--   R1 SB の銀Pay の印：いま押さえている前払いか、会計で銀Pay から払われ取消・返金を引いても残っているときだけ（sb_reservation）
--      これまでは押さえが閉じれば（現金で会計しても・返金しても）印が出て、押さえなしで銀Pay 会計したときは出なかった
--   R2 クローズの重なり：同じ担当・同じ時間の SB のクローズは1件だけ（staff_close_time）。外すときは重なったものもまとめて外し、
--      ほかのクローズ・休憩がまだ重なっていれば件数を返す（staff_reopen_time）
--   R3 古い SB の画面（p_ids だけ）からは、取消を確認済みにしない（staff_ack_new）
--   関数は本番の定義（20261028001000 適用後）に、上の変更だけを入れる

CREATE OR REPLACE FUNCTION app_private.sb_reservation(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
  select app_private.reservation_json(r.id) || jsonb_build_object(
    'booking_lane',r.booking_lane,'transfer_status',r.transfer_status,'updated_at',r.updated_at,
    'ginpay_paid', exists (select 1 from app_private.ginpay_holds h
                           where h.reservation_id = r.id and app_private.ginpay_hold_active(h))
                   or coalesce((select sum(t.amount) from public.ginpay_transactions t
                                where t.status = 'posted'
                                  and t.id in (select p.id from public.ginpay_transactions p
                                               join public.accounting_sessions a on a.id = p.accounting_session_id
                                               where a.reservation_id = r.id and p.type = 'payment' and p.status = 'posted'
                                               union
                                               select v.id from public.ginpay_transactions v
                                               join public.ginpay_transactions p on p.id = v.original_transaction_id
                                               join public.accounting_sessions a on a.id = p.accounting_session_id
                                               where a.reservation_id = r.id and p.type = 'payment' and v.type in ('refund', 'void'))), 0) < 0)
  from public.reservations r where r.id = p_id
$function$;

CREATE OR REPLACE FUNCTION public.staff_ack_new(p_staff text, p_staff_name text DEFAULT NULL::text, p_ids uuid[] DEFAULT NULL::uuid[], p_new_ids uuid[] DEFAULT NULL::uuid[], p_cancel_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor text := coalesce(nullif(btrim(coalesce(p_staff_name, '')), ''), 'SB'); r record; n int := 0;
  -- 監査2 R2：新しい画面は「新しい予約」と「取消」を分けて渡す。古い画面（p_ids だけ）は今までどおり両方
  v_new uuid[] := case when p_new_ids is not null or p_cancel_ids is not null then coalesce(p_new_ids, '{}') else p_ids end;
  v_cancel uuid[] := case when p_new_ids is not null or p_cancel_ids is not null then coalesce(p_cancel_ids, '{}') else '{}'::uuid[] end;  -- 監査3 R3：古い画面からは取消を確認済みにしない
begin
  perform app_private.assert_staff(p_staff);
  -- 送り手が記録していない分（画面に出ていたものだけ）を先に記録する
  if v_new is not null then
    insert into app_private.staff_push_sent (reservation_id, sent_at)
    select q.id, q.created_at from public.reservations q
    where q.id = any(v_new) and q.source = 'app' and q.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = q.id)
    on conflict do nothing;
  end if;
  if v_cancel is not null then
    insert into app_private.staff_push_cancel (reservation_id, sent_at)
    select q.id, q.cancelled_at from public.reservations q
    where q.id = any(v_cancel) and q.source = 'app' and q.status = 'cancelled' and q.cancel_reason = 'お客様アプリからキャンセル'
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = q.id)
    on conflict do nothing;
  end if;
  for r in update app_private.staff_push_sent set acked_at = now(), acked_by = v_actor
    where acked_at is null and (v_new is null or reservation_id = any(v_new)) returning reservation_id loop
    n := n + 1;
    if exists (select 1 from public.reservations where id = r.reservation_id and transfer_status = 'pending' and status not in ('cancelled', 'no_show')) then
      update public.reservations set transfer_status = 'done', updated_at = now() where id = r.reservation_id;
      perform app_private.log_reservation_event(r.reservation_id, 'transfer_updated', 'staff', v_actor,
        jsonb_build_object('transfer_status', 'pending'), jsonb_build_object('transfer_status', 'done'), 'SB の新しい予約で「サロンボードに入れました」');
    end if;
  end loop;
  for r in update app_private.staff_push_cancel set acked_at = now(), acked_by = v_actor
    where acked_at is null and (v_cancel is null or reservation_id = any(v_cancel)) returning reservation_id loop
    n := n + 1;
  end loop;
  return json_build_object('acked', n);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_close_time(p_staff text, p_staff_ids uuid[], p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_actor text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ids uuid[]; v_actor text := left(coalesce(nullif(btrim(coalesce(p_actor, '')), ''), 'SB'), 40); v_out uuid[]; v_overlap int;
begin
  perform app_private.assert_staff(p_staff);
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '14 hours'
     or extract(epoch from p_starts_at)::bigint % 900 <> 0 or extract(epoch from p_ends_at)::bigint % 900 <> 0 then
    return json_build_object('error', 'invalid_range');
  end if;
  if p_ends_at <= now() then return json_build_object('error', 'past'); end if;
  select array_agg(distinct s.id) into v_ids from public.staff_members s where s.id = any(coalesce(p_staff_ids, '{}')) and s.is_active and s.is_bookable;
  if v_ids is null or cardinality(v_ids) <> cardinality(array(select distinct unnest(p_staff_ids))) then return json_build_object('error', 'invalid_staff'); end if;
  perform app_private.lock_staff(v_ids);
  -- 監査3 R2：同じ担当・同じ時間の SB のクローズがあれば作らない（担当のロックの中なので2台同時でも1件）
  with ins as (
    insert into public.time_blocks (staff_id, starts_at, ends_at, kind, note, created_by)
    select x.sid, p_starts_at, p_ends_at, 'unavailable', left(nullif(btrim(coalesce(p_note, '')), ''), 120), 'SB:' || v_actor
    from unnest(v_ids) as x(sid)
    where not exists (select 1 from public.time_blocks b where b.staff_id = x.sid and b.starts_at = p_starts_at and b.ends_at = p_ends_at
                        and b.kind = 'unavailable' and b.created_by like 'SB:%')
    returning id
  ) select array_agg(id) into v_out from ins;
  v_out := coalesce(v_out, '{}') || coalesce((select array_agg(b.id) from public.time_blocks b
    where b.staff_id = any(v_ids) and b.starts_at = p_starts_at and b.ends_at = p_ends_at and b.kind = 'unavailable' and b.created_by like 'SB:%'
      and not (b.id = any(coalesce(v_out, '{}')))), '{}');
  select count(*) into v_overlap from public.reservations r
  where r.staff_id = any(v_ids) and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment')
    and tstzrange(r.starts_at, r.occupied_until) && tstzrange(p_starts_at, p_ends_at);
  return json_build_object('ok', true, 'ids', to_json(v_out), 'overlap', v_overlap);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_reopen_time(p_staff text, p_block_id uuid, p_actor text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n int; v_b public.time_blocks; v_left int;
begin
  perform app_private.assert_staff(p_staff);
  select * into v_b from public.time_blocks where id = p_block_id and kind = 'unavailable' and created_by like 'SB:%';
  if not found then return json_build_object('error', 'not_found'); end if;
  perform app_private.lock_staff(array[v_b.staff_id]);
  -- 監査3 R2：同じ担当・同じ時間の SB のクローズ（重なって作られたもの）もいっしょに外す
  delete from public.time_blocks where staff_id = v_b.staff_id and starts_at = v_b.starts_at and ends_at = v_b.ends_at
    and kind = 'unavailable' and created_by like 'SB:%';
  get diagnostics n = row_count;
  if n = 0 then return json_build_object('error', 'not_found'); end if;
  -- 外したあとも、ほかのクローズ・休憩が同じ時間に重なっていれば知らせる（本部の休憩などは消さない）
  select count(*) into v_left from public.time_blocks b where b.staff_id = v_b.staff_id
    and tstzrange(b.starts_at, b.ends_at) && tstzrange(v_b.starts_at, v_b.ends_at);
  return json_build_object('ok', true, 'removed', n, 'still_blocked', v_left);
end;
$function$;
