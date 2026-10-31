-- 同じ担当で同じ時刻に始まる予約は取らない（開始を30分以上ずらす）。
-- HOT PEPPER の実際の予約は、重なるときも必ず30分以上ずらしていた（10/15〜12/31、同時刻の開始は0件。パーマを置いている間に次のカットなど）。
-- AI 予約・店舗端末・本部の空き（available_slots・create_hold・create_reservation・reschedule）はこの決まりに従う。
-- SB の手入力（sb_free_lane）はスタッフの判断で入れられるよう今までどおり（11/1 慶一郎さん）。

create or replace function app_private.booking_free_lane(p_staff uuid, p_start timestamptz, p_until timestamptz, p_exclude_reservation uuid default null, p_exclude_hold uuid default null)
returns smallint language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select l::smallint from public.staff_members s
  cross join lateral generate_series(0, s.booking_capacity - 1) l
  where s.id = p_staff and s.is_active and s.is_bookable and p_until > p_start
    and exists (select 1 from app_private.effective_shifts(s.id,(p_start at time zone 'Asia/Tokyo')::date) sh
                where sh.st <= p_start and sh.en >= p_until)
    and not exists (select 1 from public.time_blocks b where (b.staff_id = s.id or b.staff_id is null)
                    and tstzrange(b.starts_at,b.ends_at) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.reservations r where r.staff_id=s.id and r.booking_lane=l
                    and r.id is distinct from p_exclude_reservation
                    and r.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
                    and tstzrange(r.starts_at,r.occupied_until) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.booking_holds h where h.staff_id=s.id and h.booking_lane=l
                    and h.id is distinct from p_exclude_hold
                    and h.released_at is null and h.converted_reservation_id is null and h.expires_at>now()
                    and tstzrange(h.starts_at,h.occupied_until) && tstzrange(p_start,p_until))
    -- 開始を30分以上ずらす：同じ担当のほかの予約・仮押さえの開始と30分未満のずれなら入れない
    and not exists (select 1 from public.reservations r where r.staff_id=s.id
                    and r.id is distinct from p_exclude_reservation
                    and r.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
                    and r.starts_at > p_start - interval '30 minutes' and r.starts_at < p_start + interval '30 minutes')
    and not exists (select 1 from public.booking_holds h where h.staff_id=s.id
                    and h.id is distinct from p_exclude_hold
                    and h.released_at is null and h.converted_reservation_id is null and h.expires_at>now()
                    and h.starts_at > p_start - interval '30 minutes' and h.starts_at < p_start + interval '30 minutes')
  order by l limit 1
$$;

-- SB の手入力は、ずらしの決まりなし（今までの booking_free_lane と同じ中身）
create or replace function app_private.sb_free_lane(p_staff uuid, p_start timestamptz, p_until timestamptz, p_exclude uuid default null)
returns smallint language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select l::smallint from public.staff_members s
  cross join lateral generate_series(0, s.booking_capacity - 1) l
  where s.id = p_staff and s.is_active and s.is_bookable and p_until > p_start
    and exists (select 1 from app_private.effective_shifts(s.id,(p_start at time zone 'Asia/Tokyo')::date) sh
                where sh.st <= p_start and sh.en >= p_until)
    and not exists (select 1 from public.time_blocks b where (b.staff_id = s.id or b.staff_id is null)
                    and tstzrange(b.starts_at,b.ends_at) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.reservations r where r.staff_id=s.id and r.booking_lane=l
                    and r.id is distinct from p_exclude
                    and r.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
                    and tstzrange(r.starts_at,r.occupied_until) && tstzrange(p_start,p_until))
    and not exists (select 1 from public.booking_holds h where h.staff_id=s.id and h.booking_lane=l
                    and h.released_at is null and h.converted_reservation_id is null and h.expires_at>now()
                    and tstzrange(h.starts_at,h.occupied_until) && tstzrange(p_start,p_until))
  order by l limit 1
$$;
