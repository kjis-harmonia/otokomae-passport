-- SB の黒い帯：お連れ様の予約は「〇〇様（△△様のお連れ様）」と出す（11/6 慶一郎さん：お連れ様の予約がご本人の名前で2件並び、同じ人が2件取ったように見えた）
--   帯の行に companion_name（予約メモ「お連れ様：〇〇様」の名前）を足す。ほかは 20261107000600 と同じ
create or replace function public.staff_new_unacked(p_staff text)
returns json language plpgsql security definer set search_path = '' as $$
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
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason = 'お客様アプリからキャンセル'
      and r.cancelled_at > now() - interval '7 days' and r.cancelled_at < now() - interval '2 minutes' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id and s.acked_at is not null)
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = r.id)
  ) x);
end;
$$;
revoke all on function public.staff_new_unacked(text) from public;
grant execute on function public.staff_new_unacked(text) to anon, authenticated, service_role;
