-- 今月のラインナップ（11/5 慶一郎さん「3D ショーケースで景品一覧」）：出る景品の一覧。誰でも見られる（確率・重みは出さない）
create or replace function public.gacha_lineup()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('code', p.code, 'title', p.title, 'amount', p.amount, 'free_menu', p.free_menu,
                                             'weekday_only', p.weekday_only, 'rank', p.rank)
                           order by case p.rank when 'legend' then 0 when 'rare' then 1 else 2 end, case when p.rank = 'normal' then -p.sort else p.sort end), '[]'::json)
  from app_private.gacha_prizes p where p.active and p.weight > 0
$$;
revoke all on function public.gacha_lineup() from public;
grant execute on function public.gacha_lineup() to anon, authenticated;
