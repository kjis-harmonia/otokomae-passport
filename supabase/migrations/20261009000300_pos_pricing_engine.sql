-- ============================================================================
-- GINJIRO POS Phase 0 / P0-4: Server-side Pricing / Quote Engine
-- (20261009000200_pos_operator_approval.sql の後に適用)
--
-- 金額の正本を frontend から DB / RPC へ完全移行。
--   * 単一の価格決定エンジン app_private.pos_price(...) を作成。
--   * 見積もり RPC public.staff_pos_quote と確定処理 app_private.finalize_sale は
--     全く同じ pricing engine を呼び出し、canonical quote_hash を照合する。
--   * 品目ごとの価格ルール:
--       - 予約施術: reservation_items.price (snapshot 価格を維持、マスター変更で変わらない、数量改ざん防止、重複禁止)
--       - Walk-in / POS 追加施術: service_menus.price (is_active, checkout_enabled)
--       - 会計マスター品目: accounting_items.price (is_active)
--       - 店販商品: products.price (is_active, category = '店販', price > 0)
--       - price_from メニュー: 基準価格未満を禁止、P0-5 前の基準価格超過指定は禁止
--       - 手入力商品 / 固定価格上書き / 手入力値引き: P0-5 前は一律拒否 (Fail Closed)
--   * 割引ルール:
--       - チケット: DB の有効性・期限・譲渡・平日 Welcome・1日1回ルール・所有権を行ロック後に再検証
--       - メンテナンス: 推測割引 (¥500等) は禁止。未設定 mapping は明示的拒否
--   * Customer Identity: scan session を正本とし、不一致時は customer_context_mismatch
--   * Operator Token: staff session とのバインドを検証
--   * quote_hash: POS 経路では必須 (quote_required)、不一致時は確定拒否 (quote_mismatch)
--   * request_hash: 一時的シークレット (operator_token 等) を除外して canonicalize
-- ============================================================================

-- ── 1. accounting_sessions 拡張 ──────────────────────────────────────────────
alter table public.accounting_sessions add column if not exists request_hash text;
alter table public.accounting_sessions add column if not exists quote_hash text;

create index if not exists accounting_sessions_request_hash_idx
  on public.accounting_sessions (idempotency_key, request_hash)
  where idempotency_key is not null;

-- 確定後の会計の不変性ガード（request_hash, quote_hash も保護）
create or replace function app_private.guard_accounting_session()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('completed', 'voided') then raise exception 'accounting_immutable'; end if;
    return old;
  end if;
  if old.status in ('completed', 'voided') then
    if (new.user_id, new.customer_name, new.staff_name, new.stylist_name, new.stylist_id, new.payment_method, new.subtotal,
        new.discount_total, new.total, new.used_ticket_ids, new.created_at, new.completed_at, new.reservation_id, new.tax_mode, new.tax_rate,
        new.idempotency_key, new.request_hash, new.quote_hash)
       is distinct from
       (old.user_id, old.customer_name, old.staff_name, old.stylist_name, old.stylist_id, old.payment_method, old.subtotal,
        old.discount_total, old.total, old.used_ticket_ids, old.created_at, old.completed_at, old.reservation_id, old.tax_mode, old.tax_rate,
        old.idempotency_key, old.request_hash, old.quote_hash) then
      raise exception 'accounting_immutable';
    end if;
    if old.status = 'voided' and (new.status, new.voided_at, new.voided_by, new.void_reason) is distinct from (old.status, old.voided_at, old.voided_by, old.void_reason) then
      raise exception 'accounting_immutable';
    end if;
    if old.status = 'completed' and new.status not in ('completed', 'voided') then raise exception 'accounting_immutable'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_accounting_sessions_trigger on public.accounting_sessions;
create trigger guard_accounting_sessions_trigger
  before update or delete on public.accounting_sessions
  for each row execute function app_private.guard_accounting_session();

-- ── 2. ヘルパー関数群 ─────────────────────────────────────────────────────────

-- 2-1. 操作者セッション検証（端末スタッフセッションとのバインド必須）
create or replace function app_private.resolve_pos_operator(
  p_staff_token text,
  p_operator_token text
)
returns table(operator_staff_id uuid, operator_role text)
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash text;
  v_op record;
begin
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return;
  end if;

  if p_staff_token is null or btrim(p_staff_token) = '' then
    raise exception 'staff_auth_required';
  end if;

  v_staff_hash := app_private.sha256_hex(p_staff_token);
  select o.staff_member_id, o.role, o.staff_session_hash, o.expires_at, o.revoked_at
  into v_op
  from app_private.pos_operator_sessions o
  where o.token_hash = app_private.sha256_hex(p_operator_token);

  if v_op.staff_member_id is null or v_op.revoked_at is not null or v_op.expires_at <= now()
     or v_op.staff_session_hash <> v_staff_hash then
    raise exception 'invalid_operator_session';
  end if;

  operator_staff_id := v_op.staff_member_id;
  operator_role := v_op.role;
  return next;
end;
$$;

-- 2-2. 顧客コンテキスト解決（scan_session を最優先の正本とし、不一致時は customer_context_mismatch）
create or replace function app_private.resolve_pos_client_context(
  p_staff_token text,
  p_scan_session uuid,
  p_client_id uuid,
  p_reservation_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash text;
  v_ss app_private.pos_scan_sessions;
  v_res public.reservations;
  v_canonical_client uuid := null;
  v_member uuid := null;
  v_user text := null;
  v_name text := null;
  v_scan_id uuid := null;
begin
  -- 1. scan_session が指定されている場合 (最優先・正本)
  if p_scan_session is not null then
    if p_staff_token is null or btrim(p_staff_token) = '' then
      return jsonb_build_object('error', 'staff_auth_required');
    end if;
    v_staff_hash := app_private.sha256_hex(p_staff_token);

    select * into v_ss
    from app_private.pos_scan_sessions
    where id = p_scan_session;

    if v_ss.id is null or v_ss.closed_at is not null or v_ss.expires_at <= now()
       or v_ss.staff_session_hash <> v_staff_hash then
      return jsonb_build_object('error', 'invalid_scan_session');
    end if;

    v_canonical_client := app_private.client_root(v_ss.client_id);
    if v_canonical_client is null then
      return jsonb_build_object('error', 'invalid_scan_session');
    end if;

    -- request の client_id が存在する場合、照合して不一致なら拒否
    if p_client_id is not null and app_private.client_root(p_client_id) <> v_canonical_client then
      return jsonb_build_object('error', 'customer_context_mismatch');
    end if;

    v_scan_id := v_ss.id;

  -- 2. reservation_id が指定されている場合
  elsif p_reservation_id is not null then
    select * into v_res from public.reservations where id = p_reservation_id;
    if v_res.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if v_res.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
    v_canonical_client := app_private.client_root(v_res.client_id);
    if p_client_id is not null and app_private.client_root(p_client_id) <> v_canonical_client then
      return jsonb_build_object('error', 'customer_context_mismatch');
    end if;
    v_name := coalesce(v_res.customer_name, '');

  -- 3. client_id 直接指定 (ウォークイン等)
  elsif p_client_id is not null then
    v_canonical_client := app_private.client_root(p_client_id);
    if v_canonical_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;

  if v_canonical_client is not null then
    if v_name is null or v_name = '' then
      select display_name into v_name from public.clients where id = v_canonical_client;
    end if;
    v_member := (app_private.client_members(app_private.client_family(v_canonical_client)))[1];
    if v_member is not null then
      select user_id into v_user from public.customers where id = v_member;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'client_id', v_canonical_client,
    'customer_id', v_user,
    'customer_name', v_name,
    'scan_session_id', v_scan_id,
    'reservation_id', p_reservation_id
  );
end;
$$;

-- ── 3. 単一の価格決定エンジン (app_private.pos_price) ─────────────────────────
create or replace function app_private.pos_price(
  p_request jsonb,
  p_operator_staff_id uuid default null,
  p_client_context jsonb default null,
  p_is_pos boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_res_id uuid := nullif(p_request->>'reservation_id', '')::uuid;
  v_scan_session_id uuid := null;
  v_client uuid := null;
  v_user text := null;
  v_name text := null;
  v_member uuid := null;
  r public.reservations;

  v_raw_items jsonb := coalesce(p_request->'items', '[]'::jsonb);
  v_n int;
  v_i int := 0;
  v_item jsonb;
  v_source text;
  v_ref_id text;
  v_item_name text;
  v_cat text;
  v_qty int;
  v_unit_price int;
  v_list_price int;
  v_price_source text;
  v_subtotal bigint := 0;
  v_normalized_items jsonb := '[]'::jsonb;
  v_seen_res_items uuid[] := '{}'::uuid[];

  v_tids uuid[] := '{}'::uuid[];
  v_ticket_disc bigint := 0;
  v_total bigint := 0;
  v_ticket_details jsonb := '[]'::jsonb;

  v_tax public.accounting_settings;
  v_canonical_facts jsonb;
  v_quote_hash text;
begin
  -- 1. 顧客 / 予約の特定 (p_client_context または直接)
  if p_client_context is not null and (p_client_context->>'ok')::boolean is true then
    v_client := (p_client_context->>'client_id')::uuid;
    v_user := p_client_context->>'customer_id';
    v_name := p_client_context->>'customer_name';
    v_scan_session_id := nullif(p_client_context->>'scan_session_id', '')::uuid;
    v_res_id := coalesce(nullif(p_client_context->>'reservation_id', '')::uuid, v_res_id);
  else
    if v_res_id is not null then
      select * into r from public.reservations where id = v_res_id;
      if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
      if r.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
      v_client := app_private.client_root(r.client_id);
      v_name := coalesce(r.customer_name, '');
    elsif nullif(p_request->>'client_id', '') is not null then
      v_client := app_private.client_root((p_request->>'client_id')::uuid);
      if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
    end if;

    if v_client is not null then
      if v_name is null then select display_name into v_name from public.clients where id = v_client; end if;
      v_member := (app_private.client_members(app_private.client_family(v_client)))[1];
      if v_member is not null and v_user is null then
        select user_id into v_user from public.customers where id = v_member;
      end if;
    end if;
  end if;

  -- 2. 品目計算
  v_n := jsonb_array_length(v_raw_items);
  if v_n = 0 or v_n > 50 then return jsonb_build_object('error', 'invalid_items'); end if;

  for v_item in select * from jsonb_array_elements(v_raw_items) loop
    v_i := v_i + 1;
    v_source := nullif(btrim(coalesce(v_item->>'source', '')), '');
    if v_source is null or v_source not in ('reservation', 'service_menu', 'accounting_item', 'product', 'manual') then
      return jsonb_build_object('error', 'invalid_items');
    end if;
    v_ref_id := nullif(btrim(coalesce(v_item->>'ref_id', '')), '');
    v_item_name := btrim(coalesce(v_item->>'name', ''));
    v_cat := coalesce(v_item->>'category', 'menu');

    begin
      v_qty := coalesce((v_item->>'quantity')::int, 1);
    exception when others then
      return jsonb_build_object('error', 'invalid_items');
    end;

    if v_qty < 1 or v_qty > 99 or v_cat not in ('menu', 'option', 'retail') then
      return jsonb_build_object('error', 'invalid_items');
    end if;

    v_unit_price := null;
    v_list_price := null;
    v_price_source := null;

    case v_source
      when 'reservation' then
        if v_res_id is null then return jsonb_build_object('error', 'reservation_required_for_item'); end if;
        declare
          ri public.reservation_items;
        begin
          select * into ri from public.reservation_items
          where reservation_id = v_res_id
            and (menu_code = v_ref_id or id::text = v_ref_id)
          order by sort_order limit 1;

          if ri.id is null and v_item_name <> '' then
            select * into ri from public.reservation_items
            where reservation_id = v_res_id and name = v_item_name
            order by sort_order limit 1;
          end if;

          if ri.id is null then return jsonb_build_object('error', 'reservation_item_not_found'); end if;

          -- 重複指定の拒否 (HIGH 1)
          if ri.id = any(v_seen_res_items) then
            return jsonb_build_object('error', 'duplicate_reservation_item');
          end if;
          v_seen_res_items := array_append(v_seen_res_items, ri.id);

          -- 価格未設定の明示的拒否 (HIGH 1)
          if ri.price is null then
            return jsonb_build_object('error', 'reservation_price_missing');
          end if;

          -- クライアント指定 quantity で増幅させず、スナップショット quantity (=1) を正本とする (HIGH 1)
          v_qty := 1;
          v_unit_price := ri.price;
          v_list_price := ri.price;
          v_price_source := 'reservation_snapshot';
          v_item_name := ri.name; -- サーバー解決名称
          v_cat := 'menu';
        end;

      when 'service_menu' then
        declare
          sm public.service_menus;
        begin
          if v_ref_id is null then return jsonb_build_object('error', 'invalid_items'); end if;

          select * into sm from public.service_menus
          where (code = v_ref_id or id::text = v_ref_id) and is_active;

          if sm.id is null or not sm.checkout_enabled or sm.price is null then
            return jsonb_build_object('error', 'service_menu_not_found_or_inactive');
          end if;

          -- P0-5 前は price_override は一律拒否 (BLOCKER 3)
          if v_item ? 'price_override' and v_item->'price_override' is not null and v_item->'price_override' ? 'price' then
            return jsonb_build_object('error', 'l2_authorization_not_enabled');
          end if;

          v_item_name := sm.name;
          v_cat := case sm.kind when 'option' then 'option' else 'menu' end;
          v_list_price := sm.price;

          if sm.price_from then
            -- 「〜円」メニュー: 基準価格未満は禁止
            if (v_item->>'unit_price' is not null and (v_item->>'unit_price')::int < sm.price)
               or (v_item->>'price' is not null and (v_item->>'price')::int < sm.price) then
              return jsonb_build_object('error', 'below_base_price', 'base_price', sm.price);
            end if;
            -- 基準価格超過指定は P0-5 前は一律拒否 (BLOCKER 3)
            if (v_item->>'unit_price' is not null and (v_item->>'unit_price')::int > sm.price)
               or (v_item->>'price' is not null and (v_item->>'price')::int > sm.price) then
              return jsonb_build_object('error', 'l2_authorization_not_enabled');
            end if;

            v_unit_price := sm.price;
            v_price_source := 'service_master';
          else
            -- 通常サービスメニュー
            v_unit_price := sm.price;
            v_price_source := 'service_master';
          end if;
        end;

      when 'product' then
        declare
          prod public.products;
        begin
          -- 名前による曖昧検索を禁止、ID/code のみ (Product Identity)
          if v_ref_id is null then return jsonb_build_object('error', 'invalid_items'); end if;

          select * into prod from public.products
          where id::text = v_ref_id
            and is_active and category = '店販';

          if prod.id is null or prod.price is null or prod.price <= 0 then
            return jsonb_build_object('error', 'product_not_found_or_inactive');
          end if;

          -- P0-5 前は price_override 拒否 (BLOCKER 3)
          if v_item ? 'price_override' and v_item->'price_override' is not null and v_item->'price_override' ? 'price' then
            return jsonb_build_object('error', 'l2_authorization_not_enabled');
          end if;

          v_item_name := prod.name;
          v_cat := 'retail';
          v_list_price := prod.price;
          v_unit_price := prod.price;
          v_price_source := 'product_master';
        end;

      when 'accounting_item' then
        declare
          ai public.accounting_items;
        begin
          if v_ref_id is null then return jsonb_build_object('error', 'invalid_items'); end if;

          select * into ai from public.accounting_items
          where (id::text = v_ref_id or name = v_ref_id)
            and is_active and category in ('menu', 'option');

          if ai.id is null or ai.price is null then
            return jsonb_build_object('error', 'accounting_item_not_found_or_inactive');
          end if;

          if v_item ? 'price_override' and v_item->'price_override' is not null and v_item->'price_override' ? 'price' then
            return jsonb_build_object('error', 'l2_authorization_not_enabled');
          end if;

          v_item_name := ai.name;
          v_cat := ai.category;
          v_list_price := ai.price;
          v_unit_price := ai.price;
          v_price_source := 'accounting_master';
          v_ref_id := ai.id::text;
        end;

      when 'manual' then
        -- P0-5 前は手入力品目を一律拒否 (BLOCKER 3)
        return jsonb_build_object('error', 'l2_authorization_not_enabled');
    end case;

    v_subtotal := v_subtotal + (v_unit_price * v_qty);

    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'index', v_i,
      'source', v_source,
      'ref_id', v_ref_id,
      'name', v_item_name,
      'category', v_cat,
      'quantity', v_qty,
      'unit_price', v_unit_price,
      'list_price', v_list_price,
      'line_discount', 0,
      'line_total', v_unit_price * v_qty,
      'price_source', v_price_source
    ));
  end loop;

  -- 3. 割引評価
  -- 3-1. チケット割引
  if p_request ? 'ticket_ids' and p_request->'ticket_ids' is not null and jsonb_array_length(p_request->'ticket_ids') > 0 then
    select coalesce(array_agg(x::uuid), '{}') into v_tids
    from jsonb_array_elements_text(p_request->'ticket_ids') x;

    if cardinality(v_tids) > 0 then
      if v_client is null then return jsonb_build_object('error', 'invalid_tickets'); end if;
      declare
        v_uids text[];
        v_tcount int;
        v_types text[];
        v_tuser text;
        t record;
      begin
        v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
        if v_uids is null or cardinality(v_uids) = 0 then
          return jsonb_build_object('error', 'invalid_tickets');
        end if;

        select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1], coalesce(sum(amount), 0)
        into v_tcount, v_types, v_tuser, v_ticket_disc
        from public.tickets
        where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());

        if v_tcount <> cardinality(v_tids) then return jsonb_build_object('error', 'invalid_tickets'); end if;
        if cardinality(v_types) <> 1 then return jsonb_build_object('error', 'mixed_types'); end if;
        if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
          return jsonb_build_object('error', 'transfer_pending');
        end if;
        if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
           and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2)) then
          return jsonb_build_object('error', 'welcome_weekend');
        end if;
        if not app_private.can_use_type(app_private.today_used_type(v_tuser), v_types[1]) then
          return jsonb_build_object('error', 'daily_rule');
        end if;

        for t in select id, type, title, amount from public.tickets where id = any(v_tids) order by id loop
          v_ticket_details := v_ticket_details || jsonb_build_array(jsonb_build_object(
            'id', t.id, 'type', t.type, 'title', t.title, 'amount', t.amount
          ));
        end loop;
      end;
    end if;
  end if;

  -- 3-2. メンテナンス割引 (BLOCKER 2: 一律¥500引きを廃止、未設定マッピングは拒否)
  if (p_request ? 'maintenance' and p_request->'maintenance' is not null and (p_request->'maintenance'->>'use')::boolean is true)
     or (p_request ? 'use_maintenance' and (p_request->>'use_maintenance')::boolean is true) then
    return jsonb_build_object('error', 'maintenance_offer_unconfigured');
  end if;

  -- 3-3. 手入力値引き (BLOCKER 3: P0-5 前は一律拒否)
  if p_request ? 'manual_discount' and p_request->'manual_discount' is not null
     and jsonb_typeof(p_request->'manual_discount') = 'object' then
    if coalesce((p_request->'manual_discount'->>'amount')::int, 0) > 0 then
      return jsonb_build_object('error', 'l2_authorization_not_enabled');
    end if;
  end if;

  v_total := v_subtotal - v_ticket_disc;
  if v_total < 0 then return jsonb_build_object('error', 'discount_exceeds'); end if;

  select * into v_tax from public.accounting_settings where id = 1;

  -- 4. Canonical Facts & quote_hash 生成
  select jsonb_build_object(
    'c', v_client,
    'd', jsonb_build_object(
      't', case when cardinality(v_tids) > 0 then jsonb_build_object('a', v_ticket_disc, 'ids', (select jsonb_agg(x order by x) from unnest(v_tids) x)) else null end
    ),
    'dt', v_ticket_disc,
    'i', (select jsonb_agg(
            jsonb_build_object(
              'c', item->>'category',
              'n', item->>'name',
              'p', (item->>'unit_price')::int,
              'ps', item->>'price_source',
              'q', (item->>'quantity')::int,
              'r', item->>'ref_id',
              's', item->>'source'
            )
            order by item->>'source', coalesce(item->>'ref_id', ''), item->>'name', (item->>'unit_price')::int, (item->>'quantity')::int
          ) from jsonb_array_elements(v_normalized_items) item),
    'o', p_operator_staff_id,
    'r', v_res_id,
    'ss', v_scan_session_id,
    'st', v_subtotal,
    'tm', v_tax.tax_mode,
    'tr', v_tax.tax_rate,
    'tt', v_total
  ) into v_canonical_facts;

  v_quote_hash := 'QTE1.' || app_private.sha256_hex(v_canonical_facts::text);

  return jsonb_build_object(
    'ok', true,
    'quote_hash', v_quote_hash,
    'subtotal', v_subtotal,
    'discount_total', v_ticket_disc,
    'total', v_total,
    'items', v_normalized_items,
    'discounts', jsonb_build_object(
      'ticket_discount', v_ticket_disc,
      'maintenance_discount', 0,
      'manual_discount', 0,
      'manual_discount_label', '',
      'ticket_ids', (select coalesce(jsonb_agg(x), '[]'::jsonb) from unnest(v_tids) x),
      'tickets', v_ticket_details
    ),
    'tax', jsonb_build_object(
      'tax_mode', v_tax.tax_mode,
      'tax_rate', v_tax.tax_rate
    ),
    'facts', jsonb_build_object(
      'client_id', v_client,
      'client_name', v_name,
      'reservation_id', v_res_id,
      'scan_session_id', v_scan_session_id,
      'operator_staff_id', p_operator_staff_id
    )
  );
end;
$$;

-- ── 4. staff_pos_quote RPC ──────────────────────────────────────────────────
create or replace function public.staff_pos_quote(
  p_staff text,
  p_operator_token text,
  p_scan_session uuid,
  p_request jsonb
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_op record;
  v_op_staff_id uuid := null;
  v_req jsonb := coalesce(p_request, '{}'::jsonb);
  v_client_ctx jsonb;
  v_res jsonb;
begin
  perform app_private.assert_staff(p_staff);

  -- 1. Operator session 検証 (渡されている場合)
  if p_operator_token is not null and btrim(p_operator_token) <> '' then
    begin
      select * into v_op from app_private.resolve_pos_operator(p_staff, p_operator_token);
      v_op_staff_id := v_op.operator_staff_id;
    exception when others then
      return json_build_object('error', 'invalid_operator_session');
    end;
  end if;

  -- 2. Customer context 解決 (scan_session / client_id / reservation_id)
  v_client_ctx := app_private.resolve_pos_client_context(
    p_staff,
    p_scan_session,
    nullif(v_req->>'client_id', '')::uuid,
    nullif(v_req->>'reservation_id', '')::uuid
  );
  if v_client_ctx ? 'error' then
    return v_client_ctx::json;
  end if;

  -- 3. 価格・見積もり計算
  v_res := app_private.pos_price(v_req, p_operator_staff_id => v_op_staff_id, p_client_context => v_client_ctx, p_is_pos => true);
  return v_res::json;
end;
$$;

revoke all on function public.staff_pos_quote(text, text, uuid, jsonb) from public;
grant execute on function public.staff_pos_quote(text, text, uuid, jsonb) to anon, authenticated;

-- ── 5. finalize_sale (pricing engine 統合 & 厳格検証) ──────────────────────────
create or replace function app_private.finalize_sale(
  p jsonb,
  p_actor_type text,
  p_actor_name text,
  p_staff_token text default null
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  r public.reservations;
  v_staff_token text := coalesce(p_staff_token, nullif(p->>'_staff_token', ''), nullif(p->>'staff_token', ''));
  v_client_ctx jsonb;
  v_client uuid;
  v_user text;
  v_name text;
  v_stylist public.staff_members;
  v_item jsonb;
  v_items jsonb;
  v_subtotal bigint;
  v_disc_total bigint;
  v_ticket_disc bigint := 0;
  v_total bigint;
  v_tids uuid[] := '{}'::uuid[];
  v_method text := p->>'payment_method';
  v_legacy text;
  v_tax public.accounting_settings;
  v_id uuid;
  t record;
  v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), '');
  v_canon_req jsonb;
  v_req_hash text;
  v_existing uuid;
  v_existing_req_hash text;
  v_gp jsonb;
  v_account public.ginpay_accounts;
  v_mismatch jsonb;
  v_op record;
  v_op_staff_id uuid := null;
  v_price_res jsonb;
  v_quote_hash text;
  v_is_pos_path boolean;
begin
  if p_actor_name is null or btrim(p_actor_name) = '' then return jsonb_build_object('error', 'operator_required'); end if;
  if v_method is null or v_method not in ('cash', 'card', 'qr', 'ginpay', 'other') then return jsonb_build_object('error', 'invalid_payment_method'); end if;
  if v_key is not null and length(v_key) > 100 then return jsonb_build_object('error', 'invalid_idempotency_key'); end if;
  if v_method = 'ginpay' and v_key is null then return jsonb_build_object('error', 'idempotency_key_required'); end if;

  -- 1. Operator session 検証 (BLOCKER 4)
  if nullif(p->>'operator_token', '') is not null then
    begin
      select * into v_op from app_private.resolve_pos_operator(v_staff_token, p->>'operator_token');
      v_op_staff_id := v_op.operator_staff_id;
    exception when others then
      return jsonb_build_object('error', 'invalid_operator_session');
    end;
  end if;

  -- 2. request_hash (一時的シークレットを除外)
  v_canon_req := p - 'idempotency_key' - 'operator_token' - 'approval_token' - 'staff_token' - '_staff_token' - 'presence_token';
  if v_op_staff_id is not null then
    v_canon_req := v_canon_req || jsonb_build_object('operator_staff_id', v_op_staff_id);
  end if;
  v_req_hash := 'REQ1.' || app_private.sha256_hex(v_canon_req::text);

  -- 同じキーの再送:
  if v_key is not null then
    select id, request_hash into v_existing, v_existing_req_hash
    from public.accounting_sessions
    where idempotency_key = v_key and status in ('completed', 'voided');

    if v_existing is not null then
      if v_existing_req_hash is not null and v_existing_req_hash <> v_req_hash then
        return jsonb_build_object('error', 'idempotency_conflict');
      end if;
      return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true);
    end if;
  end if;

  v_legacy := case v_method when 'card' then 'credit' else v_method end;

  -- 3. Customer Context 解決 (CRITICAL 1)
  v_client_ctx := app_private.resolve_pos_client_context(
    v_staff_token,
    nullif(p->>'scan_session_id', '')::uuid,
    nullif(p->>'client_id', '')::uuid,
    nullif(p->>'reservation_id', '')::uuid
  );
  if v_client_ctx ? 'error' then
    return v_client_ctx;
  end if;

  v_client := (v_client_ctx->>'client_id')::uuid;
  v_user := v_client_ctx->>'customer_id';
  v_name := v_client_ctx->>'customer_name';

  -- 4. 予約の行ロック
  if nullif(p->>'reservation_id', '') is not null then
    select * into r from public.reservations where id = (p->>'reservation_id')::uuid for update;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if r.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
    if exists (select 1 from public.accounting_sessions where reservation_id = r.id and status = 'completed') then
      return jsonb_build_object('error', 'already_paid');
    end if;
  end if;

  -- 担当スタイリスト
  select * into v_stylist from public.staff_members where id = nullif(p->>'stylist_id', '')::uuid;
  if v_stylist.id is null then return jsonb_build_object('error', 'stylist_required'); end if;

  -- 5. チケットの行ロック & TOCTOU 再検証 (HIGH 2)
  if p ? 'ticket_ids' and p->'ticket_ids' is not null and jsonb_array_length(p->'ticket_ids') > 0 then
    select coalesce(array_agg(x::uuid), '{}') into v_tids
    from jsonb_array_elements_text(p->'ticket_ids') x;

    if cardinality(v_tids) > 0 then
      if v_client is null then return jsonb_build_object('error', 'invalid_tickets'); end if;

      perform 1 from public.tickets where id = any(v_tids) order by id for update;

      declare
        v_uids text[];
        v_types text[];
        v_tuser text;
        v_locked_count int;
      begin
        v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
        if v_uids is null or cardinality(v_uids) = 0 then
          return jsonb_build_object('error', 'invalid_tickets');
        end if;

        select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1]
        into v_locked_count, v_types, v_tuser
        from public.tickets
        where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());

        if v_locked_count <> cardinality(v_tids) then
          return jsonb_build_object('error', 'invalid_tickets');
        end if;
        if cardinality(v_types) <> 1 then
          return jsonb_build_object('error', 'mixed_types');
        end if;
        if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
          return jsonb_build_object('error', 'transfer_pending');
        end if;
        if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
           and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2)) then
          return jsonb_build_object('error', 'welcome_weekend');
        end if;
        if not app_private.can_use_type(app_private.today_used_type(v_tuser), v_types[1]) then
          return jsonb_build_object('error', 'daily_rule');
        end if;
      end;
    end if;
  end if;

  -- 6. POS 経路判定 & 価格・見積もり再計算 (ロック取得後 & canonical client context で実行)
  v_is_pos_path := (p ? 'quote_hash' or p ? 'scan_session_id' or p ? 'operator_token');

  v_price_res := app_private.pos_price(p, p_operator_staff_id => v_op_staff_id, p_client_context => v_client_ctx, p_is_pos => v_is_pos_path);
  if v_price_res ? 'error' then return v_price_res; end if;

  v_quote_hash := v_price_res->>'quote_hash';
  v_subtotal := (v_price_res->>'subtotal')::bigint;
  v_disc_total := (v_price_res->>'discount_total')::bigint;
  v_total := (v_price_res->>'total')::bigint;
  v_items := v_price_res->'items';
  v_ticket_disc := (v_price_res->'discounts'->>'ticket_discount')::bigint;

  -- 7. quote_hash 照合 (BLOCKER 5: POS 経路では必須)
  if v_is_pos_path then
    if nullif(btrim(coalesce(p->>'quote_hash', '')), '') is null then
      return jsonb_build_object('error', 'quote_required');
    end if;
    if p->>'quote_hash' <> v_quote_hash then
      return jsonb_build_object('error', 'quote_mismatch');
    end if;
  end if;

  -- 8. expected_total 照合
  if nullif(p->>'expected_total', '') is null or (p->>'expected_total')::bigint <> v_total then
    return jsonb_build_object('error', 'total_mismatch', 'total', v_total);
  end if;

  select * into v_tax from public.accounting_settings where id = 1;

  -- 9. GINPay 払い (CRITICAL 1: 口座が canonical client に属しているか検証)
  if v_method = 'ginpay' then
    if v_client is null then return jsonb_build_object('error', 'ginpay_requires_client'); end if;
    if v_total <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;

    -- 渡された口座の所有者照合 (CRITICAL 1)
    if nullif(p->>'ginpay_account_id', '') is not null then
      select * into v_account from public.ginpay_accounts where id = (p->>'ginpay_account_id')::uuid;
      if v_account.id is null or app_private.client_root(v_account.client_id) <> v_client then
        return jsonb_build_object('error', 'customer_context_mismatch');
      end if;
    end if;

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
    -- 書き込み前に台帳と照合
    v_mismatch := app_private.ginpay_check_reconciled(v_account.id, jsonb_build_object(
      'operation', 'sale_payment', 'amount', v_total, 'idempotency_key', v_key, 'reservation_id', r.id), p_actor_type, btrim(p_actor_name));
    if v_mismatch is not null then return v_mismatch; end if;
    if v_account.balance_cached < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached);
    end if;
  end if;

  -- 10. 会計レコード作成 (以後の失敗は例外で全体を取り消す)
  begin
    insert into public.accounting_sessions (user_id, customer_name, staff_name, stylist_name, stylist_id, payment_method, status,
      subtotal, discount_total, total, used_ticket_ids, client_id, reservation_id, tax_mode, tax_rate, idempotency_key,
      request_hash, quote_hash)
    values (v_user, coalesce(v_name, r.customer_name, ''), btrim(p_actor_name), v_stylist.display_name, v_stylist.id, v_legacy, 'pending',
      v_subtotal, v_disc_total, v_total, (select array_agg(x::text) from unnest(v_tids) x),
      v_client, r.id, v_tax.tax_mode, v_tax.tax_rate, v_key,
      v_req_hash, v_quote_hash)
    returning id into v_id;
  exception when unique_violation then
    if v_key is not null then
      select id, request_hash into v_existing, v_existing_req_hash
      from public.accounting_sessions
      where idempotency_key = v_key and status in ('completed', 'voided');

      if v_existing is not null then
        if v_existing_req_hash is not null and v_existing_req_hash <> v_req_hash then
          return jsonb_build_object('error', 'idempotency_conflict');
        end if;
        return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true);
      end if;
    end if;
    return jsonb_build_object('error', 'already_paid');
  end;

  -- 明細保存 (サーバー正規化 items)
  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.accounting_session_items (session_id, item_id, item_name, category, price, quantity, source, ref_id, list_price,
      line_discount, line_total, tax_mode, tax_rate, sort_order)
    values (
      v_id,
      case when v_item->>'source' in ('accounting_item', 'product') and (v_item->>'ref_id') ~ '^[0-9a-fA-F-]{36}$' then (v_item->>'ref_id')::uuid end,
      btrim(v_item->>'name'),
      v_item->>'category',
      (v_item->>'unit_price')::int,
      coalesce((v_item->>'quantity')::int, 1),
      case when v_item->>'source' = 'legacy' then null else v_item->>'source' end,
      v_item->>'ref_id',
      (v_item->>'list_price')::int,
      0,
      (v_item->>'line_total')::int,
      v_tax.tax_mode,
      v_tax.tax_rate,
      (v_item->>'index')::int
    );
  end loop;

  -- チケット割引明細
  for t in select id, type, title, amount from public.tickets where id = any(v_tids) order by id loop
    insert into public.accounting_discounts (session_id, kind, label, amount, ticket_id, ticket_type)
    values (v_id, 'ticket', t.title, t.amount, t.id, t.type);
  end loop;

  -- 支払レコード
  insert into public.accounting_payments (session_id, method, amount)
  values (v_id, v_legacy, v_total);

  -- GINPay 支払い
  if v_method = 'ginpay' then
    v_gp := app_private.ginpay_pay(v_client, v_account.id, v_total::int, v_id, p_actor_type, btrim(p_actor_name), 'sale:' || v_key);
    if v_gp ? 'error' then raise exception '%', v_gp->>'error'; end if;
  end if;

  -- チケット消費
  if cardinality(v_tids) > 0 then
    update public.tickets set used = true, used_at = now() where id = any(v_tids);
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used'
    from public.tickets t2 where t2.id = any(v_tids);
  end if;

  if v_user is not null then perform app_private.touch_visit(v_user); end if;

  update public.accounting_sessions set status = 'completed', completed_at = now() where id = v_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, detail)
  values (v_id, 'completed', p_actor_type, btrim(p_actor_name), jsonb_build_object('total', v_total, 'payment_method', v_method, 'quote_hash', v_quote_hash));

  -- 予約の完了
  if r.id is not null and r.status <> 'completed' then
    if (app_private.set_reservation_status(r.id, 'completed', p_actor_type, btrim(p_actor_name), null)) ? 'error' then
      raise exception 'reservation_not_completed';
    end if;
  end if;

  return app_private.sale_json(v_id);
end;
$$;

-- ── 6. staff_finalize_sale wrapper ──────────────────────────────────────────
create or replace function public.staff_finalize_sale(p_staff text, p jsonb, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.finalize_sale(p, 'staff', p_staff_name, p_staff_token => p_staff)::json;
end;
$$;

-- ── 7. sale_json 拡張 (quote_hash, request_hash を出力) ──────────────────────
create or replace function app_private.sale_json(p_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'id', s.id, 'status', s.status, 'completed_at', coalesce(s.completed_at, s.created_at),
    'client', case when s.client_id is null then null else
      (select jsonb_build_object('id', c.id, 'name', c.display_name) from public.clients c where c.id = app_private.client_root(s.client_id)) end,
    'customer_name', s.customer_name,
    'reservation', case when s.reservation_id is null then null else
      (select jsonb_build_object('id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name) from public.reservations r where r.id = s.reservation_id) end,
    'stylist_name', s.stylist_name, 'operator', s.staff_name,
    'subtotal', s.subtotal, 'discount_total', s.discount_total, 'total', s.total,
    'payment_method', s.payment_method, 'tax_mode', s.tax_mode, 'tax_rate', s.tax_rate,
    'idempotency_key', s.idempotency_key,
    'quote_hash', s.quote_hash,
    'request_hash', s.request_hash,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'name', i.item_name, 'category', i.category, 'unit_price', i.price, 'quantity', coalesce(i.quantity, 1),
                'line_discount', i.line_discount, 'line_total', coalesce(i.line_total, i.price * coalesce(i.quantity, 1)),
                'list_price', i.list_price, 'source', i.source, 'tax_mode', i.tax_mode, 'tax_rate', i.tax_rate)
              order by i.sort_order nulls last, i.created_at), '[]'::jsonb)
              from public.accounting_session_items i where i.session_id = s.id),
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'label', d.label, 'amount', d.amount, 'ticket_type', d.ticket_type)
                  order by d.created_at), '[]'::jsonb) from public.accounting_discounts d where d.session_id = s.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('method', p.method, 'amount', p.amount) order by p.created_at), '[]'::jsonb)
                 from public.accounting_payments p where p.session_id = s.id),
    'ginpay', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'type', g.type, 'amount', g.amount, 'account_id', g.account_id,
                 'original_transaction_id', g.original_transaction_id, 'created_at', g.created_at) order by g.created_at, g.id), '[]'::jsonb)
               from public.ginpay_transactions g where g.accounting_session_id = s.id and g.status = 'posted'),
    'voided_at', s.voided_at, 'voided_by', s.voided_by, 'void_reason', s.void_reason,
    'events', (select coalesce(jsonb_agg(jsonb_build_object('type', e.event_type, 'actor_name', e.actor_name, 'reason', e.reason, 'created_at', e.created_at)
               order by e.id), '[]'::jsonb) from public.accounting_events e where e.session_id = s.id)
  )
  from public.accounting_sessions s where s.id = p_id
$$;

-- ── 8. 権限保護 ─────────────────────────────────────────────────────────────
revoke all on all functions in schema app_private from public, anon, authenticated;
