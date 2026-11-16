-- Black Monday の通しの試験（Staging だけ）。最後に ROLLBACK_OK を投げて、作ったものはすべて巻き戻す
do $bmtest$
<<t>>
declare
  mon date := '2026-11-30'; tue date := '2026-12-01';
  s1 uuid; s2 uuid; s3 uuid;
  m jsonb; sess text; u text; cid uuid;
  u2 text; u3 text; u4 text; u5 text; u6 text; u7 text;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid; r8 uuid; r9 uuid; rh uuid; newid uuid;
  x jsonb; q1 jsonb; q2 jsonb; pv jsonb; tk uuid; sale jsonb; ok text := '';
  item jsonb := jsonb_build_object('source', 'reservation', 'ref_id', 'perm-punch', 'name', 'パンチパーマ', 'category', 'menu', 'unit_price', 8000, 'quantity', 1);
  function_ok boolean;
begin
  execute $fdefA$CREATE OR REPLACE FUNCTION app_private.finalize_sale(p jsonb, p_actor_type text, p_actor_name text)
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
$function$$fdefA$;
  execute $fdefB$CREATE OR REPLACE FUNCTION app_private.checkout_context_json(p_reservation_id uuid, p_client_id uuid)
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
$function$$fdefB$;
  update public.booking_settings set app_booking_enabled = true, min_lead_minutes = 0 where id = 1;
  insert into public.staff_members(display_name) values ('QA BM 1') returning id into s1;
  insert into public.staff_members(display_name) values ('QA BM 2') returning id into s2;
  insert into public.staff_members(display_name) values ('QA BM 3') returning id into s3;
  insert into public.staff_shift_templates(staff_id, weekday, start_time, end_time)
    select s, d, '08:00', '21:00' from unnest(array[s1, s2, s3]) s cross join unnest(array[1, 2]) d;
  insert into public.staff_menu_capabilities(staff_id, menu_id)
    select s, mm.id from unnest(array[s1, s2, s3]) s cross join public.service_menus mm where mm.code in ('perm-punch', 'perm-pin', 'perm-curl-iper', 'perm-iper');

  -- 会員（試験ごとに別の会員。1人1件の決まりにかからないように）
  m := public.customer_register('QA BM 本人', true); sess := m->>'session'; u := m->>'user_id';
  insert into app_private.customer_store_verifications select c.id, now(), 'qa', 'qa' from public.customers c where c.user_id = u;
  u2 := public.customer_register('QA BM 二', true)->>'user_id';
  u3 := public.customer_register('QA BM 三', true)->>'user_id';
  u4 := public.customer_register('QA BM 四', true)->>'user_id';
  u5 := public.customer_register('QA BM 五', true)->>'user_id';
  u6 := public.customer_register('QA BM 六', true)->>'user_id';
  u7 := public.customer_register('QA BM 七', true)->>'user_id';

  -- 1. 見込み：祝日の月曜（11/23）も対象・日曜は対象外・カールアイパーは対象外・2メニューで 4,000
  if (app_private.black_monday_quote(app_private.jst_ts('2026-11-23', '10:00'), array['perm-punch'])->>'amount')::int is distinct from 2000 then raise exception 'FAIL 1a 祝日の月曜'; end if;
  if app_private.black_monday_quote(app_private.jst_ts('2026-11-29', '10:00'), array['perm-punch']) is not null then raise exception 'FAIL 1b 日曜'; end if;
  if app_private.black_monday_quote(app_private.jst_ts(mon, '10:00'), array['perm-curl-iper']) is not null then raise exception 'FAIL 1c 対象外メニュー'; end if;
  if (app_private.black_monday_quote(app_private.jst_ts(mon, '10:00'), array['perm-punch', 'perm-pin'])->>'amount')::int is distinct from 4000 then raise exception 'FAIL 1d 2メニュー'; end if;
  if public.menu_price_rules()->'black_monday'->>'amount' is distinct from '2000' then raise exception 'FAIL 1e 料金表'; end if;
  ok := ok || '1 見込み OK; ';

  -- 2. 月曜のアプリの予約に印が付く
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 本人', 'user_id', u, 'staff_id', s1,
         'starts_at', app_private.jst_ts(mon, '10:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 2 予約: %', x; end if;
  r1 := (x->>'id')::uuid;
  if (select amount from app_private.black_monday_marks where reservation_id = r1) is distinct from 2000 then raise exception 'FAIL 2a 印'; end if;
  if (app_private.reservation_json_customer(r1)->'black_monday'->>'amount')::int is distinct from 2000 then raise exception 'FAIL 2b お客様の予約: %', app_private.reservation_json_customer(r1); end if;
  if (app_private.sb_reservation(r1)->'black_monday'->>'amount')::int is distinct from 2000 then raise exception 'FAIL 2c SB'; end if;
  if (select (j->'black_monday'->>'amount')::int from jsonb_array_elements(public.customer_list_reservations(sess)::jsonb) j where j->>'id' = r1::text) is distinct from 2000 then raise exception 'FAIL 2d 次回予約の一覧'; end if;
  ok := ok || '2 月曜の予約に印 OK; ';

  -- 3. 店（SB・店舗端末）で火曜に変えると外れる・月曜に戻すと付く
  x := app_private.reschedule_reservation(r1, app_private.jst_ts(tue, '10:00'), s1, 'staff', 'QA');
  if x ? 'error' then raise exception 'FAIL 3 変更: %', x; end if;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r1) then raise exception 'FAIL 3a 火曜でも印'; end if;
  if app_private.reservation_json(r1)->'black_monday' <> 'null'::jsonb then raise exception 'FAIL 3b 火曜の予約に表示'; end if;
  x := app_private.reschedule_reservation(r1, app_private.jst_ts(mon, '10:00'), s1, 'staff', 'QA');
  if x ? 'error' then raise exception 'FAIL 3c 戻す: %', x; end if;
  if (select amount from app_private.black_monday_marks where reservation_id = r1) is distinct from 2000 then raise exception 'FAIL 3d 月曜に戻して印'; end if;
  -- メニューだけ変える（SB のメニューの差し替え）：対象外にすると外れ、2つにすると 4,000
  update public.reservation_items set menu_code = 'perm-curl-iper', name = 'カールアイパー' where reservation_id = r1;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r1) then raise exception 'FAIL 3e 対象外メニューで印'; end if;
  update public.reservation_items set menu_code = 'perm-punch', name = 'パンチパーマ' where reservation_id = r1;
  if not exists (select 1 from app_private.black_monday_marks where reservation_id = r1) then raise exception 'FAIL 3f 対象メニューに戻して印なし'; end if;
  ok := ok || '3 店で火曜→外れる・月曜→付く・メニュー OK; ';

  -- 4. 予約変更の確認（reservation_review）：前後の額。2回作っても同じ（確定の照合が崩れない）
  q1 := app_private.reservation_review(r1, app_private.jst_ts(tue, '12:00'), array['perm-punch']);
  q2 := app_private.reservation_review(r1, app_private.jst_ts(tue, '12:00'), array['perm-punch']);
  if q1->'impact'->'black_monday' is distinct from '{"before": 2000, "after": 0}'::jsonb then raise exception 'FAIL 4a 外れる: %', q1->'impact'; end if;
  if q1 is distinct from q2 then raise exception 'FAIL 4b 同じにならない'; end if;
  q1 := app_private.reservation_review(r1, app_private.jst_ts(mon, '12:00'), array['perm-punch', 'perm-pin']);
  if q1->'impact'->'black_monday'->>'after' is distinct from '4000' then raise exception 'FAIL 4c 2メニュー: %', q1->'impact'; end if;
  ok := ok || '4 変更の確認 OK; ';

  -- 5. アプリで変更（reservation_mutate：古い予約を取り消して新しい予約）。火曜へ→外れる、月曜へ→付く
  pv := public.customer_change_preview(sess, r1, app_private.jst_ts(tue, '12:00'), array['perm-punch'])::jsonb;
  if pv ? 'error' then raise exception 'FAIL 5 確認: %', pv; end if;
  if pv->'black_monday' is distinct from '{"before": 2000, "after": 0}'::jsonb then raise exception 'FAIL 5a 確認の表示: %', pv; end if;
  x := app_private.reservation_mutate(sess, 'change', r1, app_private.jst_ts(tue, '12:00'), array['perm-punch'], 'qa-bm-change-1', pv->'confirmation');
  if x->>'state' is distinct from 'completed' then raise exception 'FAIL 5b 変更: %', x; end if;
  newid := (x->'result'->>'id')::uuid;
  if exists (select 1 from app_private.black_monday_marks where reservation_id in (r1, newid)) then raise exception 'FAIL 5c 火曜へ変えても印'; end if;
  pv := public.customer_change_preview(sess, newid, app_private.jst_ts(mon, '14:00'), array['perm-punch'])::jsonb;
  if pv->'black_monday' is distinct from '{"before": 0, "after": 2000}'::jsonb then raise exception 'FAIL 5d 付く表示: %', pv; end if;
  x := app_private.reservation_mutate(sess, 'change', newid, app_private.jst_ts(mon, '14:00'), array['perm-punch'], 'qa-bm-change-2', pv->'confirmation');
  if x->>'state' is distinct from 'completed' then raise exception 'FAIL 5e 変更: %', x; end if;
  r2 := (x->'result'->>'id')::uuid;
  if (select amount from app_private.black_monday_marks where reservation_id = r2) is distinct from 2000 then raise exception 'FAIL 5f 月曜へ変えて印なし'; end if;
  if (x->'result'->'black_monday'->>'amount')::int is distinct from 2000 then raise exception 'FAIL 5g 変更の結果: %', x->'result'; end if;
  ok := ok || '5 アプリの変更 OK; ';

  -- 6. 取消・無断キャンセルの予約の印は効かない
  x := app_private.set_reservation_status(r2, 'cancelled', 'staff', 'QA', 'QA');
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r2) or app_private.black_monday_json(r2) is not null then raise exception 'FAIL 6a 取消で印'; end if;
  if (app_private.black_monday_checkout_json(r2)->>'eligible')::boolean then raise exception 'FAIL 6b 取消の会計'; end if;
  ok := ok || '6 取消 OK; ';

  -- 7. HOT PEPPER の予約は付かない
  x := app_private.create_reservation(jsonb_build_object('source', 'hotpepper', 'customer_name', 'QA BM HPB', 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '08:00'), 'menu_codes', array['perm-punch']), 'staff', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 7 予約: %', x; end if;
  rh := (x->>'id')::uuid;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = rh) then raise exception 'FAIL 7a HPB に印'; end if;
  ok := ok || '7 HPB OK; ';

  -- 8. 会計で ¥2,000 引く・expected_total がずれたら total_mismatch
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 二', 'user_id', u2, 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '10:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 8 予約: %', x; end if;
  r3 := (x->>'id')::uuid;
  if not (app_private.black_monday_checkout_json(r3)->>'eligible')::boolean then raise exception 'FAIL 8a 会計の情報'; end if;
  if app_private.checkout_context_json(r3, null)->'black_monday'->>'unit' is distinct from '2000' then raise exception 'FAIL 8b checkout_context_json'; end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r3, 'stylist_id', s2, 'items', jsonb_build_array(item),
            'payment_method', 'cash', 'expected_total', 8000), 'staff', 'QA');
  if sale->>'error' is distinct from 'total_mismatch' or (sale->>'total')::int <> 6000 then raise exception 'FAIL 8c 照合: %', sale; end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r3, 'stylist_id', s2, 'items', jsonb_build_array(item),
            'payment_method', 'cash', 'expected_total', 6000), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 6000 then raise exception 'FAIL 8d 会計: %', sale; end if;
  if not exists (select 1 from public.accounting_discounts where session_id = (sale->>'id')::uuid and kind = 'campaign' and label = 'Black Monday' and amount = 2000) then raise exception 'FAIL 8e 値引きの記録'; end if;
  if (select discount_total from public.accounting_sessions where id = (sale->>'id')::uuid) <> 2000 then raise exception 'FAIL 8f 値引きの合計'; end if;
  ok := ok || '8 会計 ¥2,000・照合 OK; ';

  -- 9. Welcome 券を使う会計では引かない（予約に付けたら表示も 0）
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 三', 'user_id', u3, 'staff_id', s3,
         'starts_at', app_private.jst_ts(mon, '10:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r4 := (x->>'id')::uuid;
  insert into public.tickets(user_id, type, title, amount, issued_by, used) values (u3, 'discount', 'パーマ Welcomeクーポン', 2000, 'system-welcome', false) returning id into tk;
  insert into app_private.reservation_ticket_plans(reservation_id, user_id, ticket_ids) values (r4, u3, array[tk]);
  if (app_private.black_monday_json(r4)->>'amount')::int <> 0 or not (app_private.black_monday_json(r4)->>'perm_coupon')::boolean then raise exception 'FAIL 9a 券を付けた予約の表示: %', app_private.black_monday_json(r4); end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r4, 'stylist_id', s3, 'items', jsonb_build_array(item), 'ticket_ids', jsonb_build_array(tk),
            'payment_method', 'cash', 'expected_total', 6000), 'staff', 'QA');
  if sale ? 'error' then raise exception 'FAIL 9b 会計: %', sale; end if;
  if exists (select 1 from public.accounting_discounts where session_id = (sale->>'id')::uuid and kind = 'campaign') then raise exception 'FAIL 9c Welcome と併用された'; end if;
  ok := ok || '9 Welcome は併用なし OK; ';

  -- 10. ガチャの無料券と併用：Black Monday のあと残りを無料券がまかなう（合計 0・負にならない）
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 四', 'user_id', u4, 'staff_id', s1,
         'starts_at', app_private.jst_ts(mon, '12:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r5 := (x->>'id')::uuid;
  insert into app_private.gacha_holdings(user_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes, reservation_id, self_only)
    values (u4, 'free-apachi', 'パンチパーマ無料', null, 'パンチパーマ', false, 'rare', now() + interval '60 days', array['perm-punch'], r5, false);
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r5, 'stylist_id', s1, 'items', jsonb_build_array(item), 'use_gacha', true,
            'payment_method', 'cash', 'expected_total', 0), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 0 then raise exception 'FAIL 10a 無料券と併用: %', sale; end if;
  if (select amount from public.accounting_discounts where session_id = (sale->>'id')::uuid and ticket_type = 'gacha') <> 6000 then raise exception 'FAIL 10b 無料券の額'; end if;
  -- 額の決まったガチャ券（7,000）と併用：料金を超えた分は 0 円（負にならない）
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 五', 'user_id', u5, 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '12:00'), 'menu_codes', array['perm-punch']), 'customer', 'qa', 0);
  r6 := (x->>'id')::uuid;
  insert into app_private.gacha_holdings(user_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes, reservation_id, self_only)
    values (u5, 'off500', '7000円引き', 7000, null, false, 'rare', now() + interval '60 days', null, r6, false);
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r6, 'stylist_id', s2, 'items', jsonb_build_array(item), 'use_gacha', true,
            'payment_method', 'cash', 'expected_total', 0), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 0 then raise exception 'FAIL 10c 額の券と併用: %', sale; end if;
  ok := ok || '10 ガチャ券と併用 OK; ';

  -- 11. 対象メニュー2つで ¥4,000
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 六', 'user_id', u6, 'staff_id', s3,
         'starts_at', app_private.jst_ts(mon, '12:00'), 'menu_codes', array['perm-punch', 'perm-pin']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 11 予約: %', x; end if;
  r7 := (x->>'id')::uuid;
  if (select amount from app_private.black_monday_marks where reservation_id = r7) <> 4000 then raise exception 'FAIL 11a 印 4,000'; end if;
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', r7, 'stylist_id', s3, 'items', jsonb_build_array(item,
              jsonb_build_object('source', 'reservation', 'ref_id', 'perm-pin', 'name', 'ピンパーマ', 'category', 'menu', 'unit_price', 12000, 'quantity', 1)),
            'payment_method', 'cash', 'expected_total', 16000), 'staff', 'QA');
  if sale ? 'error' or (sale->>'total')::int <> 16000 then raise exception 'FAIL 11b 2メニューの会計: %', sale; end if;
  ok := ok || '11 2メニューで ¥4,000 OK; ';

  -- 12. 予約のない会計では引かない
  select app_private.client_root(client_id) into cid from public.reservations where id = r7;
  sale := app_private.finalize_sale(jsonb_build_object('client_id', cid, 'stylist_id', s3,
            'items', jsonb_build_array(item || jsonb_build_object('source', 'service_menu')), 'payment_method', 'cash', 'expected_total', 8000), 'staff', 'QA');
  if sale ? 'error' then raise exception 'FAIL 12 予約なし: %', sale; end if;
  ok := ok || '12 予約なしは通常 OK; ';

  -- 14. 設定を変える（開始日を先に）と、まだの予約の印が外れ、戻すと付く
  x := app_private.create_reservation(jsonb_build_object('source', 'app', 'customer_name', 'QA BM 本人', 'user_id', u, 'staff_id', s2,
         'starts_at', app_private.jst_ts(mon, '17:00'), 'menu_codes', array['perm-iper', 'perm-punch']), 'customer', 'qa', 0);
  if x ? 'error' then raise exception 'FAIL 14 予約: %', x; end if;
  r9 := (x->>'id')::uuid;
  update app_private.black_monday_settings set starts_on = '2027-01-01' where id = 1;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = r9) then raise exception 'FAIL 14a 開始日の前で印'; end if;
  update app_private.black_monday_settings set starts_on = '2026-11-02' where id = 1;
  if not exists (select 1 from app_private.black_monday_marks where reservation_id = r9) then raise exception 'FAIL 14b 戻して印なし'; end if;
  ok := ok || '14 設定の変更 OK; ';

  raise exception 'ROLLBACK_OK %', ok;
end $bmtest$;
