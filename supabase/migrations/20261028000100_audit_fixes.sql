-- Codex 監査（10/28・main 29bdd89）の要対応1〜4
--   1) 銀Pay：取消・返金・調整の減額で、予約の仮支払い（押さえ）の分まで残高を減らさない（ginpay_record_transaction）
--   2) 店舗端末：取り消した端末・承認制限で未承認の端末のセッションは使えない（assert_staff・staff_session_valid）。ログインは端末の行をロックして読む（staff_login）
--   3) 券：同じお客様・同じ日の券の使用を順番に（finalize_sale・staff_use_tickets・staff_redeem_maintenance_coupon）
--   4) 旧い券の使用（staff_use_tickets）：Welcomeクーポンは使えない。画面から呼ばれていないので、アプリからの実行権限も外す
--   関数は本番の定義（20261028000000 適用後）に、上の確認だけを足す

CREATE OR REPLACE FUNCTION app_private.ginpay_record_transaction(p_account_id uuid, p_type text, p_amount integer, p_status text, p_accounting_session_id uuid, p_stripe_event_id text, p_stripe_payment_intent_id text, p_stripe_checkout_session_id text, p_stripe_charge_id text, p_operator_type text, p_operator_name text, p_reason text, p_memo text, p_idempotency_key text, p_original_transaction_id uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
    -- 監査 10/28 要対応1：取消・返金・調整の減額で、予約の仮支払い（押さえ）の分まで残高を減らさない。
    --   支払い（payment）は会計の確定（finalize_sale）が当該予約の押さえを除いて確かめる。口座はこの関数の中で行ロック済み
    if p_amount < 0 and p_type <> 'payment' and v_next_balance < app_private.ginpay_held_sum(v_account.id) then
      return jsonb_build_object('error', 'held_funds', 'balance', v_account.balance_cached, 'held', app_private.ginpay_held_sum(v_account.id));
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
$function$;

CREATE OR REPLACE FUNCTION app_private.assert_staff(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
begin
  if p_token is null or not exists (
    select 1 from app_private.staff_sessions ss
    where ss.token_hash = app_private.sha256_hex(p_token)
      and ss.revoked_at is null
      and ss.expires_at > now()
      -- 監査 10/28 要対応2：いまの端末の状態（取消・承認制限）も確かめる
      and (
      (ss.device_hash is null and not coalesce((select pol.require_approval from app_private.staff_device_policy pol where pol.id = 1), false))
      or exists (select 1 from app_private.staff_devices dv where dv.key_hash = ss.device_hash and dv.revoked_at is null
                 and (dv.approved_at is not null or not coalesce((select pol.require_approval from app_private.staff_device_policy pol where pol.id = 1), false))))
  ) then
    raise exception 'staff_auth_required' using errcode = '28000';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_session_valid(p_token text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select exists (
    select 1 from app_private.staff_sessions ss
    where ss.token_hash = app_private.sha256_hex(p_token) and ss.revoked_at is null and ss.expires_at > now()
      and (
      (ss.device_hash is null and not coalesce((select pol.require_approval from app_private.staff_device_policy pol where pol.id = 1), false))
      or exists (select 1 from app_private.staff_devices dv where dv.key_hash = ss.device_hash and dv.revoked_at is null
                 and (dv.approved_at is not null or not coalesce((select pol.require_approval from app_private.staff_device_policy pol where pol.id = 1), false))))
  )
$function$;

CREATE OR REPLACE FUNCTION public.staff_login(p_pin text, p_device_key text DEFAULT NULL::text, p_hint text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_hash     text;
  v_token    text;
  v_exp      timestamptz := now() + interval '14 hours';
  v_dev      app_private.staff_devices;
  v_subject  text;
  v_new_key  text;
  v_dev_hash text;
  v_hint     text := nullif(left(btrim(coalesce(p_hint, '')), 80), '');
begin
  if p_device_key is not null and length(p_device_key) >= 32 then
    select * into v_dev from app_private.staff_devices
    where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null
    for update;  -- 監査 10/28 要対応2：本部の取消・承認と同じ行を順番に扱う
  end if;
  v_subject := case when v_dev.key_hash is not null then 'device:' || v_dev.key_hash else 'unregistered' end;

  if (v_dev.key_hash is not null and app_private.recent_failures('staff_pin', v_subject, 10) >= 5)
     or (v_dev.key_hash is null and app_private.recent_failures('staff_pin', 'unregistered', 10) >= 10) then
    return json_build_object('error', 'locked');
  end if;
  select hash into v_hash from app_private.secrets where key = 'staff_pin';
  if v_hash is null then
    return json_build_object('error', 'not_configured');
  end if;
  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then
    insert into app_private.auth_attempts (kind, success, subject) values ('staff_pin', false, v_subject);
    return json_build_object('error', 'invalid_pin');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('staff_pin', true, v_subject);

  if v_dev.key_hash is null then
    -- 初めての端末：覚える（承認はまだ）
    v_new_key := encode(gen_random_bytes(32), 'hex');
    v_dev_hash := app_private.sha256_hex(v_new_key);
    insert into app_private.staff_devices (key_hash, hint) values (v_dev_hash, v_hint);
  else
    v_dev_hash := v_dev.key_hash;
    update app_private.staff_devices set last_seen_at = now(), hint = coalesce(v_hint, hint) where key_hash = v_dev_hash;
  end if;

  -- 「登録した端末だけ」がオンで、まだ承認していない端末は入れない（端末キーは返して、この端末を本部で承認できるようにする）
  if (select require_approval from app_private.staff_device_policy where id = 1)
     and not exists (select 1 from app_private.staff_devices where key_hash = v_dev_hash and approved_at is not null) then
    return json_build_object('error', 'device_pending', 'device_key', v_new_key);
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into app_private.staff_sessions (token_hash, expires_at, device_hash)
  values (app_private.sha256_hex(v_token), v_exp, v_dev_hash);
  delete from app_private.staff_sessions where expires_at < now() - interval '7 days';
  delete from app_private.auth_attempts where attempted_at < now() - interval '30 days';
  return json_build_object('token', v_token, 'expires_at', v_exp, 'device_key', v_new_key);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.finalize_sale(p jsonb, p_actor_type text, p_actor_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_client uuid; v_member uuid; v_user text; v_name text; v_stylist public.staff_members;
        v_item jsonb; v_items jsonb := coalesce(p->'items', '[]'::jsonb); v_n int; v_qty int; v_price int; v_disc int; v_list int;
        v_subtotal bigint := 0; v_line_disc bigint := 0; v_ticket_disc bigint := 0; v_manual int := 0; v_total bigint;
        v_tids uuid[]; v_tcount int; v_types text[]; v_tuser text; v_method text := p->>'payment_method'; v_legacy text;
        v_tax public.accounting_settings; v_id uuid; v_i int := 0; v_uids text[]; t record;
        v_key text := nullif(btrim(coalesce(p->>'idempotency_key', '')), ''); v_existing uuid; v_gp jsonb; v_account public.ginpay_accounts;
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
    -- 割引券・漢トク券は何枚でも種類をまたいでも使える。メンテナンスクーポンだけはほかの券と一緒に使えない（2026-10-17 お店の決定）
    if 'coupon' = any(v_types) and cardinality(v_types) > 1 then return jsonb_build_object('error', 'mixed_types'); end if;
    if exists (select 1 from public.ticket_transfers where ticket_id = any(v_tids) and status = 'pending' and expires_at > now()) then
      return jsonb_build_object('error', 'transfer_pending');
    end if;
    if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7)
       and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2)) then
      return jsonb_build_object('error', 'welcome_weekend');
    end if;
    -- Welcomeクーポン（初回パーマ 2,000円引き）はパーマ（セットを含む）のメニューがある会計だけ（10/27 慶一郎さん：カットでも使えていた）
    if exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_welcome(t2))
       and not exists (select 1 from jsonb_array_elements(v_items) i
                       where i->>'source' in ('reservation', 'service_menu') and coalesce(i->>'ref_id', '') ~ '^(perm|set)-') then
      return jsonb_build_object('error', 'welcome_perm_only');
    end if;
    -- 監査 10/28 要対応3：同じお客様・同じ日の券の使用は順番に（ほかの使用が終わってから、今日の使用を読み直す）
    perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || v_tuser || ':' || app_private.today_jst()::text, 0));
    if exists (select 1 from unnest(v_types) as ticket_type(value) where not app_private.can_use_type(app_private.today_used_type(v_tuser), ticket_type.value)) then
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
    -- 予約の仮支払い（銀Pay の押さえ）の分は使えない。この会計の予約の押さえは、この会計で閉じるので数えない（10/27：押さえた分まで払えていた）
    if v_account.balance_cached - app_private.ginpay_held_sum(v_account.id, r.id) < v_total then
      return jsonb_build_object('error', 'insufficient_balance', 'balance', v_account.balance_cached - app_private.ginpay_held_sum(v_account.id, r.id));
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
$function$;

CREATE OR REPLACE FUNCTION public.staff_use_tickets(p_staff text, p_user_id text, p_ticket_ids uuid[], p_staff_name text, p_customer_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_types text[]; v_count int; v_used_type text; v_rows json; v_t text;
begin
  perform app_private.assert_staff(p_staff);
  if p_ticket_ids is null or cardinality(p_ticket_ids) = 0 then raise exception 'no_tickets'; end if;
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;

  -- 対象行をロック
  perform 1 from public.tickets where id = any(p_ticket_ids) for update;

  select count(*), array_agg(distinct type) into v_count, v_types
  from public.tickets
  where id = any(p_ticket_ids) and user_id = p_user_id and used = false
    and (expires_at is null or expires_at > now());
  if v_count <> cardinality(p_ticket_ids) then
    return json_build_object('error', 'invalid_tickets');   -- 他人の券・使用済み・期限切れ・存在しない
  end if;
  -- メンテナンスクーポンは、ほかの券と一緒には使えない
  if 'coupon' = any(v_types) and cardinality(v_types) > 1 then
    return json_build_object('error', 'mixed_types');
  end if;
  if exists (select 1 from public.ticket_transfers where ticket_id = any(p_ticket_ids) and status = 'pending' and expires_at > now()) then
    return json_build_object('error', 'transfer_pending');
  end if;
  -- Welcomeクーポン（パーマ ¥2,000）は平日のみ
  if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7) and exists (
    select 1 from public.tickets
    where id = any(p_ticket_ids)
      and (issued_by = 'system-welcome' or (title in ('特殊パーマ Welcomeクーポン', 'パーマ Welcomeクーポン') and amount = 2000))
  ) then
    return json_build_object('error', 'welcome_weekend');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || p_user_id || ':' || app_private.today_jst()::text, 0));
  -- 監査 10/28 要対応4：Welcomeクーポンはお会計の中（パーマのときだけ）で使う。この旧い経路では使えない
  if exists (select 1 from public.tickets t2 where t2.id = any(p_ticket_ids) and app_private.is_welcome(t2)) then
    return json_build_object('error', 'welcome_checkout_only');
  end if;
  v_used_type := app_private.today_used_type(p_user_id);
  foreach v_t in array v_types loop
    if not app_private.can_use_type(v_used_type, v_t) then
      return json_build_object('error', 'daily_rule', 'used_type', v_used_type);
    end if;
  end loop;

  with upd as (
    update public.tickets set used = true, used_at = now()
    where id = any(p_ticket_ids) returning *
  ), logs as (
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
    select app_private.today_jst(), p_staff_name, coalesce(p_customer_name, ''), p_user_id, upd.id::text, upd.type, upd.amount, 'staff-terminal', 'used'
    from upd returning 1
  )
  select json_agg(row_to_json(upd)) into v_rows from upd;

  perform app_private.touch_visit(p_user_id);
  return json_build_object('tickets', v_rows, 'visit_date', app_private.today_jst());
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_redeem_maintenance_coupon(p_staff text, p_token uuid, p_staff_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_t public.maintenance_coupon_tokens; v_days int; v_name text;
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;

  select * into v_t from public.maintenance_coupon_tokens where token = p_token for update;
  if not found                    then return json_build_object('error', 'not_found'); end if;
  if v_t.used_at is not null      then return json_build_object('error', 'already_used'); end if;
  if v_t.revoked_at is not null   then return json_build_object('error', 'revoked'); end if;
  if v_t.expires_at <= now()      then return json_build_object('error', 'qr_expired'); end if;

  v_days := app_private.maintenance_days_remaining(v_t.user_id);
  if v_days is null then return json_build_object('error', 'no_visit'); end if;
  if v_days < 0     then return json_build_object('error', 'cycle_expired'); end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || v_t.user_id || ':' || app_private.today_jst()::text, 0));
  if not app_private.can_use_type(app_private.today_used_type(v_t.user_id), 'coupon') then
    return json_build_object('error', 'used_today');
  end if;

  select name into v_name from public.customers where user_id = v_t.user_id;

  update public.maintenance_coupon_tokens set used_at = now(), used_by = p_staff_name where token = p_token;
  insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status)
  values (app_private.today_jst(), p_staff_name, coalesce(v_name, ''), v_t.user_id, p_token::text, 'coupon', 0, 'staff-terminal', 'used');
  perform app_private.touch_visit(v_t.user_id);

  return json_build_object('ok', true, 'user_id', v_t.user_id, 'customer_name', v_name,
    'visit_date', app_private.today_jst(),
    'menu', json_build_object('name', '銀二郎Only メンテナンスカット', 'stylist', '銀二郎', 'normal_price', 3000, 'member_price', 2500));
end;
$function$;

-- 4) 旧い券の使用はアプリから呼ばない（会計の中で使う）。管理者が SQL から使うことはできる
revoke execute on function public.staff_use_tickets(text, text, uuid[], text, text) from anon, authenticated;
