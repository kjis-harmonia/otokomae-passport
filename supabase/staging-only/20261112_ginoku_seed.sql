-- 銀オクの見本（Staging だけ）：ガチャ券を3つ出品する。何度流しても、見本の開催中のものは1組だけ。
--   npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku_seed.sql
-- 見本は created_by = 'seed'。入札の無い開催中の見本だけ入れ替える（入札・落札のあるものは残す）
delete from app_private.ginoku_auctions where created_by = 'seed' and status = 'open' and bid_count = 0;

insert into app_private.ginoku_auctions (prize_code, title, rank, ticket_amount, weekday_only, start_price, increment, buy_now_price, starts_at, ends_at, original_ends_at, created_by)
select v.code, v.title, p.rank, p.amount, p.weekday_only, v.start_price, 100, v.buy_now, now(), now() + v.span, now() + v.span, 'seed'
from (values
  ('off1000', '1,000円引き券', 100, 800, interval '5 hours'),
  ('off500',  '500円引き券',   100, null::integer, interval '1 day 3 hours'),
  ('off300',  '300円引き券',   100, 200, interval '3 days')
) as v(code, title, start_price, buy_now, span)
join app_private.gacha_prizes p on p.code = v.code
where not exists (select 1 from app_private.ginoku_auctions x where x.created_by = 'seed' and x.status = 'open' and x.prize_code = v.code);

select id, title, start_price, buy_now_price, ends_at from app_private.ginoku_auctions where created_by = 'seed' and status = 'open' order by ends_at;
