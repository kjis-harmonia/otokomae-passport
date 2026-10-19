-- HOT PEPPER メール取込の手直し：予約のメモを短くする
--   ・ご要望が「-」など中身の無いものは書かない
--   ・メニュー名はクーポンを使った予約のときだけ書く（クーポンなしなら予約のメニュー名と同じなので）

create or replace function app_private.hpb_parse(p_text text)
returns jsonb language plpgsql immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare t text; line text; cur text; f jsonb := '{}'; m text[]; v_kind text; v_start timestamptz;
        v_dur int; v_name text; v_coupon text[]; c text;
begin
  t := translate(replace(replace(coalesce(p_text, ''), E'\r\n', E'\n'), E'\r', E'\n'),
                 '　０１２３４５６７８９：，', ' 0123456789:,');
  v_kind := case when t ~ '予約のキャンセルがありました' then 'cancel'
                 when t ~ '予約(内容)?の変更がありました|予約が変更されました' then 'change'
                 when t ~ '予約が入りました' then 'booking' else 'unknown' end;
  foreach line in array string_to_array(t, E'\n') loop
    if line ~ '^\s*■' then
      cur := left(btrim(regexp_replace(line, '^\s*■', ''), E' \t'), 30);
      f := f || jsonb_build_object(cur, '');
    elsif line ~ '^\s*◇' or btrim(line, E' \t') = '' then
      if cur is not null and f->>cur <> '' then cur := null; end if;
    elsif cur is not null then
      f := jsonb_set(f, array[cur], to_jsonb(concat_ws(E'\n', nullif(f->>cur, ''), btrim(line, E' \t'))));
    end if;
  end loop;

  m := regexp_match(coalesce(f->>'来店日時', ''), '(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日[^0-9]*(\d{1,2}):(\d{2})');
  if m is not null then
    begin
      v_start := make_timestamptz(m[1]::int, m[2]::int, m[3]::int, m[4]::int, m[5]::int, 0, 'Asia/Tokyo');
    exception when others then v_start := null;
    end;
  end if;
  m := regexp_match(coalesce(f->>'メニュー', ''), '施術時間目安:\s*(?:(\d+)時間)?\s*(?:(\d+)分)?');
  if m is not null then v_dur := nullif(coalesce(m[1]::int, 0) * 60 + coalesce(m[2]::int, 0), 0); end if;
  if v_dur not between 5 and 600 then v_dur := null; end if;
  v_name := split_part(coalesce(f->>'氏名', ''), E'\n', 1);
  -- クーポン：[全員] などの札を除いた最初の行が名前、残りが説明
  foreach c in array string_to_array(coalesce(f->>'ご利用クーポン', ''), E'\n') loop
    if c !~ '^\[[^]]*\]$' and c !~ 'クーポンなし|^なし$' and c <> '' then v_coupon := v_coupon || c; end if;
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'kind', v_kind,
    'external_ref', substring(coalesce(f->>'予約番号', '') from '[A-Za-z]{1,4}[0-9]{5,}'),
    'customer_name', left(nullif(btrim(regexp_replace(v_name, '[（(].*$', '')), ''), 60),
    'customer_kana', nullif(btrim(substring(v_name from '[（(]([^）)]*)[）)]')), ''),
    'starts_at', v_start,
    'stylist', nullif(split_part(coalesce(f->>'スタイリスト', ''), E'\n', 1), ''),
    'menu', nullif(split_part(coalesce(f->>'メニュー', ''), E'\n', 1), ''),
    'duration_min', v_dur,
    'menu_price', replace(substring(coalesce(f->>'メニュー', '') from 'メニュー金額:\s*([0-9,]+)円'), ',', '')::int,
    'coupon', v_coupon[1],
    'coupon_detail', nullif(array_to_string(v_coupon[2:], ' '), ''),
    'total_price', replace(coalesce(substring(coalesce(f->>'合計金額', '') from 'お支払い予定金額\s*([0-9,]+)円'),
                                    substring(coalesce(f->>'合計金額', '') from '予約時合計金額\s*([0-9,]+)円')), ',', '')::int,
    'phone', substring(coalesce(f->>'電話番号', '') from '[0-9][0-9-]{8,14}'),
    'request', nullif(regexp_replace(left(coalesce(f->>'ご要望・ご相談', f->>'ご要望', f->>'お客様からのご要望', ''), 300), '^([-－ー―‐\s]*|なし)$', ''), ''),
    'fields', f));
end $$;

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
end $$;

revoke all on function app_private.hpb_parse(text) from public, anon, authenticated, service_role;
revoke all on function app_private.hpb_import(text, text, text) from public, anon, authenticated, service_role;

-- すでに取り込んだ予約のメモを直す
update app_private.hpb_mails set parsed = parsed - 'request' where parsed->>'request' ~ '^[-－ー―‐\s　]*$|^なし$';
update public.reservations r set note = left(concat_ws(E'\n',
    'HOT PEPPER予約' || coalesce('（' || (m.parsed->>'customer_kana') || '）', ''),
    case when m.parsed->>'coupon' is not null then 'クーポン：' || (m.parsed->>'coupon') end,
    case when m.parsed->>'coupon' is not null and m.parsed->>'menu' is not null then 'メニュー：' || (m.parsed->>'menu') end,
    case when m.parsed->>'request' is not null then 'ご要望：' || (m.parsed->>'request') end), 500)
from app_private.hpb_mails m
where m.reservation_id = r.id and m.status = 'applied' and m.kind in ('booking', 'change') and r.source = 'hotpepper';
