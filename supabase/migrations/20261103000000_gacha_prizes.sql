-- 本日のガチャの景品（11/1 慶一郎さん決定・11/3 実装）
--   ・1会員1日1回（日本時間 0:00 区切り）・ハズレなし。抽選はサーバーで決め、途中で閉じても同じ日は同じ結果
--   ・ガチャ券は1枚しか持てない。新しい券が出たら「今の券」と「新しい券」のどちらを残すかお客様が選ぶ（選ぶまで今の券はそのまま）
--   ・券は AI 予約で使う（使い方は次の工程。ここでは抽選と持ち券だけ。会計・予約・ほかの券には触らない）
--   ・確率は app_private.gacha_prizes の weight（合計に対する割合）で変えられる。active=false で出なくなる

create table if not exists app_private.gacha_prizes (
  code         text primary key,
  title        text not null,
  amount       int,              -- 値引き額（無料券は null）
  free_menu    text,             -- 無料券のメニュー（表示用）
  weekday_only boolean not null default true,
  rank         text not null default 'normal' check (rank in ('normal', 'rare', 'legend')),
  weight       numeric not null check (weight >= 0),
  active       boolean not null default true,
  sort         int not null default 0
);
revoke all on table app_private.gacha_prizes from public, anon, authenticated;

insert into app_private.gacha_prizes (code, title, amount, free_menu, weekday_only, rank, weight, sort) values
  ('off100',        '100円引き',                 100,  null,              true,  'normal', 95,    10),
  ('off300',        '300円引き',                 300,  null,              true,  'normal', 4,     20),
  ('off500',        '500円引き',                 500,  null,              true,  'rare',   0.975, 30),
  ('teitei1000',    'テイテイ刈り 1,000円引き',  1000, null,              false, 'legend', 0.01,  40),
  ('skinfade',      '追加スキンフェード 無料',   null, '追加スキンフェード', false, 'legend', 0.01,  50),
  ('free-apachi',   'APACHI 無料',               null, 'APACHI',          false, 'legend', 0.001, 60),
  ('free-ginpara',  '銀パラ 無料',               null, '銀パラ',          false, 'legend', 0.001, 61),
  ('free-punch',    'パンチパーマ 無料',         null, 'パンチパーマ',    false, 'legend', 0.001, 62),
  ('free-aipa',     'アイパー 無料',             null, 'アイパー',        false, 'legend', 0.001, 63),
  ('free-nigro',    'ニグロ 無料',               null, 'ニグロ',          false, 'legend', 0.001, 64)
on conflict (code) do nothing;

-- 1日1回の記録。choice：auto＝券を持っていなかったのでそのまま／new＝新しい券を残した／old＝今の券を残した／null＝まだ選んでいない
create table if not exists app_private.gacha_draws (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  draw_date   date not null,
  prize_code  text not null references app_private.gacha_prizes(code),
  created_at  timestamptz not null default now(),
  choice      text check (choice in ('auto', 'new', 'old')),
  decided_at  timestamptz,
  unique (user_id, draw_date)
);
revoke all on table app_private.gacha_draws from public, anon, authenticated;

-- いま持っているガチャ券（1会員1枚）。景品の名前・金額は出た時のまま写しておく
create table if not exists app_private.gacha_holdings (
  user_id     text primary key,
  draw_id     uuid not null references app_private.gacha_draws(id),
  prize_code  text not null references app_private.gacha_prizes(code),
  title       text not null,
  amount      int,
  free_menu   text,
  weekday_only boolean not null,
  rank        text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
revoke all on table app_private.gacha_holdings from public, anon, authenticated;

create or replace function app_private.gacha_prize_json(p app_private.gacha_prizes)
returns json language sql stable set search_path = '' as $$
  select json_build_object('code', p.code, 'title', p.title, 'amount', p.amount, 'free_menu', p.free_menu,
                           'weekday_only', p.weekday_only, 'rank', p.rank)
$$;

/** 使える持ち券（期限切れ・使用済みは持っていない扱い） */
create or replace function app_private.gacha_held_json(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object('code', h.prize_code, 'title', h.title, 'amount', h.amount, 'free_menu', h.free_menu,
                           'weekday_only', h.weekday_only, 'rank', h.rank, 'expires_at', h.expires_at)
  from app_private.gacha_holdings h
  where h.user_id = p_user and h.used_at is null and h.expires_at > now()
$$;

/** 今日の抽選と持ち券 */
create or replace function app_private.gacha_state(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'today', (select json_build_object('id', d.id, 'prize', app_private.gacha_prize_json(p), 'choice', d.choice)
              from app_private.gacha_draws d join app_private.gacha_prizes p on p.code = d.prize_code
              where d.user_id = p_user and d.draw_date = app_private.today_jst()),
    'held', app_private.gacha_held_json(p_user))
$$;

/** 券を持たせる（期限は出た日から30日・その日の終わりまで） */
create or replace function app_private.gacha_hold(p_user text, p_draw uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p app_private.gacha_prizes; v_last date := app_private.today_jst() + 30;
begin
  select pr.* into p from app_private.gacha_draws d join app_private.gacha_prizes pr on pr.code = d.prize_code where d.id = p_draw;
  insert into app_private.gacha_holdings (user_id, draw_id, prize_code, title, amount, free_menu, weekday_only, rank, expires_at)
  values (p_user, p_draw, p.code, p.title, p.amount, p.free_menu, p.weekday_only, p.rank, ((v_last + 1)::timestamp at time zone 'Asia/Tokyo'))
  on conflict (user_id) do update set draw_id = excluded.draw_id, prize_code = excluded.prize_code, title = excluded.title,
    amount = excluded.amount, free_menu = excluded.free_menu, weekday_only = excluded.weekday_only, rank = excluded.rank,
    expires_at = excluded.expires_at, used_at = null, created_at = now();
end;
$$;

/** お客様：今日のガチャと持ち券 */
create or replace function public.customer_gacha_state(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  return app_private.gacha_state(v_user);
end;
$$;

/** お客様：引く。今日もう引いていれば同じ結果を返す。券を持っていなければそのまま持たせ、持っていれば選ぶまで待つ */
create or replace function public.customer_gacha_draw(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_today date := app_private.today_jst();
        v_total numeric; v_roll numeric; v_code text; v_id uuid;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  if not exists (select 1 from app_private.gacha_draws where user_id = v_user and draw_date = v_today) then
    select sum(weight) into v_total from app_private.gacha_prizes where active and weight > 0;
    if coalesce(v_total, 0) <= 0 then return json_build_object('error', 'no_prizes'); end if;
    v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric / 281474976710656 * v_total;
    select code into v_code from (
      select code, sum(weight) over (order by sort, code) as upto from app_private.gacha_prizes where active and weight > 0
    ) c where c.upto > v_roll order by c.upto limit 1;
    if v_code is null then
      select code into v_code from app_private.gacha_prizes where active and weight > 0 order by sort desc, code desc limit 1;
    end if;
    insert into app_private.gacha_draws (user_id, draw_date, prize_code) values (v_user, v_today, v_code) returning id into v_id;
    if app_private.gacha_held_json(v_user) is null then
      perform app_private.gacha_hold(v_user, v_id);
      update app_private.gacha_draws set choice = 'auto', decided_at = now() where id = v_id;
    end if;
  end if;
  return app_private.gacha_state(v_user);
end;
$$;

/** お客様：今日の券と今の券のどちらを残すか（new＝新しい券／old＝今の券）。1回だけ */
create or replace function public.customer_gacha_keep(p_session text, p_choice text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); d app_private.gacha_draws;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice not in ('new', 'old') then return json_build_object('error', 'bad_choice'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  select * into d from app_private.gacha_draws where user_id = v_user and draw_date = app_private.today_jst();
  if d.id is null then return json_build_object('error', 'not_drawn'); end if;
  if d.choice is null then
    -- 選ぶ前に今の券が期限切れ・使用済みになっていたら、新しい券をそのまま持たせる
    if p_choice = 'new' or app_private.gacha_held_json(v_user) is null then
      perform app_private.gacha_hold(v_user, d.id);
    end if;
    update app_private.gacha_draws set choice = p_choice, decided_at = now() where id = d.id;
  end if;
  return app_private.gacha_state(v_user);
end;
$$;

revoke all on function app_private.gacha_prize_json(app_private.gacha_prizes), app_private.gacha_held_json(text),
  app_private.gacha_state(text), app_private.gacha_hold(text, uuid) from public, anon, authenticated;
revoke all on function public.customer_gacha_state(text), public.customer_gacha_draw(text), public.customer_gacha_keep(text, text) from public;
grant execute on function public.customer_gacha_state(text), public.customer_gacha_draw(text), public.customer_gacha_keep(text, text)
  to anon, authenticated, service_role;
