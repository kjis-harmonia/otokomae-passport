-- ガチャのゲージ（11/6 慶一郎さん「ガチャ券を使えば使うだけ欲しい景品にたどり着くゲージ」）
--   ・お客様は「狙う景品」を選ぶ。ガチャ券を使った来店の会計が済むとポイントが付き、狙う景品の分たまったら受け取れる
--   ・ポイント：会計の値引き前の金額（メニュー・オプション。物販と子どものメニューは入れない）が 3,000円以上で 0.5pt、5,000円以上で 1pt
--   ・付くのは会員ご本人の予約だけ（お連れ様の予約は付かない）。子どものメニューで貯めてお父さんが受け取る形にしない
--   ・ゲージで受け取った券はご本人の予約だけに使える（お連れ様には回せない）
--   ・会計を取り消したら、その会計のポイントも戻す（受け取ったあとならマイナスになり、次のポイントで埋まる）
--   ・会計の関数（finalize_sale・void_sale）には触らない。会計の状態が変わったときのトリガーで付ける／戻す。
--     ポイントの計算で何か起きても会計そのものは止めない（警告だけ残す）
--   ・解禁日 gacha_settings.gauge_opens_on（本番 12/1）より前の会計にはポイントを付けない

alter table app_private.gacha_settings add column if not exists gauge_opens_on date not null default date '2026-12-01';

-- 景品ごとに必要なポイント（無い景品はゲージで狙えない）
create table if not exists app_private.gacha_gauge_goals (
  prize_code text primary key references app_private.gacha_prizes(code),
  points     numeric(5,1) not null check (points > 0)
);
revoke all on table app_private.gacha_gauge_goals from public, anon, authenticated;
insert into app_private.gacha_gauge_goals (prize_code, points) values
  ('off500', 5), ('teitei1000', 10), ('skinfade', 10),
  ('free-punch', 30), ('free-aipa', 30), ('free-nigro', 30),
  ('free-apachi', 50), ('free-ginpara', 50)
on conflict (prize_code) do nothing;

-- ポイントの付かないメニュー（子ども）
create table if not exists app_private.gacha_gauge_skip_menus (menu_code text primary key);
revoke all on table app_private.gacha_gauge_skip_menus from public, anon, authenticated;
insert into app_private.gacha_gauge_skip_menus (menu_code) values ('cut-elementary'), ('cut-kids-skin-fade') on conflict do nothing;

-- お客様ごとのゲージ
create table if not exists app_private.gacha_gauge (
  user_id    text primary key,
  points     numeric(6,1) not null default 0,
  target     text references app_private.gacha_gauge_goals(prize_code),
  updated_at timestamptz not null default now()
);
revoke all on table app_private.gacha_gauge from public, anon, authenticated;

-- 動きの記録（会計1件につき1回だけ付く。受け取りは sale_id なし）
create table if not exists app_private.gacha_gauge_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  kind       text not null check (kind in ('earn', 'void', 'claim')),
  points     numeric(6,1) not null,
  sale_id    uuid,
  prize_code text,
  base       int,
  created_at timestamptz not null default now()
);
create unique index if not exists gacha_gauge_log_once on app_private.gacha_gauge_log (sale_id, kind) where sale_id is not null;
create index if not exists gacha_gauge_log_user on app_private.gacha_gauge_log (user_id, created_at desc);
revoke all on table app_private.gacha_gauge_log from public, anon, authenticated;

-- 持ち券：ゲージで受け取った券は抽選の記録が無い（draw_id は空）。self_only＝ご本人の予約だけ
alter table app_private.gacha_holdings alter column draw_id drop not null;
alter table app_private.gacha_holdings add column if not exists source text not null default 'draw' check (source in ('draw', 'gauge'));
alter table app_private.gacha_holdings add column if not exists self_only boolean not null default false;

create or replace function app_private.gacha_gauge_open() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.gauge_opens_on <= app_private.today_jst() from app_private.gacha_settings s where s.id = 1), false)
$$;

/** その会計で付くポイント（0／0.5／1） */
create or replace function app_private.gacha_gauge_points(p_base bigint) returns numeric
language sql immutable set search_path = '' as $$
  select case when p_base >= 5000 then 1.0 when p_base >= 3000 then 0.5 else 0 end
$$;

/** 抽選の券を持たせる（工程②の形に、ゲージの印を戻す列を足しただけ） */
create or replace function app_private.gacha_hold(p_user text, p_draw uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p app_private.gacha_prizes; v_last date := app_private.today_jst() + 30;
begin
  select pr.* into p from app_private.gacha_draws d join app_private.gacha_prizes pr on pr.code = d.prize_code where d.id = p_draw;
  insert into app_private.gacha_holdings (user_id, draw_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes, source, self_only)
  values (p_user, p_draw, p.code, p.title, p.amount, p.free_menu, p.weekday_only, p.rank, ((v_last + 1)::timestamp at time zone 'Asia/Tokyo'), p.menu_codes, 'draw', false)
  on conflict (user_id) do update set draw_id = excluded.draw_id, prize_code = excluded.prize_code, title = excluded.title,
    amount = excluded.amount, free_menu = excluded.free_menu, weekday_only = excluded.weekday_only, rank = excluded.rank,
    expires_at = excluded.expires_at, menu_codes = excluded.menu_codes, used_at = null, created_at = now(),
    reservation_id = null, used_sale_id = null, source = 'draw', self_only = false;
end;
$$;

/** その予約に券が使えるか（工程③に、ゲージの券はお連れ様に使えない、を足す） */
create or replace function app_private.gacha_unfit(p_user text, p_reservation uuid)
returns text language plpgsql stable set search_path = '' as $$
declare h app_private.gacha_holdings; r public.reservations; v_codes text[];
begin
  select * into h from app_private.gacha_holdings where user_id = p_user and used_at is null and expires_at > now();
  if h.user_id is null then return 'no_ticket'; end if;
  r := app_private.gacha_active_reservation(p_reservation);
  if r.id is null or r.user_id is distinct from p_user then return 'not_found'; end if;
  if r.companion_of is not null and (h.free_menu is null or h.self_only) then return 'companion'; end if;
  if h.expires_at <= r.starts_at then return 'expired'; end if;
  if h.weekday_only and app_private.gacha_offday(r.starts_at) then return 'weekday'; end if;
  select coalesce(array_agg(menu_code), '{}') into v_codes from public.reservation_items where reservation_id = r.id;
  if h.menu_codes is not null and not (v_codes && h.menu_codes) then return 'menu'; end if;
  if h.menu_codes is null and not exists (select 1 from unnest(v_codes) c where c <> 'maintenance') then return 'menu'; end if;
  return null;
end;
$$;

/** 使える持ち券（工程②の形に self_only を足す） */
create or replace function app_private.gacha_held_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object('code', h.prize_code, 'title', h.title, 'amount', h.amount, 'free_menu', h.free_menu,
                           'weekday_only', h.weekday_only, 'rank', h.rank, 'expires_at', h.expires_at, 'menu_codes', h.menu_codes,
                           'self_only', h.self_only,
                           'reserved', (select json_build_object('id', r.id, 'starts_at', r.starts_at)
                                        from app_private.gacha_active_reservation(h.reservation_id) r where r.id is not null))
  from app_private.gacha_holdings h
  where h.user_id = p_user and h.used_at is null and h.expires_at > now()
$$;

/** ゲージ（解禁前は open=false だけ） */
create or replace function app_private.gacha_gauge_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select case when not app_private.gacha_gauge_open() then json_build_object('open', false) else
    json_build_object(
      'open', true,
      'points', coalesce(g.points, 0),
      'target', g.target,
      'goals', (select coalesce(json_agg(json_build_object('code', p.code, 'title', p.title, 'rank', p.rank, 'points', gg.points,
                                                           'amount', p.amount, 'free_menu', p.free_menu, 'weekday_only', p.weekday_only)
                                         order by gg.points, p.sort), '[]'::json)
                from app_private.gacha_gauge_goals gg join app_private.gacha_prizes p on p.code = gg.prize_code where p.active))
  end
  from (select 1) one left join app_private.gacha_gauge g on g.user_id = p_user
$$;

/** 今日の抽選・持ち券・ゲージ（工程①の形に gauge を足す） */
create or replace function app_private.gacha_state(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'today', (select json_build_object('id', d.id, 'prize', app_private.gacha_prize_json(p), 'choice', d.choice, 'draw_date', d.draw_date)
              from (select * from app_private.gacha_pending(p_user) union all select * from app_private.gacha_today(p_user)) d
              join app_private.gacha_prizes p on p.code = d.prize_code
              where d.id is not null limit 1),
    'held', app_private.gacha_held_json(p_user),
    'repeat', app_private.gacha_repeat(),
    'gauge', app_private.gacha_gauge_json(p_user))
$$;

/** 会計が済んだ／取り消されたとき：ガチャ券を使った会計ならポイントを付ける／戻す */
create or replace function app_private.gacha_gauge_on_sale()
returns trigger language plpgsql security definer set search_path = '' as $$
declare h app_private.gacha_holdings; r public.reservations; v_base bigint; v_pt numeric; l app_private.gacha_gauge_log;
begin
  begin
    if new.status = 'completed' and old.status is distinct from 'completed' then
      if not app_private.gacha_gauge_open() or new.reservation_id is null then return new; end if;
      select * into h from app_private.gacha_holdings where used_sale_id = new.id;
      if h.user_id is null then return new; end if;
      select * into r from public.reservations where id = new.reservation_id;
      -- ご本人の予約だけ（お連れ様の予約・ほかの会員の予約は付かない）
      if r.id is null or r.companion_of is not null or r.user_id is distinct from h.user_id then return new; end if;
      select coalesce(sum(i.price::bigint * i.quantity), 0) into v_base
      from public.accounting_session_items i
      where i.session_id = new.id and i.category in ('menu', 'option')
        and not exists (select 1 from app_private.gacha_gauge_skip_menus s where s.menu_code = i.ref_id);
      v_pt := app_private.gacha_gauge_points(v_base);
      if v_pt <= 0 then return new; end if;
      insert into app_private.gacha_gauge_log (user_id, kind, points, sale_id, base) values (h.user_id, 'earn', v_pt, new.id, v_base)
      on conflict do nothing;
      if found then
        insert into app_private.gacha_gauge (user_id, points) values (h.user_id, v_pt)
        on conflict (user_id) do update set points = app_private.gacha_gauge.points + excluded.points, updated_at = now();
      end if;
    elsif new.status = 'voided' and old.status = 'completed' then
      select * into l from app_private.gacha_gauge_log where sale_id = new.id and kind = 'earn';
      if l.id is null then return new; end if;
      insert into app_private.gacha_gauge_log (user_id, kind, points, sale_id, base) values (l.user_id, 'void', -l.points, new.id, l.base)
      on conflict do nothing;
      if found then
        update app_private.gacha_gauge set points = points - l.points, updated_at = now() where user_id = l.user_id;
      end if;
    end if;
  exception when others then
    raise warning 'gacha_gauge_on_sale %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function app_private.gacha_gauge_on_sale() from public, anon, authenticated;
drop trigger if exists gacha_gauge_on_sale on public.accounting_sessions;
create trigger gacha_gauge_on_sale after update of status on public.accounting_sessions
  for each row execute function app_private.gacha_gauge_on_sale();

/** お客様：狙う景品を選ぶ（いつでも変えられる。ポイントはそのまま） */
create or replace function public.customer_gacha_gauge_target(p_session text, p_code text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if not app_private.gacha_gauge_open() then return json_build_object('error', 'not_open'); end if;
  if not exists (select 1 from app_private.gacha_gauge_goals gg join app_private.gacha_prizes p on p.code = gg.prize_code
                 where gg.prize_code = p_code and p.active) then
    return json_build_object('error', 'bad_target');
  end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  insert into app_private.gacha_gauge (user_id, target) values (v_user, p_code)
  on conflict (user_id) do update set target = excluded.target, updated_at = now();
  return app_private.gacha_state(v_user);
end;
$$;

/** お客様：たまったら受け取る。今の券と入れ替わる（予約に付いた券があるうちは受け取れない） */
create or replace function public.customer_gacha_gauge_claim(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); g app_private.gacha_gauge; v_need numeric;
        p app_private.gacha_prizes; h app_private.gacha_holdings; v_last date := app_private.today_jst() + 30;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if not app_private.gacha_gauge_open() then return json_build_object('error', 'not_open'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  select * into g from app_private.gacha_gauge where user_id = v_user for update;
  if g.target is null then return json_build_object('error', 'no_target'); end if;
  select gg.points into v_need from app_private.gacha_gauge_goals gg where gg.prize_code = g.target;
  select * into p from app_private.gacha_prizes where code = g.target and active;
  if v_need is null or p.code is null then return json_build_object('error', 'bad_target'); end if;
  if g.points < v_need then return json_build_object('error', 'not_enough'); end if;
  select * into h from app_private.gacha_holdings where user_id = v_user for update;
  if h.user_id is not null and h.used_at is null and h.expires_at > now()
     and (app_private.gacha_active_reservation(h.reservation_id)).id is not null then
    return json_build_object('error', 'held_reserved');
  end if;
  insert into app_private.gacha_holdings (user_id, draw_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at, menu_codes, source, self_only)
  values (v_user, null, p.code, p.title, p.amount, p.free_menu, p.weekday_only, p.rank, ((v_last + 1)::timestamp at time zone 'Asia/Tokyo'), p.menu_codes, 'gauge', true)
  on conflict (user_id) do update set draw_id = null, prize_code = excluded.prize_code, title = excluded.title,
    amount = excluded.amount, free_menu = excluded.free_menu, weekday_only = excluded.weekday_only, rank = excluded.rank,
    expires_at = excluded.expires_at, menu_codes = excluded.menu_codes, used_at = null, created_at = now(),
    reservation_id = null, used_sale_id = null, source = 'gauge', self_only = true;
  update app_private.gacha_gauge set points = points - v_need, updated_at = now() where user_id = v_user;
  insert into app_private.gacha_gauge_log (user_id, kind, points, prize_code) values (v_user, 'claim', -v_need, p.code);
  return app_private.gacha_state(v_user);
end;
$$;

revoke all on function app_private.gacha_gauge_open(), app_private.gacha_gauge_points(bigint), app_private.gacha_gauge_json(text)
  from public, anon, authenticated;
revoke all on function public.customer_gacha_gauge_target(text, text), public.customer_gacha_gauge_claim(text) from public;
grant execute on function public.customer_gacha_gauge_target(text, text), public.customer_gacha_gauge_claim(text)
  to anon, authenticated, service_role;
