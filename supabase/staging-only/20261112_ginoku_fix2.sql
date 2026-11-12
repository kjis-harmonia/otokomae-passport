-- 銀オクの直し 2（11/12・2回目の粗探し）。Staging だけ。20261112_ginoku_free_and_hold.sql のあとに流す
--   1. 額があってメニューが決まっている景品は出品できない（メニューを問わない割引券になってしまうため）
--   2. 店の会計の情報に、銀オクの入札で押さえている額を足す（auction_held）。本番にもある app_private.checkout_context_json を Staging で置き換える
-- 戻すとき：20261112_ginoku_fix2_off.sql
set check_function_bodies = off;

create or replace function public.staff_ginoku_create(
  p_staff text, p_prize_code text, p_start_price integer, p_ends_at timestamptz,
  p_buy_now_price integer default null, p_title text default null, p_ticket_amount integer default null,
  p_starts_at timestamptz default null, p_increment integer default 100, p_staff_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare p app_private.gacha_prizes; a app_private.ginoku_auctions; v_amount integer; v_free boolean; v_start timestamptz := coalesce(p_starts_at, now());
begin
  perform app_private.assert_staff(p_staff);
  select * into p from app_private.gacha_prizes where code = p_prize_code;
  if p.code is null then return json_build_object('error', 'prize_not_found'); end if;
  if p_start_price is null then return json_build_object('error', 'invalid_value'); end if;
  v_free := p.amount is null and p.menu_codes is not null and cardinality(p.menu_codes) > 0 and p.free_menu is not null;
  -- 額があってメニューが決まっている景品（テイテイ刈り1,000円引きなど）は、メニューを問わない割引券になってしまうので出品できない（11/12 粗探し）
  if not v_free and p.menu_codes is not null and cardinality(p.menu_codes) > 0 then return json_build_object('error', 'menu_discount_not_supported'); end if;
  if v_free then
    -- 無料券の値引きはその日のメニューの料金。額は付けられない
    if p_ticket_amount is not null then return json_build_object('error', 'invalid_value'); end if;
    v_amount := null;
  else
    v_amount := coalesce(p_ticket_amount, p.amount);
    if v_amount is null or v_amount <= 0 then return json_build_object('error', 'ticket_amount_required'); end if;
  end if;
  if p_ends_at is null or p_ends_at <= greatest(v_start, now()) + interval '10 minutes' or p_ends_at > v_start + interval '30 days' then
    return json_build_object('error', 'invalid_ends_at');
  end if;
  insert into app_private.ginoku_auctions (prize_code, title, rank, ticket_amount, free_menu, menu_codes, weekday_only, start_price, increment,
    buy_now_price, starts_at, ends_at, original_ends_at, created_by)
  values (p.code, coalesce(nullif(btrim(p_title), ''), case when v_free then p.free_menu || '無料券' else p.title || '券' end), p.rank,
    v_amount, case when v_free then p.free_menu end, case when v_free then p.menu_codes end, p.weekday_only, p_start_price,
    coalesce(p_increment, 100), p_buy_now_price, v_start, p_ends_at, p_ends_at, coalesce(nullif(btrim(p_staff_name), ''), 'staff'))
  returning * into a;
  return app_private.ginoku_json(a, null)::json;
exception when check_violation or not_null_violation then
  return json_build_object('error', 'invalid_value');
end;
$$;

CREATE OR REPLACE FUNCTION app_private.checkout_context_json(p_reservation_id uuid, p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_client uuid; v_paid uuid;
begin
  if p_reservation_id is not null then
    select * into r from public.reservations where id = p_reservation_id;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    v_client := app_private.client_root(r.client_id);
    select id into v_paid from public.accounting_sessions where reservation_id = r.id and status = 'completed';
  elsif p_client_id is not null then
    v_client := app_private.client_root(p_client_id);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;
  return jsonb_build_object(
    'reservation', case when r.id is null then null else app_private.reservation_json(r.id) end,
    'paid_sale_id', v_paid,
    'client', case when v_client is null then null else (select jsonb_build_object('id', c.id, 'name', c.display_name,
                'app_linked', cardinality(app_private.client_members(app_private.client_family(c.id))) > 0)
              from public.clients c where c.id = v_client) end,
    'gacha', app_private.gacha_for_reservation(r.id),
    'tickets', case when v_client is null then '[]'::jsonb else app_private.client_tickets_json(v_client) end,
    'ginpay_accounts', case when v_client is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'client_name', c.display_name, 'balance', a.balance_cached,
         -- 銀オクの入札で押さえている額（Staging だけ）：店の会計画面で「足りる」と誤って出さないように
         'auction_held', coalesce((select sum(g.amount) from app_private.ginoku_holds g join app_private.ginoku_auctions x on x.id = g.auction_id where g.account_id = a.id and g.status = 'held' and x.status = 'open'), 0),
                 'is_current_client', a.client_id = v_client) order by (a.client_id = v_client) desc, a.created_at), '[]'::jsonb)
       from public.ginpay_accounts a join public.clients c on c.id = a.client_id
       where a.id = any(app_private.ginpay_family_accounts(v_client))) end,
    -- 有効な口座がなく停止中の口座だけがある（会計画面で「口座がありません」と誤って案内しない）
    'ginpay_suspended', v_client is not null and exists (select 1 from public.ginpay_accounts a
      where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended'),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name) order by m.sort_order), '[]'::jsonb)
              from public.staff_members m where m.is_active and (m.is_bookable or m.id = r.staff_id)),
    'tax', (select jsonb_build_object('mode', tax_mode, 'rate', tax_rate) from public.accounting_settings where id = 1)
  );
end;
$function$;

notify pgrst, 'reload schema';
