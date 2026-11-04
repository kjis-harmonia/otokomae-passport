-- ガチャの解禁日（11/5 慶一郎さん「ガチャ解禁は11/11って決まってる」）
-- 本番はこの日より前は抽選しない（画面も「準備中」）。Staging は試すので、入れたあとに過去の日へ変える
alter table app_private.gacha_settings add column if not exists opens_on date not null default date '2026-11-11';

create or replace function app_private.gacha_is_open() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.opens_on <= app_private.today_jst() from app_private.gacha_settings s where s.id = 1), false)
$$;
revoke all on function app_private.gacha_is_open() from public, anon, authenticated;

create or replace function public.customer_gacha_draw(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_today date := app_private.today_jst();
        v_total numeric; v_roll numeric; v_code text; v_id uuid;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if not app_private.gacha_is_open() then return json_build_object('error', 'not_open'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  perform app_private.gacha_settle(v_user);
  -- 選んでいない当選があるうちは引かずに、それを返す（画面はどちらを残すかを出す）
  if (app_private.gacha_pending(v_user)).id is not null then return app_private.gacha_state(v_user); end if;
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
