-- =============================================================================
-- 20261001_security_hardening_rollback.sql
-- 20261001_security_hardening.sql を適用する前のアクセス状態に戻す（緊急用）。
--
-- ・テーブルの allow_all ポリシーと権限を復元する
-- ・recover_member の anon 実行権を復元する
-- ・追加した RPC / テーブル / app_private スキーマは残す（害は無く、再適用時に再利用される）
-- 注意：これを実行するとセキュリティ監査の指摘状態（誰でも読み書き可）に戻る。
--       旧アプリ（PINがフロントにある版）に戻す場合のみ使うこと。
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'tickets', 'ticket_issue_logs', 'maintenance_visits', 'ticket_transfers',
    'ticket_usage_logs', 'customer_user_aliases', 'customer_recovery_logs',
    'customers', 'live_statuses', 'shop_status',
    'accounting_items', 'accounting_sessions', 'accounting_session_items', 'daily_reports', 'customer_notes', 'products'
  ] loop
    execute format('drop policy if exists "public_read" on public.%I', t);
    execute format('drop policy if exists "read_basic_columns" on public.%I', t);
    execute format('drop policy if exists "public_read_retail" on public.%I', t);
    execute format('drop policy if exists "allow_all" on public.%I', t);
    execute format('create policy "allow_all" on public.%I for all using (true) with check (true)', t);
  end loop;
end $$;

grant all on public.customers to anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array[
    'tickets', 'ticket_issue_logs', 'maintenance_visits', 'ticket_transfers',
    'ticket_usage_logs', 'customer_user_aliases', 'customer_recovery_logs',
    'maintenance_coupon_tokens', 'live_statuses', 'shop_status',
    'accounting_items', 'accounting_sessions', 'accounting_session_items', 'daily_reports', 'customer_notes', 'products'
  ] loop
    execute format('grant all on public.%I to anon, authenticated', t);
  end loop;
end $$;

grant execute on function public.recover_member(text, text, text, text) to anon, authenticated;
grant execute on function public.complete_customer_onboarding(text, text, boolean) to anon, authenticated;
grant execute on function public.claim_ticket_transfer(text, text) to anon, authenticated;
