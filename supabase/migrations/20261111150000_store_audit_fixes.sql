-- 11/11 店舗端末の点検（富士通・5人）の「今日中」のうち DB の分
--   1 SB：アプリでの予約の変更（元の予約の取消）も SB に届ける（staff_push_pending_for_sender・staff_new_unacked）
--   2 安全：未登録の端末で PIN を間違えただけでは全体をロックしない（staff_device_alert。staff_login・hq_login はこれを呼ぶ）。staff_lockdown_status はログインしていないと答えない
--   5 会計：予約のない方の会計（not_owner）は会員ご本人の来店・施術の記録に入れない・Welcome 券を使わない（finalize_sale）
--   6 お客様ごとの料金：お連れ様の予約・予約のない方の会計を除く（client_menu_price・client_menu_prices）
-- 元にした定義は Staging＝本番で同じ（md5 確認済み）。戻し方：supabase/rollback/20261111_store_audit_off.sql
alter table public.accounting_sessions add column if not exists not_owner boolean not null default false;

CREATE OR REPLACE FUNCTION public.staff_push_pending_for_sender(p_secret text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_list json; v_cancels json; v_overdue json; v_subs json;
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  with fresh as (
    insert into app_private.staff_push_sent (reservation_id)
    select r.id from public.reservations r
    where r.source = 'app' and r.created_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
    on conflict do nothing
    returning reservation_id
  )
  select coalesce(json_agg(json_build_object(
      'id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', app_private.staff_push_label(r.nominated, m.display_name),
      'menus', (select string_agg(i.name, '・' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id)
    ) order by r.starts_at), '[]'::json)
  into v_list
  from fresh f join public.reservations r on r.id = f.reservation_id left join public.staff_members m on m.id = r.staff_id;

  -- お客様がアプリで取り消した予約（SB に知らせた予約だけ・これからの予約だけ）
  with fresh as (
    insert into app_private.staff_push_cancel (reservation_id)
    select r.id from public.reservations r
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason in ('お客様アプリからキャンセル', 'お客様アプリで予約を変更（新しい予約へ）')
      and r.cancelled_at > now() - interval '1 day' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = r.id)
    on conflict do nothing
    returning reservation_id
  )
  select coalesce(json_agg(json_build_object(
      'id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', app_private.staff_push_label(r.nominated, m.display_name),
      'menus', (select string_agg(i.name, '・' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id),
      'rescheduled', app_private.staff_push_rescheduled(r.id)
    ) order by r.starts_at), '[]'::json)
  into v_cancels
  from fresh f join public.reservations r on r.id = f.reservation_id left join public.staff_members m on m.id = r.staff_id;

  with late as (
    update app_private.staff_push_sent s set final_pushed_at = now()
    from public.reservations r
    where r.id = s.reservation_id and s.acked_at is null and s.final_pushed_at is null
      and s.sent_at < now() - interval '5 minutes' and s.sent_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
    returning s.reservation_id, 'new'::text as kind
  ), late_cancel as (
    update app_private.staff_push_cancel s set final_pushed_at = now()
    where s.acked_at is null and s.final_pushed_at is null
      and s.sent_at < now() - interval '5 minutes' and s.sent_at > now() - interval '1 day'
    returning s.reservation_id, 'cancel'::text as kind
  )
  select coalesce(json_agg(json_build_object('id', r.id, 'kind', l.kind, 'starts_at', r.starts_at, 'customer_name', r.customer_name,
      'staff_name', app_private.staff_push_label(r.nominated, m.display_name)) order by r.starts_at), '[]'::json)
  into v_overdue
  from (select * from late union all select * from late_cancel) l join public.reservations r on r.id = l.reservation_id left join public.staff_members m on m.id = r.staff_id;

  select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json) into v_subs
  from app_private.staff_push_subscriptions s;
  return json_build_object('reservations', v_list, 'cancels', v_cancels, 'overdue', v_overdue, 'subs', v_subs);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_new_unacked(p_staff text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform app_private.assert_staff(p_staff);
  return (select coalesce(json_agg(x order by x.sent_at), '[]'::json) from (
    select r.id, 'new'::text as kind, r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name) as staff_name, s.sent_at, false as rescheduled, nullif(substring(r.note from '^お連れ様：(.+)様$'), '') as companion_name
    from app_private.staff_push_sent s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '7 days' and r.starts_at > now() and r.status not in ('cancelled', 'no_show')
    union all
    -- 送り手が記録していない新しい AI 予約（2分たっても）
    select r.id, 'new', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), r.created_at, false, nullif(substring(r.note from '^お連れ様：(.+)様$'), '')
    from public.reservations r left join public.staff_members m on m.id = r.staff_id
    where r.source = 'app' and r.created_at > now() - interval '7 days' and r.created_at < now() - interval '2 minutes' and r.starts_at > now()
      and r.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
    union all
    -- 取り消し：サロンボードに入れてあった（「入れました」を押した）予約だけ
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), s.sent_at, app_private.staff_push_rescheduled(r.id), nullif(substring(r.note from '^お連れ様：(.+)様$'), '')
    from app_private.staff_push_cancel s join public.reservations r on r.id = s.reservation_id left join public.staff_members m on m.id = r.staff_id
    where s.acked_at is null and s.sent_at > now() - interval '7 days' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent n where n.reservation_id = r.id and n.acked_at is not null)
    union all
    -- 送り手が記録していないアプリでの取り消し（2分たっても）。これも入れてあった予約だけ
    select r.id, 'cancel', r.starts_at, r.customer_name, app_private.staff_push_label(r.nominated, m.display_name), r.cancelled_at, app_private.staff_push_rescheduled(r.id), nullif(substring(r.note from '^お連れ様：(.+)様$'), '')
    from public.reservations r left join public.staff_members m on m.id = r.staff_id
    where r.source = 'app' and r.status = 'cancelled' and r.cancel_reason in ('お客様アプリからキャンセル', 'お客様アプリで予約を変更（新しい予約へ）')
      and r.cancelled_at > now() - interval '7 days' and r.cancelled_at < now() - interval '2 minutes' and r.starts_at > now()
      and exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id and s.acked_at is not null)
      and not exists (select 1 from app_private.staff_push_cancel c where c.reservation_id = r.id)
  ) x);
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.staff_device_alert(p_reason text, p_app text, p_hint text, p_device_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- 11/11 店舗端末点検：PIN の打ち間違い（pin_fail）だけでは全体をロックしない（知らせは残す）。ロックは未登録の端末で正しい PIN（pin_ok）のとき
  if p_reason = 'pin_ok' then
    update app_private.staff_device_policy set locked_at = coalesce(locked_at, now()) where id = 1;
  end if;
  if exists (select 1 from app_private.staff_device_alerts a
             where a.acked_at is null and a.created_at > now() - interval '10 minutes'
               and (a.device_hash = p_device_hash or (p_device_hash is null and a.device_hash is null and a.reason = p_reason))) then
    return;
  end if;
  insert into app_private.staff_device_alerts (reason, app, hint, device_hash, ip, user_agent)
  values (p_reason, p_app, p_hint, p_device_hash, app_private.request_ip(), app_private.request_user_agent());
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_lockdown_status()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  -- 11/11 店舗端末点検：ログインしていない人にロックの有無を答えない
  select json_build_object('error', 'staff_auth_required')
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
        h app_private.gacha_holdings; v_gacha int := 0; v_gitem jsonb;
        v_is_comp boolean := false; v_comp uuid; v_comp_name text; v_owner text;
        -- 11/11：予約のない方の会計（お子様・お連れ様など）。会員ご本人の施術ではない印（予約がある会計では使わない）
        v_not_owner boolean := coalesce(p->>'not_owner', '') = 'true' and nullif(p->>'reservation_id', '') is null;
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
    -- 受ける人（11/8）：お連れ様の予約か
    v_is_comp := app_private.res_is_companion(r.companion_id, r.companion_of, r.note);
    if v_is_comp then v_comp := app_private.res_companion(r.id); v_comp_name := app_private.res_companion_name(r.id); end if;
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
       and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
      return jsonb_build_object('error', 'welcome_weekend');
    end if;
    -- Welcomeクーポン（初回パーマ 2,000円引き）はパーマ（セットを含む）のメニューがある会計だけ（10/27 慶一郎さん：カットでも使えていた）
    if exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2))
       and not exists (select 1 from jsonb_array_elements(v_items) i
                       where i->>'source' in ('reservation', 'service_menu') and coalesce(i->>'ref_id', '') ~ '^(perm|set)-') then
      return jsonb_build_object('error', 'welcome_perm_only');
    end if;
    -- Welcome クーポンは発行された会員本人の施術だけ（お連れ様の会計では使えない・11/8）
    if (v_is_comp or v_not_owner) and exists (select 1 from public.tickets t2 where t2.id = any(v_tids) and app_private.is_perm_coupon(t2)) then
      return jsonb_build_object('error', 'welcome_owner_only');
    end if;
    -- 監査 10/28 要対応3：同じお客様・同じ日の券の使用は順番に（ほかの使用が終わってから、今日の使用を読み直す）
    perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_tuser))[1] || ':' || app_private.today_jst()::text, 0));
    if exists (select 1 from unnest(v_types) as ticket_type(value) where not app_private.can_use_type(app_private.today_used_type(v_tuser), ticket_type.value)) then
      return jsonb_build_object('error', 'daily_rule');
    end if;
  end if;

  -- ガチャ券（予約に付いた券。11/4 工程②）。店舗端末が use_gacha を付けたときだけ使う
  if coalesce(p->>'use_gacha', '') = 'true' then
    if r.id is null then return jsonb_build_object('error', 'gacha_invalid'); end if;
    select * into h from app_private.gacha_holdings where reservation_id = r.id and used_at is null for update;
    if h.user_id is null then return jsonb_build_object('error', 'gacha_invalid'); end if;
    if h.weekday_only and app_private.gacha_offday(now()) then return jsonb_build_object('error', 'gacha_weekday'); end if;
    -- 本人だけの券（無料券以外・本人限定）はお連れ様の会計では使えない（予約に付けるときと同じ）
    if v_is_comp and (h.free_menu is null or h.self_only) then return jsonb_build_object('error', 'gacha_companion'); end if;
    if h.menu_codes is not null then
      select i into v_gitem from jsonb_array_elements(v_items) i
       where i->>'source' in ('reservation', 'service_menu') and i->>'ref_id' = any(h.menu_codes) limit 1;
      if v_gitem is null then return jsonb_build_object('error', 'gacha_menu'); end if;
    end if;
    -- 無料券はそのメニュー1つ分の料金（明細の値引き後）
    v_gacha := coalesce(h.amount, least((v_gitem->>'unit_price')::int,
      (v_gitem->>'unit_price')::int * coalesce((v_gitem->>'quantity')::int, 1) - coalesce((v_gitem->>'discount')::int, 0)));
    -- 値引き額が決まらない券（額もメニューも無い）は使わない（11/4 守り）
    if v_gacha is null or v_gacha < 0 then return jsonb_build_object('error', 'gacha_invalid'); end if;
    v_ticket_disc := v_ticket_disc + v_gacha;
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
  if h.user_id is not null then
    insert into public.accounting_discounts (session_id, kind, ticket_type, label, amount) values (v_id, 'ticket', 'gacha', 'ガチャ券 ' || h.title, v_gacha);
    update app_private.gacha_holdings set used_at = now(), used_sale_id = v_id where user_id = h.user_id;
  end if;
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
    -- 誰の施術に使ったか（お連れ様ならお名前と番号）も残す
    insert into public.ticket_usage_logs (usage_date, staff_name, customer_name, user_id, ticket_id, ticket_type, amount, terminal, status, treated_companion_id, treated_name)
    select app_private.today_jst(), btrim(p_actor_name), coalesce(v_name, ''), t2.user_id, t2.id::text, t2.type, t2.amount, 'ginjiro-os', 'used', v_comp, v_comp_name
    from public.tickets t2 where t2.id = any(v_tids);
  end if;
  -- 来店の記録は会員本人の施術だけ。対象メニューの施術なら、受ける人の14日をここ（会計の完了）から始める
  v_owner := coalesce(r.user_id, v_user);
  if v_owner is not null and not v_is_comp and not v_not_owner then perform app_private.touch_visit(v_owner, r.id is null); end if;
  if not v_not_owner then perform app_private.record_treatment(v_id, v_owner, v_comp, v_is_comp); end if;
  if v_not_owner then update public.accounting_sessions set not_owner = true where id = v_id; end if;

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

CREATE OR REPLACE FUNCTION app_private.client_menu_price(p_client uuid, p_code text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select i.price from public.accounting_session_items i
  join public.accounting_sessions s on s.id = i.session_id
  where p_client is not null and p_code is not null and s.status = 'completed'
    and s.client_id = any(app_private.client_family(app_private.client_root(p_client)))
    and i.source in ('reservation', 'service_menu') and i.ref_id = p_code and i.price is not null and i.price >= 0
    and not s.not_owner and not exists (select 1 from public.reservations rr where rr.id = s.reservation_id and app_private.res_is_companion(rr.companion_id, rr.companion_of, rr.note))
  order by s.completed_at desc nulls last, s.created_at desc, i.sort_order
  limit 1
$function$;

CREATE OR REPLACE FUNCTION app_private.client_menu_prices(p_client uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('menu_code', x.code, 'price', x.price) order by x.code), '[]'::jsonb) from (
    select distinct on (i.ref_id) i.ref_id as code, i.price
    from public.accounting_session_items i
    join public.accounting_sessions s on s.id = i.session_id
    where p_client is not null and s.status = 'completed'
      and s.client_id = any(app_private.client_family(app_private.client_root(p_client)))
      and i.source in ('reservation', 'service_menu') and i.ref_id is not null and i.price is not null and i.price >= 0
      and not s.not_owner and not exists (select 1 from public.reservations rr where rr.id = s.reservation_id and app_private.res_is_companion(rr.companion_id, rr.companion_of, rr.note))
      and exists (select 1 from public.service_menus m where m.code = i.ref_id)
    order by i.ref_id, s.completed_at desc nulls last, s.created_at desc, i.sort_order
  ) x
$function$;
