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
