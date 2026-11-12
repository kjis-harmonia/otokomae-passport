-- 20261112_ginoku_label.sql を戻す（Staging の元の定義）
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
    'transactions', (select coalesce(jsonb_agg(jsonb_build_object('id', t->'id', 'type', t->'type', 'amount', t->'amount', 'status', t->'status', 'created_at', t->'created_at')), '[]'::jsonb)
                     from jsonb_array_elements(l.j->'transactions') t)
  ) end
  from l
$function$;
