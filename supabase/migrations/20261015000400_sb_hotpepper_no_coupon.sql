-- HOT PEPPER メール取込の手直し：クーポン欄が「利用クーポンなし」のときはクーポン名にせず、メニュー名を使う

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
    'request', nullif(left(coalesce(f->>'ご要望・ご相談', f->>'ご要望', f->>'お客様からのご要望', ''), 300), ''),
    'fields', f));
end $$;

revoke all on function app_private.hpb_parse(text) from public, anon, authenticated, service_role;

-- すでに取り込んだ予約の表示名・メモを直す
update app_private.hpb_mails set parsed = parsed - 'coupon' where parsed->>'coupon' ~ 'クーポンなし|^なし$';
update public.reservation_items i set name = left(coalesce(m.parsed->>'menu', 'HOT PEPPER予約'), 80)
from app_private.hpb_mails m
where m.reservation_id = i.reservation_id and m.status = 'applied' and i.name ~ 'クーポンなし|^なし$';
update public.reservations set note = regexp_replace(note, E'\nクーポン：(利用)?クーポンなし', '')
where source = 'hotpepper' and note ~ 'クーポン：(利用)?クーポンなし';
