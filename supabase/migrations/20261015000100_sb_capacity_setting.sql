-- 銀二郎SB：同時受付の枠（SALON BOARD の「受付可能数」と同じ）。
-- 2026-10-15 にお店の SALON BOARD の画面で、テイテイ・銀二郎とも「受付可能数：3」であることを確認した。
-- 20261015000000 は全員を 1 で始める（勝手に受付を増やさない）ので、この2人だけを 3 にする。
-- 何度当てても同じ結果（すでに 3 なら何も変わらない）。ほかのスタッフは変えない。
update public.staff_members
set booking_capacity = 3, updated_at = now()
where display_name in ('テイテイ', '銀二郎') and booking_capacity <> 3;
