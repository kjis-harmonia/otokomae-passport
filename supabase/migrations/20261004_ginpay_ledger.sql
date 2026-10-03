-- ============================================================================
-- GINJIRO OS GINPay prepaid ledger
-- ----------------------------------------------------------------------------
-- 前提：20261002_booking_phase1.sql / 20261003_customer_ledger.sql 適用済み。20261005_checkout.sql がこの後に適用され、
--       会計の確定（app_private.finalize_sale）が同じトランザクションの中で GINPay 支払いを記録する。
--
-- 方針：
--   * GINPay は clients に紐付くプリペイド口座。
--   * balance を直接増減させるのではなく、ginpay_transactions の不可変台帳を正とする。
--   * balance_cached は高速表示用。posted 台帳合計と照合できる。
--   * 確定済み取引は UPDATE / DELETE 不可。取消・返金は逆向き transaction を追加する。
--   * 支払い・負方向の取消/調整は account 行を SELECT ... FOR UPDATE して残高不足を防ぐ。
--   * 顧客統合では口座を自動合算しない。統合元口座は元 client_id のまま残し、台帳もそのまま追跡する。
--   * anon/authenticated はテーブル直接読み書き不可。customer/staff/HQ/Stripe webhook RPC のみ。
--   * 会計の支払い（payment）は会計の確定の中でだけ作る（別トランザクションの支払い RPC は置かない）。
--     会計1件につき GINPay 支払いは1件（一意インデックス）。会計に紐付いた支払いの返金・取消は会計の取消から行う。
--   * 統合顧客で口座が複数あるときは、使う口座を明示させる（自動で決めない）。
-- ============================================================================

create extension if not exists pgcrypto;

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists public.ginpay_accounts (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete restrict,
  status          text not null default 'active'
                    check (status in ('active', 'suspended', 'closed')),
  currency        text not null default 'JPY' check (currency = 'JPY'),
  balance_cached  integer not null default 0 check (balance_cached >= 0),
  opened_by_type  text not null default 'system'
                    check (opened_by_type in ('customer', 'staff', 'hq', 'system', 'stripe')),
  opened_by_name  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists ginpay_accounts_active_client_uidx
  on public.ginpay_accounts (client_id)
  where status in ('active', 'suspended');

create index if not exists ginpay_accounts_client_idx on public.ginpay_accounts (client_id);

create table if not exists public.ginpay_transactions (
  id                         uuid primary key default gen_random_uuid(),
  account_id                 uuid not null references public.ginpay_accounts(id) on delete restrict,
  client_id                  uuid not null references public.clients(id) on delete restrict,
  root_client_id             uuid references public.clients(id) on delete set null,
  amount                     integer not null,
  type                       text not null check (type in ('charge_store', 'charge_stripe', 'payment', 'refund', 'adjustment', 'void')),
  status                     text not null default 'posted' check (status in ('posted', 'failed', 'cancelled')),
  accounting_session_id      uuid references public.accounting_sessions(id) on delete restrict,
  stripe_event_id            text,
  stripe_payment_intent_id   text,
  stripe_checkout_session_id text,
  stripe_charge_id           text,
  operator_type              text not null check (operator_type in ('customer', 'staff', 'hq', 'system', 'stripe')),
  operator_name              text,
  reason                     text,
  memo                       text,
  idempotency_key            text not null,
  original_transaction_id    uuid references public.ginpay_transactions(id) on delete restrict,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),

  check (btrim(idempotency_key) <> ''),
  check (status <> 'posted' or amount <> 0),
  check (
    status <> 'posted'
    or (type in ('charge_store', 'charge_stripe', 'refund') and amount > 0)
    or (type = 'payment' and amount < 0)
    or (type in ('adjustment', 'void') and amount <> 0)
  ),
  check (type <> 'payment' or accounting_session_id is not null),
  check (type not in ('refund', 'void') or original_transaction_id is not null),
  check (type <> 'charge_stripe' or stripe_payment_intent_id is not null or stripe_checkout_session_id is not null or stripe_event_id is not null)
);

create unique index if not exists ginpay_transactions_idempotency_uidx
  on public.ginpay_transactions (idempotency_key);

create unique index if not exists ginpay_transactions_stripe_event_uidx
  on public.ginpay_transactions (stripe_event_id)
  where stripe_event_id is not null;

create unique index if not exists ginpay_transactions_stripe_pi_posted_uidx
  on public.ginpay_transactions (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null and type = 'charge_stripe' and status = 'posted';

create unique index if not exists ginpay_transactions_one_payment_per_sale
  on public.ginpay_transactions (accounting_session_id)
  where type = 'payment' and status = 'posted';

create index if not exists ginpay_transactions_account_idx on public.ginpay_transactions (account_id, created_at desc);
create index if not exists ginpay_transactions_client_idx on public.ginpay_transactions (client_id, created_at desc);
create index if not exists ginpay_transactions_root_client_idx on public.ginpay_transactions (root_client_id, created_at desc);
create index if not exists ginpay_transactions_accounting_idx on public.ginpay_transactions (accounting_session_id) where accounting_session_id is not null;
create index if not exists ginpay_transactions_original_idx on public.ginpay_transactions (original_transaction_id) where original_transaction_id is not null;

create table if not exists public.ginpay_stripe_events (
  event_id                  text primary key,
  event_type                text not null,
  status                    text not null check (status in ('processed', 'ignored', 'failed')),
  client_id                 uuid references public.clients(id) on delete set null,
  transaction_id            uuid references public.ginpay_transactions(id) on delete set null,
  amount                    integer,
  stripe_payment_intent_id  text,
  stripe_checkout_session_id text,
  stripe_charge_id          text,
  error                     text,
  payload                   jsonb not null,
  received_at               timestamptz not null default now()
);

create index if not exists ginpay_stripe_events_received_idx on public.ginpay_stripe_events (received_at desc);
create index if not exists ginpay_stripe_events_pi_idx on public.ginpay_stripe_events (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

create table if not exists public.ginpay_account_events (
  id            bigint generated always as identity primary key,
  account_id    uuid not null references public.ginpay_accounts(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete restrict,
  event_type    text not null check (event_type in ('opened', 'client_merged', 'client_unmerged')),
  actor_type    text not null check (actor_type in ('customer', 'staff', 'hq', 'system', 'stripe')),
  actor_name    text,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

-- 停止中の口座への、会計取消に伴う GINPay の戻し（監査用）
alter table public.ginpay_account_events drop constraint if exists ginpay_account_events_event_type_check;
alter table public.ginpay_account_events add constraint ginpay_account_events_event_type_check
  check (event_type in ('opened', 'client_merged', 'client_unmerged', 'sale_reversal_while_suspended'));

create index if not exists ginpay_account_events_account_idx on public.ginpay_account_events (account_id, created_at desc);
create index if not exists ginpay_account_events_client_idx on public.ginpay_account_events (client_id, created_at desc);

alter table public.ginpay_accounts enable row level security;
alter table public.ginpay_transactions enable row level security;
alter table public.ginpay_stripe_events enable row level security;
alter table public.ginpay_account_events enable row level security;

revoke all on public.ginpay_accounts from anon, authenticated;
revoke all on public.ginpay_transactions from anon, authenticated;
revoke all on public.ginpay_stripe_events from anon, authenticated;
revoke all on public.ginpay_account_events from anon, authenticated;
revoke all on sequence public.ginpay_account_events_id_seq from public, anon, authenticated;

-- ── Immutability ─────────────────────────────────────────────────────────────

create or replace function app_private.ginpay_block_transaction_mutation()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  raise exception 'ginpay_transactions_are_immutable' using errcode = '23000';
end;
$$;

drop trigger if exists ginpay_transactions_no_update on public.ginpay_transactions;
create trigger ginpay_transactions_no_update
  before update on public.ginpay_transactions
  for each row execute function app_private.ginpay_block_transaction_mutation();

drop trigger if exists ginpay_transactions_no_delete on public.ginpay_transactions;
create trigger ginpay_transactions_no_delete
  before delete on public.ginpay_transactions
  for each row execute function app_private.ginpay_block_transaction_mutation();

-- ── Internal helpers ─────────────────────────────────────────────────────────

create or replace function app_private.ginpay_posted_sum(p_account_id uuid)
returns integer language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(sum(t.amount), 0)::integer
  from public.ginpay_transactions t
  where t.account_id = p_account_id and t.status = 'posted'
$$;

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
    'ledger_balance', app_private.ginpay_posted_sum(a.id),
    'consistent', a.balance_cached = app_private.ginpay_posted_sum(a.id),
    'created_at', a.created_at,
    'updated_at', a.updated_at
  )
$$;

create or replace function app_private.ginpay_open_account(
  p_client_id uuid,
  p_actor_type text,
  p_actor_name text,
  p_create boolean default true
)
returns uuid language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_root uuid := app_private.client_root(p_client_id);
  v_account uuid;
begin
  if v_root is null then
    raise exception 'client_not_found' using errcode = '22023';
  end if;

  select id into v_account
  from public.ginpay_accounts
  where client_id = v_root and status in ('active', 'suspended')
  order by created_at
  limit 1;

  if v_account is not null or not p_create then
    return v_account;
  end if;

  begin
    insert into public.ginpay_accounts (client_id, opened_by_type, opened_by_name)
    values (v_root, p_actor_type, nullif(btrim(coalesce(p_actor_name, '')), ''))
    returning id into v_account;

    insert into public.ginpay_account_events (account_id, client_id, event_type, actor_type, actor_name)
    values (v_account, v_root, 'opened', p_actor_type, nullif(btrim(coalesce(p_actor_name, '')), ''));
  exception when unique_violation then
    select id into v_account
    from public.ginpay_accounts
    where client_id = v_root and status in ('active', 'suspended')
    order by created_at
    limit 1;
  end;

  return v_account;
end;
$$;

/**
 * 同じ idempotency key の再送：同じ内容（口座・種類・金額・会計・元取引）なら既存の取引を返す。
 * 内容が違えば成功扱いにせず idempotency_conflict（別の操作がキーを再利用した可能性）。
 */
create or replace function app_private.ginpay_idempotent_result(
  v_existing public.ginpay_transactions, p_account_id uuid, p_type text, p_amount integer, p_accounting_session_id uuid, p_original_transaction_id uuid
)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select case
    when (v_existing.account_id, v_existing.type, v_existing.amount, v_existing.accounting_session_id, v_existing.original_transaction_id)
         is not distinct from (p_account_id, p_type, p_amount, p_accounting_session_id, p_original_transaction_id)
      or (p_type = 'charge_stripe' and v_existing.type = 'charge_stripe')  -- 同じ PaymentIntent の別イベント（金額・口座は Stripe 側の同一取引）
    then app_private.ginpay_tx_json(v_existing) || jsonb_build_object('idempotent', true, 'balance', (select balance_cached from public.ginpay_accounts where id = v_existing.account_id))
    else jsonb_build_object('error', 'idempotency_conflict')
  end
$$;

/** 顧客（統合された顧客を含む）の有効な口座 */
create or replace function app_private.ginpay_family_accounts(p_root uuid)
returns uuid[] language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(a.id order by a.created_at), '{}') from public.ginpay_accounts a
  where a.client_id = any(app_private.client_family(p_root)) and a.status = 'active'
$$;

/**
 * 使う口座を決める（支払い・チャージ・調整で共通）。曖昧なときは自動で決めない。
 *   明示した口座（その顧客か統合された顧客の有効な口座であること）
 *   → 明示なしで有効な口座が1つならその口座 → 0なら p_create のとき顧客（統合先）に口座を開く
 *   → 複数なら account_selection_required
 */
create or replace function app_private.ginpay_resolve_account(p_client_id uuid, p_account_id uuid, p_create boolean, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_root uuid := app_private.client_root(p_client_id); v_accounts uuid[];
begin
  if v_root is null then return jsonb_build_object('error', 'client_not_found'); end if;
  v_accounts := app_private.ginpay_family_accounts(v_root);
  if p_account_id is not null then
    if not (p_account_id = any(v_accounts)) then return jsonb_build_object('error', 'account_not_found'); end if;
    return jsonb_build_object('account_id', p_account_id);
  end if;
  if cardinality(v_accounts) = 1 then return jsonb_build_object('account_id', v_accounts[1]); end if;
  if cardinality(v_accounts) > 1 then return jsonb_build_object('error', 'account_selection_required'); end if;
  if not p_create then return jsonb_build_object('error', 'account_not_found'); end if;
  return jsonb_build_object('account_id', app_private.ginpay_open_account(v_root, p_actor_type, p_actor_name, true));
end;
$$;

create or replace function app_private.ginpay_record_transaction(
  p_account_id uuid,
  p_type text,
  p_amount integer,
  p_status text,
  p_accounting_session_id uuid,
  p_stripe_event_id text,
  p_stripe_payment_intent_id text,
  p_stripe_checkout_session_id text,
  p_stripe_charge_id text,
  p_operator_type text,
  p_operator_name text,
  p_reason text,
  p_memo text,
  p_idempotency_key text,
  p_original_transaction_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_account public.ginpay_accounts;
  v_tx public.ginpay_transactions;
  v_existing public.ginpay_transactions;
  v_next_balance integer;
  v_original public.ginpay_transactions;
  v_sale_reversal boolean := false;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    return jsonb_build_object('error', 'idempotency_key_required');
  end if;

  select * into v_existing
  from public.ginpay_transactions
  where idempotency_key = btrim(p_idempotency_key);
  if v_existing.id is not null then
    return app_private.ginpay_idempotent_result(v_existing, p_account_id, p_type, p_amount, p_accounting_session_id, p_original_transaction_id);
  end if;

  select * into v_account
  from public.ginpay_accounts
  where id = p_account_id
  for update;
  if v_account.id is null then return jsonb_build_object('error', 'account_not_found'); end if;
  -- 停止中の口座は、通常の利用（支払い・チャージ・調整・返金）を受け付けない。
  -- 例外は確定済み会計の取消に伴う戻しだけ：元の支払い取引が同じ口座・同じ会計にあり、その会計が
  -- このトランザクションで取消済みになっている場合（呼び出し側の指定ではなく DB の状態で判定する）。
  -- 戻し先は元の口座だけ。解約済み（closed）の口座は対象外。
  if v_account.status = 'suspended' and p_type in ('void', 'refund') and p_original_transaction_id is not null
     and p_accounting_session_id is not null and p_amount > 0 then
    select * into v_original from public.ginpay_transactions where id = p_original_transaction_id;
    v_sale_reversal := v_original.id is not null
      and v_original.account_id = v_account.id
      and v_original.type = 'payment' and v_original.status = 'posted'
      and v_original.accounting_session_id = p_accounting_session_id
      and exists (select 1 from public.accounting_sessions s where s.id = p_accounting_session_id and s.status = 'voided')
      -- 戻すのは元の支払いの残り（すでに戻した分は戻さない＝二重の戻しは不可）
      and p_amount <= -(v_original.amount + coalesce((select sum(t.amount) from public.ginpay_transactions t
                          where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void')), 0));
  end if;
  if v_account.status <> 'active' and not v_sale_reversal then return jsonb_build_object('error', 'account_not_active'); end if;

  if p_status = 'posted' then
    v_next_balance := v_account.balance_cached + p_amount;
    if v_next_balance < 0 then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached);
    end if;
  else
    v_next_balance := v_account.balance_cached;
  end if;

  begin
    insert into public.ginpay_transactions (
      account_id, client_id, root_client_id, amount, type, status, accounting_session_id,
      stripe_event_id, stripe_payment_intent_id, stripe_checkout_session_id, stripe_charge_id,
      operator_type, operator_name, reason, memo, idempotency_key, original_transaction_id, metadata
    )
    values (
      v_account.id, v_account.client_id, app_private.client_root(v_account.client_id), p_amount, p_type, p_status, p_accounting_session_id,
      nullif(btrim(coalesce(p_stripe_event_id, '')), ''),
      nullif(btrim(coalesce(p_stripe_payment_intent_id, '')), ''),
      nullif(btrim(coalesce(p_stripe_checkout_session_id, '')), ''),
      nullif(btrim(coalesce(p_stripe_charge_id, '')), ''),
      p_operator_type, nullif(btrim(coalesce(p_operator_name, '')), ''),
      nullif(btrim(coalesce(p_reason, '')), ''),
      nullif(btrim(coalesce(p_memo, '')), ''),
      btrim(p_idempotency_key), p_original_transaction_id, coalesce(p_metadata, '{}'::jsonb)
    )
    returning * into v_tx;
  exception when unique_violation then
    select * into v_existing
    from public.ginpay_transactions
    where idempotency_key = p_idempotency_key
       or (p_stripe_event_id is not null and stripe_event_id = p_stripe_event_id)
       or (p_type = 'charge_stripe' and p_status = 'posted'
           and p_stripe_payment_intent_id is not null
           and stripe_payment_intent_id = p_stripe_payment_intent_id
           and type = 'charge_stripe' and status = 'posted')
    order by created_at
    limit 1;
    if v_existing.id is not null then
      return app_private.ginpay_idempotent_result(v_existing, p_account_id, p_type, p_amount, p_accounting_session_id, p_original_transaction_id);
    end if;
    raise;
  end;

  if p_status = 'posted' then
    update public.ginpay_accounts
    set balance_cached = v_next_balance, updated_at = now()
    where id = v_account.id;
  end if;

  if v_sale_reversal then
    insert into public.ginpay_account_events (account_id, client_id, event_type, actor_type, actor_name, detail)
    values (v_account.id, v_account.client_id, 'sale_reversal_while_suspended', p_operator_type, nullif(btrim(coalesce(p_operator_name, '')), ''),
            jsonb_build_object('transaction_id', v_tx.id, 'original_transaction_id', p_original_transaction_id,
                               'accounting_session_id', p_accounting_session_id, 'amount', p_amount, 'reason', p_reason));
  end if;

  return app_private.ginpay_tx_json(v_tx) || jsonb_build_object('balance', v_next_balance, 'idempotent', false);
exception
  when check_violation or foreign_key_violation or invalid_text_representation then
    return jsonb_build_object('error', 'invalid_value');
end;
$$;

/**
 * GINPay 支払い（会計の確定の中で呼ぶ内部関数）。会計と同じトランザクションで口座を行ロックし、残高を確認して記録する。
 * 会計1件につき1件（一意インデックス）。残高不足・口座なし・口座の選択が必要な場合は { error }。
 */
create or replace function app_private.ginpay_pay(
  p_client_id uuid, p_account_id uuid, p_amount integer, p_accounting_session_id uuid,
  p_actor_type text, p_actor_name text, p_idempotency_key text
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_res jsonb;
begin
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
  if p_accounting_session_id is null then return jsonb_build_object('error', 'accounting_session_required'); end if;
  v_res := app_private.ginpay_resolve_account(p_client_id, p_account_id, false, p_actor_type, p_actor_name);
  if v_res ? 'error' then return v_res; end if;
  return app_private.ginpay_record_transaction(
    (v_res->>'account_id')::uuid, 'payment', -p_amount, 'posted', p_accounting_session_id, null, null, null, null,
    p_actor_type, p_actor_name, null, null, p_idempotency_key, null, '{}'::jsonb
  );
end;
$$;

create or replace function app_private.ginpay_client_ledger_json(p_client_id uuid, p_limit integer default 50)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_root uuid := app_private.client_root(p_client_id);
  v_ids uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if v_root is null then return jsonb_build_object('error', 'client_not_found'); end if;
  v_ids := app_private.client_family(v_root);

  return jsonb_build_object(
    'client_id', v_root,
    'client_name', (select display_name from public.clients where id = v_root),
    'app_linked', exists (
      select 1 from public.client_identifiers i
      where i.client_id = any(v_ids) and i.kind = 'app_member' and i.removed_at is null
    ),
    'balance', coalesce((select sum(a.balance_cached) from public.ginpay_accounts a where a.client_id = any(v_ids) and a.status <> 'closed'), 0),
    'ledger_balance', coalesce((select sum(app_private.ginpay_posted_sum(a.id)) from public.ginpay_accounts a where a.client_id = any(v_ids) and a.status <> 'closed'), 0),
    'consistent', not exists (
      select 1 from public.ginpay_accounts a
      where a.client_id = any(v_ids) and a.status <> 'closed' and a.balance_cached <> app_private.ginpay_posted_sum(a.id)
    ),
    'multiple_accounts', (select count(*) from public.ginpay_accounts a where a.client_id = any(v_ids) and a.status <> 'closed') > 1,
    'accounts', coalesce((
      select jsonb_agg(app_private.ginpay_account_json(a, v_root) order by (a.client_id = v_root) desc, a.created_at)
      from public.ginpay_accounts a
      where a.client_id = any(v_ids) and a.status <> 'closed'
    ), '[]'::jsonb),
    'transactions', coalesce((
      select jsonb_agg(app_private.ginpay_tx_json(t) order by t.created_at desc, t.id)
      from (
        select t.*
        from public.ginpay_transactions t
        join public.ginpay_accounts a on a.id = t.account_id
        where a.client_id = any(v_ids)
        order by t.created_at desc
        limit v_limit
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

/** お客様向けの台帳（残高と取引の種類・金額・日時だけ。担当者名・メモ・内部キー・Stripe の ID は返さない） */
create or replace function app_private.ginpay_customer_ledger_json(p_client_id uuid, p_limit integer default 50)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  with l as (select app_private.ginpay_client_ledger_json(p_client_id, p_limit) j)
  select case when l.j ? 'error' then l.j else jsonb_build_object(
    'balance', l.j->'balance',
    'multiple_accounts', l.j->'multiple_accounts',
    'consistent', l.j->'consistent',
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a->'id', 'status', a->'status', 'balance', a->'balance')), '[]'::jsonb)
                 from jsonb_array_elements(l.j->'accounts') a),
    'transactions', (select coalesce(jsonb_agg(jsonb_build_object('id', t->'id', 'type', t->'type', 'amount', t->'amount', 'status', t->'status', 'created_at', t->'created_at')), '[]'::jsonb)
                     from jsonb_array_elements(l.j->'transactions') t)
  ) end
  from l
$$;

create or replace function app_private.ginpay_reconcile_json()
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'checked_at', now(),
    'total_cached_balance', coalesce(sum(a.balance_cached), 0),
    'total_ledger_balance', coalesce(sum(app_private.ginpay_posted_sum(a.id)), 0),
    'consistent', coalesce(bool_and(a.balance_cached = app_private.ginpay_posted_sum(a.id)), true),
    'accounts', coalesce(jsonb_agg(app_private.ginpay_account_json(a, a.client_id) order by a.created_at)
      filter (where a.balance_cached <> app_private.ginpay_posted_sum(a.id)), '[]'::jsonb)
  )
  from public.ginpay_accounts a
  where a.status <> 'closed'
$$;

create or replace function app_private.ginpay_reverse_transaction(
  p_transaction_id uuid,
  p_amount integer,
  p_kind text,
  p_actor_type text,
  p_actor_name text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_original public.ginpay_transactions;
  v_effect integer;
  v_amount integer;
begin
  if p_reason is null or btrim(p_reason) = '' then return jsonb_build_object('error', 'reason_required'); end if;

  select * into v_original
  from public.ginpay_transactions
  where id = p_transaction_id and status = 'posted';
  if v_original.id is null then return jsonb_build_object('error', 'transaction_not_found'); end if;
  if v_original.type = 'void' then return jsonb_build_object('error', 'invalid_transaction'); end if;
  if v_original.type = 'payment' and exists (
       select 1 from public.accounting_sessions s where s.id = v_original.accounting_session_id and s.status = 'completed') then
    return jsonb_build_object('error', 'use_sale_void');
  end if;

  perform 1
  from public.ginpay_accounts
  where id = v_original.account_id
  for update;

  if p_kind = 'refund' then
    if v_original.type <> 'payment' or v_original.amount >= 0 then
      return jsonb_build_object('error', 'invalid_transaction');
    end if;
    if p_amount is null or p_amount <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
    select v_original.amount + coalesce(sum(t.amount), 0) into v_effect
    from public.ginpay_transactions t
    where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void');
    if p_amount > abs(v_effect) then return jsonb_build_object('error', 'amount_exceeds_refundable'); end if;
    v_amount := p_amount;
  elsif p_kind = 'void' then
    select v_original.amount + coalesce(sum(t.amount), 0) into v_effect
    from public.ginpay_transactions t
    where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void');
    if v_effect = 0 then return jsonb_build_object('error', 'already_reversed'); end if;
    v_amount := -v_effect;
  else
    return jsonb_build_object('error', 'invalid_transaction');
  end if;

  return app_private.ginpay_record_transaction(
    v_original.account_id, p_kind, v_amount, 'posted', v_original.accounting_session_id,
    null, null, null, null, p_actor_type, p_actor_name, p_reason, null,
    p_idempotency_key, v_original.id, jsonb_build_object('reverses', v_original.id)
  );
end;
$$;

create or replace function app_private.ginpay_note_client_merge()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  a public.ginpay_accounts;
  v_event text;
begin
  if new.event_type not in ('merged', 'unmerged') then return new; end if;
  v_event := case when new.event_type = 'merged' then 'client_merged' else 'client_unmerged' end;

  for a in
    select *
    from public.ginpay_accounts
    where client_id in (new.client_id, new.other_client_id)
  loop
    insert into public.ginpay_account_events (account_id, client_id, event_type, actor_type, actor_name, detail)
    values (a.id, a.client_id, v_event, new.actor_type, new.actor_name,
            jsonb_build_object('client_event_id', new.id, 'client_id', new.client_id, 'other_client_id', new.other_client_id));
  end loop;
  return new;
end;
$$;

drop trigger if exists ginpay_client_merge_events on public.client_events;
create trigger ginpay_client_merge_events
  after insert on public.client_events
  for each row execute function app_private.ginpay_note_client_merge();

-- ── Customer RPC ─────────────────────────────────────────────────────────────

create or replace function public.customer_ginpay_ledger(p_session text, p_limit integer default 50)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user_id text;
  v_client uuid;
begin
  v_user_id := app_private.session_user_id(p_session);
  v_client := app_private.user_client(v_user_id);
  if v_client is null then return json_build_object('error', 'client_not_found'); end if;
  return app_private.ginpay_customer_ledger_json(v_client, p_limit)::json;
end;
$$;

-- ── Staff RPC ────────────────────────────────────────────────────────────────

create or replace function public.staff_ginpay_ledger(p_staff text, p_client_id uuid, p_limit integer default 50)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.ginpay_client_ledger_json(p_client_id, p_limit)::json;
end;
$$;

create or replace function public.staff_ginpay_open_account(p_staff text, p_client_id uuid, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_account uuid;
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  v_account := app_private.ginpay_open_account(p_client_id, 'staff', p_staff_name, true);
  return app_private.ginpay_client_ledger_json(p_client_id, 50)::json;
end;
$$;

drop function if exists public.staff_ginpay_charge_store(text, uuid, integer, text, text, text, text);
create or replace function public.staff_ginpay_charge_store(
  p_staff text,
  p_client_id uuid,
  p_amount integer,
  p_payment_method text,
  p_staff_name text,
  p_memo text,
  p_idempotency_key text,
  p_account_id uuid default null
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_res jsonb;
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if p_amount is null or p_amount <= 0 then return json_build_object('error', 'invalid_amount'); end if;
  if coalesce(p_payment_method, '') not in ('cash', 'credit', 'qr', 'other') then return json_build_object('error', 'invalid_payment_method'); end if;
  v_res := app_private.ginpay_resolve_account(p_client_id, p_account_id, true, 'staff', p_staff_name);
  if v_res ? 'error' then return v_res::json; end if;
  return app_private.ginpay_record_transaction(
    (v_res->>'account_id')::uuid, 'charge_store', p_amount, 'posted', null, null, null, null, null,
    'staff', p_staff_name, p_payment_method, p_memo, p_idempotency_key, null,
    jsonb_build_object('store_payment_method', p_payment_method)
  )::json;
end;
$$;

-- 支払い（payment）は会計の確定（staff_finalize_sale）の中でだけ記録する。別トランザクションで支払う RPC は置かない。
drop function if exists public.staff_ginpay_payment(text, uuid, integer, uuid, text, text, text, uuid);

create or replace function public.staff_ginpay_refund(
  p_staff text,
  p_transaction_id uuid,
  p_amount integer,
  p_staff_name text,
  p_reason text,
  p_idempotency_key text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  return app_private.ginpay_reverse_transaction(p_transaction_id, p_amount, 'refund', 'staff', p_staff_name, p_reason, p_idempotency_key)::json;
end;
$$;

create or replace function public.staff_ginpay_void(
  p_staff text,
  p_transaction_id uuid,
  p_staff_name text,
  p_reason text,
  p_idempotency_key text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  return app_private.ginpay_reverse_transaction(p_transaction_id, null, 'void', 'staff', p_staff_name, p_reason, p_idempotency_key)::json;
end;
$$;

create or replace function public.staff_ginpay_adjustment(
  p_staff text,
  p_client_id uuid,
  p_amount integer,
  p_staff_name text,
  p_reason text,
  p_idempotency_key text,
  p_account_id uuid default null
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account uuid;
  v_root uuid := app_private.client_root(p_client_id);
  v_res jsonb;
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if p_amount is null or p_amount = 0 then return json_build_object('error', 'invalid_amount'); end if;
  if p_reason is null or btrim(p_reason) = '' then return json_build_object('error', 'reason_required'); end if;
  if v_root is null then return json_build_object('error', 'client_not_found'); end if;
  v_res := app_private.ginpay_resolve_account(v_root, p_account_id, true, 'staff', p_staff_name);
  if v_res ? 'error' then return v_res::json; end if;
  v_account := (v_res->>'account_id')::uuid;
  return app_private.ginpay_record_transaction(
    v_account, 'adjustment', p_amount, 'posted', null, null, null, null, null,
    'staff', p_staff_name, p_reason, null, p_idempotency_key, null, '{}'::jsonb
  )::json;
end;
$$;

-- ── HQ RPC ───────────────────────────────────────────────────────────────────

create or replace function public.hq_ginpay_ledger(p_hq text, p_client_id uuid, p_limit integer default 100)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.ginpay_client_ledger_json(p_client_id, p_limit)::json;
end;
$$;

create or replace function public.hq_ginpay_audit(
  p_hq text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_client_id uuid default null,
  p_type text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ids uuid[] := case when p_client_id is null then null else app_private.client_family(app_private.client_root(p_client_id)) end;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform app_private.assert_hq(p_hq);
  return (
    select coalesce(json_agg(app_private.ginpay_tx_json(t) order by t.created_at desc, t.id), '[]'::json)
    from (
      select t.*
      from public.ginpay_transactions t
      where (p_from is null or t.created_at >= p_from)
        and (p_to is null or t.created_at < p_to)
        and (p_type is null or t.type = p_type)
        and (v_ids is null or t.client_id = any(v_ids) or t.root_client_id = any(v_ids))
      order by t.created_at desc
      offset v_offset
      limit v_limit
    ) t
  );
end;
$$;

create or replace function public.hq_ginpay_reconcile(p_hq text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.ginpay_reconcile_json()::json;
end;
$$;

create or replace function public.hq_ginpay_refund(
  p_hq text,
  p_transaction_id uuid,
  p_amount integer,
  p_reason text,
  p_idempotency_key text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.ginpay_reverse_transaction(p_transaction_id, p_amount, 'refund', 'hq', '本部', p_reason, p_idempotency_key)::json;
end;
$$;

create or replace function public.hq_ginpay_void(
  p_hq text,
  p_transaction_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.ginpay_reverse_transaction(p_transaction_id, null, 'void', 'hq', '本部', p_reason, p_idempotency_key)::json;
end;
$$;

create or replace function public.hq_ginpay_adjustment(
  p_hq text,
  p_client_id uuid,
  p_amount integer,
  p_reason text,
  p_idempotency_key text,
  p_account_id uuid default null
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account uuid;
  v_root uuid := app_private.client_root(p_client_id);
  v_res jsonb;
begin
  perform app_private.assert_hq(p_hq);
  if p_amount is null or p_amount = 0 then return json_build_object('error', 'invalid_amount'); end if;
  if p_reason is null or btrim(p_reason) = '' then return json_build_object('error', 'reason_required'); end if;
  if v_root is null then return json_build_object('error', 'client_not_found'); end if;
  v_res := app_private.ginpay_resolve_account(v_root, p_account_id, true, 'hq', '本部');
  if v_res ? 'error' then return v_res::json; end if;
  v_account := (v_res->>'account_id')::uuid;
  return app_private.ginpay_record_transaction(
    v_account, 'adjustment', p_amount, 'posted', null, null, null, null, null,
    'hq', '本部', p_reason, null, p_idempotency_key, null, '{}'::jsonb
  )::json;
end;
$$;

-- ── Stripe webhook entrypoint ────────────────────────────────────────────────
-- Edge Function 側で署名検証後、service_role でのみ呼ぶ。anon/authenticated には付与しない。

create or replace function public.ginpay_apply_stripe_webhook(
  p_event_id text,
  p_event_type text,
  p_client_id uuid,
  p_amount integer,
  p_payment_intent_id text,
  p_checkout_session_id text,
  p_charge_id text,
  p_payload jsonb
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.ginpay_stripe_events;
  v_account uuid;
  v_tx jsonb;
  v_status text := 'ignored';
  v_error text;
  v_object jsonb := coalesce(p_payload->'data'->'object', '{}'::jsonb);
  v_root uuid;
begin
  if p_event_id is null or btrim(p_event_id) = '' then return json_build_object('error', 'stripe_event_id_required'); end if;

  select * into v_existing from public.ginpay_stripe_events where event_id = p_event_id;
  if v_existing.event_id is not null then
    return json_build_object('ok', true, 'idempotent', true, 'transaction_id', v_existing.transaction_id, 'status', v_existing.status);
  end if;

  -- 入金が確定したイベントだけ（Checkout は payment_status = paid。コンビニ・振込などの非同期払いは async_payment_succeeded で反映）
  if p_event_type in ('payment_intent.succeeded', 'checkout.session.async_payment_succeeded')
     or (p_event_type = 'checkout.session.completed' and v_object->>'payment_status' = 'paid') then
    v_root := app_private.client_root(p_client_id);
    if p_client_id is null then
      v_status := 'ignored';           -- GINPay のチャージではない Stripe の入金
      v_error := 'not_ginpay';
    elsif v_root is null then
      v_status := 'failed';
      v_error := 'client_not_found';
    elsif lower(coalesce(v_object->>'currency', '')) <> 'jpy' then
      v_status := 'failed';
      v_error := 'invalid_currency';
    elsif p_amount is null or p_amount <= 0 then
      v_status := 'failed';
      v_error := 'invalid_amount';
    else
      -- 入金先：メタデータの顧客の口座 → 統合先の口座 → 統合された顧客の最も古い口座 → なければ統合先に口座を開く
      select a.id into v_account from public.ginpay_accounts a
      where a.client_id = any(app_private.client_family(v_root)) and a.status = 'active'
      order by (a.client_id = p_client_id) desc, (a.client_id = v_root) desc, a.created_at
      limit 1;
      if v_account is null then v_account := app_private.ginpay_open_account(v_root, 'stripe', 'Stripe', true); end if;
      v_tx := app_private.ginpay_record_transaction(
        v_account, 'charge_stripe', p_amount, 'posted', null, p_event_id, p_payment_intent_id, p_checkout_session_id, p_charge_id,
        'stripe', 'Stripe', null, null,
        'stripe:' || coalesce(nullif(p_payment_intent_id, ''), nullif(p_checkout_session_id, ''), p_event_id),
        null, coalesce(p_payload, '{}'::jsonb)
      );
      if v_tx ? 'error' then
        v_status := 'failed';
        v_error := v_tx->>'error';
      else
        v_status := 'processed';
      end if;
    end if;
  elsif p_event_type in ('payment_intent.payment_failed', 'payment_intent.canceled', 'checkout.session.expired',
                         'checkout.session.async_payment_failed', 'checkout.session.completed') then
    v_status := 'ignored';             -- 失敗・キャンセル・未入金（payment_status <> paid）は残高に反映しない
  else
    v_status := 'ignored';
  end if;

  insert into public.ginpay_stripe_events (
    event_id, event_type, status, client_id, transaction_id, amount,
    stripe_payment_intent_id, stripe_checkout_session_id, stripe_charge_id, error, payload
  )
  values (
    p_event_id, p_event_type, v_status, case when v_root is not null then p_client_id end, nullif(v_tx->>'id', '')::uuid, p_amount,
    nullif(p_payment_intent_id, ''), nullif(p_checkout_session_id, ''), nullif(p_charge_id, ''), v_error, coalesce(p_payload, '{}'::jsonb)
  );

  return json_build_object('ok', v_status <> 'failed', 'idempotent', false, 'status', v_status, 'error', v_error, 'transaction', v_tx);
exception when unique_violation then
  select * into v_existing from public.ginpay_stripe_events where event_id = p_event_id;
  if v_existing.event_id is not null then
    return json_build_object('ok', true, 'idempotent', true, 'transaction_id', v_existing.transaction_id, 'status', v_existing.status);
  end if;
  raise;
end;
$$;

revoke all on function public.ginpay_apply_stripe_webhook(text, text, uuid, integer, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ginpay_apply_stripe_webhook(text, text, uuid, integer, text, text, text, jsonb) to service_role;

-- ── Grants for session-protected RPCs ────────────────────────────────────────

do $$
declare f text;
begin
  foreach f in array array[
    'public.customer_ginpay_ledger(text, integer)',
    'public.staff_ginpay_ledger(text, uuid, integer)',
    'public.staff_ginpay_open_account(text, uuid, text)',
    'public.staff_ginpay_charge_store(text, uuid, integer, text, text, text, text, uuid)',
    'public.staff_ginpay_refund(text, uuid, integer, text, text, text)',
    'public.staff_ginpay_void(text, uuid, text, text, text)',
    'public.staff_ginpay_adjustment(text, uuid, integer, text, text, text, uuid)',
    'public.hq_ginpay_ledger(text, uuid, integer)',
    'public.hq_ginpay_audit(text, timestamptz, timestamptz, uuid, text, integer, integer)',
    'public.hq_ginpay_reconcile(text)',
    'public.hq_ginpay_refund(text, uuid, integer, text, text)',
    'public.hq_ginpay_void(text, uuid, text, text)',
    'public.hq_ginpay_adjustment(text, uuid, integer, text, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema app_private from public, anon, authenticated;
