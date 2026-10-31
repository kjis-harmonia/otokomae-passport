-- HOT PEPPER の予約が同時枠（3枠）を超えたとき、断らずに枠の外の段（4本目〜6本目）に入れる。
-- お客様には確定済みの予約なので、SB に載せずに来店されるより、赤い「枠オーバー」で見せる方が安全（11/1 慶一郎さん：佐々木様 15:30 が入らなかった）。
-- AI 予約・SB の新規予約は今までどおり同時枠の中だけ（hpb_lane・sb_plan は変えない）。

alter table public.reservations drop constraint reservations_booking_lane_check;
alter table public.reservations add constraint reservations_booking_lane_check check (booking_lane between 0 and 5);

create or replace function app_private.hpb_overflow_lane(p_staff uuid, p_start timestamptz, p_until timestamptz, p_exclude uuid)
returns smallint language sql stable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select l::smallint from public.staff_members s
  cross join lateral generate_series(s.booking_capacity, 5) l
  where s.id = p_staff and s.is_active
    and not exists (select 1 from public.reservations r where r.staff_id = s.id and r.booking_lane = l
                    and r.id is distinct from p_exclude
                    and r.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
                    and tstzrange(r.starts_at,r.occupied_until) && tstzrange(p_start,p_until))
  order by l limit 1
$$;
revoke all on function app_private.hpb_overflow_lane(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated, service_role;

-- 同時枠を超える予約を止める見張り：HOT PEPPER の予約（お客様に確定済み）だけは枠の外の段を許す
create or replace function app_private.sb_capacity_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if new.status in ('confirmed','checked_in','in_service','awaiting_payment','completed')
     and new.occupied_until > now()
     and new.source is distinct from 'hotpepper'
     and new.booking_lane >= (select booking_capacity from public.staff_members where id = new.staff_id) then
    raise exception 'booking_capacity_exceeded' using errcode = '23514';
  end if;
  return new;
end $$;

CREATE OR REPLACE FUNCTION app_private.hpb_import(p_text text, p_via text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
declare v_hash text; v_mail uuid; p jsonb; v_kind text; v_ref text; r public.reservations; s record;
        v_start timestamptz; v_dur int; v_until timestamptz; v_staff uuid; v_lane smallint; v_nominated boolean;
        v_status text := 'needs_review'; v_reason text; v_warn text[] := '{}'; v_res uuid; v_client uuid;
        v_menu public.service_menus; v_item_name text; v_price int; v_note text; v_before jsonb; v_after jsonb;
        v_date date; v_actor_type text := case when p_via = 'paste' then 'staff' else 'system' end;
begin
  if p_text is null or length(p_text) not between 20 and 20000 then return jsonb_build_object('error', 'invalid_mail'); end if;
  v_hash := app_private.sha256_hex(p_text);
  perform pg_advisory_xact_lock(hashtextextended('ginjiro_hpb_mail', 0));
  select id into v_mail from app_private.hpb_mails where text_hash = v_hash;
  if found then return app_private.hpb_mail_json(v_mail) || jsonb_build_object('repeat', true); end if;

  p := app_private.hpb_parse(p_text);
  v_kind := p->>'kind'; v_ref := p->>'external_ref';
  v_start := (p->>'starts_at')::timestamptz; v_dur := (p->>'duration_min')::int;
  perform app_private.lock_all_staff();
  if v_ref is not null then
    select * into r from public.reservations where source = 'hotpepper' and external_ref = v_ref for update;
  end if;

  if v_kind = 'unknown' and p_text ~ '未対応予約のお知らせ' then
    v_status := 'ignored'; v_reason := 'notice';
  elsif v_ref is null or v_kind = 'unknown' then
    v_reason := 'unreadable';
  elsif v_kind = 'cancel' then
    v_res := r.id;
    if r.id is null then v_status := 'ignored'; v_reason := 'not_found';
    elsif r.status = 'cancelled' then v_status := 'duplicate';
    elsif r.status <> 'confirmed' then v_reason := 'invalid_status';
    else
      perform app_private.set_reservation_status(r.id, 'cancelled', v_actor_type, p_actor, 'HOT PEPPERでキャンセル');
      update public.reservations set transfer_status = 'not_required' where id = r.id;
      v_status := 'applied';
    end if;
  elsif v_kind = 'booking' and r.id is not null then
    v_status := 'duplicate'; v_res := r.id;
  elsif v_kind = 'booking' and exists (select 1 from app_private.hpb_mails where external_ref = v_ref and kind = 'cancel') then
    -- キャンセルのメールが先に届いていた予約は入れない（そのキャンセルも片付いたことにする）
    v_status := 'duplicate'; v_reason := 'already_cancelled';
    update app_private.hpb_mails set status = 'applied', reason = null
    where external_ref = v_ref and kind = 'cancel' and status = 'needs_review';
  elsif r.id is not null and r.status <> 'confirmed' then
    v_reason := 'invalid_status'; v_res := r.id;
  elsif v_start is null or v_dur is null or p->>'customer_name' is null then
    v_reason := 'unreadable'; v_res := r.id;
  else
    v_until := v_start + make_interval(mins => v_dur);
    v_date := (v_start at time zone 'Asia/Tokyo')::date;
    select id into v_staff from public.staff_members
    where is_active and regexp_replace(display_name, '\s', '', 'g') = regexp_replace(coalesce(p->>'stylist', ''), '\s', '', 'g')
    limit 1;
    v_nominated := v_staff is not null;
    if v_staff is not null then
      v_lane := app_private.hpb_lane(v_staff, v_start, v_until, r.id);
    else
      if p->>'stylist' is not null and p->>'stylist' !~ '指名なし|なし|フリー' then v_warn := v_warn || 'unknown_stylist'::text; end if;
      for s in select id from public.staff_members where is_active and is_bookable
               order by case when id = r.staff_id then 0 else 1 end, app_private.booked_minutes(id, v_date), sort_order, display_name loop
        v_lane := app_private.hpb_lane(s.id, v_start, v_until, r.id);
        if v_lane is not null then v_staff := s.id; exit; end if;
      end loop;
    end if;
    if v_lane is null then
      -- 同時枠が埋まっていても、HOT PEPPER の予約はお客様に確定済み。枠の外（4本目〜）に入れて SB で赤く出す（11/1 慶一郎さん）
      if v_staff is null then
        select id into v_staff from public.staff_members where is_active and is_bookable
        order by case when id = r.staff_id then 0 else 1 end, app_private.booked_minutes(id, v_date), sort_order, display_name limit 1;
      end if;
      if v_staff is not null then
        v_lane := app_private.hpb_overflow_lane(v_staff, v_start, v_until, r.id);
        if v_lane is not null then v_warn := v_warn || 'over_capacity'::text; end if;
      end if;
    end if;
    if v_lane is null then
      v_reason := 'slot_taken'; v_res := r.id;
    else
      if not exists (select 1 from app_private.effective_shifts(v_staff, v_date) e where e.st <= v_start and e.en >= v_until) then
        v_warn := v_warn || 'out_of_hours'::text;
      end if;
      select * into v_menu from public.service_menus
      where regexp_replace(name, '\s', '', 'g') = regexp_replace(coalesce(p->>'menu', ''), '\s', '', 'g') limit 1;
      v_item_name := left(coalesce(p->>'coupon', p->>'menu', 'HOT PEPPER予約'), 80);
      v_price := coalesce((p->>'total_price')::int, (p->>'menu_price')::int);
      v_note := left(concat_ws(E'\n',
        'HOT PEPPER予約' || coalesce('（' || (p->>'customer_kana') || '）', ''),
        case when p->>'coupon' is not null then 'クーポン：' || (p->>'coupon') end,
        case when p->>'coupon' is not null and p->>'menu' is not null then 'メニュー：' || (p->>'menu') end,
        case when p->>'request' is not null then 'ご要望：' || (p->>'request') end), 500);
      if r.id is null then
        v_client := app_private.booking_client(jsonb_build_object('external_ref', v_ref, 'customer_phone', p->>'phone'),
          null, p->>'customer_name', 'hotpepper', v_actor_type, p_actor);
        insert into public.reservations(staff_id, booking_lane, nominated, staff_confirmed, client_id, customer_name, customer_phone,
          starts_at, ends_at, occupied_until, source, external_ref, total_price, note, created_by, transfer_status)
        values (v_staff, v_lane, v_nominated, v_nominated, v_client, p->>'customer_name', p->>'phone',
          v_start, v_until, v_until, 'hotpepper', v_ref, v_price, v_note, p_actor, 'not_required')
        returning id into v_res;
        if v_kind = 'change' then v_warn := v_warn || 'created_from_change'::text; end if;
      else
        v_res := r.id; v_before := app_private.sb_reservation(r.id);
        update public.reservations set staff_id = v_staff, booking_lane = v_lane, nominated = v_nominated,
          staff_confirmed = v_nominated or (staff_confirmed and staff_id = v_staff),
          starts_at = v_start, ends_at = v_until, occupied_until = v_until, total_price = v_price, note = v_note,
          transfer_status = 'not_required', updated_at = clock_timestamp()
        where id = r.id;
        delete from public.reservation_items where reservation_id = r.id;
      end if;
      insert into public.reservation_items(reservation_id, menu_id, menu_code, name, duration_min, buffer_after_min, price, sort_order)
      values (v_res, v_menu.id, coalesce(v_menu.code, 'hotpepper'), v_item_name, v_dur, 0, v_price, 0);
      v_after := app_private.sb_reservation(v_res);
      perform app_private.log_reservation_event(v_res, case when v_before is null then 'created' else 'rescheduled' end,
        v_actor_type, p_actor, v_before, v_after, 'HOT PEPPERのメールから取込');
      v_status := 'applied';
    end if;
  end if;

  insert into app_private.hpb_mails(text_hash, via, kind, external_ref, parsed, raw_text, status, reason, warnings, reservation_id, created_by)
  values (v_hash, p_via, v_kind, v_ref, p, p_text, v_status, v_reason, v_warn, v_res, p_actor)
  returning id into v_mail;
  return app_private.hpb_mail_json(v_mail);
end $function$;

-- 枠が埋まっていて入らなかった、まだ先（12時間前まで）の HOT PEPPER の予約を入れ直す（前の記録は残して印を付ける）
do $$ declare m record;
begin
  for m in select id, raw_text, via, created_by from app_private.hpb_mails
           where reason = 'slot_taken' and status in ('needs_review','checked')
             and (parsed->>'starts_at')::timestamptz > now() - interval '12 hours'
           order by created_at loop
    update app_private.hpb_mails set text_hash = app_private.sha256_hex(text_hash || ':retried'), reason = 'retried' where id = m.id;
    perform app_private.hpb_import(m.raw_text, m.via, m.created_by);
  end loop;
end $$;
