-- Codex 最終監査（10/28・main 609ed9f）の要対応
--   R1 本部端末の取消：1つずつ順番に・最後の承認済み端末は取り消さない（hq_revoke_hq_device・hq_set_hq_device_policy）
--   R2 「サロンボードに入れました」：画面に出ていた通知（新しい予約／取消）だけを確認済みに（staff_ack_new に p_new_ids・p_cancel_ids）
--   R3 ログインと承認のロックの順番をそろえる（ポリシー行 → 端末行）（staff_login・hq_login）
--   R4 券の同日ルール：統合したお客様の全会員IDで確かめる・ロックも同じ単位（today_used_type・会計・旧券使用・メンテナンス）
--   R7 台数の上限の既定値を今の運用（店舗端末3台・SB7台）にそろえる
--   関数は本番の定義（20261028000900 適用後）に、上の変更だけを入れる

-- R7
alter table app_private.staff_device_policy alter column staff_limit set default 3;
alter table app_private.staff_device_policy alter column sb_limit set default 7;
update app_private.staff_device_policy set staff_limit = 3 where id = 1 and staff_limit = 2;
update app_private.staff_device_policy set sb_limit = 7 where id = 1 and sb_limit = 6;

-- R4：その会員IDと同じお客様（統合を含む）の全会員ID（並べ替え済み・先頭をロックの単位に使う）
create or replace function app_private.ticket_family_uids(p_user_id text)
returns text[] language sql stable security definer set search_path = '' as $$
  with m as (
    select c.id from public.customers c where c.user_id = p_user_id
    union select a.customer_id from public.customer_user_aliases a where a.user_id = p_user_id
  ), roots as (
    select distinct app_private.client_root(i.client_id) as root
    from public.client_identifiers i join m on i.value = m.id::text
    where i.kind = 'app_member' and i.removed_at is null
  ), fam as (
    select unnest(app_private.member_user_ids(app_private.client_members(app_private.client_family(roots.root)))) as u
    from roots where roots.root is not null
  )
  select array(select distinct x.u from (select p_user_id as u union select fam.u from fam) x where x.u is not null order by x.u)
$$;
revoke all on function app_private.ticket_family_uids(text) from public, anon, authenticated;

-- 今日すでに使った券の種類（統合したお客様の全会員IDで。メンテナンスクーポンがあればそれを優先して返す）
create or replace function app_private.today_used_type(p_user_id text)
returns text language sql stable set search_path to 'pg_catalog' as $$
  select ticket_type from public.ticket_usage_logs
  where user_id = any(app_private.ticket_family_uids(p_user_id)) and usage_date = app_private.today_jst() and status = 'used'
  order by (ticket_type = 'coupon') desc, used_at limit 1
$$;

CREATE OR REPLACE FUNCTION public.staff_login(p_pin text, p_device_key text DEFAULT NULL::text, p_hint text DEFAULT NULL::text, p_app text DEFAULT NULL::text)
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
  v_app      text := case when p_app in ('staff', 'sb') then p_app end;
  v_policy   boolean := coalesce((select require_approval from app_private.staff_device_policy where id = 1), false);
begin
  -- 監査2 R3：承認・取消と同じ順（ポリシー行 → 端末行）でロックし、ロック後の設定で判断する
  perform 1 from app_private.staff_device_policy where id = 1 for update;
  v_policy := coalesce((select require_approval from app_private.staff_device_policy where id = 1), false);
  if p_device_key is not null and length(p_device_key) >= 32 then
    select * into v_dev from app_private.staff_devices
    where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null
    for update;  -- 監査 10/28 要対応2：本部の取消・承認と同じ行を順番に扱う
  end if;
  v_subject := case when v_dev.key_hash is not null then 'device:' || v_dev.key_hash else 'unregistered' end;
  -- 10/28：侵入でロック中は、本部で解除するまで誰も入れない
  if exists (select 1 from app_private.staff_device_policy where id = 1 and locked_at is not null) then
    return json_build_object('error', 'lockdown');
  end if;

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
    -- 登録していない端末で1回でも間違えたら、ロックして登録済みの端末へ知らせる（10/28 慶一郎さん：3回→1回）
    if v_policy and v_dev.approved_at is null then
      perform app_private.staff_device_alert('pin_fail', coalesce(v_dev.app, v_app), coalesce(v_hint, v_dev.hint), v_dev.key_hash);
    end if;
    return json_build_object('error', 'invalid_pin');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('staff_pin', true, v_subject);

  if v_dev.key_hash is null then
    -- 初めての端末：覚える（承認はまだ）
    v_new_key := encode(gen_random_bytes(32), 'hex');
    v_dev_hash := app_private.sha256_hex(v_new_key);
    insert into app_private.staff_devices (key_hash, hint, app) values (v_dev_hash, v_hint, v_app);
  else
    v_dev_hash := v_dev.key_hash;
    update app_private.staff_devices set last_seen_at = now(), hint = coalesce(v_hint, hint), app = coalesce(app, v_app) where key_hash = v_dev_hash;
  end if;

  -- 「登録した端末だけ」がオンで、まだ承認していない端末は入れない（端末キーは返して、この端末を本部で承認できるようにする）
  if v_policy and not exists (select 1 from app_private.staff_devices where key_hash = v_dev_hash and approved_at is not null) then
    -- 正しい PIN で、登録していない端末から入ろうとした：登録済みの端末へ知らせる
    perform app_private.staff_device_alert('pin_ok', coalesce(v_dev.app, v_app), coalesce(v_hint, v_dev.hint), v_dev_hash);
    return json_build_object('error', 'device_pending', 'device_key', v_new_key);
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into app_private.staff_sessions (token_hash, expires_at, device_hash)
  values (app_private.sha256_hex(v_token), v_exp, v_dev_hash);
  delete from app_private.staff_sessions where expires_at < now() - interval '7 days';
  delete from app_private.auth_attempts where attempted_at < now() - interval '30 days';
  delete from app_private.staff_device_alerts where created_at < now() - interval '90 days';
  return json_build_object('token', v_token, 'expires_at', v_exp, 'device_key', v_new_key);
end;
$function$;

CREATE OR REPLACE FUNCTION public.hq_login(p_pin text, p_device_key text DEFAULT NULL::text, p_hint text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_hash     text;
  v_token    text;
  v_exp      timestamptz := now() + interval '14 hours';
  v_dev      app_private.hq_devices;
  v_dev_hash text;
  v_subject  text;
  v_new_key  text;
  v_hint     text := nullif(left(btrim(coalesce(p_hint, '')), 80), '');
  v_policy   boolean := coalesce((select hq_require_approval from app_private.staff_device_policy where id = 1), false);
begin
  -- 監査2 R3：承認・取消と同じ順（ポリシー行 → 端末行）でロックし、ロック後の設定で判断する
  perform 1 from app_private.staff_device_policy where id = 1 for update;
  v_policy := coalesce((select hq_require_approval from app_private.staff_device_policy where id = 1), false);
  if p_device_key is not null and length(p_device_key) >= 32 then
    select * into v_dev from app_private.hq_devices
    where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null
    for update;
  end if;
  v_subject := case when v_dev.key_hash is not null then 'device:' || v_dev.key_hash else 'unregistered' end;

  if (v_dev.key_hash is not null and app_private.recent_failures('hq_pin', v_subject, 10) >= 5)
     or (v_dev.key_hash is null and app_private.recent_failures('hq_pin', 'unregistered', 10) >= 10) then
    return json_build_object('error', 'locked');
  end if;
  select hash into v_hash from app_private.secrets where key = 'hq_pin';
  if v_hash is null then
    return json_build_object('error', 'not_configured');
  end if;
  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then
    insert into app_private.auth_attempts (kind, success, subject) values ('hq_pin', false, v_subject);
    -- 登録していない端末で本部 PIN を間違えた：ロックして登録済みの端末へ知らせる
    if v_policy and v_dev.approved_at is null then
      perform app_private.staff_device_alert('pin_fail', 'hq', coalesce(v_hint, v_dev.hint), v_dev.key_hash);
    end if;
    return json_build_object('error', 'invalid_pin');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('hq_pin', true, v_subject);

  if v_dev.key_hash is null then
    v_new_key := encode(gen_random_bytes(32), 'hex');
    v_dev_hash := app_private.sha256_hex(v_new_key);
    insert into app_private.hq_devices (key_hash, hint) values (v_dev_hash, v_hint);
  else
    v_dev_hash := v_dev.key_hash;
    update app_private.hq_devices set last_seen_at = now(), hint = coalesce(v_hint, hint) where key_hash = v_dev_hash;
  end if;

  -- 本部も登録制がオンで、承認していない端末：本部 PIN が合っていても入れない（本部 PIN が漏れている）
  if v_policy and not exists (select 1 from app_private.hq_devices where key_hash = v_dev_hash and approved_at is not null) then
    perform app_private.staff_device_alert('pin_ok', 'hq', coalesce(v_hint, v_dev.hint), v_dev_hash);
    return json_build_object('error', 'device_pending', 'device_key', v_new_key);
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into app_private.hq_sessions (token_hash, expires_at, device_hash)
  values (app_private.sha256_hex(v_token), v_exp, v_dev_hash);
  delete from app_private.hq_sessions where expires_at < now() - interval '7 days';
  return json_build_object('token', v_token, 'expires_at', v_exp, 'device_key', v_new_key);
end;
$function$;

CREATE OR REPLACE FUNCTION public.hq_revoke_hq_device(p_hq text, p_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_hash text; v_mine text;
begin
  perform app_private.assert_hq(p_hq);
  -- 監査2 R1：承認・取消・承認制の切替を1つずつ（同時に取り消し合って全台締め出されないように）
  perform 1 from app_private.staff_device_policy where id = 1 for update;
  perform app_private.assert_hq(p_hq);  -- ロックを待つ間に自分が取り消されていないか、もう一度
  select device_hash into v_mine from app_private.hq_sessions where token_hash = app_private.sha256_hex(p_hq);
  select key_hash into v_hash from app_private.hq_devices where left(key_hash, 16) = p_id and revoked_at is null;
  if v_hash is null then return json_build_object('error', 'not_found'); end if;
  if v_hash = v_mine then return json_build_object('error', 'own_device'); end if;
  if not exists (select 1 from app_private.hq_devices where key_hash <> v_hash and revoked_at is null and approved_at is not null) then
    return json_build_object('error', 'last_device');
  end if;
  update app_private.hq_devices set revoked_at = now() where key_hash = v_hash;
  update app_private.hq_sessions set revoked_at = now() where device_hash = v_hash and revoked_at is null;
  return json_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.hq_set_hq_device_policy(p_hq text, p_require boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_mine text;
begin
  perform app_private.assert_hq(p_hq);
  perform 1 from app_private.staff_device_policy where id = 1 for update;  -- 監査2 R1：取消と順番に
  perform app_private.assert_hq(p_hq);
  select device_hash into v_mine from app_private.hq_sessions where token_hash = app_private.sha256_hex(p_hq);
  if p_require and not exists (select 1 from app_private.hq_devices where key_hash = v_mine and approved_at is not null and revoked_at is null) then
    return json_build_object('error', 'own_device_not_approved');
  end if;
  update app_private.staff_device_policy set hq_require_approval = coalesce(p_require, false), updated_at = now(), updated_by = '本部' where id = 1;
  if p_require then
    update app_private.hq_sessions s set revoked_at = now()
    where s.revoked_at is null and s.expires_at > now()
      and not exists (select 1 from app_private.hq_devices d where d.key_hash = s.device_hash and d.approved_at is not null and d.revoked_at is null);
  end if;
  return json_build_object('ok', true);
end;
$function$;

drop function if exists public.staff_ack_new(text, text, uuid[]);
CREATE OR REPLACE FUNCTION public.staff_ack_new(p_staff text, p_staff_name text DEFAULT NULL::text, p_ids uuid[] DEFAULT NULL::uuid[], p_new_ids uuid[] DEFAULT NULL::uuid[], p_cancel_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor text := coalesce(nullif(btrim(coalesce(p_staff_name, '')), ''), 'SB'); r record; n int := 0;
  -- 監査2 R2：新しい画面は「新しい予約」と「取消」を分けて渡す。古い画面（p_ids だけ）は今までどおり両方
  v_new uuid[] := case when p_new_ids is not null or p_cancel_ids is not null then coalesce(p_new_ids, '{}') else p_ids end;
  v_cancel uuid[] := case when p_new_ids is not null or p_cancel_ids is not null then coalesce(p_cancel_ids, '{}') else p_ids end;
begin
  perform app_private.assert_staff(p_staff);
  -- 送り手が記録していない分（画面に出ていたものだけ）を先に記録する
  if v_new is not null then
    insert into app_private.staff_push_sent (reservation_id, sent_at)
    select q.id, q.created_at from public.reservations q
    where q.id = any(v_new) and q.source = 'app' and q.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = q.id)
    on conflict do nothing;
  end if;
  if v_cancel is not null then
    insert into app_private.staff_push_cancel (reservation_id, sent_at)
    select q.id, q.cancelled_at from public.reservations q
    where q.id = any(v_cancel) and q.source = 'app' and q.status = 'cancelled' and q.cancel_reason = 'お客様アプリからキャンセル'
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = q.id)
    on conflict do nothing;
  end if;
  for r in update app_private.staff_push_sent set acked_at = now(), acked_by = v_actor
    where acked_at is null and (v_new is null or reservation_id = any(v_new)) returning reservation_id loop
    n := n + 1;
    if exists (select 1 from public.reservations where id = r.reservation_id and transfer_status = 'pending' and status not in ('cancelled', 'no_show')) then
      update public.reservations set transfer_status = 'done', updated_at = now() where id = r.reservation_id;
      perform app_private.log_reservation_event(r.reservation_id, 'transfer_updated', 'staff', v_actor,
        jsonb_build_object('transfer_status', 'pending'), jsonb_build_object('transfer_status', 'done'), 'SB の新しい予約で「サロンボードに入れました」');
    end if;
  end loop;
  for r in update app_private.staff_push_cancel set acked_at = now(), acked_by = v_actor
    where acked_at is null and (v_cancel is null or reservation_id = any(v_cancel)) returning reservation_id loop
    n := n + 1;
  end loop;
  return json_build_object('acked', n);
end;
$function$;
revoke all on function public.staff_ack_new(text, text, uuid[], uuid[], uuid[]) from public;
grant execute on function public.staff_ack_new(text, text, uuid[], uuid[], uuid[]) to anon, authenticated;

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
    perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_tuser))[1] || ':' || app_private.today_jst()::text, 0));
    if exists (select 1 from unnest(v_types) as ticket_type(value) where not app_private.can_use_type(app_private.today_used_type(v_tuser), ticket_type.value)) then
      return jsonb_build_object('error', 'daily_rule');
    end if;
  end if;

  v_total := v_subtotal - v_line_disc - v_ticket_disc - v_manual;
  -- 券が料金を超えたときは 0円（超えた分はおつりにしない＝お店の従来どおり・10/28 慶一郎さん）。券以外の値引きが料金を超えるのは今までどおり不可
  if v_total < 0 and v_ticket_disc > 0 and v_subtotal - v_line_disc - v_manual >= 0 then v_total := 0; end if;
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
  perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(p_user_id))[1] || ':' || app_private.today_jst()::text, 0));
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
  perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_t.user_id))[1] || ':' || app_private.today_jst()::text, 0));
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
