-- Black Monday（11/17 オーナー決定）と新メニュー「ピンパーマ」
--   毎週月曜（祝日の月曜も）に来店する、アプリで取った予約（reservations.source = 'app'）だけ。対象のパーマ1メニューにつき ¥2,000 引き。
--   開始は 2026-11-23（月・祝）の来店から。開始日・額・対象メニューは app_private.black_monday_settings（1行）で変える。
--   ・予約の印 app_private.black_monday_marks：予約・予約のメニューのトリガーで、どこから変えても作り直す（月曜以外へ変えたら外れる・取消で消える）
--   ・お会計（finalize_sale）で DB が額を決めて引く。accounting_discounts に kind 'campaign'・label 'Black Monday' で残す
--   ・Welcome・再来店パーマクーポン（is_perm_coupon）を使う会計では引かない。ガチャの無料券は Black Monday のあとの残りをまかなう
--   ・予約（reservation_json）・会計の情報（checkout_context_json）・予約変更の確認（reservation_review）・料金表（menu_price_rules）に black_monday を足す
-- 元にした定義は本番（ufyzynpmkxytnhebombq）の今の定義（pg_get_functiondef・11/17 読み取り）。Staging には銀オク入りの版があるので、
--   Staging ではこのあと supabase/staging-only/ の Black Monday の版（README.md の表）を流すこと。
-- 戻し方：supabase/rollback/20261117_black_monday_off.sql

-- ── 1. 会計の値引きに「キャンペーン」（Black Monday）を足す ──
alter table public.accounting_discounts drop constraint if exists accounting_discounts_kind_check;
alter table public.accounting_discounts add constraint accounting_discounts_kind_check check (kind = any (array['ticket'::text, 'manual'::text, 'campaign'::text]));

-- ── 2. 新しいメニュー「ピンパーマ」（perm-pin）：料金・時間のほかは perm-twist（ツイスト系）にならう ──
--   担当できる人も perm-twist と同じ。予約可のメニューに担当がいるかの見張り（service_menus_staff_guard）は最後にまとめて確かめる
insert into public.service_menus (code, name, duration_min, buffer_after_min, price, normal_price, is_active, sort_order, kind, category,
  checkout_enabled, price_tax_included, price_from, reference_duration_min, reference_duration_note, booking_enabled, member_label, maintenance_eligible)
select 'perm-pin', 'ピンパーマ', 120, t.buffer_after_min, 12000, t.normal_price, t.is_active, 405, t.kind, 'パーマ',
  t.checkout_enabled, t.price_tax_included, t.price_from, t.reference_duration_min, t.reference_duration_note, t.booking_enabled, t.member_label, t.maintenance_eligible
from public.service_menus t where t.code = 'perm-twist'
on conflict (code) do nothing;
insert into public.staff_menu_capabilities (staff_id, menu_id, duration_override_min)
select c.staff_id, p.id, c.duration_override_min
from public.staff_menu_capabilities c
join public.service_menus t on t.id = c.menu_id and t.code = 'perm-twist'
cross join public.service_menus p
where p.code = 'perm-pin'
  and not exists (select 1 from public.staff_menu_capabilities x where x.staff_id = c.staff_id and x.menu_id = p.id);

-- ── 3. Black Monday の設定（1行）。開始日・1メニューの額・対象メニューはここで変える ──
create table if not exists app_private.black_monday_settings (
  id smallint primary key default 1 check (id = 1),
  starts_on date not null,
  amount integer not null check (amount between 0 and 100000),
  menu_codes text[] not null,
  updated_at timestamptz not null default now()
);
insert into app_private.black_monday_settings (id, starts_on, amount, menu_codes)
values (1, '2026-11-23', 2000, array['perm-punch', 'perm-nurepan', 'perm-iper', 'perm-curly', 'perm-spain', 'perm-twist', 'perm-pin'])
on conflict (id) do nothing;

-- ── 4. 予約の印（Black Monday の対象の予約だけ1行）。予約・予約のメニューが変わるたびに作り直す ──
--   unit_amount＝1メニューの額（印を付けたときの設定）、amount＝その予約の合計（対象メニューの数×額。メニューの料金を超えない）
create table if not exists app_private.black_monday_marks (
  reservation_id uuid primary key references public.reservations(id) on delete cascade,
  menu_codes text[] not null,
  unit_amount integer not null check (unit_amount >= 0),
  amount integer not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
revoke all on table app_private.black_monday_settings, app_private.black_monday_marks from public, anon, authenticated;

-- 予約前の見込み（日時・メニューから）。月曜（祝日も）・開始日以降・対象メニューがあるときだけ。アプリの予約かどうかは呼ぶ側が決める
create or replace function app_private.black_monday_quote(p_starts timestamptz, p_codes text[])
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
  select case when x.codes is null then null else jsonb_build_object('label', 'Black Monday', 'unit', s.amount,
           'menu_codes', to_jsonb(x.codes), 'amount', x.amount) end
  from app_private.black_monday_settings s
  cross join lateral (
    select array_agg(u.c order by u.o) as codes, sum(least(s.amount, coalesce(m.price, s.amount)))::int as amount
    from unnest(coalesce(p_codes, '{}'::text[])) with ordinality u(c, o)
    left join public.service_menus m on m.code = u.c
    where u.c = any(s.menu_codes)) x
  where s.id = 1 and s.amount > 0 and p_starts is not null
    and (p_starts at time zone 'Asia/Tokyo')::date >= s.starts_on
    and extract(isodow from (p_starts at time zone 'Asia/Tokyo')) = 1
$function$;

-- その予約の印を今の内容で作り直す（月曜・アプリの予約・取消/無断キャンセルでない・対象メニューあり、のときだけ印がある）
create or replace function app_private.black_monday_sync(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare r public.reservations; s app_private.black_monday_settings; v_codes text[]; v_amount int;
begin
  if p_id is null then return; end if;
  select * into r from public.reservations where id = p_id;
  select * into s from app_private.black_monday_settings where id = 1;
  if r.id is not null and s.id is not null and s.amount > 0 and r.source = 'app' and r.status not in ('cancelled', 'no_show')
     and (r.starts_at at time zone 'Asia/Tokyo')::date >= s.starts_on
     and extract(isodow from (r.starts_at at time zone 'Asia/Tokyo')) = 1 then
    select array_agg(i.menu_code order by i.sort_order), sum(least(s.amount, coalesce(i.price, s.amount)))::int
      into v_codes, v_amount
    from public.reservation_items i where i.reservation_id = r.id and i.menu_code = any(s.menu_codes);
  end if;
  if v_codes is null then
    delete from app_private.black_monday_marks where reservation_id = p_id;
  else
    insert into app_private.black_monday_marks as k (reservation_id, menu_codes, unit_amount, amount)
    values (r.id, v_codes, s.amount, v_amount)
    on conflict (reservation_id) do update set menu_codes = excluded.menu_codes, unit_amount = excluded.unit_amount,
      amount = excluded.amount, updated_at = now()
      where (k.menu_codes, k.unit_amount, k.amount) is distinct from (excluded.menu_codes, excluded.unit_amount, excluded.amount);
  end if;
end;
$function$;

-- 予約（日時・状態・受けた所）が変わったら印を作り直す。アプリの変更（取消→新しい予約）・SB・店舗端末、どこから変えても同じ
create or replace function app_private.black_monday_on_reservation()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform app_private.black_monday_sync(new.id);
  return null;
end;
$function$;

-- 予約のメニューが変わったら印を作り直す
create or replace function app_private.black_monday_on_item()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    perform app_private.black_monday_sync(new.reservation_id);
  elsif tg_op = 'DELETE' then
    perform app_private.black_monday_sync(old.reservation_id);
  else
    perform app_private.black_monday_sync(old.reservation_id);
    if new.reservation_id is distinct from old.reservation_id then perform app_private.black_monday_sync(new.reservation_id); end if;
  end if;
  return null;
end;
$function$;

-- 設定を変えたら、今日以降のまだ会計していない予約の印を作り直す（開始日・額・対象メニューの変更がすぐ効くように）
create or replace function app_private.black_monday_on_settings()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform app_private.black_monday_sync(r.id) from public.reservations r
   where r.starts_at >= ((now() at time zone 'Asia/Tokyo')::date)::timestamp at time zone 'Asia/Tokyo'
     and r.status not in ('completed', 'cancelled', 'no_show');
  return null;
end;
$function$;

drop trigger if exists black_monday_sync on public.reservations;
create trigger black_monday_sync after insert or update of starts_at, status, source on public.reservations
  for each row execute function app_private.black_monday_on_reservation();
drop trigger if exists black_monday_sync on public.reservation_items;
create trigger black_monday_sync after insert or update or delete on public.reservation_items
  for each row execute function app_private.black_monday_on_item();
drop trigger if exists black_monday_resync on app_private.black_monday_settings;
create trigger black_monday_resync after update on app_private.black_monday_settings
  for each statement execute function app_private.black_monday_on_settings();

-- お客様・SB・店舗端末に出す Black Monday（予約ごと）。印が無い・取消/無断キャンセルなら null。
--   予約に Welcome・再来店パーマクーポンを付けていれば amount は 0（券を優先。会計でも引かない）
create or replace function app_private.black_monday_json(p_id uuid)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
  select case when k.reservation_id is null then null else jsonb_build_object('label', 'Black Monday', 'unit', k.unit_amount,
           'menu_codes', to_jsonb(k.menu_codes), 'perm_coupon', p.perm, 'amount', case when p.perm then 0 else k.amount end) end
  from public.reservations r
  left join app_private.black_monday_marks k on k.reservation_id = r.id
  cross join lateral (select exists (select 1 from app_private.reservation_ticket_plans tp join public.tickets t on t.id = any(tp.ticket_ids)
                                     where tp.reservation_id = r.id and not t.used and app_private.is_perm_coupon(t)) as perm) p
  where r.id = p_id and r.status not in ('cancelled', 'no_show')
$function$;

-- 店舗端末の会計用：この予約が対象か・1メニューの額・対象メニュー（会計の明細のどれが対象かを端末が出すため）。引く額は finalize_sale が決める
create or replace function app_private.black_monday_checkout_json(p_id uuid)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
  select case when p_id is null then null else jsonb_build_object('label', 'Black Monday',
           'eligible', k.reservation_id is not null and r.status not in ('cancelled', 'no_show'),
           'unit', coalesce(k.unit_amount, s.amount), 'amount', coalesce(k.amount, 0), 'menu_codes', to_jsonb(s.menu_codes)) end
  from app_private.black_monday_settings s
  left join public.reservations r on r.id = p_id
  left join app_private.black_monday_marks k on k.reservation_id = r.id
  where s.id = 1
$function$;

revoke all on function app_private.black_monday_quote(timestamptz, text[]) from public, anon, authenticated;
revoke all on function app_private.black_monday_sync(uuid) from public, anon, authenticated;
revoke all on function app_private.black_monday_on_reservation() from public, anon, authenticated;
revoke all on function app_private.black_monday_on_item() from public, anon, authenticated;
revoke all on function app_private.black_monday_on_settings() from public, anon, authenticated;
revoke all on function app_private.black_monday_json(uuid) from public, anon, authenticated;
revoke all on function app_private.black_monday_checkout_json(uuid) from public, anon, authenticated;

-- 今ある予約（開始日以降のアプリの予約）に印を付ける
do $black_monday_seed$
begin
  perform app_private.black_monday_sync(r.id) from public.reservations r
   where r.source = 'app' and r.starts_at >= timestamptz '2026-11-01 00:00+09' and r.status not in ('cancelled', 'no_show');
end;
$black_monday_seed$;

CREATE OR REPLACE FUNCTION app_private.reservation_json(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'id', r.id, 'client_id', r.client_id, 'staff_id', r.staff_id, 'staff_name', s.display_name, 'nominated', r.nominated, 'staff_confirmed', r.staff_confirmed,
    'customer_id', r.customer_id, 'user_id', r.user_id, 'customer_name', r.customer_name, 'customer_phone', r.customer_phone,
    'starts_at', r.starts_at, 'ends_at', r.ends_at, 'occupied_until', r.occupied_until,
    'status', r.status, 'source', r.source, 'external_ref', r.external_ref, 'total_price', r.total_price,
    'note', r.note, 'created_by', r.created_by, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    -- Black Monday（11/17）：その予約の値引きの見込み（無ければ null。予約に Welcome 等の券を付けていれば amount は 0）
    'black_monday', app_private.black_monday_json(r.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('menu_code', i.menu_code, 'name', i.name,
                          'duration_min', i.duration_min, 'price', i.price) order by i.sort_order)
                       from public.reservation_items i where i.reservation_id = r.id), '[]'::jsonb))
  from public.reservations r join public.staff_members s on s.id = r.staff_id
  where r.id = p_id
$function$;

CREATE OR REPLACE FUNCTION app_private.reservation_review(p_old uuid, p_starts timestamp with time zone, p_codes text[], p_cancel boolean, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare r public.reservations; s public.booking_settings; v_plan jsonb; v_staff uuid; v_effect jsonb;
  v_items jsonb; v_tickets jsonb; v_gacha jsonb; v_holds jsonb; v_now timestamptz; v_person_ok boolean;
  v_client uuid; v_line jsonb; v_new_items jsonb := '[]'; v_personal int; v_total int;
  v_family text[]; v_ticket jsonb; v_target uuid; v_nominated boolean;
begin
  select * into r from public.reservations where id = p_old;
  if r.id is null then return null; end if;
  select * into s from public.booking_settings where id = 1;
  select t.target, t.nominated into v_target, v_nominated from app_private.change_staff_target(r, p_staff) t;
  select coalesce(jsonb_agg(jsonb_build_object('menu_code', menu_code, 'name', name, 'price', price, 'duration_min', duration_min) order by sort_order), '[]')
    into v_items from public.reservation_items where reservation_id = r.id;
  if not p_cancel then
    select a.staff_id into v_staff
    from app_private.available_slots((p_starts at time zone 'Asia/Tokyo')::date, p_codes, v_target, s.min_lead_minutes, r.id) a
    join public.staff_members m on m.id = a.staff_id
    where a.starts_at = p_starts
    order by app_private.free_fragments(a.staff_id, (p_starts at time zone 'Asia/Tokyo')::date, tstzrange(a.starts_at, a.occupied_until)),
      app_private.booked_minutes(a.staff_id, (p_starts at time zone 'Asia/Tokyo')::date), m.sort_order, m.display_name, m.id limit 1;
    if v_staff is not null then v_plan := app_private.booking_plan(v_staff, p_codes); end if;
    if v_plan is not null then
      v_client := app_private.user_client(r.user_id);
      v_total := (v_plan->>'total_price')::int;
      for v_line in select value from jsonb_array_elements(v_plan->'items') loop
        v_personal := app_private.client_menu_price(v_client, v_line->>'menu_code');
        if v_personal is not null and v_personal is distinct from (v_line->>'price')::int then
          v_total := coalesce(v_total,0) - coalesce((v_line->>'price')::int,0) + v_personal;
          v_line := v_line || jsonb_build_object('price',v_personal);
        end if;
        v_new_items := v_new_items || v_line;
      end loop;
      v_plan := v_plan || jsonb_build_object('items',v_new_items,'total_price',v_total);
    end if;
  end if;
  v_person_ok := not ('maintenance' = any(p_codes)) or app_private.person_maintenance_ok(r.user_id, r.companion_id);
  v_effect := app_private.change_effects(r.id, p_starts, p_codes, (v_plan->>'total_price')::int);
  v_family := app_private.ticket_family_uids(r.user_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'type',t.type,'amount',t.amount,
      'used',t.used,'expires_at',t.expires_at,'perm_coupon',app_private.is_perm_coupon(t),
      'in_family',t.user_id=any(v_family)) order by t.id), '[]') into v_tickets
    from public.tickets t where t.id = any(coalesce((select ticket_ids from app_private.reservation_ticket_plans where reservation_id=r.id), '{}'));
  for v_ticket in select value from jsonb_array_elements(v_tickets) loop
    if (v_ticket->>'in_family')::boolean is distinct from true and (v_effect->'tickets_keep') ? (v_ticket->>'id') then
      v_effect := v_effect || jsonb_build_object('tickets_keep',(v_effect->'tickets_keep') - (v_ticket->>'id'),
        'tickets_drop',(v_effect->'tickets_drop') || jsonb_build_object('title',v_ticket->>'title','why','owner_changed'));
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('draw_id',h.draw_id,'title',h.title,'amount',h.amount,'free_menu',h.free_menu,
      'expires_at',h.expires_at,'weekday_only',h.weekday_only,'self_only',h.self_only,'menu_codes',h.menu_codes) order by h.user_id), '[]') into v_gacha
    from app_private.gacha_holdings h where h.reservation_id=r.id and h.used_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'account_id', h.account_id, 'amount', h.amount, 'status', h.status) order by h.id), '[]')
    into v_holds from app_private.ginpay_holds h where h.reservation_id=r.id and h.status='held';
  -- Black Monday（11/17）：変更の前と後の額（付く・外れる）。変更後はアプリの予約（reservation_mutate が source 'app' で作り直す）。
  --   残る券に Welcome・再来店パーマクーポンがあれば付かない（券を優先）。キャンセルなら 0。前と後で同じ値になるので、確定のときの照合はそのまま
  v_effect := v_effect || jsonb_build_object('black_monday', jsonb_build_object(
    'before', coalesce((app_private.black_monday_json(r.id)->>'amount')::int, 0),
    'after', case when p_cancel then 0
                  when exists (select 1 from public.tickets t where t.id::text in (select jsonb_array_elements_text(coalesce(v_effect->'tickets_keep', '[]'::jsonb)))
                               and app_private.is_perm_coupon(t)) then 0
                  else coalesce((app_private.black_monday_quote(p_starts, p_codes)->>'amount')::int, 0) end));
  v_now := clock_timestamp();
  return jsonb_build_object('version', 'RESERVATION_REVIEW_V1',
    'old', jsonb_build_object('id', r.id, 'companion_id', r.companion_id, 'companion_of', r.companion_of,
      'starts_at', r.starts_at, 'status', r.status, 'total_price', r.total_price, 'items', v_items),
    'new', case when p_cancel then null else jsonb_build_object('starts_at', p_starts, 'menu_codes', to_jsonb(p_codes),
      'staff_id', v_staff, 'nominated', v_nominated, 'total_price', v_plan->'total_price',
      'duration_min', v_plan->'duration_min', 'buffer_min', v_plan->'buffer_min', 'items', v_plan->'items') end,
    'slot_ok', p_cancel or (v_plan is not null and app_private.customer_slot_ok(p_starts) and v_person_ok),
    'call_shop', r.starts_at < v_now + make_interval(mins=>s.customer_cancel_deadline_minutes),
    'late_penalty', not p_cancel and p_starts <> r.starts_at and r.starts_at < v_now + make_interval(mins=>s.ai_late_cancel_minutes),
    'cancel_late', p_cancel and r.starts_at < v_now + make_interval(mins=>s.ai_late_cancel_minutes),
    'impact', v_effect, 'ticket_facts', v_tickets, 'gacha_facts', v_gacha, 'hold_facts', v_holds);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.checkout_context_json(p_reservation_id uuid, p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_client uuid; v_paid uuid;
begin
  if p_reservation_id is not null then
    select * into r from public.reservations where id = p_reservation_id;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    v_client := app_private.client_root(r.client_id);
    select id into v_paid from public.accounting_sessions where reservation_id = r.id and status = 'completed';
  elsif p_client_id is not null then
    v_client := app_private.client_root(p_client_id);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;
  return jsonb_build_object(
    'reservation', case when r.id is null then null else app_private.reservation_json(r.id) end,
    'paid_sale_id', v_paid,
    'client', case when v_client is null then null else (select jsonb_build_object('id', c.id, 'name', c.display_name,
                'app_linked', cardinality(app_private.client_members(app_private.client_family(c.id))) > 0)
              from public.clients c where c.id = v_client) end,
    'gacha', app_private.gacha_for_reservation(r.id),
    -- Black Monday（11/17）：この予約が対象か・1メニューの額・対象メニュー。引く額は会計の明細から finalize_sale が決める（端末は表示と expected_total 用）
    'black_monday', app_private.black_monday_checkout_json(r.id),
    'tickets', case when v_client is null then '[]'::jsonb else app_private.client_tickets_json(v_client) end,
    'ginpay_accounts', case when v_client is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'client_name', c.display_name, 'balance', a.balance_cached,
                 'is_current_client', a.client_id = v_client) order by (a.client_id = v_client) desc, a.created_at), '[]'::jsonb)
       from public.ginpay_accounts a join public.clients c on c.id = a.client_id
       where a.id = any(app_private.ginpay_family_accounts(v_client))) end,
    -- 有効な口座がなく停止中の口座だけがある（会計画面で「口座がありません」と誤って案内しない）
    'ginpay_suspended', v_client is not null and exists (select 1 from public.ginpay_accounts a
      where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended'),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name) order by m.sort_order), '[]'::jsonb)
              from public.staff_members m where m.is_active and (m.is_bookable or m.id = r.staff_id)),
    'tax', (select jsonb_build_object('mode', tax_mode, 'rate', tax_rate) from public.accounting_settings where id = 1)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.finalize_sale(p jsonb, p_actor_type text, p_actor_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_client uuid; v_member uuid; v_user text; v_name text; v_stylist public.staff_members;
        v_item jsonb; v_items jsonb := coalesce(p->'items', '[]'::jsonb); v_n int; v_qty int; v_price int; v_disc int; v_list int;
        v_subtotal bigint := 0; v_line_disc bigint := 0; v_ticket_disc bigint := 0; v_manual int := 0; v_total bigint;
        v_tids uuid[]; v_tcount int; v_types text[]; v_tuser text; v_method text := p->>'payment_method'; v_legacy text;
        v_tax public.accounting_settings; v_id uuid; v_i int := 0; v_uids text[]; t record;
        v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), ''); v_existing uuid; v_gp jsonb; v_account public.ginpay_accounts;
        h app_private.gacha_holdings; v_gacha int := 0; v_gitem jsonb;
        -- Black Monday（11/17）：予約の印・対象メニュー・明細ごとの値引き（明細の順）・合計。v_gidx はガチャ券の明細の番号
        v_bm app_private.black_monday_marks; v_bm_codes text[]; v_bm_line int[] := '{}'; v_bm_total bigint := 0; v_gidx bigint;
        v_is_comp boolean := false; v_comp uuid; v_comp_name text; v_owner text;
        -- 11/11：予約のない方の会計（お子様・お連れ様など）。会員ご本人の施術ではない印（予約がある会計では使わない）
        v_not_owner boolean := coalesce(p->>'not_owner', '') = 'true' and nullif(p->>'reservation_id', '') is null;
begin
  if p_actor_name is null or btrim(p_actor_name) = '' then return jsonb_build_object('error', 'operator_required'); end if;
  if v_method is null or v_method not in ('cash', 'card', 'qr', 'ginpay', 'other') then return jsonb_build_object('error', 'invalid_payment_method'); end if;
  if v_key is not null and length(v_key) > 100 then return jsonb_build_object('error', 'invalid_idempotency_key'); end if;
  if v_method = 'ginpay' and v_key is null then return jsonb_build_object('error', 'idempotency_key_required'); end if;
  -- 同じキーの再送（通信の再試行・二重タップ）：確定済みの会計をそのまま返す
  if v_key is not null then
    select id into v_existing from public.accounting_sessions where idempotency_key = v_key and status in ('completed', 'voided');
    if v_existing is not null then return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true); end if;
  end if;
  v_legacy := case v_method when 'card' then 'credit' else v_method end;

  -- 予約（行ロックで同じ予約の同時会計を直列化）
  if nullif(p->>'reservation_id', '') is not null then
    select * into r from public.reservations where id = (p->>'reservation_id')::uuid for update;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if r.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
    if exists (select 1 from public.accounting_sessions where reservation_id = r.id and status = 'completed') then
      return jsonb_build_object('error', 'already_paid');
    end if;
    v_client := app_private.client_root(r.client_id);
    -- 受ける人（11/8）：お連れ様の予約か
    v_is_comp := app_private.res_is_companion(r.companion_id, r.companion_of, r.note);
    if v_is_comp then v_comp := app_private.res_companion(r.id); v_comp_name := app_private.res_companion_name(r.id); end if;
  elsif nullif(p->>'client_id', '') is not null then
    v_client := app_private.client_root((p->>'client_id')::uuid);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;
  if v_client is not null then
    select display_name into v_name from public.clients where id = v_client;
    v_member := (app_private.client_members(app_private.client_family(v_client)))[1];
    if v_member is not null then select user_id into v_user from public.customers where id = v_member; end if;
  end if;

  -- 担当
  select * into v_stylist from public.staff_members where id = nullif(p->>'stylist_id', '')::uuid;
  if v_stylist.id is null then return jsonb_build_object('error', 'stylist_required'); end if;

  -- 明細
  v_n := jsonb_array_length(v_items);
  if v_n = 0 or v_n > 50 then return jsonb_build_object('error', 'invalid_items'); end if;
  for v_item in select * from jsonb_array_elements(v_items) loop
    begin
      v_price := (v_item->>'unit_price')::int; v_qty := coalesce((v_item->>'quantity')::int, 1); v_disc := coalesce((v_item->>'discount')::int, 0);
    exception when others then return jsonb_build_object('error', 'invalid_items'); end;
    if btrim(coalesce(v_item->>'name', '')) = '' or length(v_item->>'name') > 80
       or coalesce(v_item->>'category', '') not in ('menu', 'option', 'retail')
       or v_price is null or v_price < 0 or v_price > 1000000 or v_qty < 1 or v_qty > 99 or v_disc < 0 or v_disc > v_price * v_qty
       or coalesce(v_item->>'source', 'manual') not in ('reservation', 'service_menu', 'accounting_item', 'product', 'manual') then
      return jsonb_build_object('error', 'invalid_items');
    end if;
    v_subtotal := v_subtotal + v_price * v_qty;
    v_line_disc := v_line_disc + v_disc;
  end loop;

  -- 手入力の値引き
  if p ? 'manual_discount' and p->'manual_discount' is not null and jsonb_typeof(p->'manual_discount') = 'object' then
    begin v_manual := coalesce((p->'manual_discount'->>'amount')::int, 0); exception when others then return jsonb_build_object('error', 'invalid_discount'); end;
    if v_manual < 0 or (v_manual > 0 and btrim(coalesce(p->'manual_discount'->>'label', '')) = '') then return jsonb_build_object('error', 'invalid_discount'); end if;
  end if;

  -- チケット（App 会員の顧客だけ。既存の staff_use_tickets と同じ規則で、行ロックしてから検証）
  select coalesce(array_agg(distinct x::uuid), '{}') into v_tids from jsonb_array_elements_text(coalesce(p->'ticket_ids', '[]'::jsonb)) x;
  if cardinality(v_tids) > 0 then
    if v_member is null then return jsonb_build_object('error', 'invalid_tickets'); end if;
    v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
    perform 1 from public.tickets where id = any(v_tids) order by id for update;
    select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1], coalesce(sum(amount), 0) into v_tcount, v_types, v_tuser, v_ticket_disc
    from public.tickets where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());
    if v_tcount <> cardinality(v_tids) then return jsonb_build_object('error', 'invalid_tickets'); end if;
    -- 割引券・漢トク券は何枚でも種類をまたいでも使える。メンテナンスクーポンだけはほかの券と一緒に使えない（2026-10-17 お店の決定）
    if 'coupon' = any(v_types) and cardinality(v_types) > 1 then return jsonb_build_object('error', 'mixed_types'); end if;
    if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
      return jsonb_build_object('error', 'transfer_pending');
    end if;
    if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
       and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
      return jsonb_build_object('error', 'welcome_weekend');
    end if;
    -- Welcomeクーポン（初回パーマ 2,000円引き）はパーマ（セットを含む）のメニューがある会計だけ（10/27 慶一郎さん：カットでも使えていた）
    if exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2))
       and not exists (select 1 from jsonb_array_elements(v_items) i
                       where i->>'source' in ('reservation', 'service_menu') and coalesce(i->>'ref_id', '') ~ '^(perm|set)-') then
      return jsonb_build_object('error', 'welcome_perm_only');
    end if;
    -- Welcome クーポンは発行された会員本人の施術だけ（お連れ様の会計では使えない・11/8）
    if (v_is_comp or v_not_owner) and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
      return jsonb_build_object('error', 'welcome_owner_only');
    end if;
    -- 監査 10/28 要対応3：同じお客様・同じ日の券の使用は順番に（ほかの使用が終わってから、今日の使用を読み直す）
    perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_tuser))[1] || ':' || app_private.today_jst()::text, 0));
    if exists (select 1 from unnest(v_types) as ticket_type(value) where not app_private.can_use_type(app_private.today_used_type(v_tuser), ticket_type.value)) then
      return jsonb_build_object('error', 'daily_rule');
    end if;
  end if;

  -- Black Monday（11/17 オーナー決定）：月曜来店のアプリの予約（予約の印＝app_private.black_monday_marks）で、会計の明細に対象メニューがあれば
  --   明細1つにつき1メニューの額（明細の残りを超えない）を引く。額は DB が決める（端末の額は使わない。expected_total の照合にも入る）。
  --   Welcome・再来店パーマクーポンを使う会計では引かない（券を優先）。予約のない会計では引かない
  if r.id is not null and not exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
    select * into v_bm from app_private.black_monday_marks where reservation_id = r.id;
    if v_bm.reservation_id is not null then
      select menu_codes into v_bm_codes from app_private.black_monday_settings where id = 1;
      select coalesce(array_agg(case when x.i->>'source' in ('reservation', 'service_menu') and x.i->>'ref_id' = any(coalesce(v_bm_codes, '{}'::text[]))
                                     then greatest(0, least(v_bm.unit_amount, (x.i->>'unit_price')::int * coalesce((x.i->>'quantity')::int, 1) - coalesce((x.i->>'discount')::int, 0)))
                                     else 0 end order by x.n), '{}'::int[])
        into v_bm_line
      from jsonb_array_elements(v_items) with ordinality x(i, n);
      select coalesce(sum(v), 0) into v_bm_total from unnest(v_bm_line) v;
    end if;
  end if;

  -- ガチャ券（予約に付いた券。11/4 工程②）。店舗端末が use_gacha を付けたときだけ使う
  if coalesce(p->>'use_gacha', '') = 'true' then
    if r.id is null then return jsonb_build_object('error', 'gacha_invalid'); end if;
    select * into h from app_private.gacha_holdings where reservation_id = r.id and used_at is null for update;
    if h.user_id is null then return jsonb_build_object('error', 'gacha_invalid'); end if;
    if h.weekday_only and app_private.gacha_offday(now()) then return jsonb_build_object('error', 'gacha_weekday'); end if;
    -- 本人だけの券（無料券以外・本人限定）はお連れ様の会計では使えない（予約に付けるときと同じ）
    if v_is_comp and (h.free_menu is null or h.self_only) then return jsonb_build_object('error', 'gacha_companion'); end if;
    if h.menu_codes is not null then
      select x.i, x.n into v_gitem, v_gidx from jsonb_array_elements(v_items) with ordinality x(i, n)
       where x.i->>'source' in ('reservation', 'service_menu') and x.i->>'ref_id' = any(h.menu_codes) order by x.n limit 1;
      if v_gitem is null then return jsonb_build_object('error', 'gacha_menu'); end if;
    end if;
    -- 無料券はそのメニュー1つ分の料金（明細の値引き後）。Black Monday を先に引き、無料券はその明細の残りをまかなう（11/17）
    v_gacha := coalesce(h.amount, greatest(0, least((v_gitem->>'unit_price')::int,
      (v_gitem->>'unit_price')::int * coalesce((v_gitem->>'quantity')::int, 1) - coalesce((v_gitem->>'discount')::int, 0)
      - coalesce(v_bm_line[v_gidx], 0))));
    -- 値引き額が決まらない券（額もメニューも無い）は使わない（11/4 守り）
    if v_gacha is null or v_gacha < 0 then return jsonb_build_object('error', 'gacha_invalid'); end if;
    v_ticket_disc := v_ticket_disc + v_gacha;
  end if;

  v_total := v_subtotal - v_line_disc - v_ticket_disc - v_manual - v_bm_total;
  -- 券が料金を超えたときは 0円（超えた分はおつりにしない＝お店の従来どおり・10/28 慶一郎さん）。券以外の値引きが料金を超えるのは今までどおり不可
  if v_total < 0 and v_ticket_disc > 0 and v_subtotal - v_line_disc - v_manual - v_bm_total >= 0 then v_total := 0; end if;
  if v_total < 0 then return jsonb_build_object('error', 'discount_exceeds'); end if;
  if nullif(p->>'expected_total', '') is null or (p->>'expected_total')::bigint <> v_total then
    return jsonb_build_object('error', 'total_mismatch', 'total', v_total);
  end if;
  select * into v_tax from public.accounting_settings where id = 1;

  -- GINPay 払い：顧客が必要（匿名は不可）。口座を決め（複数なら明示）、行ロックして残高を確認する
  if v_method = 'ginpay' then
    if v_client is null then return jsonb_build_object('error', 'ginpay_requires_client'); end if;
    if v_total <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
    v_gp := app_private.ginpay_resolve_account(v_client, nullif(p->>'ginpay_account_id', '')::uuid, false, p_actor_type, btrim(p_actor_name));
    if v_gp ? 'error' then
      if v_gp->>'error' = 'account_not_found' and exists (select 1 from public.ginpay_accounts a
           where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended') then
        return jsonb_build_object('error', 'ginpay_account_suspended');
      end if;
      return jsonb_build_object('error', case v_gp->>'error' when 'account_not_found' then 'ginpay_account_not_found' else v_gp->>'error' end);
    end if;
    select * into v_account from public.ginpay_accounts where id = (v_gp->>'account_id')::uuid for update;
    if v_account.status <> 'active' then return jsonb_build_object('error', 'ginpay_account_suspended'); end if;
    -- 予約の仮支払い（銀Pay の押さえ）の分は使えない。この会計の予約の押さえは、この会計で閉じるので数えない（10/27：押さえた分まで払えていた）
    if v_account.balance_cached - app_private.ginpay_held_sum(v_account.id, r.id) < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached - app_private.ginpay_held_sum(v_account.id, r.id));
    end if;
  end if;

  -- ── ここから書き込み（以後の失敗は例外で全体を取り消す） ──
  begin
    insert into public.accounting_sessions (user_id, customer_name, staff_name, stylist_name, stylist_id, payment_method, status,
      subtotal, discount_total, total, used_ticket_ids, client_id, reservation_id, tax_mode, tax_rate, idempotency_key)
    values (v_user, coalesce(v_name, r.customer_name, ''), btrim(p_actor_name), v_stylist.display_name, v_stylist.id, v_legacy, 'pending',
      v_subtotal, v_line_disc + v_ticket_disc + v_manual + v_bm_total, v_total, (select array_agg(x::text) from unnest(v_tids) x),
      v_client, r.id, v_tax.tax_mode, v_tax.tax_rate, v_key)
    returning id into v_id;
  exception when unique_violation then
    -- 同じキーの同時送信は、先に確定した会計を返す。それ以外は同じ予約の二重会計
    if v_key is not null then
      select id into v_existing from public.accounting_sessions where idempotency_key = v_key and status in ('completed', 'voided');
      if v_existing is not null then return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true); end if;
    end if;
    return jsonb_build_object('error', 'already_paid');
  end;
  for v_item in select * from jsonb_array_elements(v_items) loop
    v_i := v_i + 1;
    v_price := (v_item->>'unit_price')::int; v_qty := coalesce((v_item->>'quantity')::int, 1); v_disc := coalesce((v_item->>'discount')::int, 0);
    v_list := case v_item->>'source'
      when 'service_menu' then (select price from public.service_menus where code = v_item->>'ref_id')
      when 'reservation' then (select ri.price from public.reservation_items ri where ri.reservation_id = r.id and ri.menu_code = v_item->>'ref_id' limit 1)
      when 'accounting_item' then (select price from public.accounting_items where id::text = v_item->>'ref_id')
      when 'product' then (select price from public.products where id::text = v_item->>'ref_id')
      else null end;
    insert into public.accounting_session_items (session_id, item_id, item_name, category, price, quantity, source, ref_id, list_price,
      line_discount, line_total, tax_mode, tax_rate, sort_order)
    values (v_id, case when v_item->>'source' in ('accounting_item', 'product') then nullif(v_item->>'ref_id', '')::uuid end,
      btrim(v_item->>'name'), v_item->>'category', v_price, v_qty, coalesce(v_item->>'source', 'manual'), nullif(v_item->>'ref_id', ''), v_list,
      v_disc, v_price * v_qty - v_disc, v_tax.tax_mode, v_tax.tax_rate, v_i);
  end loop;
  for t in select * from public.tickets where id = any(v_tids) order by id loop
    insert into public.accounting_discounts (session_id, kind, ticket_id, ticket_type, label, amount)
    values (v_id, 'ticket', t.id, t.type, t.title, t.amount);
  end loop;
  if h.user_id is not null then
    insert into public.accounting_discounts (session_id, kind, ticket_type, label, amount) values (v_id, 'ticket', 'gacha', 'ガチャ券 ' || h.title, v_gacha);
    update app_private.gacha_holdings set used_at = now(), used_sale_id = v_id where user_id = h.user_id;
  end if;
  if v_manual > 0 then
    insert into public.accounting_discounts (session_id, kind, label, amount) values (v_id, 'manual', btrim(p->'manual_discount'->>'label'), v_manual);
  end if;
  if v_bm_total > 0 then
    insert into public.accounting_discounts (session_id, kind, label, amount) values (v_id, 'campaign', 'Black Monday', v_bm_total);
  end if;
  insert into public.accounting_payments (session_id, method, amount) values (v_id, v_method, v_total);

  -- GINPay 支払い（同じトランザクション。会計1件につき1件。失敗すれば会計ごと取り消す）
  if v_method = 'ginpay' then
    v_gp := app_private.ginpay_pay(v_client, v_account.id, v_total::int, v_id, p_actor_type, btrim(p_actor_name), 'sale:' || v_key);
    if v_gp ? 'error' then raise exception '%', v_gp->>'error'; end if;
  end if;

  -- チケットの消費（既存と同じ使用ログ・来店日）
  if cardinality(v_tids) > 0 then
    update public.tickets set used = true, used_at = now() where id = any(v_tids);
    -- 誰の施術に使ったか（お連れ様ならお名前と番号）も残す
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status, treated_companion_id, treated_name)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used', v_comp, v_comp_name
    from public.tickets t2 where t2.id = any(v_tids);
  end if;
  -- 来店の記録は会員本人の施術だけ。対象メニューの施術なら、受ける人の14日をここ（会計の完了）から始める
  v_owner := coalesce(r.user_id, v_user);
  if v_owner is not null and not v_is_comp and not v_not_owner then perform app_private.touch_visit(v_owner, r.id is null); end if;
  if not v_not_owner then perform app_private.record_treatment(v_id, v_owner, v_comp, v_is_comp); end if;
  if v_not_owner then update public.accounting_sessions set not_owner = true where id = v_id; end if;

  update public.accounting_sessions set status = 'completed', completed_at = now() where id = v_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, detail)
  values (v_id, 'completed', p_actor_type, btrim(p_actor_name), jsonb_build_object('total', v_total, 'payment_method', v_method)
          || case when v_bm_total > 0 then jsonb_build_object('black_monday', v_bm_total) else '{}'::jsonb end);

  -- 予約の完了（会計と同じトランザクション。完了にできなければ全体を取り消す）
  if r.id is not null and r.status <> 'completed' then
    if (app_private.set_reservation_status(r.id, 'completed', p_actor_type, btrim(p_actor_name), null)) ? 'error' then
      raise exception 'reservation_not_completed';
    end if;
  end if;
  return app_private.sale_json(v_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.menu_price_rules()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select json_build_object(
    'menus', coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'price', m.price, 'normal_price', m.normal_price,
                'member_label', m.member_label, 'price_from', m.price_from) order by m.sort_order, m.name)
              from public.service_menus m where m.is_active), '[]'::json),
    'member_time', json_build_object('weekday', 'all_day', 'weekend_holiday_from', '17:00', 'weekend_holiday_to', '19:00'),
    'holidays', coalesce((select json_agg(h.day order by h.day) from app_private.holidays h where h.day >= app_private.today_jst()), '[]'::json),
    -- Black Monday（11/17）：開始日・1メニューの額・対象メニュー。アプリの予約の確認で「Black Monday −¥2,000」を出すため（額は DB が会計で決める）
    'black_monday', (select json_build_object('label', 'Black Monday', 'starts_on', s.starts_on, 'amount', s.amount, 'menu_codes', s.menu_codes)
                     from app_private.black_monday_settings s where s.id = 1 and s.amount > 0))
$function$;
