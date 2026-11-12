-- 銀オクの直し 2（11/12 慶一郎さんの決め）。Staging だけ。20261112_ginoku.sql → _fix1.sql → _label.sql のあとに流す
--   npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku_free_and_hold.sql
-- 戻すとき：20261112_ginoku_free_and_hold_off.sql
--
-- 1. 本物の無料券
--   ・ガチャの無料の景品（app_private.gacha_prizes の amount が無く menu_codes がある＝「銀パラ 無料」など）から出品したものは、
--     落札で「無料券」を出す。券は public.tickets（割引券・額 0）＋ app_private.ticket_free_menus（使えるメニューと名前）。
--     本番にもある public.tickets の形は変えない。ガチャの持ち券（gacha_holdings・1枚まで）には入れない
--   ・お会計（finalize_sale）：そのメニューが会計にあるときだけ使え、値引きはその明細1つ分の料金（ガチャの無料券と同じ。明細の値引き・
--     ガチャ券のあと。1つの明細を2枚では引かない）。端末の額は使わない
--   ・「平日のみ」の券（銀オクの券すべて）は、土日・祝日のお会計でも断る（予約に付けるときは _fix1 で断っている）
--   ・予約に付ける（customer_set_ticket_plan）：無料券は、そのメニューの予約にだけ
-- 2. 入札額の押さえ
--   ・最高額になった方の入札額を、銀Pay で押さえる（app_private.ginoku_holds）。押さえは「使える額＝残高 − 押さえ」の押さえに入る
--     （ginpay_held_sum を Staging で置き換え）＝会計・予約の仮支払い・調整でも使えない。予約の仮支払いの分は入札に使えない
--   ・抜かれたら、同じトランザクションですぐ戻す。落札で押さえを引き落としに変える（冪等キー ginoku:<ID>＝1回だけ）。
--     流札・取り下げ・即決（ほかの方が即決したとき）も戻す。開催中でなくなったオークションの押さえは数えない（二重の守り）
--   ・ロックの順：オークションの行 → 口座（入札した方の1つだけ）。戻すのは押さえの行だけを書く（戻すのは使える額を増やすだけなので、口座のロックは要らない）
--
-- 本番にもある関数で、ここで Staging だけ置き換えるもの（本番に入れるときは一緒に）：
--   app_private.ginpay_held_sum, app_private.ginpay_hold_summary, app_private.finalize_sale,
--   app_private.client_tickets_json, app_private.ticket_json, public.customer_set_ticket_plan（_fix1 の置き換えに足す）
set check_function_bodies = off;

-- ── 表 ──────────────────────────────────────────────────────────────

-- 出品：無料券なら free_menu（「銀パラ」）と menu_codes。券の額（ticket_amount）は無し
alter table app_private.ginoku_auctions add column if not exists free_menu text;
alter table app_private.ginoku_auctions add column if not exists menu_codes text[];
alter table app_private.ginoku_auctions alter column ticket_amount drop not null;
alter table app_private.ginoku_auctions drop constraint if exists ginoku_auctions_ticket_amount_check;
alter table app_private.ginoku_auctions add constraint ginoku_auctions_ticket_amount_check
  check (ticket_amount is null or (ticket_amount > 0 and ticket_amount <= 100000));
alter table app_private.ginoku_auctions drop constraint if exists ginoku_auctions_kind_check;
alter table app_private.ginoku_auctions add constraint ginoku_auctions_kind_check check (
  case when menu_codes is null then ticket_amount is not null and free_menu is null
       else ticket_amount is null and free_menu is not null and btrim(free_menu) <> '' and cardinality(menu_codes) > 0 end);

-- 無料券（券の ID ごと）。譲っても券の ID は変わらないので、そのままついていく
create table if not exists app_private.ticket_free_menus (
  ticket_id uuid primary key references public.tickets(id) on delete cascade,
  free_menu text not null check (btrim(free_menu) <> ''),
  menu_codes text[] not null check (cardinality(menu_codes) > 0),
  source text not null default 'ginoku',
  created_at timestamptz not null default now()
);
alter table app_private.ticket_free_menus enable row level security;
revoke all on app_private.ticket_free_menus from public, anon, authenticated;

-- 入札の押さえ。1つのオークションで押さえているのは、いつも最高額の方の1つだけ
create table if not exists app_private.ginoku_holds (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references app_private.ginoku_auctions(id) on delete cascade,
  user_id text not null,
  account_id uuid not null references public.ginpay_accounts(id) on delete restrict,
  amount integer not null check (amount > 0 and amount <= 1000000),
  bid_id uuid references app_private.ginoku_bids(id) on delete set null,
  -- held＝押さえ中、captured＝落札で引き落としに変えた、released＝戻した
  status text not null default 'held' check (status in ('held', 'captured', 'released')),
  release_reason text check (release_reason in ('outbid', 'won', 'lost', 'buy_now', 'unsold', 'closed')),
  transaction_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'held') = (release_reason is null)),
  check ((status = 'captured') = (transaction_id is not null))
);
create unique index if not exists ginoku_holds_one_per_auction on app_private.ginoku_holds (auction_id) where status = 'held';
create index if not exists ginoku_holds_account_idx on app_private.ginoku_holds (account_id) where status = 'held';
create index if not exists ginoku_holds_user_idx on app_private.ginoku_holds (user_id, created_at desc);
alter table app_private.ginoku_holds enable row level security;
revoke all on app_private.ginoku_holds from public, anon, authenticated;

-- 守り：オークションが開催中でなくなったら、残っている押さえをすべて戻す（通常は精算・即決の中で先に閉じている）
create or replace function app_private.ginoku_release_on_close()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    update app_private.ginoku_holds set status = 'released', release_reason = 'closed', updated_at = now()
    where auction_id = new.id and status = 'held';
  end if;
  return new;
end;
$$;
drop trigger if exists ginoku_release_on_close on app_private.ginoku_auctions;
create trigger ginoku_release_on_close after update of status on app_private.ginoku_auctions
  for each row execute function app_private.ginoku_release_on_close();

-- ── 銀Pay の押さえ（本番にもある関数の置き換え） ─────────────────────────

-- 押さえの合計：予約の仮支払い（今までどおり・p_except の予約は除く）＋ 銀オクの入札の押さえ（開催中のオークションだけ）
create or replace function app_private.ginpay_held_sum(p_account_id uuid, p_except uuid default null::uuid)
returns integer language sql stable set search_path = '' as $$
  select (coalesce((select sum(h.amount) from app_private.ginpay_holds h
                    where h.account_id = p_account_id and h.status = 'held'
                      and (p_except is null or h.reservation_id <> p_except)
                      and app_private.ginpay_hold_active(h)), 0)
        + coalesce((select sum(g.amount) from app_private.ginoku_holds g
                    join app_private.ginoku_auctions a on a.id = g.auction_id
                    where g.account_id = p_account_id and g.status = 'held' and a.status = 'open'), 0))::integer
$$;

-- お客様の押さえの一覧：予約の仮支払い（holds・今までどおり）に、銀オクの入札の押さえ（auction_holds）を足す。held は両方の合計
create or replace function app_private.ginpay_hold_summary(p_client uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_res jsonb; v_acc public.ginpay_accounts;
begin
  v_res := app_private.ginpay_resolve_account(p_client, null, false, 'customer', null);
  if v_res ? 'error' then return json_build_object('error', v_res->>'error'); end if;
  select * into v_acc from public.ginpay_accounts where id = (v_res->>'account_id')::uuid;
  return json_build_object(
    'balance', v_acc.balance_cached,
    'held', app_private.ginpay_held_sum(v_acc.id),
    'available', v_acc.balance_cached - app_private.ginpay_held_sum(v_acc.id),
    'holds', coalesce((select json_agg(json_build_object('reservation_id', h.reservation_id, 'amount', h.amount) order by h.created_at)
                       from app_private.ginpay_holds h where h.account_id = v_acc.id and app_private.ginpay_hold_active(h)), '[]'::json),
    'auction_holds', coalesce((select json_agg(json_build_object('auction_id', g.auction_id, 'title', a.title, 'amount', g.amount, 'ends_at', a.ends_at) order by a.ends_at)
                       from app_private.ginoku_holds g join app_private.ginoku_auctions a on a.id = g.auction_id
                       where g.account_id = v_acc.id and g.status = 'held' and a.status = 'open'), '[]'::json));
end;
$$;

-- ── 券（本番にもある関数の置き換え） ─────────────────────────────────────

-- お客様の券：無料券なら free_menu・menu_codes を足す（チケットウォレット・予約の券の選び）
create or replace function app_private.ticket_json(t public.tickets)
returns json language sql stable set search_path = 'pg_catalog' as $$
  select (to_jsonb(t) || jsonb_build_object('pending_transfer', exists (
    select 1 from public.ticket_transfers x
    where x.ticket_id = t.id and x.status = 'pending' and x.expires_at > now()
  )) || coalesce((select jsonb_build_object('free_menu', f.free_menu, 'menu_codes', to_jsonb(f.menu_codes))
                  from app_private.ticket_free_menus f where f.ticket_id = t.id), '{}'::jsonb))::json
$$;

-- お会計の券：無料券なら free_menu・menu_codes。銀オクの「平日のみ」の券は、土日・祝日は ginoku_weekday で止める
create or replace function app_private.client_tickets_json(p_client_id uuid)
returns jsonb language plpgsql stable set search_path = 'public', 'extensions', 'pg_temp' as $$
declare v_root uuid := app_private.client_root(p_client_id); v_uids text[];
begin
  if v_root is null then return '[]'::jsonb; end if;
  v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_root)));
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'type', t.type, 'title', t.title, 'amount', t.amount, 'expires_at', t.expires_at,
      'free_menu', f.free_menu, 'menu_codes', to_jsonb(f.menu_codes),
      'blocked', case
        when exists (select 1 from public.ticket_transfers x where x.ticket_id = t.id and x.status = 'pending' and x.expires_at > now()) then 'transfer_pending'
        when app_private.is_perm_coupon(t) and extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7) then 'welcome_weekend'
        when app_private.ginoku_offday(now()) and app_private.ginoku_weekday_ticket(t.id) then 'ginoku_weekday'
        when not app_private.can_use_type(app_private.today_used_type(t.user_id), t.type) then 'daily_rule'
        else null end
    ) order by t.expires_at nulls last, t.created_at), '[]'::jsonb)
    from public.tickets t
    left join app_private.ticket_free_menus f on f.ticket_id = t.id
    where t.user_id = any(v_uids) and not t.used and (t.expires_at is null or t.expires_at > now()));
end;
$$;

-- 予約に券を付ける：_fix1（平日のみ）に、無料券はそのメニューの予約だけ、を足す
create or replace function public.customer_set_ticket_plan(p_session text, p_reservation_id uuid, p_ticket_ids uuid[])
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_ids uuid[]; v_at timestamptz;
begin
  select r.starts_at into v_at from public.reservations r where r.id = p_reservation_id and r.user_id = v_user and r.status = 'confirmed' for no key update;
  if v_at is null then
    return json_build_object('error', 'not_found');
  end if;
  select coalesce(array_agg(distinct t.id), '{}') into v_ids from public.tickets t
  where t.id = any(coalesce(p_ticket_ids, '{}')) and t.user_id = any(app_private.ticket_family_uids(v_user)) and not t.used
    and cardinality(p_ticket_ids) <= 30;
  if cardinality(v_ids) = 0 then
    delete from app_private.reservation_ticket_plans where reservation_id = p_reservation_id;
    return json_build_object('ok', true, 'count', 0);
  end if;
  -- 銀オクの「平日のみ」の券は、土日・祝日の予約には付けない（11/12 慶一郎さん）
  if app_private.ginoku_offday(v_at) and exists (select 1 from unnest(v_ids) i where app_private.ginoku_weekday_ticket(i)) then
    return json_build_object('error', 'weekday_only');
  end if;
  -- 無料券は、そのメニューの予約にだけ付ける（11/12）
  if exists (select 1 from app_private.ticket_free_menus f where f.ticket_id = any(v_ids)
             and not exists (select 1 from public.reservation_items ri where ri.reservation_id = p_reservation_id and ri.menu_code = any(f.menu_codes))) then
    return json_build_object('error', 'free_menu');
  end if;
  insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) values (p_reservation_id, v_user, v_ids)
  on conflict (reservation_id) do update set ticket_ids = excluded.ticket_ids, user_id = excluded.user_id, created_at = now();
  return json_build_object('ok', true, 'count', cardinality(v_ids));
end;
$$;

-- お会計の確定（本番にもある関数の置き換え）。中身は Staging の今の定義のまま、銀オクの無料券・平日のみの確かめだけ足す
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
        v_is_comp boolean := false; v_comp uuid; v_comp_name text; v_owner text;
        -- 11/11：予約のない方の会計（お子様・お連れ様など）。会員ご本人の施術ではない印（予約がある会計では使わない）
        v_not_owner boolean := coalesce(p->>'not_owner', '') = 'true' and nullif(p->>'reservation_id', '') is null;
        -- 銀オクの無料券（11/12・Staging だけ）：券ごとの値引き額（券の ID → 額）。額は会計の明細から DB が決める
        v_gidx bigint; v_rem int[]; v_codes text[]; v_free jsonb := '{}'::jsonb; v_free_disc bigint := 0; v_take int; fm record; k int;
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
    -- 銀オクの「平日のみ」の券は、土日・祝日のお会計では使えない（11/12 慶一郎さん・Staging だけ）
    if app_private.ginoku_offday(now()) and exists (select 1 from unnest(v_tids) i where app_private.ginoku_weekday_ticket(i)) then
      return jsonb_build_object('error', 'ginoku_weekday');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_tuser))[1] || ':' || app_private.today_jst()::text, 0));
    if exists (select 1 from unnest(v_types) as ticket_type(value) where not app_private.can_use_type(app_private.today_used_type(v_tuser), ticket_type.value)) then
      return jsonb_build_object('error', 'daily_rule');
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
    -- 無料券はそのメニュー1つ分の料金（明細の値引き後）
    v_gacha := coalesce(h.amount, least((v_gitem->>'unit_price')::int,
      (v_gitem->>'unit_price')::int * coalesce((v_gitem->>'quantity')::int, 1) - coalesce((v_gitem->>'discount')::int, 0)));
    -- 値引き額が決まらない券（額もメニューも無い）は使わない（11/4 守り）
    if v_gacha is null or v_gacha < 0 then return jsonb_build_object('error', 'gacha_invalid'); end if;
    v_ticket_disc := v_ticket_disc + v_gacha;
  end if;

  -- 銀オクの無料券（11/12・Staging だけ）：そのメニューが会計にあるときだけ。値引きはその明細1つ分の料金（明細の値引き・ガチャ券のあと）。
  --   端末の額は使わない（券の amount は 0）。1つの明細を2枚で引かない。券の ID の順に、明細の順で最初に残りのある対象の明細へ
  if cardinality(v_tids) > 0 and exists (select 1 from app_private.ticket_free_menus f where f.ticket_id = any(v_tids)) then
    select array_agg(case when x.i->>'source' in ('reservation', 'service_menu') and coalesce(x.i->>'ref_id', '') <> ''
                          then (x.i->>'unit_price')::int * coalesce((x.i->>'quantity')::int, 1) - coalesce((x.i->>'discount')::int, 0) else 0 end order by x.n),
           array_agg(case when x.i->>'source' in ('reservation', 'service_menu') then coalesce(x.i->>'ref_id', '') else '' end order by x.n)
      into v_rem, v_codes
    from jsonb_array_elements(v_items) with ordinality x(i, n);
    if v_gidx is not null then v_rem[v_gidx] := greatest(v_rem[v_gidx] - v_gacha, 0); end if;
    for fm in select f.ticket_id, f.menu_codes from app_private.ticket_free_menus f where f.ticket_id = any(v_tids) order by f.ticket_id loop
      v_take := null;
      for k in 1 .. cardinality(v_rem) loop
        if v_codes[k] = any(fm.menu_codes) and v_rem[k] > 0 then
          v_take := least((v_items->(k - 1)->>'unit_price')::int, v_rem[k]);
          v_rem[k] := v_rem[k] - v_take;
          exit;
        end if;
      end loop;
      if v_take is null then return jsonb_build_object('error', 'free_menu'); end if;
      v_free := v_free || jsonb_build_object(fm.ticket_id::text, v_take);
      v_free_disc := v_free_disc + v_take;
    end loop;
    -- 無料券の券面の額（0）は数えず、明細から決めた額にする
    v_ticket_disc := v_ticket_disc - (select coalesce(sum(t2.amount), 0) from public.tickets t2
                                      where t2.id = any(v_tids) and exists (select 1 from app_private.ticket_free_menus f where f.ticket_id = t2.id))
                     + v_free_disc;
  end if;

  v_total := v_subtotal - v_line_disc - v_ticket_disc - v_manual;
  -- 券が料金を超えたときは 0円（超えた分はおつりにしない＝お店の従来どおり・10/28 慶一郎さん）。券以外の値引きが料金を超えるのは今までどおり不可
  if v_total < 0 and v_ticket_disc > 0 and v_subtotal - v_line_disc - v_manual >= 0 then v_total := 0; end if;
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
      v_subtotal, v_line_disc + v_ticket_disc + v_manual, v_total, (select array_agg(x::text) from unnest(v_tids) x),
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
    values (v_id, 'ticket', t.id, t.type, t.title, coalesce((v_free->>t.id::text)::int, t.amount));
  end loop;
  if h.user_id is not null then
    insert into public.accounting_discounts (session_id, kind, ticket_type, label, amount) values (v_id, 'ticket', 'gacha', 'ガチャ券 ' || h.title, v_gacha);
    update app_private.gacha_holdings set used_at = now(), used_sale_id = v_id where user_id = h.user_id;
  end if;
  if v_manual > 0 then
    insert into public.accounting_discounts (session_id, kind, label, amount) values (v_id, 'manual', btrim(p->'manual_discount'->>'label'), v_manual);
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
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, coalesce((v_free->>t2.id::text)::int, t2.amount), 'ginjiro-os', 'used', v_comp, v_comp_name
    from public.tickets t2 where t2.id = any(v_tids);
  end if;
  -- 来店の記録は会員本人の施術だけ。対象メニューの施術なら、受ける人の14日をここ（会計の完了）から始める
  v_owner := coalesce(r.user_id, v_user);
  if v_owner is not null and not v_is_comp and not v_not_owner then perform app_private.touch_visit(v_owner, r.id is null); end if;
  if not v_not_owner then perform app_private.record_treatment(v_id, v_owner, v_comp, v_is_comp); end if;
  if v_not_owner then update public.accounting_sessions set not_owner = true where id = v_id; end if;

  update public.accounting_sessions set status = 'completed', completed_at = now() where id = v_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, detail)
  values (v_id, 'completed', p_actor_type, btrim(p_actor_name), jsonb_build_object('total', v_total, 'payment_method', v_method));

  -- 予約の完了（会計と同じトランザクション。完了にできなければ全体を取り消す）
  if r.id is not null and r.status <> 'completed' then
    if (app_private.set_reservation_status(r.id, 'completed', p_actor_type, btrim(p_actor_name), null)) ? 'error' then
      raise exception 'reservation_not_completed';
    end if;
  end if;
  return app_private.sale_json(v_id);
end;
$function$
;

-- ── 銀オクの関数 ───────────────────────────────────────────────────────

-- 引き落としと券の発行（呼び出し側がオークションの行をロック済み・status = 'open' であること）。
-- 払えなければ何も書かずに {error} を返す（次の方へ回すため）。
-- この方がこのオークションで押さえている額は、使える額に戻して数える（押さえを引き落としに変える）。
-- 書き込みの順：口座の行ロック → このオークションの押さえをすべて閉じる（この方の分は captured、ほかは released）→ 台帳 → 券。
--   台帳が断ったら例外で全部取り消す（押さえも元のまま）。前もって台帳と同じ条件で確かめるので、通常は起きない
create or replace function app_private.ginoku_charge_and_issue(p_id uuid, p_user text, p_price integer, p_via text)
returns jsonb language plpgsql set search_path = '' as $$
declare a app_private.ginoku_auctions; w jsonb; v_acc public.ginpay_accounts; v_own integer; v_avail integer;
        v_tx jsonb; v_ticket uuid; v_expires timestamptz;
begin
  select * into a from app_private.ginoku_auctions where id = p_id;
  if a.id is null or a.status <> 'open' then return jsonb_build_object('error', 'not_open'); end if;
  if p_price is null or p_price <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
  -- 口座の行ロック（予約の仮支払い・会計・ほかの入札と同時に動かない）
  w := app_private.ginoku_wallet(p_user, true);
  if w ? 'error' then return w; end if;
  select * into v_acc from public.ginpay_accounts where id = (w->>'account_id')::uuid;
  v_own := coalesce((select sum(g.amount) from app_private.ginoku_holds g
                     where g.auction_id = a.id and g.user_id = p_user and g.account_id = v_acc.id and g.status = 'held'), 0);
  -- 使える額＝残高 − （この方のこのオークションの押さえを除いた）押さえ。台帳の「残高が負にならない・押さえの分まで減らさない」と同じ
  v_avail := v_acc.balance_cached - (app_private.ginpay_held_sum(v_acc.id) - v_own);
  if v_avail < p_price then
    return jsonb_build_object('error', 'insufficient_balance', 'available', greatest(v_avail, 0));
  end if;
  -- 押さえを先に閉じる（台帳が「押さえの分まで減らさない」を確かめるときに、この方の押さえを数えないように）
  update app_private.ginoku_holds
  set status = 'released',
      release_reason = case when user_id = p_user and account_id = v_acc.id then 'won' when p_via = 'buy_now' then 'buy_now' else 'lost' end,
      updated_at = now()
  where auction_id = a.id and status = 'held';
  v_tx := app_private.ginpay_record_transaction(
    v_acc.id, 'adjustment', -p_price, 'posted', null, null, null, null, null,
    'system', '銀オク', '銀オク落札：' || a.title, case p_via when 'buy_now' then '即決' else '落札' end,
    'ginoku:' || a.id::text, null,
    jsonb_build_object('ginoku_auction_id', a.id, 'via', p_via, 'user_id', p_user, 'held', v_own));
  if v_tx ? 'error' then
    raise exception 'ginoku_charge_failed: %', v_tx->>'error';
  end if;
  if coalesce((v_tx->>'idempotent')::boolean, false) then
    -- 同じオークションの引き落としがもう台帳にある＝状態がずれている。二重には引かず止める
    raise exception 'ginoku_already_charged';
  end if;
  -- この方の押さえは、引き落としに変えた（captured）
  update app_private.ginoku_holds set status = 'captured', transaction_id = (v_tx->>'id')::uuid, updated_at = now()
  where auction_id = a.id and user_id = p_user and account_id = v_acc.id and status = 'released' and release_reason = 'won' and transaction_id is null;
  v_expires := ((app_private.today_jst() + a.ticket_days + 1)::timestamp at time zone 'Asia/Tokyo');
  insert into public.tickets (user_id, type, title, amount, memo, issued_by, used, expires_at)
  values (p_user, 'discount', a.title, coalesce(a.ticket_amount, 0),
          '銀オクで' || case p_via when 'buy_now' then '即決' else '落札' end || '・' || case when a.weekday_only then '平日のみ' else '曜日を問わず' end,
          '銀オク', false, v_expires)
  returning id into v_ticket;
  if a.menu_codes is not null then
    insert into app_private.ticket_free_menus (ticket_id, free_menu, menu_codes, source) values (v_ticket, a.free_menu, a.menu_codes, 'ginoku');
  end if;
  update app_private.ginoku_auctions
  set status = 'sold', winner_user = p_user, final_price = p_price, sold_via = p_via, settled_at = now(),
      ticket_id = v_ticket, ginpay_tx_id = (v_tx->>'id')::uuid, updated_at = now(),
      current_price = case when p_via = 'buy_now' then p_price else current_price end,
      leader_user = case when p_via = 'buy_now' then p_user else leader_user end
  where id = a.id;
  return jsonb_build_object('ok', true, 'ticket_id', v_ticket, 'transaction_id', v_tx->>'id', 'balance', (v_tx->>'balance')::integer);
end;
$$;

-- 精算：終わったオークションを1回だけ締める。p_wait = false なら、ほかで処理中のものは飛ばす。
-- 最高額の方は押さえがあるので、ふつうはその方で決まる。払えない（口座の停止など）ときは次に高い方（押さえは無いので残高で確かめる）
create or replace function app_private.ginoku_settle(p_id uuid, p_wait boolean default true)
returns text language plpgsql set search_path = '' as $$
declare a app_private.ginoku_auctions; b record; r jsonb; v_log jsonb := '[]'::jsonb;
begin
  if p_wait then
    select * into a from app_private.ginoku_auctions where id = p_id for update;
  else
    select * into a from app_private.ginoku_auctions where id = p_id for update skip locked;
  end if;
  if a.id is null then return 'busy'; end if;
  if a.status <> 'open' then return a.status; end if;
  if a.ends_at > now() then return 'open'; end if;
  for b in
    select user_id, max(amount) as amount
    from app_private.ginoku_bids where auction_id = a.id
    group by user_id
    order by max(amount) desc, min(created_at) asc
  loop
    r := app_private.ginoku_charge_and_issue(a.id, b.user_id, b.amount, 'bid');
    if coalesce((r->>'ok')::boolean, false) then
      update app_private.ginoku_auctions set settle_log = settle_log || v_log where id = a.id;
      return 'sold';
    end if;
    v_log := v_log || jsonb_build_array(jsonb_build_object('user_id', b.user_id, 'amount', b.amount, 'error', r->>'error', 'at', now()));
  end loop;
  update app_private.ginoku_holds set status = 'released', release_reason = 'unsold', updated_at = now()
  where auction_id = a.id and status = 'held';
  update app_private.ginoku_auctions
  set status = 'unsold', settled_at = now(), settle_log = settle_log || v_log, updated_at = now()
  where id = a.id;
  return 'unsold';
end;
$$;

-- お客様に見せる形（入札した方の ID は出さない）。free_menu（無料券）・held（自分の押さえ）を足す
create or replace function app_private.ginoku_json(a app_private.ginoku_auctions, p_user text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'title', a.title, 'prize_code', a.prize_code, 'rank', a.rank,
    'ticket_amount', a.ticket_amount, 'free_menu', a.free_menu,
    'ticket_days', a.ticket_days, 'weekday_only', a.weekday_only, 'note', a.note,
    'start_price', a.start_price, 'increment', a.increment, 'buy_now_price', a.buy_now_price,
    'current_price', a.current_price, 'min_bid', app_private.ginoku_min_bid(a), 'bid_count', a.bid_count,
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'extended', a.ends_at > a.original_ends_at,
    'status', case when a.status = 'open' and a.ends_at <= now() then 'ending' else a.status end,
    'sold_via', a.sold_via, 'final_price', a.final_price,
    'my_bid', (select max(x.amount) from app_private.ginoku_bids x where x.auction_id = a.id and x.user_id = p_user),
    'held', case when p_user is null then null else
      (select g.amount from app_private.ginoku_holds g where g.auction_id = a.id and g.user_id = p_user and g.status = 'held' and a.status = 'open') end,
    'mine', case
      when p_user is null then null
      when a.status = 'sold' and a.winner_user = p_user then 'won'
      when not exists (select 1 from app_private.ginoku_bids x where x.auction_id = a.id and x.user_id = p_user) then null
      when a.status = 'open' then case when a.leader_user = p_user then 'leading' else 'outbid' end
      else 'lost' end,
    'ticket_id', case when a.status = 'sold' and a.winner_user = p_user then a.ticket_id end
  )
$$;

-- 入札：最高額になったら入札額を押さえ、前の最高額の方の押さえを同じトランザクションで戻す
create or replace function public.customer_ginoku_bid(p_session text, p_id uuid, p_amount integer)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); a app_private.ginoku_auctions; w jsonb;
        v_acc public.ginpay_accounts; v_own integer; v_avail integer; v_min integer; v_extended boolean := false; v_bid uuid;
begin
  select * into a from app_private.ginoku_auctions where id = p_id for update;
  if a.id is null or a.status = 'cancelled' or a.starts_at > now() then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'open' or a.ends_at <= now() then
    perform app_private.ginoku_settle(a.id, true);
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'ended'))::json;
  end if;
  v_min := app_private.ginoku_min_bid(a);
  if p_amount is null or p_amount < v_min then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'too_low', 'min_bid', v_min))::json;
  end if;
  if p_amount > 1000000 then return json_build_object('error', 'too_high'); end if;
  if a.buy_now_price is not null and p_amount >= a.buy_now_price then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'use_buy_now'))::json;
  end if;
  if a.leader_user = v_user then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'already_leading'))::json;
  end if;
  -- 口座の行ロック（オークションの行のあと）。ここから先、この口座の会計・仮支払い・ほかの入札は待つ
  w := app_private.ginoku_wallet(v_user, true);
  if w ? 'error' then return json_build_object('error', w->>'error'); end if;
  select * into v_acc from public.ginpay_accounts where id = (w->>'account_id')::uuid;
  -- 使える額＝残高 − 押さえ（予約の仮支払い・ほかのオークションの押さえ）。このオークションの自分の押さえは除く（最高額のあいだは入札できないので、ふつうは 0）
  v_own := coalesce((select sum(g.amount) from app_private.ginoku_holds g
                     where g.auction_id = a.id and g.user_id = v_user and g.account_id = v_acc.id and g.status = 'held'), 0);
  v_avail := v_acc.balance_cached - (app_private.ginpay_held_sum(v_acc.id) - v_own);
  if v_avail < p_amount then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'insufficient_balance', 'available', greatest(v_avail, 0)))::json;
  end if;
  -- 前の最高額の方の押さえを戻す（抜かれた）
  update app_private.ginoku_holds set status = 'released', release_reason = 'outbid', updated_at = now()
  where auction_id = a.id and status = 'held';
  insert into app_private.ginoku_bids (auction_id, user_id, amount, created_at) values (a.id, v_user, p_amount, clock_timestamp())
  returning id into v_bid;
  insert into app_private.ginoku_holds (auction_id, user_id, account_id, amount, bid_id) values (a.id, v_user, v_acc.id, p_amount, v_bid);
  -- 終了5分前からの入札は、終了を5分延ばす
  v_extended := a.ends_at - now() <= interval '5 minutes';
  update app_private.ginoku_auctions
  set current_price = p_amount, bid_count = bid_count + 1, leader_user = v_user, updated_at = now(),
      ends_at = case when v_extended then ends_at + interval '5 minutes' else ends_at end
  where id = a.id;
  return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('ok', true, 'extended', v_extended))::json;
end;
$$;

-- 出品：無料の景品（額が無くメニューがある）なら無料券。名前は「銀パラ無料券」。券の額は持たない
create or replace function public.staff_ginoku_create(
  p_staff text, p_prize_code text, p_start_price integer, p_ends_at timestamptz,
  p_buy_now_price integer default null, p_title text default null, p_ticket_amount integer default null,
  p_starts_at timestamptz default null, p_increment integer default 100, p_staff_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare p app_private.gacha_prizes; a app_private.ginoku_auctions; v_amount integer; v_free boolean; v_start timestamptz := coalesce(p_starts_at, now());
begin
  perform app_private.assert_staff(p_staff);
  select * into p from app_private.gacha_prizes where code = p_prize_code;
  if p.code is null then return json_build_object('error', 'prize_not_found'); end if;
  if p_start_price is null then return json_build_object('error', 'invalid_value'); end if;
  v_free := p.amount is null and p.menu_codes is not null and cardinality(p.menu_codes) > 0 and p.free_menu is not null;
  if v_free then
    -- 無料券の値引きはその日のメニューの料金。額は付けられない
    if p_ticket_amount is not null then return json_build_object('error', 'invalid_value'); end if;
    v_amount := null;
  else
    v_amount := coalesce(p_ticket_amount, p.amount);
    if v_amount is null or v_amount <= 0 then return json_build_object('error', 'ticket_amount_required'); end if;
  end if;
  if p_ends_at is null or p_ends_at <= greatest(v_start, now()) + interval '10 minutes' or p_ends_at > v_start + interval '30 days' then
    return json_build_object('error', 'invalid_ends_at');
  end if;
  insert into app_private.ginoku_auctions (prize_code, title, rank, ticket_amount, free_menu, menu_codes, weekday_only, start_price, increment,
    buy_now_price, starts_at, ends_at, original_ends_at, created_by)
  values (p.code, coalesce(nullif(btrim(p_title), ''), case when v_free then p.free_menu || '無料券' else p.title || '券' end), p.rank,
    v_amount, case when v_free then p.free_menu end, case when v_free then p.menu_codes end, p.weekday_only, p_start_price,
    coalesce(p_increment, 100), p_buy_now_price, v_start, p_ends_at, p_ends_at, coalesce(nullif(btrim(p_staff_name), ''), 'staff'))
  returning * into a;
  return app_private.ginoku_json(a, null)::json;
exception when check_violation or not_null_violation then
  return json_build_object('error', 'invalid_value');
end;
$$;

-- 取り下げ（入札がまだ無いものだけ）。押さえは無いはずだが、念のため閉じる（トリガーでも閉じる）
create or replace function public.staff_ginoku_cancel(p_staff text, p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare a app_private.ginoku_auctions;
begin
  perform app_private.assert_staff(p_staff);
  select * into a from app_private.ginoku_auctions where id = p_id for update;
  if a.id is null then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'open' then return json_build_object('error', 'not_open'); end if;
  if a.bid_count > 0 then return json_build_object('error', 'has_bids'); end if;
  update app_private.ginoku_holds set status = 'released', release_reason = 'closed', updated_at = now() where auction_id = a.id and status = 'held';
  update app_private.ginoku_auctions set status = 'cancelled', updated_at = now() where id = a.id;
  return json_build_object('ok', true);
end;
$$;

revoke all on function app_private.ginoku_release_on_close() from public;
revoke all on function app_private.ginoku_charge_and_issue(uuid, text, integer, text) from public;
revoke all on function app_private.ginoku_settle(uuid, boolean) from public;
revoke all on function app_private.ginoku_json(app_private.ginoku_auctions, text) from public;
revoke all on function public.customer_ginoku_bid(text, uuid, integer) from public;
grant execute on function public.customer_ginoku_bid(text, uuid, integer) to anon, authenticated;
revoke all on function public.staff_ginoku_create(text, text, integer, timestamptz, integer, text, integer, timestamptz, integer, text) from public;
grant execute on function public.staff_ginoku_create(text, text, integer, timestamptz, integer, text, integer, timestamptz, integer, text) to anon, authenticated;
revoke all on function public.staff_ginoku_cancel(text, uuid) from public;
grant execute on function public.staff_ginoku_cancel(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
