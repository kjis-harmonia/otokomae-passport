-- =============================================================================
-- 20261001_security_hardening_b_lockdown.sql   【ステップB：閉鎖】
--
-- 新アプリ（RPC 版）を公開し、店舗端末・お客様アプリの動作を確認した「後」に実行する。
-- これを実行すると旧アプリ（テーブル直接アクセス版）は動かなくなる。
-- 元に戻す場合は 20261001_security_hardening_rollback.sql を実行する。
-- =============================================================================

-- p_user_id を本人として信用する旧RPCは anon から呼べなくする
--   recover_member            → staff_recover_member（スタッフ認証）経由のみ
--   complete_customer_onboarding → customer_register（サーバー採番＋顧客セッション）に置き換え
--   claim_ticket_transfer     → customer_claim_transfer（受け取る人も顧客セッションで特定）経由のみ
revoke execute on function public.recover_member(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.complete_customer_onboarding(text, text, boolean) from public, anon, authenticated;
revoke execute on function public.claim_ticket_transfer(text, text) from public, anon, authenticated;

-- ── 6. allow_all 廃止 ─────────────────────────────────────────────────────────

-- 6-1. 直接アクセスを完全に閉じる（RPC 経由のみ。廃止機能のテーブルは RPC も無し）
do $$
declare t text;
begin
  foreach t in array array[
    'tickets', 'ticket_issue_logs', 'maintenance_visits', 'ticket_transfers',
    'ticket_usage_logs', 'customer_user_aliases', 'customer_recovery_logs',
    -- 本部系（売上・会計・日報・カルテメモ）：本部セッション RPC／店舗業務はスタッフセッション RPC のみ
    'accounting_items', 'accounting_sessions', 'accounting_session_items', 'daily_reports', 'customer_notes',
    -- 廃止済み機能（LIVE STATUS・営業開始／終了）
    'live_statuses', 'shop_status'
  ] loop
    execute format('drop policy if exists "allow_all" on public.%I', t);
    execute format('drop policy if exists "public_read" on public.%I', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- 6-2. customers：外部からの直接アクセスは読み取りも含めて完全に禁止。
--      お客様本人は顧客セッション付き RPC（customer_get_profile）、
--      店舗端末はスタッフセッション付き RPC（staff_customer_context / staff_search_customers）のみ。
drop policy if exists "allow_all" on public.customers;
drop policy if exists "read_basic_columns" on public.customers;
alter table public.customers enable row level security;
revoke all on public.customers from anon, authenticated;

-- 6-4. 二重の閉鎖：RLS に加えてテーブル権限そのものを anon / authenticated から外す
--      （RLS の設定ミスや GraphQL 等の別経路があっても読み書きできないようにする）
do $$
declare t text;
begin
  foreach t in array array[
    'tickets', 'ticket_issue_logs', 'maintenance_visits', 'ticket_transfers',
    'ticket_usage_logs', 'customer_user_aliases', 'customer_recovery_logs',
    'maintenance_coupon_tokens',
    'accounting_items', 'accounting_sessions', 'accounting_session_items', 'daily_reports', 'customer_notes',
    'live_statuses', 'shop_status'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- 6-5. products：お客様アプリの SHOP タブが店販商品を表示するため、
--      「店販・販売中の行」かつ「表示に必要な列」だけ公開読み取り。書き込みは RPC のみ。
--      （最低在庫数などの在庫管理情報、店販以外のカテゴリーは非公開）
drop policy if exists "allow_all" on public.products;
drop policy if exists "public_read_retail" on public.products;
alter table public.products enable row level security;
create policy "public_read_retail" on public.products for select to anon, authenticated
  using (category = '店販' and is_active is not false);
revoke all on public.products from anon, authenticated;
grant select (id, name, category, is_active, current_stock, price, accounting_group, created_at, updated_at)
  on public.products to anon, authenticated;
