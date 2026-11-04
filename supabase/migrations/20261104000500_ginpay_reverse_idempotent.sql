-- 銀Pay の取消・返金：同じキーの再送は、先に記録済みの取引を返す（11/4 Sランク点検）
--   店舗端末で返事が消えたあと「結果を確かめる」を押すと、取消は「取消済み」、全額の返金は「返金できる額を超える」の
--   エラーになっていた（お金は正しいが、スタッフには失敗に見える）。キーの照合を先にする。ほかの判定は変えない
CREATE OR REPLACE FUNCTION app_private.ginpay_reverse_transaction(p_transaction_id uuid, p_amount integer, p_kind text, p_actor_type text, p_actor_name text, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_original public.ginpay_transactions;
  v_effect integer;
  v_amount integer;
  v_existing public.ginpay_transactions;
begin
  if p_reason is null or btrim(p_reason) = '' then return jsonb_build_object('error', 'reason_required'); end if;

  -- 同じキーの再送（返事が消えて「結果を確かめる」を押した）：先に記録済みの取引を返す。
  -- これまでは「取消済み」「返金できる額を超える」の判定が先で、成功していたのにエラーを返していた（11/4 Sランク点検）
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select * into v_existing from public.ginpay_transactions where idempotency_key = btrim(p_idempotency_key);
    if v_existing.id is not null then
      if v_existing.original_transaction_id is distinct from p_transaction_id or v_existing.type <> p_kind then
        return jsonb_build_object('error', 'idempotency_conflict');
      end if;
      return app_private.ginpay_idempotent_result(v_existing, v_existing.account_id, v_existing.type, v_existing.amount,
        v_existing.accounting_session_id, v_existing.original_transaction_id);
    end if;
  end if;

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
$function$;
