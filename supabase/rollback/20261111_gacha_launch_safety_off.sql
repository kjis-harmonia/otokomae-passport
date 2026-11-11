-- Roll back 20261111114500_gacha_launch_safety.sql.
-- Original definitions from 20261105000100_gacha_opens_on.sql and
-- 20261104000300_gacha_hardening.sql at Staging base 5a2713a.
-- Coordinate with reverting the frontend that calls the new RPCs.
begin;

create or replace function app_private.gacha_is_open() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.opens_on <= app_private.today_jst() from app_private.gacha_settings s where s.id = 1), false)
$$;

create or replace function public.customer_gacha_keep(p_session text, p_choice text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); d app_private.gacha_draws; h app_private.gacha_holdings; v jsonb;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice not in ('new', 'old') then return json_build_object('error', 'bad_choice'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  d := app_private.gacha_pending(v_user);
  if d.id is not null then
    select * into h from app_private.gacha_holdings where user_id = v_user and used_at is null and expires_at > now() for update;
    if p_choice = 'new' and h.user_id is not null and (app_private.gacha_active_reservation(h.reservation_id)).id is not null then
      return json_build_object('error', 'held_reserved');
    end if;
    if p_choice = 'new' or h.user_id is null then
      perform app_private.gacha_hold(v_user, d.id);
    end if;
    update app_private.gacha_draws set choice = p_choice, decided_at = now() where id = d.id;
  end if;
  v := app_private.gacha_state(v_user)::jsonb;
  if d.id is not null and v->'today' = 'null'::jsonb then
    v := jsonb_set(v, '{today}', (select jsonb_build_object('id', x.id, 'prize', app_private.gacha_prize_json(p), 'choice', x.choice, 'draw_date', x.draw_date)
      from app_private.gacha_draws x join app_private.gacha_prizes p on p.code = x.prize_code where x.id = d.id));
  end if;
  return v::json;
end;
$$;

drop function if exists public.customer_gacha_keep_checked(text, text, uuid);
drop function if exists public.customer_gacha_peek(text);
drop function if exists app_private.gacha_is_open_at(timestamptz);

commit;
