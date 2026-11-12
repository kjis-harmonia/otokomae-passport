-- 銀オクの直し 1（11/12・粗探しの結果と慶一郎さんの決め）。Staging だけ。20261112_ginoku.sql のあとに流す
--   1. 落札の引き落としは、店・本部の「取消」「返金」で戻せない（券が残ったまま銀Payだけ戻っていた）
--   2. 精算は1件ずつ受け止める：1件で例外が出ても、ほかの精算・一覧は止めない（次の回にもう一度）
--   3. 「平日のみ」の落札券は、土日・祝日の予約には付けられない（慶一郎さん「券を利用した土日予約はできないようにする」）
--   4. 開始前の出品は、詳細でも見せない
--   5. 出品：終了は「今」からも10分以上先・開始価格が無いときは invalid_value
-- 戻すとき：20261112_ginoku_fix1_off.sql
set check_function_bodies = off;

-- 1. 取消・返金の止め（台帳に入る前に断る）
create or replace function app_private.ginoku_block_reverse()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type in ('void', 'refund') and new.original_transaction_id is not null and exists (
    select 1 from public.ginpay_transactions o where o.id = new.original_transaction_id and o.idempotency_key like 'ginoku:%') then
    raise exception 'ginoku_no_reverse' using hint = '銀オクの支払いは取り消せません（券と一緒に本部で対応してください）';
  end if;
  return new;
end;
$$;
drop trigger if exists ginoku_block_reverse on public.ginpay_transactions;
create trigger ginoku_block_reverse before insert on public.ginpay_transactions
  for each row execute function app_private.ginoku_block_reverse();

-- 2. 精算を1件ずつ受け止める（デッドロック・ロック待ちの打ち切り・状態のずれも、その1件だけ次の回に）
create or replace function app_private.ginoku_settle_due()
returns integer language plpgsql set search_path = '' as $$
declare v_id uuid; v_n integer := 0; v_status text;
begin
  for v_id in select id from app_private.ginoku_auctions where status = 'open' and ends_at <= now() order by ends_at limit 50 loop
    begin
      v_status := app_private.ginoku_settle(v_id, false);
      if v_status in ('sold', 'unsold') then v_n := v_n + 1; end if;
    exception when others then
      raise warning 'ginoku_settle % failed: %', v_id, sqlerrm;
    end;
  end loop;
  return v_n;
end;
$$;

create or replace function public.customer_ginoku_list(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.ginoku_session_user(p_session);
begin
  -- 締めるのはついで。失敗しても一覧は出す（締めは cron と次の回）
  begin perform app_private.ginoku_settle_due(); exception when others then null; end;
  return json_build_object(
    'now', now(),
    'signed_in', v_user is not null,
    'wallet', app_private.ginoku_wallet_public(v_user),
    'auctions', coalesce((
      select jsonb_agg(app_private.ginoku_json(a, v_user) order by (a.status = 'open') desc,
                       case when a.status = 'open' then a.ends_at end asc, a.ends_at desc)
      from app_private.ginoku_auctions a
      where a.starts_at <= now() and a.status <> 'cancelled'
        and (a.status = 'open' or a.ends_at > now() - interval '1 day'
             or (a.winner_user = v_user and a.ends_at > now() - interval '7 days'))), '[]'::jsonb));
end;
$$;

create or replace function public.customer_ginoku_detail(p_session text, p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.ginoku_session_user(p_session); v jsonb;
begin
  -- 終わったものだけ締める（開催中の詳細を開いただけで行をロックしない）
  if exists (select 1 from app_private.ginoku_auctions where id = p_id and status = 'open' and ends_at <= now()) then
    begin perform app_private.ginoku_settle(p_id, true); exception when others then null; end;
  end if;
  v := app_private.ginoku_detail_json(p_id, v_user);
  if v is null then return json_build_object('error', 'not_found'); end if;
  return v::json;
end;
$$;

-- 4. 開始前は見せない
create or replace function app_private.ginoku_detail_json(p_id uuid, p_user text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'now', now(),
    'signed_in', p_user is not null,
    'wallet', app_private.ginoku_wallet_public(p_user),
    'auction', app_private.ginoku_json(a, p_user),
    'bids', coalesce((
      select jsonb_agg(jsonb_build_object('amount', x.amount, 'at', x.created_at, 'mine', x.user_id = p_user,
                                          'bidder', '入札者' || n.k::text) order by x.amount desc, x.created_at)
      from (select * from app_private.ginoku_bids where auction_id = a.id order by amount desc, created_at limit 20) x
      join (select user_id, row_number() over (order by min(created_at)) as k from app_private.ginoku_bids
            where auction_id = a.id group by user_id) n on n.user_id = x.user_id), '[]'::jsonb))
  from app_private.ginoku_auctions a where a.id = p_id and a.status <> 'cancelled' and a.starts_at <= now()
$$;

-- 5. 出品の確かめ
create or replace function public.staff_ginoku_create(
  p_staff text, p_prize_code text, p_start_price integer, p_ends_at timestamptz,
  p_buy_now_price integer default null, p_title text default null, p_ticket_amount integer default null,
  p_starts_at timestamptz default null, p_increment integer default 100, p_staff_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare p app_private.gacha_prizes; a app_private.ginoku_auctions; v_amount integer; v_start timestamptz := coalesce(p_starts_at, now());
begin
  perform app_private.assert_staff(p_staff);
  select * into p from app_private.gacha_prizes where code = p_prize_code;
  if p.code is null then return json_build_object('error', 'prize_not_found'); end if;
  if p_start_price is null then return json_build_object('error', 'invalid_value'); end if;
  v_amount := coalesce(p_ticket_amount, p.amount);
  if v_amount is null or v_amount <= 0 then return json_build_object('error', 'ticket_amount_required'); end if;
  if p_ends_at is null or p_ends_at <= greatest(v_start, now()) + interval '10 minutes' or p_ends_at > v_start + interval '30 days' then
    return json_build_object('error', 'invalid_ends_at');
  end if;
  insert into app_private.ginoku_auctions (prize_code, title, rank, ticket_amount, weekday_only, start_price, increment,
    buy_now_price, starts_at, ends_at, original_ends_at, created_by)
  values (p.code, coalesce(nullif(btrim(p_title), ''), p.title || '券'), p.rank, v_amount, p.weekday_only, p_start_price,
    coalesce(p_increment, 100), p_buy_now_price, v_start, p_ends_at, p_ends_at, coalesce(nullif(btrim(p_staff_name), ''), 'staff'))
  returning * into a;
  return app_private.ginoku_json(a, null)::json;
exception when check_violation or not_null_violation then
  return json_build_object('error', 'invalid_value');
end;
$$;

-- 3. 「平日のみ」の落札券は、土日・祝日の予約に付けない
create or replace function app_private.ginoku_offday(p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select extract(isodow from (p_at at time zone 'Asia/Tokyo')) in (6, 7)
      or exists (select 1 from app_private.holidays h where h.day = (p_at at time zone 'Asia/Tokyo')::date)
$$;
create or replace function app_private.ginoku_weekday_ticket(p_ticket uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from app_private.ginoku_auctions a where a.ticket_id = p_ticket and a.weekday_only)
$$;

-- 本番にもある関数を Staging で置き換える（中身は Staging の今の定義のまま、平日のみの確かめだけ足す）
create or replace function public.customer_set_ticket_plan(p_session text, p_reservation_id uuid, p_ticket_ids uuid[])
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); v_ids uuid[]; v_at timestamptz;
begin
  select r.starts_at into v_at from public.reservations r where r.id = p_reservation_id and r.user_id = v_user and r.status = 'confirmed' for no key update;
  if v_at is null then
    return json_build_object('error', 'not_found');
  end if;
  select coalesce(array_agg(distinct t.id), '{}') into v_ids from public.tickets t
  where t.id = any(coalesce(p_ticket_ids, '{}')) and t.user_id = any(app_private.ticket_family_uids(v_user)) and not t.used
    and cardinality(p_ticket_ids) <= 30;
  if cardinality(v_ids) = 0 then
    delete from app_private.reservation_ticket_plans where reservation_id = p_reservation_id;
    return json_build_object('ok', true, 'count', 0);
  end if;
  -- 銀オクの「平日のみ」の券は、土日・祝日の予約には付けない（11/12 慶一郎さん）
  if app_private.ginoku_offday(v_at) and exists (select 1 from unnest(v_ids) i where app_private.ginoku_weekday_ticket(i)) then
    return json_build_object('error', 'weekday_only');
  end if;
  insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) values (p_reservation_id, v_user, v_ids)
  on conflict (reservation_id) do update set ticket_ids = excluded.ticket_ids, user_id = excluded.user_id, created_at = now();
  return json_build_object('ok', true, 'count', cardinality(v_ids));
end;
$$;

revoke all on function app_private.ginoku_block_reverse() from public;
revoke all on function app_private.ginoku_offday(timestamptz) from public;
revoke all on function app_private.ginoku_weekday_ticket(uuid) from public;

notify pgrst, 'reload schema';
