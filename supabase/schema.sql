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
