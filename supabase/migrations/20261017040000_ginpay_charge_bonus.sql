-- ============================================================================
-- GINPay チャージ特典（段階式）と、現金分・特典分の按分記録
-- ----------------------------------------------------------------------------
-- 前提：20261004000000_ginpay_ledger.sql 適用済み。追加のみ・何度実行しても同じ結果。
--
-- 決まり（2026-10-17 店と決定）：
--   * 店頭で現金を受け取り、段階に応じた特典を足す。特典に期限はない。1回の上限 50,000円。
--       5,000 → 5,250 / 10,000 → 11,000 / 20,000 → 22,500 / 30,000 → 34,500 / 50,000 → 58,500
--   * 取引ごとに「うち特典分」（bonus_amount）を持つ。現金分 = amount - bonus_amount。
--       チャージ：特典の額。支払い・マイナス調整：その時点の口座の現金残高と特典残高の割合で按分。
--       取消・返金：元の取引と同じ割合で戻す。それ以外（Stripe チャージ・プラス調整）：0（すべて現金扱い）。
--   * 按分は BEFORE INSERT のトリガーで決める（会計の確定・取消など、既存の呼び出し口はそのまま）。
--     ginpay_record_transaction が口座行を FOR UPDATE で押さえてから挿入するので、残高の読み取りは競合しない。
--   * 既存の取引は bonus_amount = 0（すべて現金）。
-- ============================================================================

alter table public.ginpay_transactions add column if not exists bonus_amount integer not null default 0;

alter table public.ginpay_transactions drop constraint if exists ginpay_transactions_bonus_amount_check;
alter table public.ginpay_transactions add constraint ginpay_transactions_bonus_amount_check
  check (bonus_amount = 0 or (sign(bonus_amount) = sign(amount) and abs(bonus_amount) <= abs(amount)));

/** チャージの段階（現金 → 特典）。段階にない金額は null */
create or replace function app_private.ginpay_charge_tiers()
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select '[{"cash":5000,"bonus":250},{"cash":10000,"bonus":1000},{"cash":20000,"bonus":2500},{"cash":30000,"bonus":4500},{"cash":50000,"bonus":8500}]'::jsonb
$$;

create or replace function app_private.ginpay_charge_bonus(p_cash integer)
returns integer language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select (t->>'bonus')::integer from jsonb_array_elements(app_private.ginpay_charge_tiers()) t where (t->>'cash')::integer = p_cash
$$;

/** 挿入する取引の「うち特典分」を決める */
create or replace function app_private.ginpay_set_bonus_part()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_total integer;
  v_bonus integer;
  v_part integer;
  v_orig public.ginpay_transactions;
begin
  new.bonus_amount := 0;
  if new.status <> 'posted' then return new; end if;

  if new.type = 'charge_store' then
    new.bonus_amount := least(greatest(coalesce((new.metadata->>'bonus')::integer, 0), 0), new.amount);
    return new;
  end if;

  if new.type in ('void', 'refund') and new.original_transaction_id is not null then
    select * into v_orig from public.ginpay_transactions where id = new.original_transaction_id;
    if v_orig.id is not null and v_orig.amount <> 0 and v_orig.bonus_amount <> 0 then
      v_part := round(v_orig.bonus_amount::numeric * new.amount / v_orig.amount)::integer;
    else
      v_part := 0;
    end if;
    if new.amount > 0 then
      new.bonus_amount := least(greatest(v_part, 0), new.amount);
      return new;
    end if;
    -- 減る向きの取消（チャージの取消など）は、下の按分と同じく残高を超えないように収める
  elsif not (new.type = 'payment' or (new.type = 'adjustment' and new.amount < 0)) then
    return new;
  end if;

  select coalesce(sum(t.amount), 0), coalesce(sum(t.bonus_amount), 0) into v_total, v_bonus
  from public.ginpay_transactions t
  where t.account_id = new.account_id and t.status = 'posted';
  if v_total <= 0 or v_bonus <= 0 then return new; end if;

  -- 支払い・マイナス調整は残高の割合で按分。減る向きの取消は元取引の割合（v_part）
  if new.type not in ('void', 'refund') then
    v_part := round(abs(new.amount)::numeric * v_bonus / v_total)::integer;
  else
    v_part := abs(v_part);
  end if;
  -- 特典残高を超えず、現金残高も超えない範囲に収める
  v_part := least(v_part, v_bonus, abs(new.amount));
  v_part := greatest(v_part, abs(new.amount) - (v_total - v_bonus), 0);
  new.bonus_amount := -v_part;
  return new;
end;
$$;

drop trigger if exists ginpay_transactions_bonus_part on public.ginpay_transactions;
create trigger ginpay_transactions_bonus_part
  before insert on public.ginpay_transactions
  for each row execute function app_private.ginpay_set_bonus_part();

create or replace function app_private.ginpay_bonus_sum(p_account_id uuid)
returns integer language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(sum(t.bonus_amount), 0)::integer
  from public.ginpay_transactions t
  where t.account_id = p_account_id and t.status = 'posted'
$$;

-- ── JSON に特典を足す（元の項目はそのまま） ──────────────────────────────────

create or replace function app_private.ginpay_tx_json(t public.ginpay_transactions)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'id', t.id,
    'account_id', t.account_id,
    'client_id', t.client_id,
    'client_name', (select c.display_name from public.clients c where c.id = t.client_id),
    'root_client_id', t.root_client_id,
    'amount', t.amount,
    'bonus_amount', t.bonus_amount,
    'type', t.type,
    'status', t.status,
    'accounting_session_id', t.accounting_session_id,
    'stripe_event_id', t.stripe_event_id,
    'stripe_payment_intent_id', t.stripe_payment_intent_id,
    'stripe_checkout_session_id', t.stripe_checkout_session_id,
    'stripe_charge_id', t.stripe_charge_id,
    'operator_type', t.operator_type,
    'operator_name', t.operator_name,
    'reason', t.reason,
    'memo', t.memo,
    'idempotency_key', t.idempotency_key,
    'original_transaction_id', t.original_transaction_id,
    'created_at', t.created_at
  )
$$;

create or replace function app_private.ginpay_account_json(a public.ginpay_accounts, p_current_client uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'id', a.id,
    'client_id', a.client_id,
    'client_name', (select c.display_name from public.clients c where c.id = a.client_id),
    'is_current_client', a.client_id = p_current_client,
    'status', a.status,
    'currency', a.currency,
    'balance', a.balance_cached,
    'bonus_balance', app_private.ginpay_bonus_sum(a.id),
    'ledger_balance', app_private.ginpay_posted_sum(a.id),
    'consistent', a.balance_cached = app_private.ginpay_posted_sum(a.id),
    'created_at', a.created_at,
    'updated_at', a.updated_at
  )
$$;

/** 全体の照合に、預かっている現金と特典の残りを足す（資金決済法の未使用残高を見るため） */
create or replace function app_private.ginpay_reconcile_json()
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'checked_at', now(),
    'total_cached_balance', coalesce(sum(a.balance_cached), 0),
    'total_ledger_balance', coalesce(sum(app_private.ginpay_posted_sum(a.id)), 0),
    'total_bonus_balance', coalesce(sum(app_private.ginpay_bonus_sum(a.id)), 0),
    'total_cash_balance', coalesce(sum(app_private.ginpay_posted_sum(a.id) - app_private.ginpay_bonus_sum(a.id)), 0),
    'consistent', coalesce(bool_and(a.balance_cached = app_private.ginpay_posted_sum(a.id)), true),
    'accounts', coalesce(jsonb_agg(app_private.ginpay_account_json(a, a.client_id) order by a.created_at)
      filter (where a.balance_cached <> app_private.ginpay_posted_sum(a.id)), '[]'::jsonb)
  )
  from public.ginpay_accounts a
  where a.status <> 'closed'
$$;

-- ── 店頭の段階チャージ（現金） ────────────────────────────────────────────────

create or replace function public.staff_ginpay_charge_tiers(p_staff text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.ginpay_charge_tiers()::json;
end;
$$;

create or replace function public.staff_ginpay_charge_tier(
  p_staff text,
  p_client_id uuid,
  p_cash integer,
  p_staff_name text,
  p_memo text,
  p_idempotency_key text,
  p_account_id uuid default null
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_bonus integer := app_private.ginpay_charge_bonus(p_cash);
  v_res jsonb;
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if v_bonus is null then return json_build_object('error', 'invalid_charge_tier'); end if;
  v_res := app_private.ginpay_resolve_account(p_client_id, p_account_id, true, 'staff', p_staff_name);
  if v_res ? 'error' then return v_res::json; end if;
  return app_private.ginpay_record_transaction(
    (v_res->>'account_id')::uuid, 'charge_store', p_cash + v_bonus, 'posted', null, null, null, null, null,
    'staff', p_staff_name, 'cash', p_memo, p_idempotency_key, null,
    jsonb_build_object('store_payment_method', 'cash', 'cash', p_cash, 'bonus', v_bonus)
  )::json;
end;
$$;

revoke all on function public.staff_ginpay_charge_tiers(text) from public;
grant execute on function public.staff_ginpay_charge_tiers(text) to anon, authenticated;
revoke all on function public.staff_ginpay_charge_tier(text, uuid, integer, text, text, text, uuid) from public;
grant execute on function public.staff_ginpay_charge_tier(text, uuid, integer, text, text, text, uuid) to anon, authenticated;

revoke all on all functions in schema app_private from public, anon, authenticated;
