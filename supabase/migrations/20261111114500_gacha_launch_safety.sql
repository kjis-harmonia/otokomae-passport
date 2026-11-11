-- 2026/11/11 の解禁は正午（JST）。別の日を指定した環境は従来どおり日付で判定する。
create or replace function app_private.gacha_is_open_at(p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((
    select case when s.opens_on = date '2026-11-11'
      then p_at >= timestamptz '2026-11-11 12:00:00+09'
      else s.opens_on <= (p_at at time zone 'Asia/Tokyo')::date
    end
    from app_private.gacha_settings s where s.id = 1
  ), false)
$$;
revoke all on function app_private.gacha_is_open_at(timestamptz) from public, anon, authenticated, service_role;

create or replace function app_private.gacha_is_open()
returns boolean language sql stable set search_path = '' as $$
  select app_private.gacha_is_open_at(statement_timestamp())
$$;

-- Wait for an in-flight draw or choice without auto-claiming a pending ticket.
create or replace function public.customer_gacha_peek(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  return app_private.gacha_state(v_user);
end;
$$;
revoke all on function public.customer_gacha_peek(text) from public, anon, authenticated, service_role;
grant execute on function public.customer_gacha_peek(text) to anon, authenticated;

create or replace function public.customer_gacha_keep_checked(p_session text, p_choice text, p_draw_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_user text := app_private.session_user_id(p_session);
  d app_private.gacha_draws;
  h app_private.gacha_holdings;
  v_has_held boolean;
  v_replayed boolean := false;
  v jsonb;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice is null or p_choice not in ('new', 'old') then
    return json_build_object('error', 'bad_choice');
  end if;
  if p_draw_id is null then return json_build_object('error', 'stale_draw'); end if;

  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  d := app_private.gacha_pending(v_user);
  if d.id = p_draw_id then
    -- A concurrent void can restore a used ticket. Lock the row before testing its usability.
    select * into h from app_private.gacha_holdings where user_id = v_user for update;
    v_has_held := h.user_id is not null and h.used_at is null and h.expires_at > now();
    if p_choice = 'new' and v_has_held and (app_private.gacha_active_reservation(h.reservation_id)).id is not null then
      return json_build_object('error', 'held_reserved');
    end if;
    if p_choice = 'new' or not v_has_held then
      perform app_private.gacha_hold(v_user, d.id);
    end if;
    update app_private.gacha_draws set choice = p_choice, decided_at = now()
    where id = d.id returning * into d;
  else
    -- A newer pending draw does not change the outcome of a committed choice.
    select * into d from app_private.gacha_draws
    where id = p_draw_id and user_id = v_user and decided_at is not null and choice = p_choice;
    if d.id is null then return json_build_object('error', 'stale_draw'); end if;
    v_replayed := true;
  end if;

  v := app_private.gacha_state(v_user)::jsonb;
  -- The result panel checks today against p_draw_id. Preserve the live state separately when it differs.
  if v->'today'->>'id' is distinct from d.id::text then
    v := v || jsonb_build_object(
      'current_today', v->'today',
      'today', (select jsonb_build_object('id', d.id, 'prize', app_private.gacha_prize_json(p), 'choice', d.choice, 'draw_date', d.draw_date)
                from app_private.gacha_prizes p where p.code = d.prize_code));
  end if;
  if v_replayed then v := v || jsonb_build_object('replayed', true); end if;
  return v::json;
end;
$$;
revoke all on function public.customer_gacha_keep_checked(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.customer_gacha_keep_checked(text, text, uuid) to anon, authenticated;

-- Cached clients cannot prove which pending draw they are confirming.
create or replace function public.customer_gacha_keep(p_session text, p_choice text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session);
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  if p_choice is null or p_choice not in ('new', 'old') then
    return json_build_object('error', 'bad_choice');
  end if;
  perform pg_advisory_xact_lock(hashtext('gacha:' || v_user));
  if (app_private.gacha_pending(v_user)).id is not null then
    return json_build_object('error', 'stale_draw');
  end if;
  return app_private.gacha_state(v_user);
end;
$$;
