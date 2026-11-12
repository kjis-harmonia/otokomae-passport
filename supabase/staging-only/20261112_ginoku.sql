-- 銀二郎オークション【銀オク】（Staging だけ・11/12）
-- 本番には入れない。適用は Staging（kfufxzmucjljjouzpumi）だけ：
--   npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku.sql
-- 戻すとき：20261112_ginoku_off.sql
--
-- 決まりごと（慶一郎さん）
--   ・出品はお店だけ（staff_ginoku_create）。品物はガチャ券（app_private.gacha_prizes の景品）
--   ・支払いは銀Pay だけ。入札できるのは、そのときの「使える残高（残高 − 予約の仮支払い）」が入札額以上のとき
--   ・終了時刻に最高額の方の銀Pay から引き落とし、券をすぐウォレットへ。残高が足りなければ次に高い方、…。誰も払えなければ流札
--   ・即決価格を押すと、その場で引き落とし＋券の発行で終了
--   ・終了5分前からの入札で、終了を5分延ばす
--
-- お金と券の正しさ
--   ・引き落としは既存の台帳（app_private.ginpay_record_transaction）に「マイナスの調整（adjustment）」として記録する。
--     残高・利用履歴・HQ の監査はそのまま整合する。残高が負になる・予約の仮支払いの分まで使うことは台帳側が拒む。
--     冪等キーは 'ginoku:<オークションID>'＝1つのオークションで引き落としは必ず1回だけ（二重に精算しても二重に引かない）
--   ・券は public.tickets に割引券（discount）として発行（チケットウォレットに出る）。ガチャの持ち券（gacha_holdings）には入れない
--   ・入札・即決・精算はオークションの行ロック（for update）で1本ずつ。精算は終わったものを見たときに必ず行う（遅延精算）＋
--     cron（app_private.ginoku_settle_due）
set check_function_bodies = off;

create table if not exists app_private.ginoku_auctions (
  id uuid primary key default gen_random_uuid(),
  prize_code text references app_private.gacha_prizes(code),
  title text not null check (btrim(title) <> ''),
  rank text not null default 'normal' check (rank in ('normal', 'rare', 'legend')),
  ticket_amount integer not null check (ticket_amount > 0 and ticket_amount <= 100000),
  ticket_days integer not null default 30 check (ticket_days between 1 and 365),
  weekday_only boolean not null default true,
  note text,
  start_price integer not null check (start_price > 0 and start_price <= 1000000),
  increment integer not null default 100 check (increment > 0 and increment <= 100000),
  buy_now_price integer check (buy_now_price is null or (buy_now_price > start_price and buy_now_price <= 1000000)),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  original_ends_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'sold', 'unsold', 'cancelled')),
  current_price integer,
  bid_count integer not null default 0,
  leader_user text,
  winner_user text,
  final_price integer,
  sold_via text check (sold_via in ('bid', 'buy_now')),
  settled_at timestamptz,
  ticket_id uuid,
  ginpay_tx_id uuid,
  settle_log jsonb not null default '[]'::jsonb,
  created_by text not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((status = 'sold') = (winner_user is not null and final_price is not null and ticket_id is not null and ginpay_tx_id is not null))
);
create index if not exists ginoku_auctions_open_idx on app_private.ginoku_auctions (ends_at) where status = 'open';

create table if not exists app_private.ginoku_bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references app_private.ginoku_auctions(id) on delete cascade,
  user_id text not null,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index if not exists ginoku_bids_auction_idx on app_private.ginoku_bids (auction_id, amount desc, created_at);
create index if not exists ginoku_bids_user_idx on app_private.ginoku_bids (user_id, created_at desc);

alter table app_private.ginoku_auctions enable row level security;
alter table app_private.ginoku_bids enable row level security;
revoke all on app_private.ginoku_auctions, app_private.ginoku_bids from public, anon, authenticated;

-- 次に入札できる最低額（入札が無ければ開始価格）
create or replace function app_private.ginoku_min_bid(a app_private.ginoku_auctions)
returns integer language sql immutable set search_path = '' as $$
  select case when a.current_price is null then a.start_price else a.current_price + a.increment end
$$;

-- 会員の銀Pay：口座と使える額（残高 − 予約の仮支払い）。口座が無い・複数・停止中は null
create or replace function app_private.ginoku_wallet(p_user text, p_lock boolean default false)
returns jsonb language plpgsql set search_path = '' as $$
declare v_client uuid := app_private.user_client(p_user); v_res jsonb; v_acc public.ginpay_accounts;
begin
  if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  v_res := app_private.ginpay_resolve_account(v_client, null, false, 'customer', null);
  if v_res ? 'error' then return v_res; end if;
  if p_lock then
    select * into v_acc from public.ginpay_accounts where id = (v_res->>'account_id')::uuid for update;
  else
    select * into v_acc from public.ginpay_accounts where id = (v_res->>'account_id')::uuid;
  end if;
  if v_acc.status <> 'active' then return jsonb_build_object('error', 'account_not_active'); end if;
  return jsonb_build_object('account_id', v_acc.id, 'balance', v_acc.balance_cached,
    'available', greatest(v_acc.balance_cached - app_private.ginpay_held_sum(v_acc.id), 0));
end;
$$;

-- 引き落としと券の発行（呼び出し側がオークションの行をロック済み・status = 'open' であること）。
-- 払えなければ何も書かずに {error} を返す（次の方へ回すため）
create or replace function app_private.ginoku_charge_and_issue(p_id uuid, p_user text, p_price integer, p_via text)
returns jsonb language plpgsql set search_path = '' as $$
declare a app_private.ginoku_auctions; w jsonb; v_tx jsonb; v_ticket uuid; v_expires timestamptz;
begin
  select * into a from app_private.ginoku_auctions where id = p_id;
  if a.id is null or a.status <> 'open' then return jsonb_build_object('error', 'not_open'); end if;
  -- 口座の行ロック（予約の仮支払い・会計と同時に動かない）。台帳側でも同じ口座をロックし、負の残高・仮支払いの食い込みを拒む
  w := app_private.ginoku_wallet(p_user, true);
  if w ? 'error' then return w; end if;
  if (w->>'available')::integer < p_price then
    return jsonb_build_object('error', 'insufficient_balance', 'available', (w->>'available')::integer);
  end if;
  v_tx := app_private.ginpay_record_transaction(
    (w->>'account_id')::uuid, 'adjustment', -p_price, 'posted', null, null, null, null, null,
    'system', '銀オク', '銀オク落札：' || a.title, case p_via when 'buy_now' then '即決' else '落札' end,
    'ginoku:' || a.id::text, null,
    jsonb_build_object('ginoku_auction_id', a.id, 'via', p_via, 'user_id', p_user));
  if v_tx ? 'error' then return v_tx; end if;
  if coalesce((v_tx->>'idempotent')::boolean, false) then
    -- 同じオークションの引き落としがもう台帳にある＝状態がずれている。二重には引かず止める
    raise exception 'ginoku_already_charged';
  end if;
  v_expires := ((app_private.today_jst() + a.ticket_days + 1)::timestamp at time zone 'Asia/Tokyo');
  insert into public.tickets (user_id, type, title, amount, memo, issued_by, used, expires_at)
  values (p_user, 'discount', a.title, a.ticket_amount,
          '銀オクで' || case p_via when 'buy_now' then '即決' else '落札' end || '・' || case when a.weekday_only then '平日のみ' else '曜日を問わず' end,
          '銀オク', false, v_expires)
  returning id into v_ticket;
  update app_private.ginoku_auctions
  set status = 'sold', winner_user = p_user, final_price = p_price, sold_via = p_via, settled_at = now(),
      ticket_id = v_ticket, ginpay_tx_id = (v_tx->>'id')::uuid, updated_at = now(),
      current_price = case when p_via = 'buy_now' then p_price else current_price end,
      leader_user = case when p_via = 'buy_now' then p_user else leader_user end
  where id = a.id;
  return jsonb_build_object('ok', true, 'ticket_id', v_ticket, 'transaction_id', v_tx->>'id', 'balance', (v_tx->>'balance')::integer);
end;
$$;

-- 精算：終わったオークションを1回だけ締める。p_wait = false なら、ほかで処理中のものは飛ばす
create or replace function app_private.ginoku_settle(p_id uuid, p_wait boolean default true)
returns text language plpgsql set search_path = '' as $$
declare a app_private.ginoku_auctions; b record; r jsonb; v_log jsonb := '[]'::jsonb;
begin
  if p_wait then
    select * into a from app_private.ginoku_auctions where id = p_id for update;
  else
    select * into a from app_private.ginoku_auctions where id = p_id for update skip locked;
  end if;
  if a.id is null then return 'busy'; end if;
  if a.status <> 'open' then return a.status; end if;
  if a.ends_at > now() then return 'open'; end if;
  -- 入札した方ごとの最高額で、高い順（同じ額なら先に入れた方）
  for b in
    select user_id, max(amount) as amount
    from app_private.ginoku_bids where auction_id = a.id
    group by user_id
    order by max(amount) desc, min(created_at) asc
  loop
    r := app_private.ginoku_charge_and_issue(a.id, b.user_id, b.amount, 'bid');
    if coalesce((r->>'ok')::boolean, false) then
      update app_private.ginoku_auctions set settle_log = settle_log || v_log where id = a.id;
      return 'sold';
    end if;
    v_log := v_log || jsonb_build_array(jsonb_build_object('user_id', b.user_id, 'amount', b.amount, 'error', r->>'error', 'at', now()));
  end loop;
  update app_private.ginoku_auctions
  set status = 'unsold', settled_at = now(), settle_log = settle_log || v_log, updated_at = now()
  where id = a.id;
  return 'unsold';
end;
$$;

-- cron から呼ぶ：終わったのに締めていないものをすべて締める（ほかで処理中のものは次の回）
create or replace function app_private.ginoku_settle_due()
returns integer language plpgsql set search_path = '' as $$
declare v_id uuid; v_n integer := 0; v_status text;
begin
  for v_id in select id from app_private.ginoku_auctions where status = 'open' and ends_at <= now() order by ends_at limit 50 loop
    v_status := app_private.ginoku_settle(v_id, false);
    if v_status in ('sold', 'unsold') then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;

-- お客様に見せる形（入札した方の ID は出さない）
create or replace function app_private.ginoku_json(a app_private.ginoku_auctions, p_user text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'title', a.title, 'prize_code', a.prize_code, 'rank', a.rank,
    'ticket_amount', a.ticket_amount, 'ticket_days', a.ticket_days, 'weekday_only', a.weekday_only, 'note', a.note,
    'start_price', a.start_price, 'increment', a.increment, 'buy_now_price', a.buy_now_price,
    'current_price', a.current_price, 'min_bid', app_private.ginoku_min_bid(a), 'bid_count', a.bid_count,
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'extended', a.ends_at > a.original_ends_at,
    'status', case when a.status = 'open' and a.ends_at <= now() then 'ending' else a.status end,
    'sold_via', a.sold_via, 'final_price', a.final_price,
    'my_bid', (select max(x.amount) from app_private.ginoku_bids x where x.auction_id = a.id and x.user_id = p_user),
    'mine', case
      when p_user is null then null
      when a.status = 'sold' and a.winner_user = p_user then 'won'
      when not exists (select 1 from app_private.ginoku_bids x where x.auction_id = a.id and x.user_id = p_user) then null
      when a.status = 'open' then case when a.leader_user = p_user then 'leading' else 'outbid' end
      else 'lost' end,
    'ticket_id', case when a.status = 'sold' and a.winner_user = p_user then a.ticket_id end
  )
$$;

create or replace function app_private.ginoku_session_user(p_session text)
returns text language plpgsql set search_path = '' as $$
begin
  if p_session is null or btrim(p_session) = '' then return null; end if;
  return app_private.session_user_id(p_session);
end;
$$;

create or replace function app_private.ginoku_wallet_public(p_user text)
returns jsonb language plpgsql set search_path = '' as $$
declare w jsonb;
begin
  if p_user is null then return null; end if;
  w := app_private.ginoku_wallet(p_user, false);
  if w ? 'error' then return jsonb_build_object('error', w->>'error'); end if;
  return jsonb_build_object('balance', (w->>'balance')::integer, 'available', (w->>'available')::integer);
end;
$$;

-- 一覧：開催中＋終わって1日以内＋自分が落札した7日以内。見る前に、終わったものを締める
create or replace function public.customer_ginoku_list(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.ginoku_session_user(p_session);
begin
  perform app_private.ginoku_settle_due();
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

create or replace function app_private.ginoku_detail_json(p_id uuid, p_user text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'now', now(),
    'signed_in', p_user is not null,
    'wallet', app_private.ginoku_wallet_public(p_user),
    'auction', app_private.ginoku_json(a, p_user),
    'bids', coalesce((
      select jsonb_agg(jsonb_build_object('amount', x.amount, 'at', x.created_at, 'mine', x.user_id = p_user,
                                          'bidder', '入札者' || chr(64 + least(n.k, 26)::integer)) order by x.amount desc, x.created_at)
      from (select * from app_private.ginoku_bids where auction_id = a.id order by amount desc, created_at limit 20) x
      join (select user_id, row_number() over (order by min(created_at)) as k from app_private.ginoku_bids
            where auction_id = a.id group by user_id) n on n.user_id = x.user_id), '[]'::jsonb))
  from app_private.ginoku_auctions a where a.id = p_id and a.status <> 'cancelled'
$$;

create or replace function public.customer_ginoku_detail(p_session text, p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.ginoku_session_user(p_session); v jsonb;
begin
  perform app_private.ginoku_settle(p_id, true);
  v := app_private.ginoku_detail_json(p_id, v_user);
  if v is null then return json_build_object('error', 'not_found'); end if;
  return v::json;
end;
$$;

-- 入札
create or replace function public.customer_ginoku_bid(p_session text, p_id uuid, p_amount integer)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); a app_private.ginoku_auctions; w jsonb;
        v_min integer; v_extended boolean := false;
begin
  select * into a from app_private.ginoku_auctions where id = p_id for update;
  if a.id is null or a.status = 'cancelled' or a.starts_at > now() then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'open' or a.ends_at <= now() then
    perform app_private.ginoku_settle(a.id, true);
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'ended'))::json;
  end if;
  v_min := app_private.ginoku_min_bid(a);
  if p_amount is null or p_amount < v_min then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'too_low', 'min_bid', v_min))::json;
  end if;
  if p_amount > 1000000 then return json_build_object('error', 'too_high'); end if;
  if a.buy_now_price is not null and p_amount >= a.buy_now_price then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'use_buy_now'))::json;
  end if;
  if a.leader_user = v_user then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'already_leading'))::json;
  end if;
  w := app_private.ginoku_wallet(v_user, false);
  if w ? 'error' then return json_build_object('error', w->>'error'); end if;
  if (w->>'available')::integer < p_amount then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'insufficient_balance'))::json;
  end if;
  insert into app_private.ginoku_bids (auction_id, user_id, amount, created_at) values (a.id, v_user, p_amount, clock_timestamp());
  -- 終了5分前からの入札は、終了を5分延ばす
  v_extended := a.ends_at - now() <= interval '5 minutes';
  update app_private.ginoku_auctions
  set current_price = p_amount, bid_count = bid_count + 1, leader_user = v_user, updated_at = now(),
      ends_at = case when v_extended then ends_at + interval '5 minutes' else ends_at end
  where id = a.id;
  return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('ok', true, 'extended', v_extended))::json;
end;
$$;

-- 即決：その場で引き落とし＋券を発行して終了
create or replace function public.customer_ginoku_buy_now(p_session text, p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); a app_private.ginoku_auctions; r jsonb;
begin
  select * into a from app_private.ginoku_auctions where id = p_id for update;
  if a.id is null or a.status = 'cancelled' or a.starts_at > now() then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'open' or a.ends_at <= now() then
    perform app_private.ginoku_settle(a.id, true);
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', 'ended'))::json;
  end if;
  if a.buy_now_price is null then return json_build_object('error', 'no_buy_now'); end if;
  r := app_private.ginoku_charge_and_issue(a.id, v_user, a.buy_now_price, 'buy_now');
  if not coalesce((r->>'ok')::boolean, false) then
    return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('error', r->>'error'))::json;
  end if;
  update app_private.ginoku_auctions set ends_at = least(ends_at, now()) where id = a.id;
  return (app_private.ginoku_detail_json(a.id, v_user) || jsonb_build_object('ok', true))::json;
end;
$$;

-- 出品（お店の端末・本部）。景品のコードから券の名前・額・条件を写す（名前・券の額は変えられる）
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
  v_amount := coalesce(p_ticket_amount, p.amount);
  if v_amount is null or v_amount <= 0 then return json_build_object('error', 'ticket_amount_required'); end if;
  if p_ends_at is null or p_ends_at <= v_start + interval '10 minutes' or p_ends_at > v_start + interval '30 days' then
    return json_build_object('error', 'invalid_ends_at');
  end if;
  insert into app_private.ginoku_auctions (prize_code, title, rank, ticket_amount, weekday_only, start_price, increment,
    buy_now_price, starts_at, ends_at, original_ends_at, created_by)
  values (p.code, coalesce(nullif(btrim(p_title), ''), p.title || '券'), p.rank, v_amount, p.weekday_only, p_start_price,
    coalesce(p_increment, 100), p_buy_now_price, v_start, p_ends_at, p_ends_at, coalesce(nullif(btrim(p_staff_name), ''), 'staff'))
  returning * into a;
  return app_private.ginoku_json(a, null)::json;
exception when check_violation then
  return json_build_object('error', 'invalid_value');
end;
$$;

-- 取り下げ（入札がまだ無いものだけ）
create or replace function public.staff_ginoku_cancel(p_staff text, p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare a app_private.ginoku_auctions;
begin
  perform app_private.assert_staff(p_staff);
  select * into a from app_private.ginoku_auctions where id = p_id for update;
  if a.id is null then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'open' then return json_build_object('error', 'not_open'); end if;
  if a.bid_count > 0 then return json_build_object('error', 'has_bids'); end if;
  update app_private.ginoku_auctions set status = 'cancelled', updated_at = now() where id = a.id;
  return json_build_object('ok', true);
end;
$$;

-- お店向けの一覧（落札者の会員 ID も見える）
create or replace function public.staff_ginoku_list(p_staff text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  perform app_private.ginoku_settle_due();
  return coalesce((select json_agg(app_private.ginoku_json(a, null)::jsonb || jsonb_build_object(
      'winner_user', a.winner_user, 'leader_user', a.leader_user, 'ticket_id', a.ticket_id, 'settle_log', a.settle_log)
    order by a.created_at desc)
    from app_private.ginoku_auctions a where a.created_at > now() - interval '60 days'), '[]'::json);
end;
$$;

revoke all on function app_private.ginoku_min_bid(app_private.ginoku_auctions) from public;
revoke all on function app_private.ginoku_wallet(text, boolean) from public;
revoke all on function app_private.ginoku_charge_and_issue(uuid, text, integer, text) from public;
revoke all on function app_private.ginoku_settle(uuid, boolean) from public;
revoke all on function app_private.ginoku_settle_due() from public;
revoke all on function app_private.ginoku_json(app_private.ginoku_auctions, text) from public;
revoke all on function app_private.ginoku_session_user(text) from public;
revoke all on function app_private.ginoku_wallet_public(text) from public;
revoke all on function app_private.ginoku_detail_json(uuid, text) from public;

revoke all on function public.customer_ginoku_list(text) from public;
revoke all on function public.customer_ginoku_detail(text, uuid) from public;
revoke all on function public.customer_ginoku_bid(text, uuid, integer) from public;
revoke all on function public.customer_ginoku_buy_now(text, uuid) from public;
revoke all on function public.staff_ginoku_create(text, text, integer, timestamptz, integer, text, integer, timestamptz, integer, text) from public;
revoke all on function public.staff_ginoku_cancel(text, uuid) from public;
revoke all on function public.staff_ginoku_list(text) from public;
grant execute on function public.customer_ginoku_list(text) to anon, authenticated;
grant execute on function public.customer_ginoku_detail(text, uuid) to anon, authenticated;
grant execute on function public.customer_ginoku_bid(text, uuid, integer) to anon, authenticated;
grant execute on function public.customer_ginoku_buy_now(text, uuid) to anon, authenticated;
grant execute on function public.staff_ginoku_create(text, text, integer, timestamptz, integer, text, integer, timestamptz, integer, text) to anon, authenticated;
grant execute on function public.staff_ginoku_cancel(text, uuid) to anon, authenticated;
grant execute on function public.staff_ginoku_list(text) to anon, authenticated;

-- 誰も画面を開かなくても締まるよう、1分ごとに精算（Staging はすでに pg_cron を使っている）
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'ginoku-settle';
    perform cron.schedule('ginoku-settle', '* * * * *', 'select app_private.ginoku_settle_due()');
  end if;
end $$;

notify pgrst, 'reload schema';
