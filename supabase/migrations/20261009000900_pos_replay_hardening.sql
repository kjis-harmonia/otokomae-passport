-- ============================================================================
-- GINJIRO POS Phase 0 / P0-5: Replay Hardening & Safety Atomicity (Phase B-1)
-- ============================================================================
-- 1. staff_ginpay_refund:
--    - Transaction-level advisory lock on idempotency key
--    - Exact replay evaluation before dynamic refundable remaining calculation
--    - Replay identity matching immutable business facts (type, status, target tx, amount, reason, account, client)
-- 2. staff_finalize_sale:
--    - Mandatory idempotency key across all payment methods & reservation/client flows
--    - Preserved auth precedence (operator auth checked before idempotency key presence)
--    - Transaction-level advisory lock on idempotency key
--    - Exact replay evaluation before mutable client resolver / repricing
--    - Case A (reservation), Case B (direct client), Case C (anonymous walk-in) & GINPay account verification
-- 3. staff_ginpay_charge_store:
--    - Subtransaction atomicity between L2 approval consumption and GINPay record transaction
--    - Preserves deterministic business error JSON while rolling back approval consumption on failure
-- ============================================================================

-- ── 1. staff_ginpay_refund ───────────────────────────────────────────────────

drop function if exists public.staff_ginpay_refund(text, uuid, integer, text, text, text);
drop function if exists public.staff_ginpay_refund(text, text, uuid, integer, text, text, text, text);

create or replace function public.staff_ginpay_refund(
  p_staff text,
  p_operator_token text,
  p_transaction_id uuid,
  p_amount integer,
  p_staff_name text,
  p_reason text,
  p_idempotency_key text,
  p_approval_token text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.ginpay_transactions;
  v_original public.ginpay_transactions;
  v_op_member_id uuid;
  v_effect integer;
  v_refundable integer;
  v_facts jsonb;
  v_req_hash text;
  v_consume jsonb;
  v_res jsonb;
begin
  -- 1. 店舗端末セッション検証
  perform app_private.assert_staff(p_staff);

  -- 2. オペレーター検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;

  if v_op_member_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  -- 3. 基本引数検証 & 冪等キー検証
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if p_amount is null or p_amount <= 0 then return json_build_object('error', 'invalid_amount'); end if;
  if p_reason is null or btrim(p_reason) = '' then return json_build_object('error', 'reason_required'); end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    return json_build_object('error', 'idempotency_key_required');
  end if;

  -- 4. トランザクション単位の Advisory Lock (同一keyのみ排他直列化)
  perform pg_advisory_xact_lock(hashtextextended('ginjiro_pos_refund_idem:' || btrim(p_idempotency_key), 0));

  -- 5. 対象取引の検証 (不変行取得)
  select * into v_original
  from public.ginpay_transactions
  where id = p_transaction_id and status = 'posted';

  if v_original.id is null then return json_build_object('error', 'transaction_not_found'); end if;
  if v_original.type = 'void' then return json_build_object('error', 'invalid_transaction'); end if;

  -- 確定済み会計の支払いは会計取消へ誘導
  if v_original.type = 'payment' and exists (
       select 1 from public.accounting_sessions s where s.id = v_original.accounting_session_id and s.status = 'completed') then
    return json_build_object('error', 'use_sale_void');
  end if;

  if v_original.type <> 'payment' and v_original.type <> 'charge_store' then
    return json_build_object('error', 'invalid_transaction');
  end if;

  -- 6. Idempotency 先行評価 (既存返金トランザクションの検索と不変事実の完全一致確認)
  select * into v_existing
  from public.ginpay_transactions
  where idempotency_key = btrim(p_idempotency_key);

  if v_existing.id is not null then
    if v_existing.type <> 'refund'
       or v_existing.status <> 'posted'
       or v_existing.original_transaction_id <> p_transaction_id
       or abs(v_existing.amount) <> p_amount
       or coalesce(v_existing.reason, '') <> btrim(p_reason)
       or v_existing.account_id <> v_original.account_id
       or v_existing.client_id is distinct from v_original.client_id then
      return json_build_object('error', 'idempotency_conflict');
    end if;
    return (app_private.ginpay_tx_json(v_existing) || jsonb_build_object('idempotent', true, 'balance', (select balance_cached from public.ginpay_accounts where id = v_existing.account_id)))::json;
  end if;

  -- 7. 既存なしの場合のみ: 返金可能残高計算
  select coalesce(sum(t.amount), 0) into v_effect
  from public.ginpay_transactions t
  where t.original_transaction_id = v_original.id and t.status = 'posted' and t.type in ('refund', 'void');

  v_refundable := abs(v_original.amount) - abs(v_effect);
  if v_refundable <= 0 or p_amount > v_refundable then
    return json_build_object('error', 'amount_exceeds_refundable', 'refundable_amount', v_refundable);
  end if;

  -- 8. L2 承認要求
  v_facts := jsonb_build_object(
    'action', 'refund',
    'account_id', v_original.account_id,
    'client_id', v_original.client_id,
    'target_transaction_id', v_original.id,
    'refundable_amount', v_refundable,
    'requested_refund_amount', p_amount,
    'reason', btrim(p_reason),
    'operator_staff_id', v_op_member_id
  );
  v_req_hash := app_private.pos_auth_hash('refund', v_facts);

  if p_approval_token is null or btrim(p_approval_token) = '' then
    return json_build_object('error', 'approval_required', 'action', 'refund', 'request_hash', v_req_hash);
  end if;

  v_consume := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, 'refund', v_req_hash);
  if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then return v_consume::json; end if;

  -- 9. 返金実行
  v_res := app_private.ginpay_reverse_transaction(
    p_transaction_id, p_amount, 'refund', 'staff', p_staff_name, btrim(p_reason), btrim(p_idempotency_key),
    v_req_hash
  );

  if v_res ? 'error' then
    raise exception 'refund_failed: %', v_res;
  end if;

  return v_res::json;
end;
$$;

revoke all on function public.staff_ginpay_refund(text, text, uuid, integer, text, text, text, text) from public;
grant execute on function public.staff_ginpay_refund(text, text, uuid, integer, text, text, text, text) to anon, authenticated;


-- ── 2. staff_finalize_sale ───────────────────────────────────────────────────

-- Static normalization against frozen pricing provenance. Each stored occurrence
-- is matched once, preserving duplicate-line multiplicity without a live lookup.
create or replace function app_private.pos_replay_items(p_items jsonb, p_stored jsonb)
returns jsonb language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_item jsonb;
  v_base jsonb;
  v_remaining jsonb := p_stored;
  v_candidate jsonb;
  v_match integer;
  v_index integer;
  v_qty integer;
  v_price integer;
  v_override integer;
  v_minimum integer;
  v_mode text;
  v_ref text;
  v_result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_typeof(p_stored) is distinct from 'array'
     or jsonb_array_length(p_items) <> jsonb_array_length(p_stored) then return null; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := coalesce((v_item->>'quantity')::integer, 1);
    if v_qty < 1 or v_qty > 100 then return null; end if;
    if v_item->>'source' = 'reservation' then v_qty := 1; end if;
    v_ref := nullif(btrim(v_item->>'ref_id'), '');
    if v_item->>'source' = 'accounting_item' then v_ref := v_ref::uuid::text; end if;
    if v_item->>'source' = 'manual' then v_ref := null; end if;
    v_match := null;
    for v_base, v_index in select value, (ordinality - 1)::integer
      from jsonb_array_elements(v_remaining) with ordinality loop
      if v_base->>'source' is distinct from v_item->>'source'
         or v_base->>'ref_id' is distinct from v_ref then continue; end if;
      if v_item->>'source' = 'reservation'
         and ((v_base->>'reference_mode' = 'name'
           and v_item->>'name' is distinct from v_base->>'reference_name')
           or (v_base->>'reference_mode' is null
             and v_item->>'name' is distinct from v_base->>'name')) then continue; end if;
      if v_item->>'source' = 'manual' then
        v_price := coalesce((v_item->>'price')::integer, (v_item->>'unit_price')::integer, 0);
      else
        v_override := case
          when v_item->>'override_price' is not null then (v_item->>'override_price')::integer
          when v_item->'price_override' ? 'price' then (v_item->'price_override'->>'price')::integer end;
        v_mode := v_base->>'base_pricing_mode';
        v_minimum := (v_base->>'base_unit_price')::integer;
        if v_override is not null then
          v_price := v_override;
        elsif v_mode = 'price_from' then
          if (v_item->>'unit_price')::integer < v_minimum
             or (v_item->>'price')::integer < v_minimum then continue; end if;
          if (v_item->>'price_from_adjustment')::integer > v_minimum then
            v_price := (v_item->>'price_from_adjustment')::integer;
          elsif (v_item->>'unit_price')::integer > v_minimum
             or (v_item->>'price')::integer > v_minimum then
            v_price := coalesce((v_item->>'unit_price')::integer, (v_item->>'price')::integer);
          else v_price := v_minimum; end if;
        elsif v_mode in ('fixed_master', 'reservation') then
          v_price := v_minimum;
        else
          -- Legacy records cannot prove whether a raw master price was ignored.
          v_price := (v_base->>'unit_price')::integer;
          if ((v_item->>'unit_price')::integer is not null and (v_item->>'unit_price')::integer <> v_price)
             or ((v_item->>'price')::integer is not null and (v_item->>'price')::integer <> v_price)
             or ((v_item->>'price_from_adjustment')::integer is not null and (v_item->>'price_from_adjustment')::integer <> v_price)
             or (v_item->>'unit_price' is null and v_item->>'price' is null
                 and v_item->>'price_from_adjustment' is null and v_minimum is distinct from v_price) then
            continue;
          end if;
        end if;
      end if;
      v_candidate := jsonb_build_object(
        'source', v_item->>'source', 'ref_id', v_ref,
        'name', case when v_item->>'source' = 'manual' then btrim(v_item->>'name') else v_base->>'name' end,
        'category', case when v_item->>'source' = 'manual' then 'manual' else v_base->>'category' end,
        'quantity', v_qty, 'unit_price', v_price, 'line_discount', 0);
      if v_candidate = v_base - 'pricing_mode' - 'base_pricing_mode' - 'base_unit_price' - 'override_path'
          - 'reference_mode' - 'reference_name' then
        v_match := v_index;
        exit;
      end if;
    end loop;
    if v_match is null then return null; end if;
    v_result := v_result || jsonb_build_array(v_candidate);
    v_remaining := v_remaining - v_match;
  end loop;
  return (select coalesce(jsonb_agg(value order by value::text), '[]'::jsonb)
    from jsonb_array_elements(v_result));
exception when invalid_text_representation or numeric_value_out_of_range then
  return null;
end;
$$;
revoke all on function app_private.pos_replay_items(jsonb, jsonb) from public, anon, authenticated;

-- New execution only. The wrapper holds source rows while pricing and saving
-- this provenance; replay never calls this helper or reads a current master.
drop function if exists app_private.pos_replay_pricing_snapshot(jsonb, jsonb);
create or replace function app_private.pos_replay_pricing_snapshot(p_items jsonb, p_priced jsonb, p_reservation_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_raw jsonb;
  v_item jsonb;
  v_base_mode text;
  v_path text;
  v_override integer;
  v_from boolean;
  v_reference_mode text;
  v_result jsonb := '[]'::jsonb;
begin
  for v_item in select value from jsonb_array_elements(p_priced) loop
    v_raw := p_items->((v_item->>'index')::integer);
    v_base_mode := case v_item->>'source' when 'manual' then 'manual'
      when 'reservation' then 'reservation' else 'fixed_master' end;
    if v_item->>'source' = 'service_menu' then
      select price_from into strict v_from from public.service_menus
      where code = v_item->>'ref_id' or id::text = v_item->>'ref_id';
      if v_from then v_base_mode := 'price_from'; end if;
    end if;
    v_reference_mode := 'reference';
    if v_item->>'source' = 'reservation' and not exists (
      select 1 from public.reservation_items ri where ri.reservation_id = p_reservation_id
        and (ri.menu_code = nullif(btrim(v_raw->>'ref_id'), '') or ri.id::text = nullif(btrim(v_raw->>'ref_id'), ''))
    ) then v_reference_mode := 'name'; end if;
    v_override := case when v_raw->>'override_price' is not null then (v_raw->>'override_price')::integer
      when v_raw->'price_override' ? 'price' then (v_raw->'price_override'->>'price')::integer end;
    v_path := 'none';
    if v_base_mode <> 'manual' then
      if v_override is not null then v_path := 'explicit';
      elsif v_base_mode = 'price_from' then
        if (v_raw->>'price_from_adjustment')::integer > (v_item->>'list_price')::integer then
          v_path := 'price_from_adjustment';
        elsif (v_raw->>'unit_price')::integer > (v_item->>'list_price')::integer
           or (v_raw->>'price')::integer > (v_item->>'list_price')::integer then
          v_path := 'price_from_input';
        end if;
      end if;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'source', v_item->>'source', 'ref_id', v_item->'ref_id',
      'name', btrim(v_item->>'name'), 'category', v_item->>'category',
      'unit_price', (v_item->>'unit_price')::integer, 'quantity', (v_item->>'quantity')::integer,
      'line_discount', (v_item->>'line_discount')::integer,
      'pricing_mode', case when v_path = 'explicit' then 'override' else v_base_mode end,
      'base_pricing_mode', v_base_mode, 'base_unit_price', (v_item->>'list_price')::integer,
      'override_path', v_path, 'reference_mode', v_reference_mode,
      'reference_name', case when v_reference_mode = 'name' then v_raw->>'name' end));
  end loop;
  return (select jsonb_agg(value order by value::text) from jsonb_array_elements(v_result));
end;
$$;
revoke all on function app_private.pos_replay_pricing_snapshot(jsonb, jsonb, uuid) from public, anon, authenticated;

drop function if exists public.staff_finalize_sale(text, jsonb, text);
drop function if exists public.staff_finalize_sale(text, jsonb, text, text);
drop function if exists public.staff_finalize_sale(text, jsonb, text, text, text);

create or replace function public.staff_finalize_sale(
  p_staff text,
  p jsonb,
  p_staff_name text,
  p_operator_token text,
  p_approval_token text
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_op_token text := coalesce(p_operator_token, p->>'operator_token');
  v_app_token text := coalesce(p_approval_token, p->>'approval_token');
  v_quote_hash text;
  v_idem_key text := btrim(coalesce(p->>'idempotency_key', ''));
  v_existing public.accounting_sessions;
  v_req_hash text;
  v_client_ctx jsonb;
  v_quote jsonb;
  v_consume jsonb;
  v_sale jsonb;
  v_final_p jsonb := p;
  v_op_staff_id uuid := null;
  v_items jsonb;
  v_in_items jsonb;
  v_tickets jsonb;
  v_in_tickets jsonb;
  v_ticket_discount bigint;
  v_manual bigint;
  v_in_manual bigint;
  v_account_id uuid;
  v_static_quote text;
  v_snapshot jsonb;
  v_pricing jsonb;
  v_replay_client uuid;
  v_saved_items jsonb;
  v_event_count integer;
begin
  -- 1. 店舗端末セッション検証
  perform app_private.assert_staff(p_staff);

  -- 2. オペレーター検証 (全リクエストで必須。未認証/無効は最優先で拒否)
  if v_op_token is null or btrim(v_op_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_staff_id from app_private.resolve_pos_operator(p_staff, v_op_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;
  if v_op_staff_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  -- 3. 冪等キー検証 (全会計経路で必須)
  if v_idem_key = '' then
    return json_build_object('error', 'idempotency_key_required');
  end if;
  if length(v_idem_key) > 100 then
    return json_build_object('error', 'invalid_idempotency_key');
  end if;

  -- 4. quote_hash 静的検証
  v_quote_hash := nullif(btrim(coalesce(p->>'quote_hash', '')), '');
  if v_quote_hash is null then
    return json_build_object('error', 'quote_required');
  end if;
  if v_quote_hash !~ '^QTE1\.[a-f0-9]{64}$' then
    return json_build_object('error', 'quote_mismatch');
  end if;

  -- 5. トランザクション単位の Advisory Lock (同一keyのみ排他直列化)
  perform pg_advisory_xact_lock(hashtextextended('ginjiro_pos_sale_idem:' || v_idem_key, 0));

  -- 6. 既存会計セッションの検索 & Exact Replay 評価
  select * into v_existing from public.accounting_sessions where idempotency_key = v_idem_key;
  if v_existing.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'source', i.source, 'ref_id', i.ref_id, 'name', i.item_name, 'category', i.category,
      'quantity', coalesce(i.quantity, 1), 'unit_price', i.price, 'line_discount', i.line_discount
    ) order by jsonb_build_object(
      'source', i.source, 'ref_id', i.ref_id, 'name', i.item_name, 'category', i.category,
      'quantity', coalesce(i.quantity, 1), 'unit_price', i.price, 'line_discount', i.line_discount
    )::text), '[]'::jsonb) into v_items
    from public.accounting_session_items i where i.session_id = v_existing.id;
    select detail->'pos_replay_v1' into v_snapshot from public.accounting_events
    where session_id = v_existing.id and event_type = 'completed' and detail ? 'pos_replay_v1';
    if found then
      if v_snapshot->>'version' is distinct from 'POS_REPLAY_V1'
         or not (v_snapshot ?& array['client_id', 'reservation_id', 'stylist_id', 'payment_method',
           'expected_total', 'ticket_ids', 'manual_discount_amount', 'ginpay_account_id', 'items'])
         or jsonb_typeof(v_snapshot->'items') is distinct from 'array' then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      v_pricing := v_snapshot->'items';
      if exists (select 1 from jsonb_array_elements(v_pricing) x
          where not (x ?& array['source', 'ref_id', 'name', 'category', 'quantity', 'unit_price',
            'line_discount', 'pricing_mode', 'base_pricing_mode', 'base_unit_price', 'override_path',
            'reference_mode', 'reference_name'])
            or x->>'base_pricing_mode' not in ('manual', 'fixed_master', 'price_from', 'reservation'))
         or (select jsonb_agg(x - 'pricing_mode' - 'base_pricing_mode' - 'base_unit_price' - 'override_path' - 'reference_mode' - 'reference_name'
           order by (x - 'pricing_mode' - 'base_pricing_mode' - 'base_unit_price' - 'override_path' - 'reference_mode' - 'reference_name')::text)
           from jsonb_array_elements(v_pricing) x) is distinct from v_items then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      v_replay_client := (v_snapshot->>'client_id')::uuid;
    else
      select jsonb_agg(x || jsonb_build_object('base_unit_price', i.list_price)) into v_pricing
      from public.accounting_session_items i
      cross join lateral (select jsonb_build_object('source', i.source, 'ref_id', i.ref_id,
        'name', i.item_name, 'category', i.category, 'quantity', coalesce(i.quantity, 1),
        'unit_price', i.price, 'line_discount', i.line_discount) x) canonical
      where i.session_id = v_existing.id;
      v_replay_client := v_existing.client_id;
    end if;
    v_in_items := app_private.pos_replay_items(p->'items', v_pricing);
    select coalesce(jsonb_agg(id::uuid order by id::uuid), '[]'::jsonb) into v_tickets
    from unnest(v_existing.used_ticket_ids) id;
    select coalesce(jsonb_agg(id::uuid order by id::uuid), '[]'::jsonb) into v_in_tickets
    from jsonb_array_elements_text(coalesce(p->'ticket_ids', '[]'::jsonb)) id;
    select coalesce(sum(amount), 0) into v_ticket_discount
    from public.accounting_discounts where session_id = v_existing.id and kind = 'ticket';
    v_manual := v_existing.discount_total - v_ticket_discount;
    v_in_manual := greatest(0, coalesce(case jsonb_typeof(p->'manual_discount')
      when 'number' then (p->>'manual_discount')::bigint
      when 'object' then (p->'manual_discount'->>'amount')::bigint end, 0));
    select account_id into v_account_id from public.ginpay_transactions
    where accounting_session_id = v_existing.id and type = 'payment' and status = 'posted';
    if v_snapshot is not null and (v_snapshot->'ticket_ids' is distinct from v_tickets
       or (v_snapshot->>'manual_discount_amount')::bigint is distinct from v_manual
       or (v_snapshot->>'ginpay_account_id')::uuid is distinct from v_account_id
       or (v_snapshot->>'reservation_id')::uuid is distinct from v_existing.reservation_id
       or (v_snapshot->>'stylist_id')::uuid is distinct from v_existing.stylist_id
       or v_snapshot->>'payment_method' is distinct from v_existing.payment_method
       or (v_snapshot->>'expected_total')::bigint is distinct from v_existing.total) then
      return json_build_object('error', 'idempotency_conflict');
    end if;

    -- Altered references retain the established security-error precedence.
    -- These gates never run for an exact original reference set.
    if v_replay_client is not null and nullif(p->>'client_id', '') is not null
       and v_replay_client is distinct from (p->>'client_id')::uuid then
      return json_build_object('error', 'customer_context_mismatch');
    end if;
    if v_existing.reservation_id is null and v_replay_client is not null
       and nullif(p->>'client_id', '') is null then
      return json_build_object('error', 'idempotency_conflict');
    end if;
    if nullif(p->>'ginpay_account_id', '') is not null
       and v_account_id is distinct from (p->>'ginpay_account_id')::uuid then
      if v_replay_client is not null and not exists (
         select 1 from public.ginpay_accounts a where a.id = (p->>'ginpay_account_id')::uuid
           and app_private.client_root(a.client_id) = v_replay_client
       ) then
      return json_build_object('error', 'customer_context_mismatch');
      end if;
    end if;
    if v_in_tickets is distinct from v_tickets then
      if exists (
      select 1 from jsonb_array_elements_text(v_in_tickets) x
      left join public.tickets t on t.id = x::uuid
      where t.id is null or t.user_id is distinct from v_existing.user_id
    ) then
      return json_build_object('error', 'customer_context_mismatch', 'detail', 'ticket_not_owned_by_customer');
      end if;
    end if;

    -- Identity is reconstructed solely from immutable completed records.
    if v_existing.status <> 'completed'
       or v_existing.total <> coalesce(nullif(p->>'expected_total', '')::bigint, -1)
       or v_existing.stylist_id is distinct from nullif(p->>'stylist_id', '')::uuid
       or v_existing.payment_method is distinct from (case p->>'payment_method' when 'card' then 'credit' else p->>'payment_method' end)
       or v_existing.reservation_id is distinct from nullif(p->>'reservation_id', '')::uuid
       or v_in_items is distinct from v_items
       or v_in_tickets is distinct from v_tickets
       or v_in_manual is distinct from v_manual
       or (v_existing.payment_method = 'ginpay' and
         v_account_id is distinct from coalesce(nullif(p->>'ginpay_account_id', '')::uuid, v_account_id)) then
      return json_build_object('error', 'idempotency_conflict');
    end if;

    -- QTE1 attestation is checked against frozen facts with the incoming ephemeral scan ID.
    -- It is not the replay identity; rotating a scan does not reprice or resolve a customer.
    v_static_quote := 'QTE1.' || app_private.sha256_hex(jsonb_build_object(
      'c', v_replay_client,
      'd', case when v_manual > 0 then jsonb_build_object('m', v_manual,
        't', case when jsonb_array_length(v_tickets) > 0 then jsonb_build_object('a', v_ticket_discount, 'ids', v_tickets) end)
        else jsonb_build_object('t', case when jsonb_array_length(v_tickets) > 0
          then jsonb_build_object('a', v_ticket_discount, 'ids', v_tickets) end) end,
      'dt', v_existing.discount_total,
      'i', (select jsonb_agg(jsonb_build_object(
        'c', x->>'category', 'n', x->>'name', 'p', (x->>'unit_price')::int,
        'ps', case x->>'source' when 'reservation' then 'reservation_snapshot'
          when 'service_menu' then 'service_master' when 'accounting_item' then 'accounting_master'
          when 'product' then 'product_master' when 'manual' then 'manual_entry' end,
        'q', (x->>'quantity')::int, 'r', x->>'ref_id', 's', x->>'source')
        order by x->>'source', coalesce(x->>'ref_id', ''), x->>'name', (x->>'unit_price')::int, (x->>'quantity')::int)
        from jsonb_array_elements(v_items) x),
      'o', v_op_staff_id, 'r', v_existing.reservation_id,
      'ss', nullif(p->>'scan_session_id', '')::uuid, 'st', v_existing.subtotal,
      'tm', v_existing.tax_mode, 'tr', v_existing.tax_rate, 'tt', v_existing.total
    )::text);
    if v_quote_hash is distinct from v_existing.quote_hash and v_quote_hash is distinct from v_static_quote then
      return json_build_object('error', 'quote_mismatch');
    end if;

    return (app_private.sale_json(v_existing.id) || jsonb_build_object('idempotent', true))::json;
  end if;

  -- 7. 既存なしの場合のみ: 動的解決 & 確定
  v_final_p := v_final_p || jsonb_build_object('operator_token', v_op_token);
  if v_app_token is not null and btrim(v_app_token) <> '' then
    v_final_p := v_final_p || jsonb_build_object('approval_token', v_app_token);
  end if;

  v_client_ctx := app_private.resolve_pos_client_context(
    p_staff, nullif(p->>'scan_session_id', '')::uuid,
    nullif(p->>'client_id', '')::uuid, nullif(p->>'reservation_id', '')::uuid
  );
  if v_client_ctx ? 'error' then return v_client_ctx::json; end if;
  v_final_p := v_final_p - 'client_id' - 'customer_name' - 'user_id';
  if v_client_ctx->>'client_id' is not null then
    v_final_p := v_final_p || jsonb_build_object('client_id', v_client_ctx->>'client_id');
  end if;

  -- Match the existing reservation-before-child lock order. The name fallback
  -- is an identity lookup, not an ignorable UI label, and must be frozen too.
  if nullif(v_final_p->>'reservation_id', '') is not null then
    perform r.id from public.reservations r where r.id = (v_final_p->>'reservation_id')::uuid for update;
    perform ri.id from public.reservation_items ri where ri.reservation_id = (v_final_p->>'reservation_id')::uuid
      order by ri.id for share;
  end if;
  -- Only initial execution locks the master whose flag selects pricing branches.
  -- Its flag cannot change between pos_price and provenance persistence.
  perform m.id from public.service_menus m
  where exists (select 1 from jsonb_array_elements(v_final_p->'items') x
    where x->>'source' = 'service_menu'
      and (m.code = btrim(x->>'ref_id') or m.id::text = btrim(x->>'ref_id')))
  order by m.id for share;

  v_quote := app_private.pos_price(
    p_request := v_final_p,
    p_operator_staff_id := v_op_staff_id,
    p_client_context := v_client_ctx,
    p_is_pos := true,
    p_staff := p_staff,
    p_operator_token := v_op_token,
    p_approval_token := v_app_token
  );
  if v_quote ? 'error' then
    return v_quote::json;
  end if;
  v_pricing := app_private.pos_replay_pricing_snapshot(v_final_p->'items', v_quote->'items',
    nullif(v_final_p->>'reservation_id', '')::uuid);

  if p->>'payment_method' = 'ginpay' then
    if v_client_ctx->>'client_id' is null then return json_build_object('error', 'ginpay_requires_client'); end if;
    if nullif(p->>'ginpay_account_id', '') is not null and not exists (
      select 1 from public.ginpay_accounts a where a.id = (p->>'ginpay_account_id')::uuid
        and app_private.client_root(a.client_id) = (v_client_ctx->>'client_id')::uuid
    ) then
      return json_build_object('error', 'customer_context_mismatch');
    end if;
  end if;

  v_req_hash := app_private.pos_sale_request_hash(v_final_p, v_quote, v_op_staff_id);

  if v_quote->>'quote_hash' is distinct from v_quote_hash then
    return json_build_object('error', 'quote_mismatch');
  end if;

  if (v_quote->>'has_l2_overrides')::boolean is true then
    if v_app_token is null or btrim(v_app_token) = '' then
      return json_build_object('error', 'approval_required', 'action', 'checkout_pricing_override', 'request_hash', v_quote->>'request_hash');
    end if;

    v_consume := app_private.consume_pos_approval(
      p_staff, v_op_token, v_app_token, 'checkout_pricing_override', v_quote->>'request_hash'
    );
    if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then
      return v_consume::json;
    end if;
  end if;

  v_sale := app_private.finalize_sale(v_final_p, 'staff', p_staff_name, p_staff);
  if v_sale ? 'error' then
    if (v_quote->>'has_l2_overrides')::boolean is true then
      raise exception 'sale_finalize_failed: %', v_sale;
    else
      return v_sale::json;
    end if;
  end if;

  -- Preserve the existing completed audit detail and attach only a namespaced
  -- snapshot before this transaction commits. Any persistence failure rolls
  -- back the sale, money mutations and approval consumption together.
  if v_sale->>'id' is null or v_sale->>'status' is distinct from 'completed' then
    raise exception 'pos_replay_snapshot_sale_invalid';
  end if;
  select jsonb_agg(jsonb_build_object('source', i.source, 'ref_id', i.ref_id,
    'name', i.item_name, 'category', i.category, 'quantity', coalesce(i.quantity, 1),
    'unit_price', i.price, 'line_discount', i.line_discount)
    order by jsonb_build_object('source', i.source, 'ref_id', i.ref_id,
      'name', i.item_name, 'category', i.category, 'quantity', coalesce(i.quantity, 1),
      'unit_price', i.price, 'line_discount', i.line_discount)::text) into v_saved_items
  from public.accounting_session_items i where i.session_id = (v_sale->>'id')::uuid;
  if app_private.pos_replay_items(v_final_p->'items', v_pricing) is distinct from v_saved_items then
    raise exception 'pos_replay_snapshot_pricing_changed';
  end if;
  select account_id into v_account_id from public.ginpay_transactions
  where accounting_session_id = (v_sale->>'id')::uuid and type = 'payment' and status = 'posted';
  select coalesce(jsonb_agg(id::uuid order by id::uuid), '[]'::jsonb) into v_tickets
  from jsonb_array_elements_text(coalesce(v_final_p->'ticket_ids', '[]'::jsonb)) id;
  v_snapshot := jsonb_build_object('version', 'POS_REPLAY_V1',
    'client_id', v_client_ctx->'client_id', 'reservation_id', nullif(v_final_p->>'reservation_id', '')::uuid,
    'stylist_id', nullif(v_final_p->>'stylist_id', '')::uuid,
    'payment_method', case v_final_p->>'payment_method' when 'card' then 'credit' else v_final_p->>'payment_method' end,
    'expected_total', (v_quote->>'total')::bigint, 'ticket_ids', v_tickets,
    'manual_discount_amount', (v_quote->'discounts'->>'manual_discount')::bigint,
    'ginpay_account_id', v_account_id, 'items', v_pricing);
  update public.accounting_events
  set detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object('pos_replay_v1', v_snapshot)
  where session_id = (v_sale->>'id')::uuid and event_type = 'completed'
    and (detail is null or (jsonb_typeof(detail) = 'object' and not (detail ? 'pos_replay_v1')));
  get diagnostics v_event_count = row_count;
  if v_event_count <> 1 then raise exception 'pos_replay_snapshot_storage_invalid'; end if;

  return v_sale::json;
end;
$$;

revoke all on function public.staff_finalize_sale(text, jsonb, text, text, text) from public;
grant execute on function public.staff_finalize_sale(text, jsonb, text, text, text) to anon, authenticated;


-- ── 3. staff_ginpay_charge_store ─────────────────────────────────────────────

drop function if exists public.staff_ginpay_charge_store(text, uuid, integer, text, text, text, text, uuid);
drop function if exists public.staff_ginpay_charge_store(text, text, uuid, integer, text, text, text, text, text, uuid);

create or replace function public.staff_ginpay_charge_store(
  p_staff text,
  p_operator_token text,
  p_client_id uuid,
  p_amount integer,
  p_payment_method text,
  p_staff_name text,
  p_memo text,
  p_idempotency_key text,
  p_approval_token text,
  p_account_id uuid
) returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.ginpay_transactions;
  v_acc_res jsonb;
  v_account_id uuid;
  v_policy public.pos_policy;
  v_op_member_id uuid;
  v_facts jsonb;
  v_req_hash text;
  v_consume jsonb;
  v_tx jsonb;
begin
  perform app_private.assert_staff(p_staff);

  -- 1. 基本引数検証
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  if p_amount is null or p_amount <= 0 then return json_build_object('error', 'invalid_amount'); end if;
  if coalesce(p_payment_method, '') not in ('cash', 'credit', 'qr', 'other') then return json_build_object('error', 'invalid_payment_method'); end if;

  -- 2. オペレーター検証
  if p_operator_token is null or btrim(p_operator_token) = '' then
    return json_build_object('error', 'operator_auth_required');
  end if;

  begin
    select operator_staff_id into v_op_member_id
    from app_private.resolve_pos_operator(p_staff, p_operator_token);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'invalid_operator_session' then
        return json_build_object('error', 'operator_session_invalid');
      elsif sqlerrm = 'staff_auth_required' then
        return json_build_object('error', 'staff_auth_required');
      else
        raise;
      end if;
  end;

  if v_op_member_id is null then
    return json_build_object('error', 'operator_session_invalid');
  end if;

  -- 3. GINPay 口座解決
  v_acc_res := app_private.ginpay_resolve_account(p_client_id, p_account_id, true, 'staff', p_staff_name);
  if v_acc_res ? 'error' then return v_acc_res::json; end if;
  v_account_id := (v_acc_res->>'account_id')::uuid;

  -- 4. canonical request_hash 生成
  v_facts := jsonb_build_object(
    'action', 'ginpay_charge',
    'client_id', p_client_id,
    'account_id', v_account_id,
    'amount', p_amount,
    'payment_method', p_payment_method,
    'operator_staff_id', v_op_member_id
  );
  v_req_hash := app_private.pos_auth_hash('ginpay_charge', v_facts);

  -- 5. Idempotency 先行評価
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select * into v_existing
    from public.ginpay_transactions
    where idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if v_existing.amount <> p_amount
         or v_existing.client_id <> p_client_id
         or (v_existing.request_hash is not null and v_existing.request_hash <> v_req_hash) then
        return json_build_object('error', 'idempotency_conflict');
      end if;
      return (app_private.ginpay_tx_json(v_existing) || jsonb_build_object('idempotent', true, 'balance', (select balance_cached from public.ginpay_accounts where id = v_existing.account_id)))::json;
    end if;
  end if;

  -- 6. L2 限度額チェック & アトミック実行 (50,000円超で L2 承認要求)
  select * into v_policy from public.pos_policy where id = 1;
  if p_amount > coalesce(v_policy.ginpay_charge_l1_limit, 50000) then
    if p_approval_token is null or btrim(p_approval_token) = '' then
      return json_build_object('error', 'approval_required', 'action', 'ginpay_charge', 'request_hash', v_req_hash);
    end if;
  end if;

  -- Nested subtransaction block for atomicity between approval consumption and mutation
  begin
    if p_amount > coalesce(v_policy.ginpay_charge_l1_limit, 50000) then
      v_consume := app_private.consume_pos_approval(p_staff, p_operator_token, p_approval_token, 'ginpay_charge', v_req_hash);
      if (v_consume->>'ok')::boolean is not true or v_consume ? 'error' then
        return v_consume::json;
      end if;
    end if;

    -- チャージ実行
    v_tx := app_private.ginpay_record_transaction(
      v_account_id, 'charge_store', p_amount, 'posted', null, null, null, null, null,
      'staff', p_staff_name, p_payment_method, p_memo, p_idempotency_key, null,
      jsonb_build_object('store_payment_method', p_payment_method),
      v_req_hash
    );

    if v_tx ? 'error' then
      -- Trigger rollback of the inner subtransaction (undoes approval consumption)
      raise exception using errcode = '20001', message = (v_tx->>'error');
    end if;
  exception
    when sqlstate '20001' then
      -- PL/pgSQL variables survive subtransaction rollback. Preserve the complete response.
      -- Recreate only the established failure audit outside the money/approval subtransaction.
      if v_tx->>'error' = 'ledger_mismatch_blocked' then
        perform app_private.ginpay_check_reconciled(v_account_id, jsonb_build_object(
          'operation', 'charge_store', 'amount', p_amount, 'accounting_session_id', null,
          'original_transaction_id', null, 'idempotency_key', btrim(p_idempotency_key)),
          'staff', p_staff_name);
      end if;
      return v_tx::json;
  end;

  return v_tx::json;
end;
$$;

revoke all on function public.staff_ginpay_charge_store(text, text, uuid, integer, text, text, text, text, text, uuid) from public;
grant execute on function public.staff_ginpay_charge_store(text, text, uuid, integer, text, text, text, text, text, uuid) to anon, authenticated;
