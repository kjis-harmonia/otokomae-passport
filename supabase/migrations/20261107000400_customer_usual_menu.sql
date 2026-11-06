-- いつものメニューを会員の記録に（11/6 慶一郎さん「お客さんのいつものメニュー登録できたらお客さん次から楽じゃない？」）
--   ・これまではお客様の端末だけに保存していた。お店（店舗端末）でも登録でき、機種変更しても消えない
--   ・お客様がアプリで変えたら、それで上書き（新しい方を使う）
create table if not exists app_private.customer_usual_menus (
  user_id   text primary key,
  menu_code text not null references public.service_menus(code),
  set_by    text not null check (set_by in ('customer', 'store')),
  set_name  text,
  set_at    timestamptz not null default now()
);
revoke all on table app_private.customer_usual_menus from public, anon, authenticated;

create or replace function app_private.usual_menu_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object('code', u.menu_code, 'name', m.name, 'set_by', u.set_by, 'set_at', u.set_at)
  from app_private.customer_usual_menus u join public.service_menus m on m.code = u.menu_code
  where u.user_id = p_user and m.is_active
$$;
revoke all on function app_private.usual_menu_json(text) from public, anon, authenticated;

/** お客様：いつものメニュー（無ければ null） */
create or replace function public.customer_usual_menu(p_session text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  return app_private.usual_menu_json(v_user);
end;
$$;

/** お客様：いつものメニューを登録する（null で取り消し） */
create or replace function public.customer_set_usual_menu(p_session text, p_code text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if p_code is null then delete from app_private.customer_usual_menus where user_id = v_user; return json_build_object('ok', true); end if;
  if not exists (select 1 from public.service_menus where code = p_code and is_active) then return json_build_object('error', 'bad_menu'); end if;
  insert into app_private.customer_usual_menus (user_id, menu_code, set_by, set_name) values (v_user, p_code, 'customer', null)
  on conflict (user_id) do update set menu_code = excluded.menu_code, set_by = 'customer', set_name = null, set_at = now();
  return json_build_object('ok', true, 'usual', app_private.usual_menu_json(v_user));
end;
$$;

/** 店舗端末：お客様のいつものメニューを登録する（会計のあとなど） */
create or replace function public.staff_set_usual_menu(p_token text, p_user_id text, p_code text, p_staff_name text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_token);
  if p_user_id is null or not exists (select 1 from public.customers where user_id = p_user_id) then return json_build_object('error', 'not_found'); end if;
  if p_code is null or not exists (select 1 from public.service_menus where code = p_code and is_active) then return json_build_object('error', 'bad_menu'); end if;
  insert into app_private.customer_usual_menus (user_id, menu_code, set_by, set_name) values (p_user_id, p_code, 'store', nullif(btrim(coalesce(p_staff_name, '')), ''))
  on conflict (user_id) do update set menu_code = excluded.menu_code, set_by = 'store', set_name = excluded.set_name, set_at = now();
  return json_build_object('ok', true, 'usual', app_private.usual_menu_json(p_user_id));
end;
$$;

revoke all on function public.customer_usual_menu(text), public.customer_set_usual_menu(text, text), public.staff_set_usual_menu(text, text, text, text) from public;
grant execute on function public.customer_usual_menu(text), public.customer_set_usual_menu(text, text), public.staff_set_usual_menu(text, text, text, text)
  to anon, authenticated, service_role;
