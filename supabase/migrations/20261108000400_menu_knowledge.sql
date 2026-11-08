-- 銀ちゃんの理容技術の知識（11/8 慶一郎さん「AIが勝手に理容技術の知識を作るのは禁止」「確認済みの理容知識だけ使わせる」）
--   メニュー（service_menus.code）ごとに、仕上がり・必要な髪の長さ・向いている髪質や条件・施術前に確認すること
--   慶一郎さんか銀二郎の理容師が確認した日（confirmed_at）が入ったものだけ、銀ちゃんが使う。料金・時間はここに持たない（正式マスタだけ）
create table if not exists app_private.menu_knowledge (
  menu_code     text primary key references public.service_menus(code),
  finish        text check (finish is null or length(finish) <= 300),          -- どんな仕上がりになるか
  length_needed text check (length_needed is null or length(length_needed) <= 300), -- 必要な今の髪の長さ（短髪向けか・長さが要るか）
  hair_fit      text check (hair_fit is null or length(hair_fit) <= 300),      -- 向いている髪質・条件
  check_before  text check (check_before is null or length(check_before) <= 300), -- 施術前に確認すること
  note          text check (note is null or length(note) <= 300),
  confirmed_by  text,
  confirmed_at  timestamptz,
  updated_at    timestamptz not null default now()
);
revoke all on table app_private.menu_knowledge from public, anon, authenticated;

/** お客様（銀ちゃん）：確認済みの理容知識だけ */
create or replace function public.customer_menu_knowledge(p_session text)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.session_user_id(p_session);
  return coalesce((select json_agg(json_build_object('menu_code', k.menu_code, 'name', m.name, 'finish', k.finish, 'length_needed', k.length_needed,
      'hair_fit', k.hair_fit, 'check_before', k.check_before) order by m.sort_order)
    from app_private.menu_knowledge k join public.service_menus m on m.code = k.menu_code
    where k.confirmed_at is not null and m.is_active), '[]'::json);
end;
$$;
revoke all on function public.customer_menu_knowledge(text) from public;
grant execute on function public.customer_menu_knowledge(text) to anon, authenticated, service_role;
