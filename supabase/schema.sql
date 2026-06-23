-- otokomae-passport: tickets table
-- Run in Supabase SQL Editor

create extension if not exists "pgcrypto";

create table if not exists public.tickets (
  id          uuid        default gen_random_uuid() primary key,
  user_id     text        not null,
  type        text        not null,
  title       text        not null,
  amount      integer     not null default 0,
  memo        text,
  used        boolean     not null default false,
  issued_by   text        not null,
  created_at  timestamptz default now() not null,
  used_at     timestamptz,
  expires_at  timestamptz,

  constraint tickets_type_check check (type in ('coupon', 'discount', 'otoku', 'cut-ticket'))
);

create index if not exists tickets_user_id_idx      on public.tickets (user_id);
create index if not exists tickets_user_id_used_idx on public.tickets (user_id, used);

-- RLS: Phase1 is open access (tie to Supabase Auth in Phase2)
alter table public.tickets enable row level security;

create policy "allow_all" on public.tickets
  for all
  using (true)
  with check (true);

-- ── ticket_issue_logs: スタッフ端末での発行ログ（全端末リアルタイム共有） ────────

create table if not exists public.ticket_issue_logs (
  id            uuid        default gen_random_uuid() primary key,
  issued_at     timestamptz default now() not null,
  staff_name    text        not null,
  customer_name text        not null,
  user_id       text        not null,
  ticket_type   text        not null,
  amount        integer     not null,
  quantity      integer     not null default 1,
  terminal      text        not null default 'staff-terminal',
  status        text        not null default 'issued'
);

create index if not exists ticket_issue_logs_issued_at_idx on public.ticket_issue_logs (issued_at desc);

alter table public.ticket_issue_logs enable row level security;

create policy "allow_all" on public.ticket_issue_logs
  for all
  using (true)
  with check (true);

-- Supabase Realtime: enable postgres_changes for this table
-- Run this separately in the SQL editor if postgres_changes are needed:
-- alter publication supabase_realtime add table public.ticket_issue_logs;

-- ── MIGRATION: fix tickets type constraint to include 'otoku' and 'discount' ──
-- If the tickets table was already created, run these two lines in the Supabase
-- SQL Editor to update the constraint without recreating the table:
--
--   ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_type_check;
--   ALTER TABLE public.tickets ADD CONSTRAINT tickets_type_check
--     CHECK (type IN ('coupon', 'discount', 'otoku', 'cut-ticket'));
--
-- Without this, issuing 漢トク券 (otoku) or 割引券 (discount) from the staff
-- terminal will silently fail the Supabase insert and fall back to the staff
-- terminal's localStorage only, making the tickets invisible to the customer.

-- ── maintenance_visits: スタッフ端末QRスキャンでのみ更新される来店日 ──────────
-- 顧客側からは書き込めない（RLSで管理）。
-- last_visit_date が 14 日以内ならメンテナンスカット対象。

create table if not exists public.maintenance_visits (
  user_id         text        primary key,
  last_visit_date date        not null,
  updated_at      timestamptz default now() not null
);

alter table public.maintenance_visits enable row level security;

create policy "allow_all" on public.maintenance_visits
  for all
  using (true)
  with check (true);

-- ── ticket_transfers: チケット譲渡管理テーブル ────────────────────────────────
-- tickets テーブルには pending_transfer / transfer_token カラムを追加しない。
-- 譲渡状態はすべてこのテーブルで管理する。

create table if not exists public.ticket_transfers (
  id            uuid        default gen_random_uuid() primary key,
  token         text        not null unique,
  ticket_id     uuid        not null,
  from_user_id  text        not null,
  to_user_id    text,
  status        text        not null default 'pending',
  created_at    timestamptz default now() not null,
  expires_at    timestamptz not null,
  claimed_at    timestamptz,
  constraint ticket_transfers_status_check check (status in ('pending', 'claimed', 'cancelled'))
);

create index if not exists ticket_transfers_token_idx       on public.ticket_transfers (token);
create index if not exists ticket_transfers_ticket_id_idx   on public.ticket_transfers (ticket_id);
create index if not exists ticket_transfers_from_user_idx   on public.ticket_transfers (from_user_id, status);

alter table public.ticket_transfers enable row level security;

create policy "allow_all" on public.ticket_transfers
  for all
  using (true)
  with check (true);

-- ── RPC: claim_ticket_transfer ────────────────────────────────────────────────
-- 二重受取防止のため、token検証・ticket更新・transfer更新を1トランザクションで行う。
-- 戻り値: { ticket: TicketRow } または { error: string }

create or replace function public.claim_ticket_transfer(
  p_token      text,
  p_to_user_id text
)
returns json
language plpgsql
security definer
as $$
declare
  v_transfer   record;
  v_ticket     record;
  v_updated    record;
begin
  -- 1. token で transfer record を取得 (FOR UPDATE でロック)
  select * into v_transfer
  from public.ticket_transfers
  where token = p_token
  for update;

  if not found then
    return json_build_object('error', 'トークンが無効または期限切れです');
  end if;

  -- 2. status='pending' 確認
  if v_transfer.status <> 'pending' then
    return json_build_object('error', 'すでに受け取り済みです');
  end if;

  -- 3. expires_at > now() 確認
  if v_transfer.expires_at <= now() then
    return json_build_object('error', 'トークンが期限切れです');
  end if;

  -- 4. ticket を取得 (FOR UPDATE でロック)
  select * into v_ticket
  from public.tickets
  where id = v_transfer.ticket_id
  for update;

  if not found then
    return json_build_object('error', 'チケットが存在しません');
  end if;

  -- 5. ticket.used=false 確認
  if v_ticket.used then
    return json_build_object('error', '使用済みチケットは受け取れません');
  end if;

  -- 6. 自己譲渡チェック
  if v_ticket.user_id = p_to_user_id then
    return json_build_object('error', '自分自身へは譲渡できません');
  end if;

  -- 7. tickets.user_id を受取側に更新
  update public.tickets
  set user_id = p_to_user_id
  where id = v_transfer.ticket_id
  returning * into v_updated;

  -- 8. ticket_transfers を claimed に更新
  update public.ticket_transfers
  set
    status     = 'claimed',
    to_user_id = p_to_user_id,
    claimed_at = now()
  where id = v_transfer.id;

  return json_build_object('ticket', row_to_json(v_updated));
end;
$$;

-- anon / authenticated ロールに実行権限を付与（PostgREST経由での呼び出しに必要）
grant execute on function public.claim_ticket_transfer(text, text) to anon, authenticated;

-- ── ticket_usage_logs: チケット使用ログ（1日1枚制限・使用履歴） ────────────────
-- usage_date は JST 当日の date 文字列（YYYY-MM-DD）。
-- (user_id, usage_date, status) でクエリするため複合インデックスを張る。

create table if not exists public.ticket_usage_logs (
  id            uuid        default gen_random_uuid() primary key,
  usage_date    date        not null,
  staff_name    text        not null,
  customer_name text        not null,
  user_id       text        not null,
  ticket_id     text,
  ticket_type   text        not null,
  amount        integer     not null default 0,
  terminal      text        not null default 'user-app',
  status        text        not null default 'used',
  used_at       timestamptz not null default now()
);

create index if not exists ticket_usage_logs_daily_idx
  on public.ticket_usage_logs (user_id, usage_date, status);

alter table public.ticket_usage_logs enable row level security;

create policy "allow_all" on public.ticket_usage_logs
  for all
  using (true)
  with check (true);

-- ── customers: 会員マスタ（Phase2 会員復旧機能） ─────────────────────────────
-- スタッフ端末でパスポートQRをスキャンするたびに upsert される。
-- recovery_code は GIN-XXXX-XXXX 形式で初回登録時に自動付与。

create table if not exists public.customers (
  id            uuid        default gen_random_uuid() primary key,
  user_id       text        not null unique,
  name          text        not null,
  phone_last4   text,
  recovery_code text        not null unique,
  created_at    timestamptz default now() not null,
  updated_at    timestamptz default now() not null
);

create index if not exists customers_user_id_idx       on public.customers (user_id);
create index if not exists customers_recovery_code_idx on public.customers (recovery_code);

alter table public.customers enable row level security;

create policy "allow_all" on public.customers
  for all
  using (true)
  with check (true);

-- ── customer_user_aliases: 端末変更履歴 ──────────────────────────────────────
-- 初回登録時と recover_member 実行時に追記される。
-- is_current=true が現在の有効 user_id。

create table if not exists public.customer_user_aliases (
  id          uuid        default gen_random_uuid() primary key,
  customer_id uuid        not null references public.customers(id),
  user_id     text        not null,
  is_current  boolean     not null default false,
  created_at  timestamptz default now() not null
);

create unique index if not exists customer_user_aliases_user_id_idx
  on public.customer_user_aliases (user_id);
create index if not exists customer_user_aliases_customer_id_idx
  on public.customer_user_aliases (customer_id);

alter table public.customer_user_aliases enable row level security;

create policy "allow_all" on public.customer_user_aliases
  for all
  using (true)
  with check (true);

-- ── customer_recovery_logs: 復旧実行ログ ─────────────────────────────────────
-- recover_member RPC が成功したときのみ追記される。

create table if not exists public.customer_recovery_logs (
  id              uuid        default gen_random_uuid() primary key,
  customer_id     uuid        not null references public.customers(id),
  old_user_id     text        not null,
  new_user_id     text        not null,
  staff_name      text        not null,
  recovery_reason text        not null,
  recovered_at    timestamptz default now() not null
);

alter table public.customer_recovery_logs enable row level security;

create policy "allow_all" on public.customer_recovery_logs
  for all
  using (true)
  with check (true);

-- ── RPC: recover_member ───────────────────────────────────────────────────────
-- 旧 user_id から新 user_id へ、tickets・maintenance_visits・エイリアスを
-- 1トランザクションで移行する。
-- 戻り値: { success: true } または { error: string }

create or replace function public.recover_member(
  p_old_user_id     text,
  p_new_user_id     text,
  p_staff_name      text,
  p_recovery_reason text
)
returns json
language plpgsql
security definer
as $$
declare
  v_customer record;
begin
  -- 1. 旧 user_id で会員を検索
  select * into v_customer
  from public.customers
  where user_id = p_old_user_id;

  if not found then
    return json_build_object('error', 'customer_not_found');
  end if;

  -- 2. customers.user_id を新 user_id に更新
  update public.customers
  set user_id = p_new_user_id, updated_at = now()
  where id = v_customer.id;

  -- 3. 未使用チケットを新 user_id に移行
  update public.tickets
  set user_id = p_new_user_id
  where user_id = p_old_user_id and used = false;

  -- 4. maintenance_visits を移行（新 user_id に既存レコードがない場合のみ）
  insert into public.maintenance_visits (user_id, last_visit_date, updated_at)
  select p_new_user_id, last_visit_date, now()
  from public.maintenance_visits
  where user_id = p_old_user_id
  on conflict (user_id) do nothing;

  -- 5. エイリアス更新: 旧を is_current=false, 新を is_current=true に
  update public.customer_user_aliases
  set is_current = false
  where customer_id = v_customer.id;

  insert into public.customer_user_aliases (customer_id, user_id, is_current)
  values (v_customer.id, p_new_user_id, true)
  on conflict (user_id) do update
    set is_current = true, customer_id = v_customer.id;

  -- 6. 復旧ログ記録
  insert into public.customer_recovery_logs
    (customer_id, old_user_id, new_user_id, staff_name, recovery_reason)
  values
    (v_customer.id, p_old_user_id, p_new_user_id, p_staff_name, p_recovery_reason);

  return json_build_object('success', true);
end;
$$;

grant execute on function public.recover_member(text, text, text, text) to anon, authenticated;

-- ── live_statuses: GINJIRO LIVE STATUS（座席ごとの本日受付状況） ─────────────
-- スタッフ端末でカードをタップするたびに
-- ready → limited → full → closed → ready の順で循環更新される。

create table if not exists public.live_statuses (
  id                   text        primary key,
  name                 text        not null,
  status               text        not null default 'ready',
  sort_order           integer     not null default 0,
  availability_message text,
  updated_at           timestamptz default now() not null,

  constraint live_statuses_status_check check (status in ('ready', 'limited', 'full', 'closed'))
);

-- ── MIGRATION: add availability_message (空き状況の補足メッセージ) ──────────
-- 既存の live_statuses テーブルがある場合は、これを Supabase SQL Editor で
-- 実行してください。新規作成時は上のCREATE TABLEに既に含まれています。
--
--   ALTER TABLE public.live_statuses ADD COLUMN IF NOT EXISTS availability_message text;
--
alter table public.live_statuses add column if not exists availability_message text;

alter table public.live_statuses enable row level security;

create policy "allow_all" on public.live_statuses
  for all
  using (true)
  with check (true);

-- Supabase Realtime: enable postgres_changes for this table
-- Run this separately in the SQL editor if postgres_changes are needed:
-- alter publication supabase_realtime add table public.live_statuses;

-- 初期データ（3件固定。既存行があれば変更しない）
insert into public.live_statuses (id, name, status, sort_order) values
  ('teitei',  'テイテイ', 'ready', 1),
  ('ginjiro', '銀二郎',   'ready', 2),
  ('free',    'フリー',   'ready', 3)
on conflict (id) do nothing;

-- ── accounting_items: 会計アシスト 商品マスタ（menu / option / retail） ──────
-- スタッフ端末の「会計アシスト」タブから追加・編集する。

create table if not exists public.accounting_items (
  id          uuid        default gen_random_uuid() primary key,
  name        text        not null unique,
  category    text        not null,
  price       integer     not null,
  is_active   boolean     not null default true,
  sort_order  integer     not null default 0,
  created_at  timestamptz default now() not null,
  updated_at  timestamptz default now() not null,

  constraint accounting_items_category_check check (category in ('menu', 'option', 'retail'))
);

create index if not exists accounting_items_category_idx on public.accounting_items (category, sort_order);

alter table public.accounting_items enable row level security;

create policy "allow_all" on public.accounting_items
  for all
  using (true)
  with check (true);

-- 初期商品マスタ（既存行があれば変更しない）
insert into public.accounting_items (name, category, price, sort_order) values
  ('カット',               'menu',   3300,  1),
  ('カット＋シェービング',  'menu',   5500,  2),
  ('濡れパン',              'menu',   8000,  3),
  ('カールアイパー',        'menu',   8000,  4),
  ('パンチパーマ',          'menu',   8000,  5),
  ('テイテイ刈り',          'menu',   8000,  6),
  ('銀パラ',                'menu',   15000, 7),
  ('海軍御用達',            'menu',   5000,  8),
  ('ライン入れ（一本）',    'option', 300,   1),
  ('ゴッソ',                'option', 300,   2),
  ('眉手入れ',              'option', 500,   3),
  ('ポマード',              'retail', 2000,  1),
  ('グリース',              'retail', 1500,  2),
  ('シャンプー',            'retail', 2000,  3)
on conflict (name) do nothing;

-- ── accounting_sessions: 会計アシスト 会計履歴（会計完了ボタン押下時のみ保存） ──

create table if not exists public.accounting_sessions (
  id              uuid        default gen_random_uuid() primary key,
  user_id         text,
  customer_name   text,
  staff_name      text,
  stylist_name    text,
  status          text        not null default 'pending',
  subtotal        integer     not null,
  discount_total  integer     not null default 0,
  total           integer     not null,
  used_ticket_ids text[],
  created_at      timestamptz default now() not null,

  constraint accounting_sessions_status_check check (status in ('pending', 'completed', 'failed'))
);

-- ── MIGRATION: add status (pending/completed/failed — 会計完了処理の安全な順序管理用) ──
-- 既存の accounting_sessions テーブルがある場合は、これを Supabase SQL Editor で
-- 実行してください。新規作成時は上のCREATE TABLEに既に含まれています。
-- 既存行は会計履歴保存より前にチケットused化等が完了していたため、すべて 'completed' とする。
alter table public.accounting_sessions add column if not exists status text not null default 'pending';
update public.accounting_sessions set status = 'completed' where status = 'pending' and created_at < now();
alter table public.accounting_sessions drop constraint if exists accounting_sessions_status_check;
alter table public.accounting_sessions add constraint accounting_sessions_status_check
  check (status in ('pending', 'completed', 'failed'));

-- ── MIGRATION: add stylist_name (施術担当。staff_nameは操作したスタッフのまま) ──
-- 既存の accounting_sessions テーブルがある場合は、これを Supabase SQL Editor で
-- 実行してください。新規作成時は上のCREATE TABLEに既に含まれています。
alter table public.accounting_sessions add column if not exists stylist_name text;

create index if not exists accounting_sessions_created_at_idx on public.accounting_sessions (created_at desc);
create index if not exists accounting_sessions_user_id_idx    on public.accounting_sessions (user_id);
create index if not exists accounting_sessions_stylist_idx    on public.accounting_sessions (stylist_name);

alter table public.accounting_sessions enable row level security;

create policy "allow_all" on public.accounting_sessions
  for all
  using (true)
  with check (true);

-- ── accounting_session_items: 会計アシスト 会計明細 ──────────────────────────

create table if not exists public.accounting_session_items (
  id          uuid        default gen_random_uuid() primary key,
  session_id  uuid        references public.accounting_sessions(id),
  item_id     uuid,
  item_name   text        not null,
  category    text        not null,
  price       integer     not null,
  quantity    integer     default 1,
  created_at  timestamptz default now() not null
);

create index if not exists accounting_session_items_session_idx on public.accounting_session_items (session_id);

alter table public.accounting_session_items enable row level security;

create policy "allow_all" on public.accounting_session_items
  for all
  using (true)
  with check (true);

-- ── shop_status: 営業状態（営業開始／営業終了のワンタップ切替） ────────────────
-- 単一行運用。id='main' 固定。LIVE STATUSの一括初期化／一括終了と合わせて
-- スタッフ端末の「営業開始」「営業終了」ボタンから更新される。

create table if not exists public.shop_status (
  id          text        primary key,
  status      text        not null default 'closed',
  opened_at   timestamptz,
  closed_at   timestamptz,
  updated_at  timestamptz default now() not null,

  constraint shop_status_status_check check (status in ('open', 'closed'))
);

alter table public.shop_status enable row level security;

create policy "allow_all" on public.shop_status
  for all
  using (true)
  with check (true);

-- 初期データ（既存行があれば変更しない）
insert into public.shop_status (id, status) values ('main', 'closed')
on conflict (id) do nothing;

-- ── 銀二郎本部 Phase4: Realtime購読の有効化 ──────────────────────────────────
-- accounting_sessions / accounting_session_items / shop_status の変更を
-- /headquarters ダッシュボードがリアルタイム反映するために必要。
-- Supabase SQL Editor で実行してください（すでに supabase_realtime publication に
-- 追加済みのテーブルに対して再実行しても "already member of publication" エラーで
-- 落ちないよう、DOブロックで安全に無視します）。
do $$
begin
  begin
    alter publication supabase_realtime add table public.accounting_sessions;
  exception when duplicate_object then
    null; -- すでに追加済み
  end;
  begin
    alter publication supabase_realtime add table public.accounting_session_items;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table public.shop_status;
  exception when duplicate_object then
    null;
  end;
end $$;

-- ── products: 在庫管理（銀二郎本部 Phase5-A／会計アシスト連携 Phase5-B）──────────
-- Phase5-Bで会計アシストの店販販売時に current_stock を自動減算するようになった
-- （item_name と products.name の完全一致でのみ照合。アプリ側のロジック）。

create table if not exists public.products (
  id             uuid        default gen_random_uuid() primary key,
  name           text        not null,
  current_stock  integer     not null default 0,
  min_stock      integer     not null default 0,
  created_at     timestamptz default now() not null,
  updated_at     timestamptz default now() not null
);

create index if not exists products_name_idx on public.products (name);

alter table public.products enable row level security;

create policy "allow_all" on public.products
  for all
  using (true)
  with check (true);

-- ── 銀二郎本部 Phase5-B: products のRealtime購読を有効化 ──────────────────────
-- 在庫管理タブが会計アシストの店販販売による在庫減算をリアルタイム反映するために必要。
-- Supabase SQL Editor で実行してください（再実行しても安全）。
do $$
begin
  begin
    alter publication supabase_realtime add table public.products;
  exception when duplicate_object then
    null; -- すでに追加済み
  end;
end $$;
