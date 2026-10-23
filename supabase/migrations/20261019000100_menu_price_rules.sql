-- 料金の正本をサーバーに一本化する（アプリ・JOHNNY・会計・本部が同じ計算を使う）。
--   service_menus.price        ＝ 会員価格（プレミアムクーポンの料金。プレミアムでないメニューは、ふつうの料金）
--   service_menus.normal_price ＝ 通常価格（プレミアム対象メニューだけ。null ならプレミアム対象外）
--   service_menus.member_label ＝ プレミアムクーポンの名前（GINJIRO CLASSICS・SPECIAL PERM・GINPARA）
--   会員価格になる条件：平日は終日、土日祝は 17:00〜19:00 開始（日本時間）。祝日は app_private.holidays（毎年足す）
--   それ以外の時間は通常価格。計算は app_private.menu_charge だけで行う
-- 料金は 2026-10-19 にお店が確定：アイパー・カールアイパー・パンチ・ニグロ・濡れパン 通常9,000／会員8,000、
--   ツイスト 通常12,000／会員10,000、銀パラ 通常16,000／会員15,000

alter table public.service_menus add column if not exists member_label text;

create table if not exists app_private.holidays (
  day date primary key,
  name text
);
insert into app_private.holidays (day, name) values
  ('2026-11-03', '文化の日'), ('2026-11-23', '勤労感謝の日'),
  ('2027-01-01', '元日'), ('2027-01-11', '成人の日'), ('2027-02-11', '建国記念の日'), ('2027-02-23', '天皇誕生日'),
  ('2027-03-22', '春分の日（振替）'), ('2027-04-29', '昭和の日'), ('2027-05-03', '憲法記念日'), ('2027-05-04', 'みどりの日'),
  ('2027-05-05', 'こどもの日'), ('2027-07-19', '海の日'), ('2027-08-11', '山の日'), ('2027-09-20', '敬老の日'),
  ('2027-09-23', '秋分の日'), ('2027-10-11', 'スポーツの日'), ('2027-11-03', '文化の日'), ('2027-11-23', '勤労感謝の日')
on conflict (day) do nothing;

-- お店が確定した料金
update public.service_menus set price = 8000, normal_price = 9000, member_label = 'GINJIRO CLASSICS', updated_at = now()
  where code in ('perm-iper', 'perm-curl-iper', 'perm-punch', 'perm-negro', 'perm-nurepan');
update public.service_menus set price = 10000, normal_price = 12000, member_label = 'SPECIAL PERM', updated_at = now() where code = 'perm-twist';
update public.service_menus set price = 15000, normal_price = 16000, member_label = 'GINPARA', updated_at = now() where code = 'perm-ginpara-curly';

/** その日時が会員価格の時間か（平日は終日、土日祝は 17:00〜19:00 開始） */
create or replace function app_private.member_price_time(p_starts_at timestamptz)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select case
    when extract(isodow from (p_starts_at at time zone 'Asia/Tokyo')) in (6, 7)
      or exists (select 1 from app_private.holidays h where h.day = (p_starts_at at time zone 'Asia/Tokyo')::date)
    then (p_starts_at at time zone 'Asia/Tokyo')::time between '17:00' and '19:00'
    else true end
$$;

/** 1 メニューの料金（その日時に払う額 charge まで） */
create or replace function app_private.menu_charge(p_code text, p_starts_at timestamptz)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'code', m.code, 'name', m.name, 'price_from', m.price_from,
    'normal_price', m.normal_price, 'member_price', case when m.normal_price is not null then m.price end,
    'member_label', m.member_label,
    'eligible', case when m.normal_price is null then null else app_private.member_price_time(p_starts_at) end,
    'charge', case when m.normal_price is not null and not app_private.member_price_time(p_starts_at) then m.normal_price else m.price end)
  from public.service_menus m where m.code = p_code
$$;

create or replace function app_private.price_quote(p_menu_codes text[], p_starts_at timestamptz)
returns json language sql stable security definer set search_path = public, pg_temp as $$
  with items as (
    select app_private.menu_charge(c, p_starts_at) j, ord from unnest(p_menu_codes) with ordinality as u(c, ord)
  )
  select json_build_object('starts_at', p_starts_at,
    'items', coalesce((select json_agg(j order by ord) from items where j is not null), '[]'::json),
    'total', (select sum((j->>'charge')::int) from items where j is not null),
    'normal_total', (select sum(coalesce((j->>'normal_price')::int, (j->>'charge')::int)) from items where j is not null))
$$;

-- ── 入口 ──────────────────────────────────────────────────────────────

/** 料金表（誰でも読める公開情報）：メニューの料金・通常価格・クーポン名と、会員価格の時間・祝日 */
create or replace function public.menu_price_rules()
returns json language sql stable security definer set search_path = public, pg_temp as $$
  select json_build_object(
    'menus', coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'price', m.price, 'normal_price', m.normal_price,
                'member_label', m.member_label, 'price_from', m.price_from) order by m.sort_order, m.name)
              from public.service_menus m where m.is_active), '[]'::json),
    'member_time', json_build_object('weekday', 'all_day', 'weekend_holiday_from', '17:00', 'weekend_holiday_to', '19:00'),
    'holidays', coalesce((select json_agg(h.day order by h.day) from app_private.holidays h where h.day >= app_private.today_jst()), '[]'::json))
$$;

/** お客様：予約の日時での料金（確認画面） */
create or replace function public.customer_price_quote(p_session text, p_menu_codes text[], p_starts_at timestamptz)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.session_user_id(p_session);
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 10 or p_starts_at is null then return json_build_object('error', 'invalid_value'); end if;
  return app_private.price_quote(p_menu_codes, p_starts_at);
end $$;

/** 店舗端末：お会計の料金（予約の日時、または今の時刻） */
create or replace function public.staff_price_quote(p_staff text, p_menu_codes text[], p_starts_at timestamptz default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 20 then return json_build_object('error', 'invalid_value'); end if;
  return app_private.price_quote(p_menu_codes, coalesce(p_starts_at, now()));
end $$;

-- ── 料金の変更（本部 JOHNNY）：通常価格も一緒に変えられるように ───────────────

alter table public.menu_price_changes add column if not exists old_normal_price int;
alter table public.menu_price_changes add column if not exists new_normal_price int check (new_normal_price is null or new_normal_price between 0 and 1000000);

create or replace function app_private.price_change_json(c public.menu_price_changes)
returns json language sql stable as $$
  select json_build_object('id', c.id, 'menu_code', c.menu_code, 'menu_name', c.menu_name, 'old_price', c.old_price, 'new_price', c.new_price,
    'old_normal_price', c.old_normal_price, 'new_normal_price', c.new_normal_price,
    'starts_on', c.starts_on, 'status', c.status, 'note', c.note, 'created_at', c.created_at, 'applied_at', c.applied_at)
$$;

create or replace function app_private.apply_price_changes()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.menu_price_changes; n int := 0; cur public.service_menus; v_text text;
begin
  for c in select * from public.menu_price_changes where status = 'scheduled' and starts_on <= app_private.today_jst() order by starts_on, created_at loop
    select * into cur from public.service_menus where code = c.menu_code;
    update public.service_menus set price = c.new_price, normal_price = coalesce(c.new_normal_price, normal_price), updated_at = now() where code = c.menu_code;
    update public.menu_price_changes set status = 'applied', applied_at = now(), old_price = coalesce(old_price, cur.price),
      old_normal_price = coalesce(old_normal_price, cur.normal_price) where id = c.id;
    v_text := case when coalesce(c.new_normal_price, cur.normal_price) is not null
      then c.menu_name || ' を 通常 ' || to_char(coalesce(c.new_normal_price, cur.normal_price), 'FM999,999,999') || '円／会員 ' || to_char(c.new_price, 'FM999,999,999') || '円 にしました。'
      else c.menu_name || ' を ' || coalesce(to_char(coalesce(c.old_price, cur.price), 'FM999,999,999') || '円 → ', '') || to_char(c.new_price, 'FM999,999,999') || '円 にしました。' end;
    perform app_private.hq_message_put('to_owner', 'note', '【料金反映】' || c.menu_name, v_text || 'アプリの予約・会計も新しい料金です。', false);
    n := n + 1;
  end loop;
  return n;
end $$;

drop function if exists public.hq_schedule_price_change(text, text, int, date, text);
create or replace function public.hq_schedule_price_change(p_hq text, p_code text, p_new_price int, p_starts_on date, p_note text default null, p_new_normal_price int default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare m public.service_menus; c public.menu_price_changes;
begin
  perform app_private.assert_hq(p_hq);
  select * into m from public.service_menus where code = p_code and is_active;
  if m.id is null then return json_build_object('error', 'menu_not_found'); end if;
  if p_new_price is null or p_new_price < 0 or p_new_price > 1000000 or p_starts_on is null then return json_build_object('error', 'invalid_value'); end if;
  if p_new_normal_price is not null and (p_new_normal_price < p_new_price or p_new_normal_price > 1000000) then return json_build_object('error', 'invalid_value'); end if;
  update public.menu_price_changes set status = 'cancelled' where menu_code = p_code and status = 'scheduled';
  insert into public.menu_price_changes (menu_code, menu_name, old_price, new_price, old_normal_price, new_normal_price, starts_on, note)
  values (m.code, m.name, m.price, p_new_price, m.normal_price, p_new_normal_price, p_starts_on, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning * into c;
  if p_starts_on <= app_private.today_jst() then perform app_private.apply_price_changes(); select * into c from public.menu_price_changes where id = c.id; end if;
  return app_private.price_change_json(c);
end $$;

create or replace function public.hq_menu_prices(p_hq text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'kind', m.kind, 'category', m.category,
      'price', m.price, 'normal_price', m.normal_price, 'member_label', m.member_label, 'booking', m.booking_enabled,
      'scheduled', (select json_build_object('new_price', c.new_price, 'new_normal_price', c.new_normal_price, 'starts_on', c.starts_on) from public.menu_price_changes c
                    where c.menu_code = m.code and c.status = 'scheduled' order by c.starts_on limit 1))
    order by m.sort_order, m.name) from public.service_menus m where m.is_active), '[]'::json);
end $$;

revoke all on function app_private.member_price_time(timestamptz), app_private.menu_charge(text, timestamptz), app_private.price_quote(text[], timestamptz) from public;
revoke all on function public.menu_price_rules(), public.customer_price_quote(text, text[], timestamptz), public.staff_price_quote(text, text[], timestamptz),
  public.hq_schedule_price_change(text, text, int, date, text, int) from public, anon, authenticated;
grant execute on function public.menu_price_rules(), public.customer_price_quote(text, text[], timestamptz), public.staff_price_quote(text, text[], timestamptz),
  public.hq_schedule_price_change(text, text, int, date, text, int) to anon, authenticated;

notify pgrst, 'reload schema';
