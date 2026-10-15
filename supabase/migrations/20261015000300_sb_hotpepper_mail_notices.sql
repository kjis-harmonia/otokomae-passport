-- HOT PEPPER メール取込の手直し（Gmail で実際に届いたメールを見て）
--   ・「本日分の未対応予約のお知らせ」は予約ではないので「お知らせ」として残すだけにする（要確認に出さない）
--   ・取込を始める前の予約のキャンセル（予約表に無い）は、することが無いので「対応不要」にする

alter table app_private.hpb_mails drop constraint if exists hpb_mails_status_check;
alter table app_private.hpb_mails add constraint hpb_mails_status_check
  check (status in ('applied', 'duplicate', 'needs_review', 'checked', 'ignored'));

create or replace function app_private.hpb_import(p_text text, p_via text, p_actor text)
returns jsonb language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
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
        case when p->>'menu' is not null then 'メニュー：' || (p->>'menu') end,
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
end $$;

revoke all on function app_private.hpb_import(text, text, text) from public, anon, authenticated, service_role;

update app_private.hpb_mails set status = 'ignored', reason = 'notice'
where status = 'needs_review' and kind = 'unknown' and raw_text ~ '未対応予約のお知らせ';
update app_private.hpb_mails set status = 'ignored'
where status = 'needs_review' and kind = 'cancel' and reason = 'not_found';
