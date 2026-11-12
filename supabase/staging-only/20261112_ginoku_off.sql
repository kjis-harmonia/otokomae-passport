-- 銀オクを Staging から外す（20261112_ginoku.sql の戻し）。Staging だけ。
--   npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku_off.sql
-- 銀Pay の台帳（ginpay_transactions の「銀オク落札」の調整）と発行した券（tickets）は消さない（お金と券の記録は残す）。
-- 落札の記録を残したいときは、先に app_private.ginoku_auctions / ginoku_bids を書き出してから流すこと。
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'ginoku-settle';
  end if;
end $$;

drop function if exists public.customer_ginoku_list(text);
drop function if exists public.customer_ginoku_detail(text, uuid);
drop function if exists public.customer_ginoku_bid(text, uuid, integer);
drop function if exists public.customer_ginoku_buy_now(text, uuid);
drop function if exists public.staff_ginoku_create(text, text, integer, timestamptz, integer, text, integer, timestamptz, integer, text);
drop function if exists public.staff_ginoku_cancel(text, uuid);
drop function if exists public.staff_ginoku_list(text);
drop function if exists app_private.ginoku_detail_json(uuid, text);
drop function if exists app_private.ginoku_wallet_public(text);
drop function if exists app_private.ginoku_session_user(text);
drop function if exists app_private.ginoku_json(app_private.ginoku_auctions, text);
drop function if exists app_private.ginoku_settle_due();
drop function if exists app_private.ginoku_settle(uuid, boolean);
drop function if exists app_private.ginoku_charge_and_issue(uuid, text, integer, text);
drop function if exists app_private.ginoku_wallet(text, boolean);
drop function if exists app_private.ginoku_min_bid(app_private.ginoku_auctions);
drop table if exists app_private.ginoku_bids;
drop table if exists app_private.ginoku_auctions;

notify pgrst, 'reload schema';
