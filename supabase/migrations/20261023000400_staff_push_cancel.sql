-- SB のお知らせの穴を埋める（10/23 監査）
--   1. お客様がアプリで取り消した（JOHNNY の日時変更で元の予約を消した分も）AI 予約も、全端末へ「キャンセルが入りました」。
--      サロンボードに残ったままだと、来ないお客様を待つ・枠が埋まったままになるため。帯・2分/5分の声・最終警告は新しい予約と同じ。
--   2. 「サロンボードに入れました／消しました」は、画面に出ていた予約だけを確認済みにする（押す直前に届いた予約を、見ないまま確認済みにしない）。
--   3. お知らせ・帯の担当は「テイテイ指名」「指名なし」と書く（指名なしの予約に仮で付いた担当を、指名と取り違えない）。

create table if not exists app_private.staff_push_cancel (
  reservation_id  uuid primary key references public.reservations(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  acked_at        timestamptz,
  acked_by        text,
  final_pushed_at timestamptz
);
alter table app_private.staff_push_cancel enable row level security;
revoke all on app_private.staff_push_cancel from public, anon, authenticated;

-- 入れる前に取り消された予約は知らせない
insert into app_private.staff_push_cancel (reservation_id, acked_at, acked_by)
select id, now(), 'migration' from public.reservations where source = 'app' and status = 'cancelled' on conflict do nothing;

/** 担当の書き方：指名ありは「テイテイ指名」、指名なしは「指名なし」 */
create or replace function app_private.staff_push_label(p_nominated boolean, p_name text)
returns text language sql immutable set search_path = '' as $$
  select case when p_nominated then coalesce(p_name, '') || '指名' else '指名なし' end
$$;

/** 取り消しが JOHNNY の日時変更か（同じお客様が直前にアプリで別の予約を入れている） */
create or replace function app_private.staff_push_rescheduled(p_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.reservations c join public.reservations n on n.user_id = c.user_id and n.id <> c.id
    where c.id = p_id and c.user_id is not null and n.source = 'app' and n.status not in ('cancelled', 'no_show')
      and n.created_at between c.cancelled_at - interval '10 minutes' and c.cancelled_at + interval '1 minute')
$$;

/** johnny-notify から：まだ知らせていない新しい予約・取り消し、5分たっても確認されていないもの（最終警告・1回だけ）と受け取り先 */
create or replace function public.staff_push_pending_for_sender(p_secret text)
returns json language plpgsql security definer set search_path = '' as $$
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
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason = 'お客様アプリからキャンセル'
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
$$;

/** SB：まだ誰も確認していない新しい予約（kind=new）と取り消し（kind=cancel）。1日以内 */
create or replace function public.staff_new_unacked(p_staff text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  return (select coalesce(json_agg(x order by x.sent_at), '[]'::json) from (
    select r.id, 'new'::text as kind, r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name) as staff_name, s.sent_at, false as rescheduled
    from app_private.staff_push_sent s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
    union all
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), s.sent_at, app_private.staff_push_rescheduled(r.id)
    from app_private.staff_push_cancel s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '1 day'
  ) x);
end;
$$;

/** SB：サロンボードに入れました／消しました。p_ids＝画面に出ていた予約（無ければ、まだ確認していない全部：古い画面向け）。
 *  新しい予約は転記状態も「転記済み」にして履歴に残す */
drop function if exists public.staff_ack_new(text, text);
create or replace function public.staff_ack_new(p_staff text, p_staff_name text default null, p_ids uuid[] default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_actor text := coalesce(nullif(btrim(coalesce(p_staff_name, '')), ''), 'SB'); r record; n int := 0;
begin
  perform app_private.assert_staff(p_staff);
  for r in update app_private.staff_push_sent set acked_at = now(), acked_by = v_actor
    where acked_at is null and (p_ids is null or reservation_id = any(p_ids)) returning reservation_id loop
    n := n + 1;
    if exists (select 1 from public.reservations where id = r.reservation_id and transfer_status = 'pending' and status not in ('cancelled', 'no_show')) then
      update public.reservations set transfer_status = 'done', updated_at = now() where id = r.reservation_id;
      perform app_private.log_reservation_event(r.reservation_id, 'transfer_updated', 'staff', v_actor,
        jsonb_build_object('transfer_status', 'pending'), jsonb_build_object('transfer_status', 'done'), 'SB の新しい予約で「サロンボードに入れました」');
    end if;
  end loop;
  for r in update app_private.staff_push_cancel set acked_at = now(), acked_by = v_actor
    where acked_at is null and (p_ids is null or reservation_id = any(p_ids)) returning reservation_id loop
    n := n + 1;
  end loop;
  return json_build_object('acked', n);
end;
$$;

revoke all on function public.staff_push_pending_for_sender(text), public.staff_new_unacked(text), public.staff_ack_new(text, text, uuid[]) from public;
revoke all on function app_private.staff_push_label(boolean, text), app_private.staff_push_rescheduled(uuid) from public, anon, authenticated;
grant execute on function public.staff_push_pending_for_sender(text), public.staff_new_unacked(text), public.staff_ack_new(text, text, uuid[]) to anon, authenticated, service_role;
