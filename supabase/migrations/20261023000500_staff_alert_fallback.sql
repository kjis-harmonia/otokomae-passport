-- SB の帯の保険（10/23 大検査）：毎分の送り手（johnny-notify・cron）が止まっても、SB を開いていれば帯と声で気づけるようにする。
--   送り手がまだ記録していない AI 予約・アプリでの取り消しも、2分たったら帯に出す（sent_at は予約・取り消しの時刻）。
--   「入れました／消しました」を押したら、その分を確認済みとして記録する（あとで送り手が動いても二重に知らせない）。
--   未確認の帯は7日間出し続ける（定休日をはさんで消えない。来店時刻を過ぎたものは出さない）。名前なしの電話予約は最初から転記済み。

/** SB：まだ誰も確認していない新しい予約（kind=new）と取り消し（kind=cancel）。定休日をはさんでも消えないよう7日以内・来店がこれからのもの */
create or replace function public.staff_new_unacked(p_staff text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  return (select coalesce(json_agg(x order by x.sent_at), '[]'::json) from (
    select r.id, 'new'::text as kind, r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name) as staff_name, s.sent_at, false as rescheduled
    from app_private.staff_push_sent s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '7 days' and r.starts_at > now() and r.status not in ('cancelled', 'no_show')
    union all
    -- 送り手が記録していない新しい AI 予約（2分たっても）
    select r.id, 'new', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), r.created_at, false
    from public.reservations r left join public.staff_members m on m.id = r.staff_id
    where r.source = 'app' and r.created_at > now() - interval '7 days' and r.created_at < now() - interval '2 minutes' and r.starts_at > now()
      and r.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
    union all
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), s.sent_at, app_private.staff_push_rescheduled(r.id)
    from app_private.staff_push_cancel s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '7 days' and r.starts_at > now()
    union all
    -- 送り手が記録していないアプリでの取り消し（2分たっても）
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), r.cancelled_at, app_private.staff_push_rescheduled(r.id)
    from public.reservations r left join public.staff_members m on m.id = r.staff_id
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason = 'お客様アプリからキャンセル'
      and r.cancelled_at > now() - interval '7 days' and r.cancelled_at < now() - interval '2 minutes' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = r.id)
  ) x);
end;
$$;

/** SB：サロンボードに入れました／消しました。p_ids＝画面に出ていた予約（無ければ、まだ確認していない全部：古い画面向け）。
 *  新しい予約は転記状態も「転記済み」にして履歴に残す。送り手がまだ記録していない分も、確認済みとして記録する */
create or replace function public.staff_ack_new(p_staff text, p_staff_name text default null, p_ids uuid[] default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_actor text := coalesce(nullif(btrim(coalesce(p_staff_name, '')), ''), 'SB'); r record; n int := 0;
begin
  perform app_private.assert_staff(p_staff);
  -- 送り手が記録していない分（画面に出ていたものだけ）を先に記録する
  if p_ids is not null then
    insert into app_private.staff_push_sent (reservation_id, sent_at)
    select q.id, q.created_at from public.reservations q
    where q.id = any(p_ids) and q.source = 'app' and q.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = q.id)
    on conflict do nothing;
    insert into app_private.staff_push_cancel (reservation_id, sent_at)
    select q.id, q.cancelled_at from public.reservations q
    where q.id = any(p_ids) and q.source = 'app' and q.status = 'cancelled' and q.cancel_reason = 'お客様アプリからキャンセル'
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = q.id)
    on conflict do nothing;
  end if;
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

revoke all on function public.staff_new_unacked(text), public.staff_ack_new(text, text, uuid[]) from public;
grant execute on function public.staff_new_unacked(text), public.staff_ack_new(text, text, uuid[]) to anon, authenticated, service_role;

-- 名前なしの「電話予約」（SB の声の枠埋め）は、サロンボードに入っている予約を写したもの：最初から転記済みにする
-- （未転記の数が毎日ふくらむと、AI 予約の入れ忘れの目印にならない）
create or replace function app_private.phone_fill_transfer_done()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.source = 'phone' and new.customer_name = '電話予約' and new.transfer_status = 'pending' then new.transfer_status := 'done'; end if;
  return new;
end;
$$;
revoke all on function app_private.phone_fill_transfer_done() from public, anon, authenticated;
drop trigger if exists phone_fill_transfer_done on public.reservations;
create trigger phone_fill_transfer_done before insert on public.reservations
  for each row execute function app_private.phone_fill_transfer_done();
