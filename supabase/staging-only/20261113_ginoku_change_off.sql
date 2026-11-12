-- 20261113_ginoku_change.sql を戻す（Staging の元の定義）
CREATE OR REPLACE FUNCTION app_private.change_effects(p_old uuid, p_starts timestamp with time zone, p_codes text[], p_new_total integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare r public.reservations; v_ids uuid[]; v_keep uuid[] := '{}'; v_drop jsonb := '[]'; t public.tickets; h app_private.gacha_holdings;
        v_gacha_keep boolean := null; v_gacha_why text; v_hold app_private.ginpay_holds; v_comp boolean; v_perm boolean;
begin
  select * into r from public.reservations where id = p_old;
  v_comp := app_private.res_is_companion(r.companion_id, r.companion_of, r.note);
  v_perm := exists (select 1 from unnest(p_codes) c where c ~ '^(perm|set)-');
  -- 割引券の予定（予約に付けた券）
  select ticket_ids into v_ids from app_private.reservation_ticket_plans where reservation_id = p_old;
  for t in select * from public.tickets where id = any(coalesce(v_ids, '{}')) order by id loop
    if t.used then v_drop := v_drop || jsonb_build_object('title', t.title, 'why', 'used');
    elsif t.expires_at is not null and t.expires_at <= p_starts then v_drop := v_drop || jsonb_build_object('title', t.title, 'why', 'expired');
    elsif app_private.is_perm_coupon(t) and (v_comp or not v_perm or app_private.gacha_offday(p_starts)) then
      v_drop := v_drop || jsonb_build_object('title', t.title, 'why', case when v_comp then 'owner_only' when not v_perm then 'menu' else 'weekday' end);
    else v_keep := v_keep || t.id; end if;
  end loop;
  -- ガチャ券
  select * into h from app_private.gacha_holdings where reservation_id = p_old and used_at is null;
  if h.user_id is not null then
    v_gacha_why := case
      when h.expires_at <= p_starts then 'expired'
      when h.weekday_only and app_private.gacha_offday(p_starts) then 'weekday'
      when v_comp and (h.free_menu is null or h.self_only) then 'owner_only'
      when h.menu_codes is not null and not (p_codes && h.menu_codes) then 'menu'
      when h.menu_codes is null and not exists (select 1 from unnest(p_codes) c where c <> 'maintenance') then 'menu'
      else null end;
    v_gacha_keep := v_gacha_why is null;
  end if;
  -- 銀Pay の押さえ
  select * into v_hold from app_private.ginpay_holds where reservation_id = p_old and status = 'held' order by updated_at desc limit 1;
  return jsonb_build_object(
    'tickets_keep', to_jsonb(v_keep), 'tickets_drop', v_drop,
    'gacha', case when h.user_id is null then null else jsonb_build_object('title', h.title, 'keep', v_gacha_keep, 'why', v_gacha_why) end,
    'ginpay_before', coalesce(v_hold.amount, 0),
    'ginpay_after', case when v_hold.id is null then 0 when p_new_total is null then v_hold.amount else least(v_hold.amount, greatest(p_new_total, 0)) end,
    'ginpay_account', v_hold.account_id);
end;
$function$;
