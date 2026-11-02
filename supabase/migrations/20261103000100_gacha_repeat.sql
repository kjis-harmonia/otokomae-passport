-- ガチャの「何回でも」スイッチ（11/3 慶一郎さん「staging は何回もガチャ引けるようにして」）
--   app_private.gacha_settings.repeat：false＝1日1回（本番）／true＝何回でも引ける（Staging の試し用）
--   何回でもの時は、引くたびに新しい記録を作る。今日の結果・選ぶ対象は「今日の最後の1回」

create table if not exists app_private.gacha_settings (
  id     int primary key default 1 check (id = 1),
  repeat boolean not null default false
);
insert into app_private.gacha_settings (id) values (1) on conflict do nothing;
revoke all on table app_private.gacha_settings from public, anon, authenticated;

-- 1日1回の決まりを表の制約から外し、関数で守る
alter table app_private.gacha_draws drop constraint if exists gacha_draws_user_id_draw_date_key;
-- 同じ処理の中で続けて引いても順番が分かるよう、記録の時刻は呼んだ瞬間の時刻にする
alter table app_private.gacha_draws alter column created_at set default clock_timestamp();
create index if not exists gacha_draws_user_day on app_private.gacha_draws (user_id, draw_date, created_at desc);

create or replace function app_private.gacha_repeat()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select repeat from app_private.gacha_settings where id = 1), false)
$$;

create or replace function app_private.gacha_today(p_user text)
returns app_private.gacha_draws language sql stable set search_path = '' as $$
  select * from app_private.gacha_draws where user_id = p_user and draw_date = app_private.today_jst() order by created_at desc limit 1
$$;

create or replace function app_private.gacha_state(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'today', (select json_build_object('id', d.id, 'prize', app_private.gacha_prize_json(p), 'choice', d.choice)
              from app_private.gacha_today(p_user) d join app_private.gacha_prizes p on p.code = d.prize_code
              where d.id is not null),
    'held', app_private.gacha_held_json(p_user),
    'repeat', app_private.gacha_repeat())
$$;

create or replace function public.customer_gacha_draw(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_today date := app_private.today_jst();
        v_total numeric; v_roll numeric; v_code text; v_id uuid;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  if app_private.gacha_repeat() or not exists (select 1 from app_private.gacha_draws where user_id = v_user and draw_date = v_today) then
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

create or replace function public.customer_gacha_keep(p_session text, p_choice text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); d app_private.gacha_draws;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice not in ('new', 'old') then return json_build_object('error', 'bad_choice'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  d := app_private.gacha_today(v_user);
  if d.id is null then return json_build_object('error', 'not_drawn'); end if;
  if d.choice is null then
    if p_choice = 'new' or app_private.gacha_held_json(v_user) is null then
      perform app_private.gacha_hold(v_user, d.id);
    end if;
    update app_private.gacha_draws set choice = p_choice, decided_at = now() where id = d.id;
  end if;
  return app_private.gacha_state(v_user);
end;
$$;

revoke all on function app_private.gacha_repeat(), app_private.gacha_today(text) from public, anon, authenticated;
