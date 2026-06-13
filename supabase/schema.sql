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

  constraint tickets_type_check check (type in ('coupon', 'discount', 'cut-ticket'))
);

create index if not exists tickets_user_id_idx      on public.tickets (user_id);
create index if not exists tickets_user_id_used_idx on public.tickets (user_id, used);

-- RLS: Phase1 is open access (tie to Supabase Auth in Phase2)
alter table public.tickets enable row level security;

create policy "allow_all" on public.tickets
  for all
  using (true)
  with check (true);

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
