-- 空き枠うめ：本部 JOHNNY が「空いてる時間」をお客様にお知らせする（テイテイさんが「送って」と言ったときだけ）。
--   送る相手：お知らせを受け取っている人のうち、メンテナンスカットの期限が近い（0〜7日）人、または前回の来店から 21〜60 日の人。
--   除く人：この3日にお知らせを受けた人・これからの予約がある人。1回に送る人数は上限あり（既定 20）。
--   記録は notification_log（kind = 'open_slots'）。届かなくなった受け取り先は止める。

create or replace function public.hq_open_slot_targets(p_hq text, p_limit int default 20)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return (
    with cand as (
      select p.user_id,
             app_private.maintenance_days_remaining(p.user_id) as days_left,
             (select max(v.visit_date) from public.visit_log v where v.user_id = p.user_id) as last_visit
      from (select distinct user_id from public.push_subscriptions where disabled_at is null) p
      where not exists (select 1 from public.notification_log l where l.user_id = p.user_id and l.sent_at > now() - interval '3 days')
        and not exists (select 1 from public.reservations r where r.user_id = p.user_id and r.starts_at > now() and r.status = 'confirmed')
    ),
    pick as (
      select c.*, case when c.days_left between 0 and 7 then 'maintenance' else 'lapsed' end as reason
      from cand c
      where c.days_left between 0 and 7
         or (c.last_visit is not null and c.last_visit between app_private.today_jst() - 60 and app_private.today_jst() - 21)
      order by (c.days_left between 0 and 7) desc, c.days_left nulls last, c.last_visit
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
    )
    select json_build_object(
      'maintenance', (select count(*) from pick where reason = 'maintenance'),
      'lapsed', (select count(*) from pick where reason = 'lapsed'),
      'targets', coalesce((select json_agg(json_build_object('user_id', k.user_id, 'reason', k.reason,
          'subs', (select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                   from public.push_subscriptions s where s.user_id = k.user_id and s.disabled_at is null)))
        from pick k), '[]'::json))
  );
end $$;

create or replace function public.hq_open_slot_record(p_hq text, p_user_id text, p_title text, p_body text, p_delivered int, p_gone text[])
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  perform app_private.notify_record(p_user_id, 'open_slots', p_title, p_body, p_delivered, p_gone);
end $$;

revoke all on function public.hq_open_slot_targets(text, int), public.hq_open_slot_record(text, text, text, text, int, text[]) from public, anon, authenticated;
grant execute on function public.hq_open_slot_targets(text, int), public.hq_open_slot_record(text, text, text, text, int, text[]) to anon, authenticated;
