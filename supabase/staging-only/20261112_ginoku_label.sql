-- 銀オク：お客様の銀Payの利用履歴で、銀オクの引き落としを「オークション」と出す（11/12 慶一郎さん）。Staging だけ
-- 台帳の種類は adjustment のまま（新しい種類を足すと制約・特典の計算・HQ の集計まで変わるため）。見分けは冪等キー ginoku:<ID>
-- 戻すとき：20261112_ginoku_label_off.sql
CREATE OR REPLACE FUNCTION app_private.ginpay_customer_ledger_json(p_client_id uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  with l as (select app_private.ginpay_client_ledger_json(p_client_id, p_limit) j)
  select case when l.j ? 'error' then l.j else jsonb_build_object(
    'balance', l.j->'balance',
    'multiple_accounts', l.j->'multiple_accounts',
    'consistent', l.j->'consistent',
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a->'id', 'status', a->'status', 'balance', a->'balance')), '[]'::jsonb)
                 from jsonb_array_elements(l.j->'accounts') a),
    'transactions', (select coalesce(jsonb_agg(jsonb_build_object('id', t->'id', 'type', t->'type', 'amount', t->'amount', 'status', t->'status', 'created_at', t->'created_at')
                       -- 銀オクの引き落とし：利用履歴で「オークション」と出す（11/12 慶一郎さん・Staging だけ）
                       || case when t->>'idempotency_key' like 'ginoku:%' then jsonb_build_object('kind', 'auction') else '{}'::jsonb end), '[]'::jsonb)
                     from jsonb_array_elements(l.j->'transactions') t)
  ) end
  from l
$function$;
