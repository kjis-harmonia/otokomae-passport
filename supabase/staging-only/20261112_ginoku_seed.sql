-- 銀オクの見本（Staging だけ）：慶一郎さんの見本の4つ（無料券3つ＋500円引き券）。何度流しても、見本の開催中のものは1組だけ。
--   npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku_seed.sql
-- 20261112_ginoku_free_and_hold.sql のあとに流す（無料券の列を使う）。
-- 見本は created_by = 'seed'。入札の無い開催中の見本だけ入れ替える（入札・落札のあるものは残す）
delete from app_private.ginoku_auctions where created_by = 'seed' and status = 'open' and bid_count = 0;

-- 無料券：景品（free-*）の名前・メニュー・平日のみをそのまま写す。券の額は持たない（値引きは来店の日のメニューの料金）
insert into app_private.ginoku_auctions (prize_code, title, rank, ticket_amount, free_menu, menu_codes, weekday_only, start_price, increment, buy_now_price, starts_at, ends_at, original_ends_at, created_by)
select v.code, v.title, p.rank,
       case when p.amount is null and p.menu_codes is not null then null else p.amount end,
       case when p.amount is null and p.menu_codes is not null then p.free_menu end,
       case when p.amount is null and p.menu_codes is not null then p.menu_codes end,
       p.weekday_only, v.start_price, 100, v.buy_now, now(), now() + v.span, now() + v.span, 'seed'
from (values
  ('free-ginpara', '銀パラ無料券',       3000, null::integer, interval '1 day 3 hours'),
  ('free-apachi',  'APACHI無料券',       4000, null::integer, interval '2 days 20 hours'),
  ('free-punch',   'パンチパーマ無料券', 2000, null::integer, interval '2 hours 30 minutes'),
  ('off500',       '500円引き券',          100, 400,          interval '5 hours')
) as v(code, title, start_price, buy_now, span)
join app_private.gacha_prizes p on p.code = v.code
where not exists (select 1 from app_private.ginoku_auctions x where x.created_by = 'seed' and x.status = 'open' and x.prize_code = v.code);

select id, title, free_menu, ticket_amount, weekday_only, start_price, buy_now_price, ends_at from app_private.ginoku_auctions where created_by = 'seed' and status = 'open' order by ends_at;
