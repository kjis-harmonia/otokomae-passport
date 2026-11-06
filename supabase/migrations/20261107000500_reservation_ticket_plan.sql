-- AI予約で選んだ券を予約と一緒に残す（11/6 慶一郎さん「店舗端末で読み込んだ際、何枚使用していくら決済したら良いのかわからん」）
--   ・これまでは、お客様の端末に覚えて、予約の当日の会員QRにだけ入れていた（当日以外・別の端末だと店に届かなかった）
--   ・予約を取ったときにアプリが送る。店舗端末の会計は、予約を開くとこの券を最初から選んで「何の券を何枚・いくら」を出す
--   ・券を使うのは今までどおり会計の確定（finalize_sale）。ここは「使う予定」の記録だけで、券もお金も動かさない
create table if not exists app_private.reservation_ticket_plans (
  reservation_id uuid primary key references public.reservations(id) on delete cascade,
  user_id        text not null,
  ticket_ids     uuid[] not null,
  created_at     timestamptz not null default now()
);
revoke all on table app_private.reservation_ticket_plans from public, anon, authenticated;

/** お客様：予約に使う券を残す（空なら消す）。自分（家族を含む）のまだ使っていない券だけ */
create or replace function public.customer_set_ticket_plan(p_session text, p_reservation_id uuid, p_ticket_ids uuid[])
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_ids uuid[];
begin
  if not exists (select 1 from public.reservations r where r.id = p_reservation_id and r.user_id = v_user and r.status = 'confirmed') then
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
$$;

/** 店舗端末：予約でお客様が選んだ券（今も使えるものだけ。使用済み・期限切れは外して返す） */
create or replace function public.staff_reservation_ticket_plan(p_token text, p_reservation_id uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_token);
  return (select json_build_object(
      'ticket_ids', coalesce((select json_agg(t.id order by t.amount desc, t.id) from public.tickets t
                              where t.id = any(p.ticket_ids) and not t.used and (t.expires_at is null or t.expires_at > now())), '[]'::json),
      'planned', cardinality(p.ticket_ids))
    from app_private.reservation_ticket_plans p where p.reservation_id = p_reservation_id);
end;
$$;

revoke all on function public.customer_set_ticket_plan(text, uuid, uuid[]), public.staff_reservation_ticket_plan(text, uuid) from public;
grant execute on function public.customer_set_ticket_plan(text, uuid, uuid[]), public.staff_reservation_ticket_plan(text, uuid) to anon, authenticated, service_role;
