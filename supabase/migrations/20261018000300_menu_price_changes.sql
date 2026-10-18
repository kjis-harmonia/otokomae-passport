-- 料金の変更（本部 JOHNNY がテイテイさんと決めた料金を、決めた日にメニューへ反映する）。
--   アプリの AI 予約・会計はどちらも service_menus.price を使うので、ここを変えれば全部が新しい料金になる。
--   その日になったら毎日 0:01（日本時間）に反映（今日以前の日付なら、登録したその場で反映）。反映したら慶一郎へ【料金反映】の伝言。

create table if not exists public.menu_price_changes (
  id uuid primary key default gen_random_uuid(),
  menu_code text not null,
  menu_name text not null,
  old_price int,
  new_price int not null check (new_price between 0 and 1000000),
  starts_on date not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'applied', 'cancelled')),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create index if not exists menu_price_changes_due_idx on public.menu_price_changes (status, starts_on);
alter table public.menu_price_changes enable row level security;
revoke all on public.menu_price_changes from anon, authenticated;

create or replace function app_private.price_change_json(c public.menu_price_changes)
returns json language sql stable as $$
  select json_build_object('id', c.id, 'menu_code', c.menu_code, 'menu_name', c.menu_name, 'old_price', c.old_price, 'new_price', c.new_price,
    'starts_on', c.starts_on, 'status', c.status, 'note', c.note, 'created_at', c.created_at, 'applied_at', c.applied_at)
$$;

/** その日が来た料金の変更を反映する（cron と、登録した時に呼ぶ） */
create or replace function app_private.apply_price_changes()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.menu_price_changes; n int := 0; cur int;
begin
  for c in select * from public.menu_price_changes where status = 'scheduled' and starts_on <= app_private.today_jst() order by starts_on, created_at loop
    select price into cur from public.service_menus where code = c.menu_code;
    update public.service_menus set price = c.new_price, updated_at = now() where code = c.menu_code;
    update public.menu_price_changes set status = 'applied', applied_at = now(), old_price = coalesce(old_price, cur) where id = c.id;
    perform app_private.hq_message_put('to_owner', 'note', '【料金反映】' || c.menu_name,
      c.menu_name || ' を ' || coalesce(to_char(coalesce(c.old_price, cur), 'FM999,999,999') || '円 → ', '') || to_char(c.new_price, 'FM999,999,999') || '円 にしました。アプリの予約・会計も新しい料金です。', false);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.hq_menu_prices(p_hq text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'kind', m.kind, 'category', m.category, 'price', m.price,
      'booking', m.booking_enabled,
      'scheduled', (select json_build_object('new_price', c.new_price, 'starts_on', c.starts_on) from public.menu_price_changes c
                    where c.menu_code = m.code and c.status = 'scheduled' order by c.starts_on limit 1))
    order by m.sort_order, m.name) from public.service_menus m where m.is_active), '[]'::json);
end $$;

create or replace function public.hq_schedule_price_change(p_hq text, p_code text, p_new_price int, p_starts_on date, p_note text default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare m public.service_menus; c public.menu_price_changes;
begin
  perform app_private.assert_hq(p_hq);
  select * into m from public.service_menus where code = p_code and is_active;
  if m.id is null then return json_build_object('error', 'menu_not_found'); end if;
  if p_new_price is null or p_new_price < 0 or p_new_price > 1000000 or p_starts_on is null then return json_build_object('error', 'invalid_value'); end if;
  -- 同じメニューのまだ反映していない変更は、新しいものに置きかえる
  update public.menu_price_changes set status = 'cancelled' where menu_code = p_code and status = 'scheduled';
  insert into public.menu_price_changes (menu_code, menu_name, old_price, new_price, starts_on, note)
  values (m.code, m.name, m.price, p_new_price, p_starts_on, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning * into c;
  if p_starts_on <= app_private.today_jst() then perform app_private.apply_price_changes(); select * into c from public.menu_price_changes where id = c.id; end if;
  return app_private.price_change_json(c);
end $$;

create or replace function public.hq_price_changes_list(p_hq text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return coalesce((select json_agg(app_private.price_change_json(c) order by c.starts_on desc, c.created_at desc)
    from (select * from public.menu_price_changes where status = 'scheduled' or created_at > now() - interval '60 days' order by created_at desc limit 50) c), '[]'::json);
end $$;

create or replace function public.hq_cancel_price_change(p_hq text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.menu_price_changes;
begin
  perform app_private.assert_hq(p_hq);
  update public.menu_price_changes set status = 'cancelled' where id = p_id and status = 'scheduled' returning * into c;
  if c.id is null then return json_build_object('error', 'not_found'); end if;
  return app_private.price_change_json(c);
end $$;

revoke all on function app_private.apply_price_changes() from public;
revoke all on function public.hq_menu_prices(text), public.hq_schedule_price_change(text, text, int, date, text),
  public.hq_price_changes_list(text), public.hq_cancel_price_change(text, uuid) from public, anon, authenticated;
grant execute on function public.hq_menu_prices(text), public.hq_schedule_price_change(text, text, int, date, text),
  public.hq_price_changes_list(text), public.hq_cancel_price_change(text, uuid) to anon, authenticated;

-- 毎日 0:01（日本時間）に、その日の料金の変更を反映する
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'apply-price-changes';
    perform cron.schedule('apply-price-changes', '1 15 * * *', 'select app_private.apply_price_changes()');
  end if;
end $$;
