-- 選ばれていない当選は日付が変わっても消さない（11/3 慶一郎さん・ジョニーの指摘：23:58 に銀パラ無料が出て選ばずに閉じたら 0 時で消えていた）
--   ・「選ぶ対象」は日付に関係なく、まだ選んでいない最後の当選（gacha_pending）
--   ・選んでいない当選があるうちは新しく引かない。先にどちらを残すか選んでもらう（翌日の抽選と重ならない）
--   ・今の券の期限が切れていたら、選ぶ時に新しい券をそのまま持たせる（customer_gacha_keep の既存の動き）

create or replace function app_private.gacha_pending(p_user text)
returns app_private.gacha_draws language sql stable set search_path = '' as $$
  select * from app_private.gacha_draws where user_id = p_user and choice is null order by created_at desc limit 1
$$;

-- today：選んでいない当選があればそれ、無ければ今日の最後の1回
create or replace function app_private.gacha_state(p_user text)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'today', (select json_build_object('id', d.id, 'prize', app_private.gacha_prize_json(p), 'choice', d.choice, 'draw_date', d.draw_date)
              from (select * from app_private.gacha_pending(p_user) union all select * from app_private.gacha_today(p_user)) d
              join app_private.gacha_prizes p on p.code = d.prize_code
              where d.id is not null limit 1),
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

create or replace function public.customer_gacha_keep(p_session text, p_choice text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); d app_private.gacha_draws;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice not in ('new', 'old') then return json_build_object('error', 'bad_choice'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  d := app_private.gacha_pending(v_user);
  if d.id is not null then
    if p_choice = 'new' or app_private.gacha_held_json(v_user) is null then
      perform app_private.gacha_hold(v_user, d.id);
    end if;
    update app_private.gacha_draws set choice = p_choice, decided_at = now() where id = d.id;
  end if;
  return app_private.gacha_state(v_user);
end;
$$;

revoke all on function app_private.gacha_pending(text) from public, anon, authenticated;
