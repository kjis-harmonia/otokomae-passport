-- 11/11 点検：お客様がアプリで予約を「変更」すると、元の予約の取消が SB の帯・通知に出なかった（理由が「お客様アプリで予約を変更（新しい予約へ）」のため）。
-- サロンボードに古い予約が残り二重になる。取消の理由に変更も足す。中身は本番の今の定義のまま、条件だけ変える。

CREATE OR REPLACE FUNCTION public.staff_new_unacked(p_staff text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform app_private.assert_staff(p_staff);
  return (select coalesce(json_agg(x order by x.sent_at), '[]'::json) from (
    select r.id, 'new'::text as kind, r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name) as staff_name, s.sent_at, false as rescheduled, nullif(substring(r.note from '^お連れ様：(.+)様$'), '') as companion_name
    from app_private.staff_push_sent s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '7 days' and r.starts_at > now() and r.status not in ('cancelled', 'no_show')
    union all
    -- 送り手が記録していない新しい AI 予約（2分たっても）
    select r.id, 'new', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), r.created_at, false, nullif(substring(r.note from '^お連れ様：(.+)様$'), '')
    from public.reservations r left join public.staff_members m on m.id = r.staff_id
    where r.source = 'app' and r.created_at > now() - interval '7 days' and r.created_at < now() - interval '2 minutes' and r.starts_at > now()
      and r.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
    union all
    -- 取り消し：サロンボードに入れてあった（「入れました」を押した）予約だけ
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), s.sent_at, app_private.staff_push_rescheduled(r.id), nullif(substring(r.note from '^お連れ様：(.+)様$'), '')
    from app_private.staff_push_cancel s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '7 days' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent n where n.reservation_id = r.id and n.acked_at is not null)
    union all
    -- 送り手が記録していないアプリでの取り消し（2分たっても）。これも入れてあった予約だけ
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), r.cancelled_at, app_private.staff_push_rescheduled(r.id), nullif(substring(r.note from '^お連れ様：(.+)様$'), '')
    from public.reservations r left join public.staff_members m on m.id = r.staff_id
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason in ('お客様アプリからキャンセル', 'お客様アプリで予約を変更（新しい予約へ）')
      and r.cancelled_at > now() - interval '7 days' and r.cancelled_at < now() - interval '2 minutes' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id and s.acked_at is not null)
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = r.id)
  ) x);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_push_pending_for_sender(p_secret text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_list json; v_cancels json; v_overdue json; v_subs json;
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  with fresh as (
    insert into app_private.staff_push_sent (reservation_id)
    select r.id from public.reservations r
    where r.source = 'app' and r.created_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
    on conflict do nothing
    returning reservation_id
  )
  select coalesce(json_agg(json_build_object(
      'id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', app_private.staff_push_label(r.nominated, m.display_name),
      'menus', (select string_agg(i.name, '・' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id)
    ) order by r.starts_at), '[]'::json)
  into v_list
  from fresh f join public.reservations r on r.id = f.reservation_id left join public.staff_members m on m.id = r.staff_id;

  -- お客様がアプリで取り消した予約（SB に知らせた予約だけ・これからの予約だけ）
  with fresh as (
    insert into app_private.staff_push_cancel (reservation_id)
    select r.id from public.reservations r
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason in ('お客様アプリからキャンセル', 'お客様アプリで予約を変更（新しい予約へ）')
      and r.cancelled_at > now() - interval '1 day' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = r.id)
    on conflict do nothing
    returning reservation_id
  )
  select coalesce(json_agg(json_build_object(
      'id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', app_private.staff_push_label(r.nominated, m.display_name),
      'menus', (select string_agg(i.name, '・' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id),
      'rescheduled', app_private.staff_push_rescheduled(r.id)
    ) order by r.starts_at), '[]'::json)
  into v_cancels
  from fresh f join public.reservations r on r.id = f.reservation_id left join public.staff_members m on m.id = r.staff_id;

  with late as (
    update app_private.staff_push_sent s set final_pushed_at = now()
    from public.reservations r
    where r.id = s.reservation_id and s.acked_at is null and s.final_pushed_at is null
      and s.sent_at < now() - interval '5 minutes' and s.sent_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
    returning s.reservation_id, 'new'::text as kind
  ), late_cancel as (
    update app_private.staff_push_cancel s set final_pushed_at = now()
    where s.acked_at is null and s.final_pushed_at is null
      and s.sent_at < now() - interval '5 minutes' and s.sent_at > now() - interval '1 day'
    returning s.reservation_id, 'cancel'::text as kind
  )
  select coalesce(json_agg(json_build_object('id', r.id, 'kind', l.kind, 'starts_at', r.starts_at, 'customer_name', r.customer_name,
      'staff_name', app_private.staff_push_label(r.nominated, m.display_name)) order by r.starts_at), '[]'::json)
  into v_overdue
  from (select * from late union all select * from late_cancel) l join public.reservations r on r.id = l.reservation_id left join public.staff_members m on m.id = r.staff_id;

  select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json) into v_subs
  from app_private.staff_push_subscriptions s;
  return json_build_object('reservations', v_list, 'cancels', v_cancels, 'overdue', v_overdue, 'subs', v_subs);
end;
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
    where q.id = any(v_cancel) and q.source = 'app' and q.status = 'cancelled' and q.cancel_reason in ('お客様アプリからキャンセル', 'お客様アプリで予約を変更（新しい予約へ）')
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

