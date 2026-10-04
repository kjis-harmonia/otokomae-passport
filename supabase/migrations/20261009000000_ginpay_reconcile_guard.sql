-- ============================================================================
-- GINJIRO POS Phase 0 / P0-1：GINPay 台帳照合ガード（20261008000000_johnny_phase1.sql の後に適用）
--
-- 台帳（ginpay_transactions の posted 合計）を残高の正本とする。
--   * 金銭の記録（posted）の前に、口座行を FOR UPDATE した状態で balance_cached = ginpay_posted_sum を確認する。
--     不一致なら金銭の記録をせず { error: ledger_mismatch_blocked } を返し、ginpay_account_events に監査を残す。
--   * 監査が消えないこと：不一致の検出は必ず「例外を投げずに返す」経路で行う。
--       - staff / HQ の GINPay RPC（チャージ・返金・取消・調整）は ginpay_record_transaction の { error } をそのまま返す。
--       - 会計の確定（finalize_sale）と取消（void_sale）は、エラー時に例外で全体を取り消すため、
--         書き込みを始める前に同じ照合をして { error } で返す（会計・明細・GINPay は何も書かれず、監査だけが commit される）。
--       - Stripe 入金は、不一致のときイベントを確定させずに retryable を返す（Edge Function が 503 を返し、Stripe が再送する）。
--   * balance_cached の直接更新を防ぐ：ginpay_record_transaction が立てる印（app.ginpay_posting）がない更新と、
--     更新後の値が台帳合計と一致しない更新はトリガーで拒否する。口座の作成時は 0 のみ。
--     （DB の所有者・superuser はトリガーを外せる。運用での修復は監査付きの専用手順で行う＝本 migration の対象外）
--   * 画面に返す残高（balance）は台帳合計。cached_balance と consistent を併せて返す。
-- 既存の取引・口座のデータは変更しない。
-- ============================================================================

-- 監査イベントの種類に ledger_mismatch_blocked を追加
alter table public.ginpay_account_events drop constraint if exists ginpay_account_events_event_type_check;
alter table public.ginpay_account_events add constraint ginpay_account_events_event_type_check
  check (event_type in ('opened', 'client_merged', 'client_unmerged', 'sale_reversal_while_suspended', 'ledger_mismatch_blocked'));

/**
 * 口座を FOR UPDATE して balance_cached と posted 台帳合計を照合する。
 * 一致なら null。不一致なら監査（ledger_mismatch_blocked）を記録して { error } を返す（例外は投げない）。
 * 呼び出し側は { error } をそのまま返すこと（例外にすると監査まで取り消される）。
 */
create or replace function app_private.ginpay_check_reconciled(p_account_id uuid, p_context jsonb, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_account public.ginpay_accounts; v_ledger integer;
begin
  select * into v_account from public.ginpay_accounts where id = p_account_id for update;
  if v_account.id is null then return null; end if;   -- 口座の有無は呼び出し側が判定する
  v_ledger := app_private.ginpay_posted_sum(v_account.id);
  if v_account.balance_cached = v_ledger then return null; end if;
  insert into public.ginpay_account_events (account_id, client_id, event_type, actor_type, actor_name, detail)
  values (v_account.id, v_account.client_id, 'ledger_mismatch_blocked',
          case when p_actor_type in ('customer', 'staff', 'hq', 'system', 'stripe') then p_actor_type else 'system' end,
          nullif(btrim(coalesce(p_actor_name, '')), ''),
          jsonb_build_object('cached_balance', v_account.balance_cached, 'ledger_balance', v_ledger, 'context', coalesce(p_context, '{}'::jsonb)));
  return jsonb_build_object('error', 'ledger_mismatch_blocked', 'account_id', v_account.id);
end;
$$;

/** balance_cached の直接更新を拒否する（ginpay_record_transaction の印があり、かつ台帳合計と一致する更新だけ通す） */
create or replace function app_private.ginpay_guard_account_balance()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.balance_cached <> 0 then raise exception 'ginpay_balance_direct_update'; end if;
    return new;
  end if;
  if new.balance_cached is distinct from old.balance_cached then
    if coalesce(current_setting('app.ginpay_posting', true), '') <> 'on'
       or new.balance_cached <> app_private.ginpay_posted_sum(new.id) then
      raise exception 'ginpay_balance_direct_update';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists ginpay_accounts_balance_guard on public.ginpay_accounts;
create trigger ginpay_accounts_balance_guard before insert or update on public.ginpay_accounts
  for each row execute function app_private.ginpay_guard_account_balance();

-- ── 表示：残高は台帳合計（balance）。cached_balance は照合用 ─────────────────────────

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
    'balance', app_private.ginpay_posted_sum(a.id),
    'cached_balance', a.balance_cached,
    'ledger_balance', app_private.ginpay_posted_sum(a.id),
    'consistent', a.balance_cached = app_private.ginpay_posted_sum(a.id),
    'created_at', a.created_at,
    'updated_at', a.updated_at
  )
$$;

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
    then app_private.ginpay_tx_json(v_existing) || jsonb_build_object('idempotent', true, 'balance', app_private.ginpay_posted_sum(v_existing.account_id))
    else jsonb_build_object('error', 'idempotency_conflict')
  end
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
    'balance', coalesce((select sum(app_private.ginpay_posted_sum(a.id)) from public.ginpay_accounts a where a.client_id = any(v_ids) and a.status <> 'closed'), 0),
    'cached_balance', coalesce((select sum(a.balance_cached) from public.ginpay_accounts a where a.client_id = any(v_ids) and a.status <> 'closed'), 0),
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

-- ── 金銭の記録：口座ロック中に台帳と照合してから記録する ─────────────────────────────

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
  v_mismatch jsonb;
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
  -- 台帳が正本：口座をロックした状態で balance_cached と posted 台帳合計を照合し、不一致なら金銭の記録をしない。
  -- 監査（ledger_mismatch_blocked）は例外を投げずに返すことで、呼び出し側のトランザクションごと残る。
  if p_status = 'posted' then
    v_mismatch := app_private.ginpay_check_reconciled(v_account.id, jsonb_build_object(
      'operation', p_type, 'amount', p_amount, 'accounting_session_id', p_accounting_session_id,
      'original_transaction_id', p_original_transaction_id, 'idempotency_key', btrim(p_idempotency_key)), p_operator_type, p_operator_name);
    if v_mismatch is not null then return v_mismatch; end if;
  end if;
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
    -- balance_cached を変えられるのはこの経路だけ（ガードトリガーがこの印と台帳合計との一致を確認する）
    perform set_config('app.ginpay_posting', 'on', true);
    update public.ginpay_accounts
    set balance_cached = v_next_balance, updated_at = now()
    where id = v_account.id;
    perform set_config('app.ginpay_posting', 'off', true);
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

-- ── 例外で全体を取り消す呼び出し側は、書き込み前に照合して { error } で返す ──────────────

create or replace function app_private.finalize_sale(p jsonb, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare r public.reservations; v_client uuid; v_member uuid; v_user text; v_name text; v_stylist public.staff_members;
        v_item jsonb; v_items jsonb := coalesce(p->'items', '[]'::jsonb); v_n int; v_qty int; v_price int; v_disc int; v_list int;
        v_subtotal bigint := 0; v_line_disc bigint := 0; v_ticket_disc bigint := 0; v_manual int := 0; v_total bigint;
        v_tids uuid[]; v_tcount int; v_types text[]; v_tuser text; v_method text := p->>'payment_method'; v_legacy text;
        v_tax public.accounting_settings; v_id uuid; v_i int := 0; v_uids text[]; t record;
        v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), ''); v_existing uuid; v_gp jsonb; v_account public.ginpay_accounts; v_mismatch jsonb;
begin
  if p_actor_name is null or btrim(p_actor_name) = '' then return jsonb_build_object('error', 'operator_required'); end if;
  if v_method is null or v_method not in ('cash', 'card', 'qr', 'ginpay', 'other') then return jsonb_build_object('error', 'invalid_payment_method'); end if;
  if v_key is not null and length(v_key) > 100 then return jsonb_build_object('error', 'invalid_idempotency_key'); end if;
  if v_method = 'ginpay' and v_key is null then return jsonb_build_object('error', 'idempotency_key_required'); end if;
  -- 同じキーの再送（通信の再試行・二重タップ）：確定済みの会計をそのまま返す
  if v_key is not null then
    select id into v_existing from public.accounting_sessions where idempotency_key = v_key and status in ('completed', 'voided');
    if v_existing is not null then return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true); end if;
  end if;
  v_legacy := case v_method when 'card' then 'credit' else v_method end;

  -- 予約（行ロックで同じ予約の同時会計を直列化）
  if nullif(p->>'reservation_id', '') is not null then
    select * into r from public.reservations where id = (p->>'reservation_id')::uuid for update;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    if r.status in ('cancelled', 'no_show') then return jsonb_build_object('error', 'invalid_status'); end if;
    if exists (select 1 from public.accounting_sessions where reservation_id = r.id and status = 'completed') then
      return jsonb_build_object('error', 'already_paid');
    end if;
    v_client := app_private.client_root(r.client_id);
  elsif nullif(p->>'client_id', '') is not null then
    v_client := app_private.client_root((p->>'client_id')::uuid);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;
  if v_client is not null then
    select display_name into v_name from public.clients where id = v_client;
    v_member := (app_private.client_members(app_private.client_family(v_client)))[1];
    if v_member is not null then select user_id into v_user from public.customers where id = v_member; end if;
  end if;

  -- 担当
  select * into v_stylist from public.staff_members where id = nullif(p->>'stylist_id', '')::uuid;
  if v_stylist.id is null then return jsonb_build_object('error', 'stylist_required'); end if;

  -- 明細
  v_n := jsonb_array_length(v_items);
  if v_n = 0 or v_n > 50 then return jsonb_build_object('error', 'invalid_items'); end if;
  for v_item in select * from jsonb_array_elements(v_items) loop
    begin
      v_price := (v_item->>'unit_price')::int; v_qty := coalesce((v_item->>'quantity')::int, 1); v_disc := coalesce((v_item->>'discount')::int, 0);
    exception when others then return jsonb_build_object('error', 'invalid_items'); end;
    if btrim(coalesce(v_item->>'name', '')) = '' or length(v_item->>'name') > 80
       or coalesce(v_item->>'category', '') not in ('menu', 'option', 'retail')
       or v_price is null or v_price < 0 or v_price > 1000000 or v_qty < 1 or v_qty > 99 or v_disc < 0 or v_disc > v_price * v_qty
       or coalesce(v_item->>'source', 'manual') not in ('reservation', 'service_menu', 'accounting_item', 'product', 'manual') then
      return jsonb_build_object('error', 'invalid_items');
    end if;
    v_subtotal := v_subtotal + v_price * v_qty;
    v_line_disc := v_line_disc + v_disc;
  end loop;

  -- 手入力の値引き
  if p ? 'manual_discount' and p->'manual_discount' is not null and jsonb_typeof(p->'manual_discount') = 'object' then
    begin v_manual := coalesce((p->'manual_discount'->>'amount')::int, 0); exception when others then return jsonb_build_object('error', 'invalid_discount'); end;
    if v_manual < 0 or (v_manual > 0 and btrim(coalesce(p->'manual_discount'->>'label', '')) = '') then return jsonb_build_object('error', 'invalid_discount'); end if;
  end if;

  -- チケット（App 会員の顧客だけ。既存の staff_use_tickets と同じ規則で、行ロックしてから検証）
  select coalesce(array_agg(distinct x::uuid), '{}') into v_tids from jsonb_array_elements_text(coalesce(p->'ticket_ids', '[]'::jsonb)) x;
  if cardinality(v_tids) > 0 then
    if v_member is null then return jsonb_build_object('error', 'invalid_tickets'); end if;
    v_uids := app_private.member_user_ids(app_private.client_members(app_private.client_family(v_client)));
    perform 1 from public.tickets where id = any(v_tids) order by id for update;
    select count(*), array_agg(distinct type), (array_agg(distinct user_id))[1], coalesce(sum(amount), 0) into v_tcount, v_types, v_tuser, v_ticket_disc
    from public.tickets where id = any(v_tids) and user_id = any(v_uids) and not used and (expires_at is null or expires_at > now());
    if v_tcount <> cardinality(v_tids) then return jsonb_build_object('error', 'invalid_tickets'); end if;
    if cardinality(v_types) <> 1 then return jsonb_build_object('error', 'mixed_types'); end if;
    if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
      return jsonb_build_object('error', 'transfer_pending');
    end if;
    if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
       and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2)) then
      return jsonb_build_object('error', 'welcome_weekend');
    end if;
    if not app_private.can_use_type(app_private.today_used_type(v_tuser), v_types[1]) then
      return jsonb_build_object('error', 'daily_rule');
    end if;
  end if;

  v_total := v_subtotal - v_line_disc - v_ticket_disc - v_manual;
  if v_total < 0 then return jsonb_build_object('error', 'discount_exceeds'); end if;
  if nullif(p->>'expected_total', '') is null or (p->>'expected_total')::bigint <> v_total then
    return jsonb_build_object('error', 'total_mismatch', 'total', v_total);
  end if;
  select * into v_tax from public.accounting_settings where id = 1;

  -- GINPay 払い：顧客が必要（匿名は不可）。口座を決め（複数なら明示）、行ロックして残高を確認する
  if v_method = 'ginpay' then
    if v_client is null then return jsonb_build_object('error', 'ginpay_requires_client'); end if;
    if v_total <= 0 then return jsonb_build_object('error', 'invalid_amount'); end if;
    v_gp := app_private.ginpay_resolve_account(v_client, nullif(p->>'ginpay_account_id', '')::uuid, false, p_actor_type, btrim(p_actor_name));
    if v_gp ? 'error' then
      if v_gp->>'error' = 'account_not_found' and exists (select 1 from public.ginpay_accounts a
           where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended') then
        return jsonb_build_object('error', 'ginpay_account_suspended');
      end if;
      return jsonb_build_object('error', case v_gp->>'error' when 'account_not_found' then 'ginpay_account_not_found' else v_gp->>'error' end);
    end if;
    select * into v_account from public.ginpay_accounts where id = (v_gp->>'account_id')::uuid for update;
    if v_account.status <> 'active' then return jsonb_build_object('error', 'ginpay_account_suspended'); end if;
    -- 書き込み前に台帳と照合（不一致なら会計を作らずに返す。監査だけが残る）
    v_mismatch := app_private.ginpay_check_reconciled(v_account.id, jsonb_build_object(
      'operation', 'sale_payment', 'amount', v_total, 'idempotency_key', v_key, 'reservation_id', r.id), p_actor_type, btrim(p_actor_name));
    if v_mismatch is not null then return v_mismatch; end if;
    if v_account.balance_cached < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached);
    end if;
  end if;

  -- ── ここから書き込み（以後の失敗は例外で全体を取り消す） ──
  begin
    insert into public.accounting_sessions (user_id, customer_name, staff_name, stylist_name, stylist_id, payment_method, status,
      subtotal, discount_total, total, used_ticket_ids, client_id, reservation_id, tax_mode, tax_rate, idempotency_key)
    values (v_user, coalesce(v_name, r.customer_name, ''), btrim(p_actor_name), v_stylist.display_name, v_stylist.id, v_legacy, 'pending',
      v_subtotal, v_line_disc + v_ticket_disc + v_manual, v_total, (select array_agg(x::text) from unnest(v_tids) x),
      v_client, r.id, v_tax.tax_mode, v_tax.tax_rate, v_key)
    returning id into v_id;
  exception when unique_violation then
    -- 同じキーの同時送信は、先に確定した会計を返す。それ以外は同じ予約の二重会計
    if v_key is not null then
      select id into v_existing from public.accounting_sessions where idempotency_key = v_key and status in ('completed', 'voided');
      if v_existing is not null then return app_private.sale_json(v_existing) || jsonb_build_object('idempotent', true); end if;
    end if;
    return jsonb_build_object('error', 'already_paid');
  end;
  for v_item in select * from jsonb_array_elements(v_items) loop
    v_i := v_i + 1;
    v_price := (v_item->>'unit_price')::int; v_qty := coalesce((v_item->>'quantity')::int, 1); v_disc := coalesce((v_item->>'discount')::int, 0);
    v_list := case v_item->>'source'
      when 'service_menu' then (select price from public.service_menus where code = v_item->>'ref_id')
      when 'reservation' then (select ri.price from public.reservation_items ri where ri.reservation_id = r.id and ri.menu_code = v_item->>'ref_id' limit 1)
      when 'accounting_item' then (select price from public.accounting_items where id::text = v_item->>'ref_id')
      when 'product' then (select price from public.products where id::text = v_item->>'ref_id')
      else null end;
    insert into public.accounting_session_items (session_id, item_id, item_name, category, price, quantity, source, ref_id, list_price,
      line_discount, line_total, tax_mode, tax_rate, sort_order)
    values (v_id, case when v_item->>'source' in ('accounting_item', 'product') then nullif(v_item->>'ref_id', '')::uuid end,
      btrim(v_item->>'name'), v_item->>'category', v_price, v_qty, coalesce(v_item->>'source', 'manual'), nullif(v_item->>'ref_id', ''), v_list,
      v_disc, v_price * v_qty - v_disc, v_tax.tax_mode, v_tax.tax_rate, v_i);
  end loop;
  for t in select * from public.tickets where id = any(v_tids) order by id loop
    insert into public.accounting_discounts (session_id, kind, ticket_id, ticket_type, label, amount)
    values (v_id, 'ticket', t.id, t.type, t.title, t.amount);
  end loop;
  if v_manual > 0 then
    insert into public.accounting_discounts (session_id, kind, label, amount) values (v_id, 'manual', btrim(p->'manual_discount'->>'label'), v_manual);
  end if;
  insert into public.accounting_payments (session_id, method, amount) values (v_id, v_method, v_total);

  -- GINPay 支払い（同じトランザクション。会計1件につき1件。失敗すれば会計ごと取り消す）
  if v_method = 'ginpay' then
    v_gp := app_private.ginpay_pay(v_client, v_account.id, v_total::int, v_id, p_actor_type, btrim(p_actor_name), 'sale:' || v_key);
    if v_gp ? 'error' then raise exception '%', v_gp->>'error'; end if;
  end if;

  -- チケットの消費（既存と同じ使用ログ・来店日）
  if cardinality(v_tids) > 0 then
    update public.tickets set used = true, used_at = now() where id = any(v_tids);
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used'
    from public.tickets t2 where t2.id = any(v_tids);
  end if;
  if v_user is not null then perform app_private.touch_visit(v_user); end if;

  update public.accounting_sessions set status = 'completed', completed_at = now() where id = v_id;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, detail)
  values (v_id, 'completed', p_actor_type, btrim(p_actor_name), jsonb_build_object('total', v_total, 'payment_method', v_method));

  -- 予約の完了（会計と同じトランザクション。完了にできなければ全体を取り消す）
  if r.id is not null and r.status <> 'completed' then
    if (app_private.set_reservation_status(r.id, 'completed', p_actor_type, btrim(p_actor_name), null)) ? 'error' then
      raise exception 'reservation_not_completed';
    end if;
  end if;
  return app_private.sale_json(v_id);
end;
$$;

create or replace function app_private.void_sale(p_id uuid, p_reason text, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare s public.accounting_sessions; v_tids uuid[]; g public.ginpay_transactions; v_gp jsonb; v_acc uuid; v_mismatch jsonb;
begin
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 200 then return jsonb_build_object('error', 'reason_required'); end if;
  select * into s from public.accounting_sessions where id = p_id for update;
  if s.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if s.status <> 'completed' then return jsonb_build_object('error', 'invalid_status'); end if;
  -- 取消で GINPay を戻す口座を先にロックして台帳と照合（不一致なら会計を変えずに返す。監査だけが残る）
  for v_acc in select distinct t.account_id from public.ginpay_transactions t
               where t.accounting_session_id = p_id and t.type = 'payment' and t.status = 'posted' order by t.account_id loop
    v_mismatch := app_private.ginpay_check_reconciled(v_acc, jsonb_build_object(
      'operation', 'sale_void', 'accounting_session_id', p_id), p_actor_type, p_actor_name);
    if v_mismatch is not null then return v_mismatch; end if;
  end loop;
  update public.accounting_sessions set status = 'voided', voided_at = now(), voided_by = p_actor_name, void_reason = btrim(p_reason) where id = p_id;
  -- GINPay 払いの会計：元の支払い取引を参照する逆向き取引（void）を追加して残高を戻す（失敗すれば取消ごと取り消す）
  for g in select * from public.ginpay_transactions where accounting_session_id = p_id and type = 'payment' and status = 'posted' loop
    v_gp := app_private.ginpay_reverse_transaction(g.id, null, 'void', p_actor_type, p_actor_name, btrim(p_reason), 'sale-void:' || p_id::text);
    if v_gp ? 'error' then raise exception 'ginpay_%', v_gp->>'error'; end if;
  end loop;
  select coalesce(array_agg(ticket_id), '{}') into v_tids from public.accounting_discounts where session_id = p_id and kind = 'ticket';
  if cardinality(v_tids) > 0 then
    update public.tickets set used = false, used_at = null where id = any(v_tids);
    update public.ticket_usage_logs set status = 'voided' where ticket_id = any(select x::text from unnest(v_tids) x) and status = 'used';
  end if;
  insert into public.accounting_events (session_id, event_type, actor_type, actor_name, reason, detail)
  values (p_id, 'voided', p_actor_type, p_actor_name, btrim(p_reason), jsonb_build_object('total', s.total, 'tickets_restored', cardinality(v_tids)));
  return app_private.sale_json(p_id);
end;
$$;

create or replace function app_private.checkout_context_json(p_reservation_id uuid, p_client_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
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
    'tickets', case when v_client is null then '[]'::jsonb else app_private.client_tickets_json(v_client) end,
    'ginpay_accounts', case when v_client is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'client_name', c.display_name, 'balance', app_private.ginpay_posted_sum(a.id),
                 'consistent', a.balance_cached = app_private.ginpay_posted_sum(a.id),
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
$$;

-- ── Stripe 入金：不一致はイベントとして確定させず、再送で反映する ───────────────────────

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
      if v_tx->>'error' = 'ledger_mismatch_blocked' then
        -- 入金を記録せず、イベントも記録しない（Stripe の再送で、台帳の修復後に反映させる）。監査は口座イベントに残る
        return json_build_object('ok', false, 'retryable', true, 'status', 'blocked', 'error', 'ledger_mismatch_blocked');
      elsif v_tx ? 'error' then
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

-- app_private の関数は外部から実行できない（他の migration と同じ）
revoke all on all functions in schema app_private from public, anon, authenticated;
