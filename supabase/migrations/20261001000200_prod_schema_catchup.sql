-- ============================================================================
-- 本番スキーマの追いつき（catch-up）— ステップA の直前に1回だけ実行
-- ----------------------------------------------------------------------------
-- 2026-10-02 の本番バックアップで、supabase/schema.sql にあるのに本番に無いものが2点見つかった。
--   1. customer_notes テーブル（本部カルテのメモ）… 無いとステップA・B が失敗する
--   2. daily_reports.payment_summary 列 … 無いと本部の日報作成が失敗する
-- どちらも supabase/schema.sql と同じ定義。何度実行しても同じ結果になる（冪等）。
-- customer_notes には allow_all ポリシーを付けない（RLS 有効・ポリシー無し＝外部からは読み書き不可。
-- 本部は hq_customer_notes / hq_create_customer_note 経由。ステップB でテーブル権限も外す）。
-- ============================================================================

-- 1. customer_notes：接客メモ（本部カルテ）
create table if not exists public.customer_notes (
  id           uuid        default gen_random_uuid() primary key,
  customer_id  uuid        not null references public.customers(id) on delete cascade,
  note         text        not null,
  created_by   text        not null,
  created_at   timestamptz default now() not null
);

create index if not exists customer_notes_customer_id_idx on public.customer_notes (customer_id);
create index if not exists customer_notes_created_at_idx  on public.customer_notes (created_at desc);

alter table public.customer_notes enable row level security;

-- 2. daily_reports：支払い方法別売上
alter table public.daily_reports add column if not exists payment_summary jsonb not null default '[]'::jsonb;
