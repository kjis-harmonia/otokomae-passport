-- SB の「新しい予約」の確認：誰かが SB で「確認しました」を押すまで、全端末で帯を出し、2分ごとに声で知らせる。
-- 確認したかどうかは全端末で共通（1台で押せば、ほかの端末も止まる）。

alter table app_private.staff_push_sent add column if not exists acked_at timestamptz;
alter table app_private.staff_push_sent add column if not exists acked_by text;
-- 入れる前に送った（または送らないことにした）予約は確認済みにする
update app_private.staff_push_sent set acked_at = now(), acked_by = 'migration' where acked_at is null;

/** SB：まだ誰も確認していない新しい AI 予約（1日以内・取り消し以外） */
create or replace function public.staff_new_unacked(p_staff text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  return (select coalesce(json_agg(json_build_object('id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name,
      'staff_name', m.display_name, 'sent_at', s.sent_at) order by s.sent_at), '[]'::json)
    from app_private.staff_push_sent s join public.reservations r on r.id = s.reservation_id join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show'));
end;
$$;

/** SB：確認しました（今まだ確認していない分をまとめて） */
create or replace function public.staff_ack_new(p_staff text, p_staff_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform app_private.assert_staff(p_staff);
  update app_private.staff_push_sent set acked_at = now(), acked_by = coalesce(nullif(btrim(coalesce(p_staff_name, '')), ''), 'SB')
  where acked_at is null;
  get diagnostics n = row_count;
  return json_build_object('acked', n);
end;
$$;

revoke all on function public.staff_new_unacked(text), public.staff_ack_new(text, text) from public;
grant execute on function public.staff_new_unacked(text), public.staff_ack_new(text, text) to anon, authenticated, service_role;
