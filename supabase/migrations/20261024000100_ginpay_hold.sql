-- ============================================================================
-- 銀Pay の仮支払い（予約のときに残高を押さえる）
--
-- - お客様が AI 予約を確定したとき、銀Pay の残高から予約の金額までを「押さえる」。台帳（ginpay_transactions）は動かさない。
-- - 本当の支払いは今までどおりレジの会計で：会員QR を読む → 予約の会計で GINPay → 確定（ginpay_pay がこのとき台帳に記録する）。
-- - 予約がキャンセル・無断キャンセルになったら押さえは消える（＝いつでも全額戻る）。会計が済んで予約が完了したら閉じる。
-- - 予約日を過ぎても会計されなかった押さえは数えない（自動で戻る）。
-- - 押さえられるのは、残高から「ほかの予約で押さえている分」を引いた残り（使える額）まで。
-- ============================================================================

create table if not exists app_private.ginpay_holds (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  account_id     uuid not null references public.ginpay_accounts(id) on delete restrict,
  amount         integer not null check (amount > 0 and amount <= 1000000),
  status         text not null default 'held' check (status in ('held', 'closed', 'released')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists ginpay_holds_one_per_reservation on app_private.ginpay_holds (reservation_id) where status = 'held';
create index if not exists ginpay_holds_account_idx on app_private.ginpay_holds (account_id) where status = 'held';
alter table app_private.ginpay_holds enable row level security;
revoke all on table app_private.ginpay_holds from public, anon, authenticated;

/** 生きている押さえ：held で、予約がまだ来店前〜会計前、予約日を過ぎていない */
create or replace function app_private.ginpay_hold_active(h app_private.ginpay_holds)
returns boolean language sql stable set search_path = '' as $$
  select h.status = 'held' and exists (
    select 1 from public.reservations r
    where r.id = h.reservation_id
      and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment')
      and r.starts_at > now() - interval '18 hours')
$$;

/** 口座で押さえている合計（p_except の予約は除く） */
create or replace function app_private.ginpay_held_sum(p_account_id uuid, p_except uuid default null)
returns integer language sql stable set search_path = '' as $$
  select coalesce(sum(h.amount), 0)::integer from app_private.ginpay_holds h
  where h.account_id = p_account_id and h.status = 'held'
    and (p_except is null or h.reservation_id <> p_except)
    and app_private.ginpay_hold_active(h)
$$;

/** 予約の状態が変わったら押さえを閉じる：キャンセル・無断キャンセル＝戻す、完了（会計済み）＝閉じる */
create or replace function app_private.ginpay_hold_follow_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('cancelled', 'no_show') then
    update app_private.ginpay_holds set status = 'released', updated_at = now() where reservation_id = new.id and status = 'held';
  elsif new.status = 'completed' then
    update app_private.ginpay_holds set status = 'closed', updated_at = now() where reservation_id = new.id and status = 'held';
  end if;
  return new;
end;
$$;
drop trigger if exists ginpay_hold_follow_reservation on public.reservations;
create trigger ginpay_hold_follow_reservation after update of status on public.reservations
  for each row when (new.status is distinct from old.status)
  execute function app_private.ginpay_hold_follow_reservation();

/** お客様：口座と使える額（残高 − 押さえている分）と、押さえている予約 */
create or replace function app_private.ginpay_hold_summary(p_client uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_res jsonb; v_acc public.ginpay_accounts;
begin
  v_res := app_private.ginpay_resolve_account(p_client, null, false, 'customer', null);
  if v_res ? 'error' then return json_build_object('error', v_res->>'error'); end if;
  select * into v_acc from public.ginpay_accounts where id = (v_res->>'account_id')::uuid;
  return json_build_object(
    'balance', v_acc.balance_cached,
    'held', app_private.ginpay_held_sum(v_acc.id),
    'available', v_acc.balance_cached - app_private.ginpay_held_sum(v_acc.id),
    'holds', coalesce((select json_agg(json_build_object('reservation_id', h.reservation_id, 'amount', h.amount) order by h.created_at)
                       from app_private.ginpay_holds h where h.account_id = v_acc.id and app_private.ginpay_hold_active(h)), '[]'::json));
end;
$$;

create or replace function public.customer_ginpay_holds(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_client uuid := app_private.user_client(app_private.session_user_id(p_session));
begin
  if v_client is null then return json_build_object('error', 'client_not_found'); end if;
  return app_private.ginpay_hold_summary(v_client);
end;
$$;

/** お客様：自分の予約に銀Pay の仮支払いを付ける（金額を変えるときも同じ）。台帳は動かさない */
create or replace function public.customer_ginpay_hold(p_session text, p_reservation_id uuid, p_amount integer)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app_private.session_user_id(p_session);
  v_client uuid := app_private.user_client(v_uid);
  r public.reservations; v_res jsonb; v_acc public.ginpay_accounts; v_avail integer;
begin
  if v_client is null then return json_build_object('error', 'client_not_found'); end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then return json_build_object('error', 'invalid_amount'); end if;
  select * into r from public.reservations where id = p_reservation_id and user_id = v_uid;
  if r.id is null or r.status <> 'confirmed' or r.starts_at <= now() then return json_build_object('error', 'not_found'); end if;
  if r.total_price is not null and p_amount > r.total_price then return json_build_object('error', 'invalid_amount'); end if;
  v_res := app_private.ginpay_resolve_account(v_client, null, false, 'customer', null);
  if v_res ? 'error' then return json_build_object('error', v_res->>'error'); end if;
  -- 同じ口座の押さえ・支払いが同時に動かないよう口座を行ロック
  select * into v_acc from public.ginpay_accounts where id = (v_res->>'account_id')::uuid for update;
  if v_acc.status <> 'active' then return json_build_object('error', 'account_not_active'); end if;
  v_avail := v_acc.balance_cached - app_private.ginpay_held_sum(v_acc.id, r.id);
  if p_amount > v_avail then return json_build_object('error', 'insufficient_balance', 'available', greatest(v_avail, 0)); end if;
  update app_private.ginpay_holds set amount = p_amount, account_id = v_acc.id, updated_at = now()
  where reservation_id = r.id and status = 'held';
  if not found then
    insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (r.id, v_acc.id, p_amount);
  end if;
  return json_build_object('reservation_id', r.id, 'amount', p_amount, 'available', v_avail - p_amount);
end;
$$;

/** お客様：仮支払いをやめる（店頭で払う） */
create or replace function public.customer_ginpay_release(p_session text, p_reservation_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  if not exists (select 1 from public.reservations where id = p_reservation_id and user_id = v_uid) then
    return json_build_object('error', 'not_found');
  end if;
  update app_private.ginpay_holds set status = 'released', updated_at = now() where reservation_id = p_reservation_id and status = 'held';
  return json_build_object('released', true);
end;
$$;

/** 店舗端末：その予約の仮支払い（会計の画面で「銀Pay 仮支払い済み」と出し、GINPay を最初から選ぶ） */
create or replace function public.staff_ginpay_hold(p_staff text, p_reservation_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare h app_private.ginpay_holds;
begin
  perform app_private.assert_staff(p_staff);
  select * into h from app_private.ginpay_holds where reservation_id = p_reservation_id and status = 'held';
  if h.id is null or not app_private.ginpay_hold_active(h) then return json_build_object('hold', null); end if;
  return json_build_object('hold', json_build_object('amount', h.amount, 'account_id', h.account_id));
end;
$$;

revoke all on function app_private.ginpay_hold_active(app_private.ginpay_holds), app_private.ginpay_held_sum(uuid, uuid),
  app_private.ginpay_hold_follow_reservation(), app_private.ginpay_hold_summary(uuid) from public, anon, authenticated;
revoke all on function public.customer_ginpay_holds(text), public.customer_ginpay_hold(text, uuid, integer),
  public.customer_ginpay_release(text, uuid), public.staff_ginpay_hold(text, uuid) from public;
grant execute on function public.customer_ginpay_holds(text), public.customer_ginpay_hold(text, uuid, integer),
  public.customer_ginpay_release(text, uuid), public.staff_ginpay_hold(text, uuid) to anon, authenticated, service_role;
