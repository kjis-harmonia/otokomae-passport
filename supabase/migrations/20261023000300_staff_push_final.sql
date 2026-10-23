-- SB の新しい AI 予約：5分たっても誰も「サロンボードに入れました」を押さなければ、全端末へもう一度お知らせ（最終警告）。
-- 「サロンボードに入れました」を押した予約は、Salon Board の転記状態も「転記済み」にする（入れ忘れ＝二重予約を防ぐ）。

alter table app_private.staff_push_sent add column if not exists final_pushed_at timestamptz;

/** johnny-notify から：まだ知らせていない AI 予約・5分たっても確認されていない予約（最終警告・1回だけ）と受け取り先 */
create or replace function public.staff_push_pending_for_sender(p_secret text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_list json; v_overdue json; v_subs json;
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
      'id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', m.display_name,
      'menus', (select string_agg(i.name, '・' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id)
    ) order by r.starts_at), '[]'::json)
  into v_list
  from fresh f join public.reservations r on r.id = f.reservation_id join public.staff_members m on m.id = r.staff_id;

  with late as (
    update app_private.staff_push_sent s set final_pushed_at = now()
    from public.reservations r
    where r.id = s.reservation_id and s.acked_at is null and s.final_pushed_at is null
      and s.sent_at < now() - interval '5 minutes' and s.sent_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
    returning s.reservation_id
  )
  select coalesce(json_agg(json_build_object('id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', m.display_name) order by r.starts_at), '[]'::json)
  into v_overdue
  from late l join public.reservations r on r.id = l.reservation_id join public.staff_members m on m.id = r.staff_id;

  select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json) into v_subs
  from app_private.staff_push_subscriptions s;
  return json_build_object('reservations', v_list, 'overdue', v_overdue, 'subs', v_subs);
end;
$$;

/** SB：サロンボードに入れました（まだ確認していない分をまとめて）。転記状態も「転記済み」にして履歴に残す */
create or replace function public.staff_ack_new(p_staff text, p_staff_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_actor text := coalesce(nullif(btrim(coalesce(p_staff_name, '')), ''), 'SB'); r record; n int := 0;
begin
  perform app_private.assert_staff(p_staff);
  for r in update app_private.staff_push_sent set acked_at = now(), acked_by = v_actor where acked_at is null returning reservation_id loop
    n := n + 1;
    if exists (select 1 from public.reservations where id = r.reservation_id and transfer_status = 'pending') then
      update public.reservations set transfer_status = 'done', updated_at = now() where id = r.reservation_id;
      perform app_private.log_reservation_event(r.reservation_id, 'transfer_updated', 'staff', v_actor,
        jsonb_build_object('transfer_status', 'pending'), jsonb_build_object('transfer_status', 'done'), 'SB の新しい予約で「サロンボードに入れました」');
    end if;
  end loop;
  return json_build_object('acked', n);
end;
$$;

revoke all on function public.staff_push_pending_for_sender(text), public.staff_ack_new(text, text) from public;
grant execute on function public.staff_push_pending_for_sender(text), public.staff_ack_new(text, text) to anon, authenticated, service_role;
