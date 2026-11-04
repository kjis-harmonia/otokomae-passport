-- ガチャ工程③（11/4）：お連れ様
--   ・お連れ様の予約を、ご本人の予約に正式につなぐ（reservations.companion_of）。これまでは予約メモの「お連れ様：〇〇様」と端末の記録だけだった
--   ・無料のガチャ券（free_menu がある券）は、お連れ様1名の予約にも使える（紹介のきっかけに）。割引券はご本人だけ
--   ・つなげるのは同じ会員の、同じ日の、まだ終わっていない予約どうし。ご本人の予約1つにお連れ様は1名

alter table public.reservations add column if not exists companion_of uuid references public.reservations(id) on delete set null;
create index if not exists reservations_companion_of on public.reservations (companion_of) where companion_of is not null;

/** お客様：お連れ様の予約をご本人の予約につなぐ（AI 予約でお二人を取ったとき） */
create or replace function public.customer_link_companion(p_session text, p_primary uuid, p_companion uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); a public.reservations; b public.reservations;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  select * into a from public.reservations where id = p_primary and user_id = v_user and status = 'confirmed' for update;
  select * into b from public.reservations where id = p_companion and user_id = v_user and status = 'confirmed' for update;
  if a.id is null or b.id is null or a.id = b.id or a.companion_of is not null then return json_build_object('error', 'not_found'); end if;
  if (a.starts_at at time zone 'Asia/Tokyo')::date <> (b.starts_at at time zone 'Asia/Tokyo')::date then return json_build_object('error', 'not_same_day'); end if;
  if exists (select 1 from public.reservations x where x.companion_of = a.id and x.id <> b.id and x.status = 'confirmed') then
    return json_build_object('error', 'companion_exists');
  end if;
  update public.reservations set companion_of = a.id where id = b.id;
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.customer_link_companion(text, uuid, uuid) from public;
grant execute on function public.customer_link_companion(text, uuid, uuid) to anon, authenticated, service_role;

/** その予約に券が使えるか（工程②に、お連れ様の予約は無料券だけ、を足す） */
create or replace function app_private.gacha_unfit(p_user text, p_reservation uuid)
returns text language plpgsql stable set search_path = '' as $$
declare h app_private.gacha_holdings; r public.reservations; v_codes text[];
begin
  select * into h from app_private.gacha_holdings where user_id = p_user and used_at is null and expires_at > now();
  if h.user_id is null then return 'no_ticket'; end if;
  r := app_private.gacha_active_reservation(p_reservation);
  if r.id is null or r.user_id is distinct from p_user then return 'not_found'; end if;
  if r.companion_of is not null and h.free_menu is null then return 'companion'; end if;
  if h.expires_at <= r.starts_at then return 'expired'; end if;
  if h.weekday_only and app_private.gacha_offday(r.starts_at) then return 'weekday'; end if;
  select coalesce(array_agg(menu_code), '{}') into v_codes from public.reservation_items where reservation_id = r.id;
  if h.menu_codes is not null and not (v_codes && h.menu_codes) then return 'menu'; end if;
  if h.menu_codes is null and not exists (select 1 from unnest(v_codes) c where c <> 'maintenance') then return 'menu'; end if;
  return null;
end;
$$;
