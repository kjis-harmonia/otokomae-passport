-- 11/5 慶一郎さん：無料券は平日のみ。ラインナップは特典の強い順（高額→100円）に並べ、特典の額（value）も返す
update app_private.gacha_prizes set weekday_only = true where free_menu is not null;

create or replace function public.gacha_lineup()
returns json language sql stable security definer set search_path = '' as $$
  with v as (
    select p.*, coalesce(p.amount, (select max(m.price) from public.service_menus m where m.code = any(p.menu_codes))) as value
    from app_private.gacha_prizes p where p.active and p.weight > 0
  )
  select coalesce(json_agg(json_build_object('code', v.code, 'title', v.title, 'amount', v.amount, 'free_menu', v.free_menu,
                                             'weekday_only', v.weekday_only, 'rank', v.rank, 'value', v.value)
                           order by v.value desc nulls last, v.sort), '[]'::json)
  from v
$$;
revoke all on function public.gacha_lineup() from public;
grant execute on function public.gacha_lineup() to anon, authenticated;
