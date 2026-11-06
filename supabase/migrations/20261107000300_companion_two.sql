-- 3名まで（11/6 慶一郎さん「3名まで予約できるようにしよや」）：ご本人の予約につなげるお連れ様を 2名まで
--   ・ほかは今までどおり（同じ会員・同じ日・確定・お連れ様の予約をさらにお連れ様にはしない）
create or replace function public.customer_link_companion(p_session text, p_primary uuid, p_companion uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); a public.reservations; b public.reservations;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  select * into a from public.reservations where id = p_primary and user_id = v_user and status = 'confirmed' for update;
  select * into b from public.reservations where id = p_companion and user_id = v_user and status = 'confirmed' for update;
  if a.id is null or b.id is null or a.id = b.id or a.companion_of is not null then return json_build_object('error', 'not_found'); end if;
  if (a.starts_at at time zone 'Asia/Tokyo')::date <> (b.starts_at at time zone 'Asia/Tokyo')::date then return json_build_object('error', 'not_same_day'); end if;
  if b.companion_of = a.id then return json_build_object('ok', true); end if;
  if (select count(*) from public.reservations x where x.companion_of = a.id and x.id <> b.id and x.status = 'confirmed') >= 2 then
    return json_build_object('error', 'companion_exists');
  end if;
  update public.reservations set companion_of = a.id where id = b.id;
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.customer_link_companion(text, uuid, uuid) from public;
grant execute on function public.customer_link_companion(text, uuid, uuid) to anon, authenticated, service_role;
