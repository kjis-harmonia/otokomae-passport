-- ============================================================================
-- GINJIRO OS 会計（20261004_ginpay_ledger.sql の後に適用。追加のみ・何度実行しても同じ結果）
--
-- 実売上の唯一の確定地点＝「会計を確定」。予約の金額は予定売上で、予約の作成・変更・キャンセルでは売上は発生しない。
--
-- データモデル（既存の accounting_sessions / accounting_session_items をそのまま使い、列とテーブルを追加する）
--   accounting_sessions       ：会計1件。会計日時・顧客・予約・担当・操作者・小計・値引き・支払総額・支払方法・税設定を
--                               確定時点の値で持つ（snapshot）。確定後は金額を変更できない（取消は状態と記録の追加だけ）
--   accounting_session_items  ：明細。名称・区分・単価・数量・値引き・小計・税設定・元マスター（ID と当時の定価）を snapshot
--   accounting_discounts      ：値引き（クーポン・手入力の値引き）
--   accounting_payments       ：支払（方法・金額）。cash / card / qr / ginpay / other。分割払い・GINPay・返金にも同じ表で対応できる
--   accounting_events         ：確定・取消の監査履歴（誰が・いつ・何を・理由）
--   accounting_settings       ：税の扱い（税込／税抜・税率）。未設定のまま（既存データから確定できないため推測しない）。
--                               設定すると、以後の会計の明細に確定時点の値が残る
--
-- 確定は1つのトランザクション：会計・明細・値引き・支払・GINPay 支払い・クーポン消費・予約の完了。どれかが失敗すれば全部取り消される。
-- GINPay 払いは、会計の確定の中で口座を行ロックして残高を確認し、GINPay の支払い取引を記録する（別トランザクションの支払いはしない）。
-- 会計には idempotency key（画面ごとの一意キー）を持たせ、同じキーの再送は同じ会計を返す（二重タップで二重会計・二重決済しない）。
-- 同じ予約の二重会計は、予約行のロックと「予約1件につき確定済み会計1件」の一意インデックスで防ぐ。
-- 取消は会計を削除・書き換えせず、状態を voided にして監査履歴を追加する（クーポンは戻す）。訂正は取消のうえ会計し直す。
-- GINPay 払いの会計の取消は、同じトランザクションで GINPay に逆向きの取引（void。元の支払い取引を参照）を追加する。
-- 既存の会計データ（金額・明細）は変更しない。
-- ============================================================================

-- ── 会計（既存テーブルへ列を追加） ────────────────────────────────────────────
alter table public.accounting_sessions add column if not exists completed_at timestamptz;         -- 会計日時（既存行は created_at）
alter table public.accounting_sessions add column if not exists stylist_id uuid references public.staff_members(id);
alter table public.accounting_sessions add column if not exists tax_mode text check (tax_mode is null or tax_mode in ('inclusive', 'exclusive'));
alter table public.accounting_sessions add column if not exists tax_rate numeric(5, 4);
alter table public.accounting_sessions add column if not exists voided_at timestamptz;
alter table public.accounting_sessions add column if not exists voided_by text;
alter table public.accounting_sessions add column if not exists void_reason text;
alter table public.accounting_sessions add column if not exists idempotency_key text;
create unique index if not exists accounting_sessions_idempotency_uidx on public.accounting_sessions (idempotency_key) where idempotency_key is not null;
alter table public.accounting_sessions drop constraint if exists accounting_sessions_status_check;
alter table public.accounting_sessions add constraint accounting_sessions_status_check
  check (status in ('pending', 'completed', 'failed', 'voided'));
-- 既存の支払方法（cash / credit / qr）に other・ginpay を追加（カードは既存どおり credit で記録）
alter table public.accounting_sessions drop constraint if exists accounting_sessions_payment_method_check;
alter table public.accounting_sessions add constraint accounting_sessions_payment_method_check
  check (payment_method in ('cash', 'credit', 'qr', 'other', 'ginpay'));
-- 予約1件につき確定済みの会計は1件だけ（取消済みは含まない＝取消のあと会計し直せる）
create unique index if not exists accounting_sessions_one_per_reservation
  on public.accounting_sessions (reservation_id) where reservation_id is not null and status = 'completed';
create index if not exists accounting_sessions_completed_at_idx on public.accounting_sessions (completed_at desc);

alter table public.accounting_session_items add column if not exists source text
  check (source is null or source in ('reservation', 'service_menu', 'accounting_item', 'product', 'manual'));
alter table public.accounting_session_items add column if not exists ref_id text;          -- 元マスターの ID（参考）
alter table public.accounting_session_items add column if not exists list_price integer;   -- 確定時点のマスター価格（単価を変えた記録）
alter table public.accounting_session_items add column if not exists line_discount integer not null default 0;
alter table public.accounting_session_items add column if not exists line_total integer;   -- 単価 × 数量 − 値引き
alter table public.accounting_session_items add column if not exists tax_mode text;
alter table public.accounting_session_items add column if not exists tax_rate numeric(5, 4);
alter table public.accounting_session_items add column if not exists sort_order integer;

create table if not exists public.accounting_discounts (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.accounting_sessions(id),
  kind         text not null check (kind in ('ticket', 'manual')),
  ticket_id    uuid,
  ticket_type  text,
  label        text not null,
  amount       integer not null check (amount >= 0),
  created_at   timestamptz not null default now()
);
create index if not exists accounting_discounts_session_idx on public.accounting_discounts (session_id);

create table if not exists public.accounting_payments (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.accounting_sessions(id),
  method      text not null check (method in ('cash', 'card', 'qr', 'ginpay', 'other')),
  amount      integer not null,                             -- 将来の返金は負の金額の行で表す
  created_at  timestamptz not null default now()
);
create index if not exists accounting_payments_session_idx on public.accounting_payments (session_id);

create table if not exists public.accounting_events (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.accounting_sessions(id),
  event_type  text not null check (event_type in ('completed', 'voided')),
  actor_type  text not null check (actor_type in ('staff', 'hq', 'system')),
  actor_name  text,
  reason      text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists accounting_events_session_idx on public.accounting_events (session_id, created_at);

create table if not exists public.accounting_settings (
  id          integer primary key default 1 check (id = 1),
  tax_mode    text check (tax_mode is null or tax_mode in ('inclusive', 'exclusive')),
  tax_rate    numeric(5, 4) check (tax_rate is null or (tax_rate >= 0 and tax_rate < 1)),
  updated_at  timestamptz not null default now()
);
insert into public.accounting_settings (id) values (1) on conflict (id) do nothing;

do $$
declare t text;
begin
  foreach t in array array['accounting_discounts', 'accounting_payments', 'accounting_events', 'accounting_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.accounting_events_id_seq from public, anon, authenticated;

-- ── 確定済み会計の保護：金額・明細の書き換えと削除を DB で禁止（顧客の統合による client_id の付け替えだけ許可） ──
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
        new.discount_total, new.total, new.used_ticket_ids, new.created_at, new.completed_at, new.reservation_id, new.tax_mode, new.tax_rate, new.idempotency_key)
       is distinct from
       (old.user_id, old.customer_name, old.staff_name, old.stylist_name, old.stylist_id, old.payment_method, old.subtotal,
        old.discount_total, old.total, old.used_ticket_ids, old.created_at, old.completed_at, old.reservation_id, old.tax_mode, old.tax_rate, old.idempotency_key) then
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
drop trigger if exists accounting_sessions_guard on public.accounting_sessions;
create trigger accounting_sessions_guard before update or delete on public.accounting_sessions
  for each row execute function app_private.guard_accounting_session();

/** 明細・値引き・支払は、確定前（pending）の会計にだけ追加でき、確定後は変更・削除できない */
create or replace function app_private.guard_accounting_child()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_status text;
begin
  select status into v_status from public.accounting_sessions where id = case when tg_op = 'DELETE' then old.session_id else new.session_id end;
  if tg_op = 'INSERT' then
    if v_status in ('completed', 'voided') then raise exception 'accounting_immutable'; end if;
    return new;
  end if;
  if v_status in ('completed', 'voided') then raise exception 'accounting_immutable'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists accounting_session_items_guard on public.accounting_session_items;
create trigger accounting_session_items_guard before insert or update or delete on public.accounting_session_items
  for each row execute function app_private.guard_accounting_child();
drop trigger if exists accounting_discounts_guard on public.accounting_discounts;
create trigger accounting_discounts_guard before insert or update or delete on public.accounting_discounts
  for each row execute function app_private.guard_accounting_child();
drop trigger if exists accounting_payments_guard on public.accounting_payments;
create trigger accounting_payments_guard before insert or update or delete on public.accounting_payments
  for each row execute function app_private.guard_accounting_child();

-- ── 内部関数 ──────────────────────────────────────────────────────────────────

/** 顧客の App 会員のチケット（未使用・有効期限内）と、今日使えるかどうか（既存の当日ルールと同じ判定） */
create or replace function app_private.client_tickets_json(p_client_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_root uuid := app_private.client_root(p_client_id); v_uids text[];
begin
  if v_root is null then return '[]'::jsonb; end if;
  v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_root)));
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'type', t.type, 'title', t.title, 'amount', t.amount, 'expires_at', t.expires_at,
      'blocked', case
        when exists (select 1 from public.ticket_transfers x where x.ticket_id = t.id and x.status = 'pending' and x.expires_at > now()) then 'transfer_pending'
        when app_private.is_welcome(t) and extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7) then 'welcome_weekend'
        when not app_private.can_use_type(app_private.today_used_type(t.user_id), t.type) then 'daily_rule'
        else null end
    ) order by t.expires_at nulls last, t.created_at), '[]'::jsonb)
    from public.tickets t
    where t.user_id = any(v_uids) and not t.used and (t.expires_at is null or t.expires_at > now()));
end;
$$;

/** 会計の内容（後から再現できるよう、確定時点の値をそのまま返す） */
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

/** 会計画面の準備：予約から（予約の顧客・担当・メニュー・予約時価格）／予約なし（顧客を選ぶか匿名） */
create or replace function app_private.checkout_context_json(p_reservation_id uuid, p_client_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
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
$$;

/** 会計に追加できるメニュー・商品（予約メニュー・会計メニュー／オプション・店販商品）。価格は現在のマスター */
create or replace function app_private.checkout_catalog_json()
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'service_menus', (select coalesce(jsonb_agg(jsonb_build_object('id', m.code, 'name', m.name, 'category', 'menu', 'price', m.price) order by m.sort_order), '[]'::jsonb)
                      from public.service_menus m where m.is_active and m.price is not null),
    'menus', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'category', a.category, 'price', a.price) order by a.category, a.sort_order), '[]'::jsonb)
              from public.accounting_items a where a.is_active and a.category in ('menu', 'option')),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'category', 'retail', 'price', p.price) order by p.name), '[]'::jsonb)
                 from public.products p where p.is_active and p.category = '店販' and p.price > 0)
  )
$$;

/**
 * 会計の確定（1トランザクション）。
 *   p：reservation_id（予約から）／client_id（予約なしで顧客を選んだとき。なければ匿名）、stylist_id（担当）、
 *      items[{source, ref_id, name, category(menu|option|retail), unit_price, quantity, discount}]、
 *      ticket_ids[]（App 会員のチケット）、manual_discount{amount, label}、payment_method(cash|card|qr|ginpay|other)、expected_total、
 *      idempotency_key（会計画面ごとの一意キー。同じキーの再送は同じ会計を返す。GINPay 払いでは必須）、
 *      ginpay_account_id（GINPay 払いで、統合顧客に口座が複数あるとき必須）
 *   先に検証し（エラーは { error } で何も書き込まない）、書き込み開始後の失敗は例外で全体を取り消す。
 */
create or replace function app_private.finalize_sale(p jsonb, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare r public.reservations; v_client uuid; v_member uuid; v_user text; v_name text; v_stylist public.staff_members;
        v_item jsonb; v_items jsonb := coalesce(p->'items', '[]'::jsonb); v_n int; v_qty int; v_price int; v_disc int; v_list int;
        v_subtotal bigint := 0; v_line_disc bigint := 0; v_ticket_disc bigint := 0; v_manual int := 0; v_total bigint;
        v_tids uuid[]; v_tcount int; v_types text[]; v_tuser text; v_method text := p->>'payment_method'; v_legacy text;
        v_tax public.accounting_settings; v_id uuid; v_i int := 0; v_uids text[]; t record;
        v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), ''); v_existing uuid; v_gp jsonb; v_account public.ginpay_accounts;
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
  end if;

  v_total := v_subtotal - v_line_disc - v_ticket_disc - v_manual;
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
    if v_account.balance_cached < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached);
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
$$;

/** 会計の取消（削除・金額の書き換えはしない。状態と監査履歴を追加し、使ったチケットを戻す） */
create or replace function app_private.void_sale(p_id uuid, p_reason text, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
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
  select coalesce(array_agg(ticket_id), '{}') into v_tids from public.accounting_discounts where session_id = p_id and kind = 'ticket';
  if cardinality(v_tids) > 0 then
    update public.tickets set used = false, used_at = null where id = any(v_tids);
    update public.ticket_usage_logs set status = 'voided' where ticket_id = any(select x::text from unnest(v_tids) x) and status = 'used';
  end if;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, reason, detail)
  values (p_id, 'voided', p_actor_type, p_actor_name, btrim(p_reason), jsonb_build_object('total', s.total, 'tickets_restored', cardinality(v_tids)));
  return app_private.sale_json(p_id);
end;
$$;

/** 本部：日別の会計一覧（確定・取消。既存の会計も含む） */
create or replace function app_private.sales_json(p_date date)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  with s as (
    select * from public.accounting_sessions
    where status in ('completed', 'voided') and (coalesce(completed_at, created_at) at time zone 'Asia/Tokyo')::date = p_date
  )
  select jsonb_build_object(
    'date', p_date,
    'count', (select count(*) from s where status = 'completed'),
    'total', (select coalesce(sum(total), 0) from s where status = 'completed'),
    'voided', (select count(*) from s where status = 'voided'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'status', s.status, 'completed_at', coalesce(s.completed_at, s.created_at),
               'customer_name', coalesce((select c.display_name from public.clients c where c.id = app_private.client_root(s.client_id)), nullif(s.customer_name, '')),
               'stylist_name', s.stylist_name, 'payment_method', s.payment_method, 'total', s.total,
               'items', (select string_agg(i.item_name || case when coalesce(i.quantity, 1) > 1 then '×' || i.quantity else '' end, '・' order by i.sort_order nulls last, i.created_at)
                         from public.accounting_session_items i where i.session_id = s.id),
               'has_reservation', s.reservation_id is not null)
             order by coalesce(s.completed_at, s.created_at) desc), '[]'::jsonb) from s)
  )
$$;

-- ── 店舗端末（スタッフセッション必須） ─────────────────────────────────────────

create or replace function public.staff_checkout_context(p_staff text, p_reservation_id uuid, p_client_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.checkout_context_json(p_reservation_id, p_client_id)::json;
end;
$$;

create or replace function public.staff_checkout_catalog(p_staff text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.checkout_catalog_json()::json;
end;
$$;

create or replace function public.staff_finalize_sale(p_staff text, p jsonb, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.finalize_sale(p, 'staff', p_staff_name)::json;
end;
$$;

-- ── 本部（本部セッション必須） ────────────────────────────────────────────────

create or replace function public.hq_sales(p_hq text, p_date date)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.sales_json(p_date)::json;
end;
$$;

create or replace function public.hq_sale_detail(p_hq text, p_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return coalesce(app_private.sale_json(p_id), jsonb_build_object('error', 'not_found'))::json;
end;
$$;

create or replace function public.hq_void_sale(p_hq text, p_id uuid, p_reason text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.void_sale(p_id, p_reason, 'hq', '本部')::json;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.staff_checkout_context(text, uuid, uuid)',
    'public.staff_checkout_catalog(text)',
    'public.staff_finalize_sale(text, jsonb, text)',
    'public.hq_sales(text, date)',
    'public.hq_sale_detail(text, uuid)',
    'public.hq_void_sale(text, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke all on all functions in schema app_private from public, anon, authenticated;
