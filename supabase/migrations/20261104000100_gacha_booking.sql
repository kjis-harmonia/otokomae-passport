-- ガチャ工程②（11/4）：ガチャ券を AI 予約に付けて、店の会計で自動で引く
--   ・予約の確認画面で、使える券なら自動で付ける（1予約1枚）。付けた券は予約が終わる（会計・キャンセル）まで交換できない
--     （銀Pay の仮支払いは券を引いた額で押さえているため、券が変わると額がずれる）
--   ・使える条件：予約の日が期限内／平日のみの券は土日祝でない／メニューの決まった券はそのメニュー／割引券はメンテナンスカット以外
--   ・会計：予約に付いた券を店舗端末が最初から引いた状態で出す（外すこともできる）。確定で使用済み、会計の取消で戻る
--   ・無料券は、そのメニューの料金をまるごと引く。追加スキンフェード無料は 1,000円引き（スキンフェード 5,000 − 通常カット 4,000）

alter table app_private.gacha_prizes add column if not exists menu_codes text[];
alter table app_private.gacha_holdings add column if not exists menu_codes text[];
alter table app_private.gacha_holdings add column if not exists reservation_id uuid references public.reservations(id) on delete set null;
alter table app_private.gacha_holdings add column if not exists used_sale_id uuid;
create index if not exists gacha_holdings_reservation on app_private.gacha_holdings (reservation_id) where reservation_id is not null;

update app_private.gacha_prizes set menu_codes = array['store-teitei-gari'] where code = 'teitei1000';
update app_private.gacha_prizes set menu_codes = array['cut-skin-fade', 'cut-skin-fade-plus', 'cut-kids-skin-fade', 'set-fade-color'],
  amount = 1000 where code = 'skinfade';
update app_private.gacha_prizes set menu_codes = array['perm-apache'] where code = 'free-apachi';
update app_private.gacha_prizes set menu_codes = array['perm-ginpara-curly'] where code = 'free-ginpara';
update app_private.gacha_prizes set menu_codes = array['perm-punch'] where code = 'free-punch';
update app_private.gacha_prizes set menu_codes = array['perm-iper', 'perm-curl-iper'] where code = 'free-aipa';
update app_private.gacha_prizes set menu_codes = array['perm-negro'] where code = 'free-nigro';
-- すでに持っている券にも写す
update app_private.gacha_holdings h set menu_codes = p.menu_codes, amount = coalesce(h.amount, case when p.code = 'skinfade' then p.amount end)
  from app_private.gacha_prizes p where p.code = h.prize_code;

/** 土日祝（日本時間）か */
create or replace function app_private.gacha_offday(p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select extract(isodow from (p_at at time zone 'Asia/Tokyo')) in (6, 7)
      or exists (select 1 from app_private.holidays where day = (p_at at time zone 'Asia/Tokyo')::date)
$$;

/** 券が付いている、まだ終わっていない予約（会計前・キャンセルでない）。無ければ null */
create or replace function app_private.gacha_active_reservation(p_reservation uuid)
returns public.reservations language sql stable set search_path = '' as $$
  select r.* from public.reservations r
  where r.id = p_reservation and r.status = 'confirmed'
    and not exists (select 1 from public.accounting_sessions s where s.reservation_id = r.id and s.status = 'completed')
$$;

/** その予約に券が使えるか。使えれば null、使えなければ理由 */
create or replace function app_private.gacha_unfit(p_user text, p_reservation uuid)
returns text language plpgsql stable set search_path = '' as $$
declare h app_private.gacha_holdings; r public.reservations; v_codes text[];
begin
  select * into h from app_private.gacha_holdings where user_id = p_user and used_at is null and expires_at > now();
  if h.user_id is null then return 'no_ticket'; end if;
  r := app_private.gacha_active_reservation(p_reservation);
  if r.id is null or r.user_id is distinct from p_user then return 'not_found'; end if;
  if h.expires_at <= r.starts_at then return 'expired'; end if;
  if h.weekday_only and app_private.gacha_offday(r.starts_at) then return 'weekday'; end if;
  select coalesce(array_agg(menu_code), '{}') into v_codes from public.reservation_items where reservation_id = r.id;
  if h.menu_codes is not null and not (v_codes && h.menu_codes) then return 'menu'; end if;
  if h.menu_codes is null and not exists (select 1 from unnest(v_codes) c where c <> 'maintenance') then return 'menu'; end if;
  return null;
end;
$$;

create or replace function app_private.gacha_hold(p_user text, p_draw uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p app_private.gacha_prizes; v_last date := app_private.today_jst() + 30;
begin
  select pr.* into p from app_private.gacha_draws d join app_private.gacha_prizes pr on pr.code = d.prize_code where d.id = p_draw;
  insert into app_private.gacha_holdings (user_id, draw_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes)
  values (p_user, p_draw, p.code, p.title, p.amount, p.free_menu, p.weekday_only, p.rank, ((v_last + 1)::timestamp at time zone 'Asia/Tokyo'), p.menu_codes)
  on conflict (user_id) do update set draw_id = excluded.draw_id, prize_code = excluded.prize_code, title = excluded.title,
    amount = excluded.amount, free_menu = excluded.free_menu, weekday_only = excluded.weekday_only, rank = excluded.rank,
    expires_at = excluded.expires_at, menu_codes = excluded.menu_codes, used_at = null, created_at = now(),
    reservation_id = null, used_sale_id = null;
end;
$$;

/** 使える持ち券。予約に付いていれば reserved（予約の id と日時） */
create or replace function app_private.gacha_held_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object('code', h.prize_code, 'title', h.title, 'amount', h.amount, 'free_menu', h.free_menu,
                           'weekday_only', h.weekday_only, 'rank', h.rank, 'expires_at', h.expires_at, 'menu_codes', h.menu_codes,
                           'reserved', (select json_build_object('id', r.id, 'starts_at', r.starts_at)
                                        from app_private.gacha_active_reservation(h.reservation_id) r where r.id is not null))
  from app_private.gacha_holdings h
  where h.user_id = p_user and h.used_at is null and h.expires_at > now()
$$;

/** 予約に付いている券は交換できない（今の券を残すことはできる） */
create or replace function public.customer_gacha_keep(p_session text, p_choice text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); d app_private.gacha_draws; h app_private.gacha_holdings;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice not in ('new', 'old') then return json_build_object('error', 'bad_choice'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  d := app_private.gacha_pending(v_user);
  if d.id is not null then
    select * into h from app_private.gacha_holdings where user_id = v_user and used_at is null and expires_at > now();
    if p_choice = 'new' and h.user_id is not null and (app_private.gacha_active_reservation(h.reservation_id)).id is not null then
      return json_build_object('error', 'held_reserved');
    end if;
    if p_choice = 'new' or h.user_id is null then
      perform app_private.gacha_hold(v_user, d.id);
    end if;
    update app_private.gacha_draws set choice = p_choice, decided_at = now() where id = d.id;
  end if;
  return app_private.gacha_state(v_user);
end;
$$;

/** お客様：持ち券を予約に付ける（予約の確認で自動）。ほかの予約に付いていて、その予約がまだ終わっていなければ付け替えない */
create or replace function public.customer_gacha_attach(p_session text, p_reservation_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); h app_private.gacha_holdings; v_why text;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  select * into h from app_private.gacha_holdings where user_id = v_user for update;
  if h.reservation_id = p_reservation_id and h.used_at is null then return app_private.gacha_state(v_user); end if;
  if h.reservation_id is not null and (app_private.gacha_active_reservation(h.reservation_id)).id is not null then
    return json_build_object('error', 'held_reserved');
  end if;
  v_why := app_private.gacha_unfit(v_user, p_reservation_id);
  if v_why is not null then return json_build_object('error', v_why); end if;
  update app_private.gacha_holdings set reservation_id = p_reservation_id where user_id = v_user;
  return app_private.gacha_state(v_user);
end;
$$;

revoke all on function app_private.gacha_offday(timestamptz), app_private.gacha_active_reservation(uuid), app_private.gacha_unfit(text, uuid)
  from public, anon, authenticated;
revoke all on function public.customer_gacha_attach(text, uuid) from public;
grant execute on function public.customer_gacha_attach(text, uuid) to anon, authenticated, service_role;

/** 会計に出す予約のガチャ券 */
create or replace function app_private.gacha_for_reservation(p_reservation uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('title', h.title, 'amount', h.amount, 'free_menu', h.free_menu, 'menu_codes', h.menu_codes,
                            'weekday_only', h.weekday_only, 'rank', h.rank)
  from app_private.gacha_holdings h where p_reservation is not null and h.reservation_id = p_reservation and h.used_at is null
$$;
revoke all on function app_private.gacha_for_reservation(uuid) from public, anon, authenticated;


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
    -- 監査 10/28 要対応3：同じお客様・同じ日の券の使用は順番に（ほかの使用が終わってから、今日の使用を読み直す）
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
    if h.menu_codes is not null then
      select i into v_gitem from jsonb_array_elements(v_items) i
       where i->>'source' in ('reservation', 'service_menu') and i->>'ref_id' = any(h.menu_codes) limit 1;
      if v_gitem is null then return jsonb_build_object('error', 'gacha_menu'); end if;
    end if;
    -- 無料券はそのメニュー1つ分の料金（明細の値引き後）
    v_gacha := coalesce(h.amount, least((v_gitem->>'unit_price')::int,
      (v_gitem->>'unit_price')::int * coalesce((v_gitem->>'quantity')::int, 1) - coalesce((v_gitem->>'discount')::int, 0)));
    v_ticket_disc := v_ticket_disc + v_gacha;
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
    values (v_id, 'ticket', t.id, t.type, t.title, t.amount);
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
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used'
    from public.tickets t2 where t2.id = any(v_tids);
  end if;
  if v_user is not null then perform app_private.touch_visit(v_user); end if;

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

CREATE OR REPLACE FUNCTION app_private.void_sale(p_id uuid, p_reason text, p_actor_type text, p_actor_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare s public.accounting_sessions; v_tids uuid[]; g public.ginpay_transactions; v_gp jsonb;
begin
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 200 then return jsonb_build_object('error', 'reason_required'); end if;
  select * into s from public.accounting_sessions where id = p_id for update;
  if s.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if s.status <> 'completed' then return jsonb_build_object('error', 'invalid_status'); end if;
  update public.accounting_sessions set status = 'voided', voided_at = now(), voided_by = p_actor_name, void_reason = btrim(p_reason) where id = p_id;
  -- GINPay 払いの会計：元の支払い取引を参照する逆向き取引（void）を追加して残高を戻す（失敗すれば取消ごと取り消す）
  for g in select * from public.ginpay_transactions where accounting_session_id = p_id and type = 'payment' and status = 'posted' loop
    v_gp := app_private.ginpay_reverse_transaction(g.id, null, 'void', p_actor_type, p_actor_name, btrim(p_reason), 'sale-void:' || p_id::text);
    if v_gp ? 'error' then raise exception 'ginpay_%', v_gp->>'error'; end if;
  end loop;
  select coalesce(array_agg(ticket_id), '{}') into v_tids from public.accounting_discounts where session_id = p_id and kind = 'ticket' and ticket_id is not null;
  if cardinality(v_tids) > 0 then
    update public.tickets set used = false, used_at = null where id = any(v_tids);
    update public.ticket_usage_logs set status = 'voided' where ticket_id = any(select x::text from unnest(v_tids) x) and status = 'used';
  end if;
  -- ガチャ券も戻す（予約はもう終わっているので、次の予約に付け直せる）
  update app_private.gacha_holdings set used_at = null, used_sale_id = null where used_sale_id = p_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, reason, detail)
  values (p_id, 'voided', p_actor_type, p_actor_name, btrim(p_reason), jsonb_build_object('total', s.total, 'tickets_restored', cardinality(v_tids)));
  return app_private.sale_json(p_id);
end;
$function$
;

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
$function$
;

-- 選んでいない当選があり、今の券がもう無い（予約で使った・期限切れ）なら、新しい券をそのまま持たせる
--   （予約に付いた券は交換できないので「ご来店のあとに受け取れます」と案内する。来店して券を使ったら、ここで受け取る）
create or replace function app_private.gacha_settle(p_user text)
returns void language plpgsql security definer set search_path = '' as $$
declare d app_private.gacha_draws;
begin
  d := app_private.gacha_pending(p_user);
  if d.id is not null and app_private.gacha_held_json(p_user) is null then
    perform app_private.gacha_hold(p_user, d.id);
    update app_private.gacha_draws set choice = 'new', decided_at = now() where id = d.id;
  end if;
end;
$$;
revoke all on function app_private.gacha_settle(text) from public, anon, authenticated;

create or replace function public.customer_gacha_state(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  perform app_private.gacha_settle(v_user);
  return app_private.gacha_state(v_user);
end;
$$;

create or replace function public.customer_gacha_draw(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_today date := app_private.today_jst();
        v_total numeric; v_roll numeric; v_code text; v_id uuid;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  perform app_private.gacha_settle(v_user);
  -- 選んでいない当選があるうちは引かずに、それを返す（画面はどちらを残すかを出す）
  if (app_private.gacha_pending(v_user)).id is not null then return app_private.gacha_state(v_user); end if;
  if app_private.gacha_repeat() or not exists (select 1 from app_private.gacha_draws where user_id = v_user and draw_date = v_today) then
    select sum(weight) into v_total from app_private.gacha_prizes where active and weight > 0;
    if coalesce(v_total, 0) <= 0 then return json_build_object('error', 'no_prizes'); end if;
    v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric / 281474976710656 * v_total;
    select code into v_code from (
      select code, sum(weight) over (order by sort, code) as upto from app_private.gacha_prizes where active and weight > 0
    ) c where c.upto > v_roll order by c.upto limit 1;
    if v_code is null then
      select code into v_code from app_private.gacha_prizes where active and weight > 0 order by sort desc, code desc limit 1;
    end if;
    insert into app_private.gacha_draws (user_id, draw_date, prize_code) values (v_user, v_today, v_code) returning id into v_id;
    if app_private.gacha_held_json(v_user) is null then
      perform app_private.gacha_hold(v_user, v_id);
      update app_private.gacha_draws set choice = 'auto', decided_at = now() where id = v_id;
    end if;
  end if;
  return app_private.gacha_state(v_user);
end;
$$;
