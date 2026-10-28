-- 侵入のロック（10/28 慶一郎さん）：登録していない端末が PIN で入ろうとしたら、店舗端末・SB のすべての操作を止める。
--   砂嵐の警告は了解を押しても消えない（了解は「見た」の記録だけ）。慶一郎さんの確認のあと、本部の「解除」で再開する
--   ロック中は約3分ごとに SB へお知らせを送り直す（iPad・iPhone は他のアプリの上に画面を出せないため）
--   お客様のアプリ・本部は止めない

alter table app_private.staff_device_policy add column if not exists locked_at timestamptz;
alter table app_private.staff_device_policy add column if not exists lock_reminded_at timestamptz;
alter table app_private.staff_device_policy add column if not exists released_at timestamptz;
alter table app_private.staff_device_policy add column if not exists released_by text;

-- 侵入の記録と同時にロックする
create or replace function app_private.staff_device_alert(p_reason text, p_app text, p_hint text, p_device_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update app_private.staff_device_policy set locked_at = coalesce(locked_at, now()) where id = 1;
  if exists (select 1 from app_private.staff_device_alerts a
             where a.acked_at is null and a.created_at > now() - interval '10 minutes'
               and (a.device_hash = p_device_hash or (p_device_hash is null and a.device_hash is null and a.reason = p_reason))) then
    return;
  end if;
  insert into app_private.staff_device_alerts (reason, app, hint, device_hash) values (p_reason, p_app, p_hint, p_device_hash);
end;
$$;
revoke all on function app_private.staff_device_alert(text, text, text, text) from public, anon, authenticated;

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
  -- 10/28：登録していない端末からの侵入でロック中は、店舗端末・SB のすべての操作を止める（本部で解除するまで）
  if exists (select 1 from app_private.staff_device_policy pol where pol.id = 1 and pol.locked_at is not null) then
    raise exception 'staff_locked' using errcode = '28000';
  end if;
end;
$function$;

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
    -- 登録していない端末で3回続けて間違えたら、登録済みの端末へ知らせる
    if v_policy and v_dev.approved_at is null and app_private.recent_failures('staff_pin', v_subject, 10) >= 3 then
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

-- ロック中かどうか（PIN の画面でも砂嵐を出すため。中身は出さない）
create or replace function public.staff_lockdown_status()
 returns json language sql stable security definer set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  select json_build_object('locked', locked_at is not null, 'since', locked_at) from app_private.staff_device_policy where id = 1
$function$;
grant execute on function public.staff_lockdown_status() to anon, authenticated;

-- 開いている端末から：ロック中でも答える（セッションだけ確かめる）
create or replace function public.staff_security_check(p_staff text, p_app text default null, p_hint text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_dev text; v_locked timestamptz;
begin
  if not public.staff_session_valid(p_staff) then raise exception 'staff_auth_required' using errcode = '28000'; end if;
  select s.device_hash into v_dev from app_private.staff_sessions s where s.token_hash = app_private.sha256_hex(p_staff);
  if v_dev is not null then
    update app_private.staff_devices
    set app = coalesce(app, case when p_app in ('staff', 'sb') then p_app end),
        hint = coalesce(nullif(left(btrim(coalesce(p_hint, '')), 80), ''), hint),
        last_seen_at = now()
    where key_hash = v_dev and last_seen_at < now() - interval '1 minute';
  end if;
  select locked_at into v_locked from app_private.staff_device_policy where id = 1;
  return json_build_object('locked', v_locked is not null, 'since', v_locked,
    'alerts', coalesce((select json_agg(json_build_object('id', a.id, 'created_at', a.created_at, 'reason', a.reason, 'app', a.app, 'hint', a.hint, 'acked_at', a.acked_at, 'acked_by', a.acked_by) order by a.created_at)
      from app_private.staff_device_alerts a
      where (v_locked is not null and a.created_at >= v_locked - interval '1 minute') or (a.acked_at is null and a.created_at > now() - interval '1 day')), '[]'::json));
end;
$function$;

-- 了解：見たことの記録だけ。ロック中は解除しない（本部の解除まで砂嵐のまま）
create or replace function public.staff_ack_device_alerts(p_staff text, p_ids bigint[], p_staff_name text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  if not public.staff_session_valid(p_staff) then raise exception 'staff_auth_required' using errcode = '28000'; end if;
  update app_private.staff_device_alerts
  set acked_at = now(), acked_by = coalesce(nullif(left(btrim(coalesce(p_staff_name, '')), 40), ''), 'スタッフ')
  where id = any(p_ids) and acked_at is null;
  return json_build_object('ok', true);
end;
$function$;

-- 本部：解除（慶一郎さんの確認のあと）。了解していない記録もまとめて了解にする
create or replace function public.hq_release_lockdown(p_hq text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  perform app_private.assert_hq(p_hq);
  update app_private.staff_device_alerts set acked_at = now(), acked_by = '本部（解除）' where acked_at is null;
  update app_private.staff_device_policy set locked_at = null, lock_reminded_at = null, released_at = now(), released_by = '本部' where id = 1;
  return json_build_object('ok', true);
end;
$function$;
revoke all on function public.hq_release_lockdown(text) from public;
grant execute on function public.hq_release_lockdown(text) to anon, authenticated;

-- 本部の一覧：ロックの状態も返す
create or replace function public.hq_staff_devices(p_hq text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  perform app_private.assert_hq(p_hq);
  return json_build_object(
    'require_approval', (select require_approval from app_private.staff_device_policy where id = 1),
    'locked_at', (select locked_at from app_private.staff_device_policy where id = 1),
    'limits', (select json_build_object('staff', staff_limit, 'sb', sb_limit) from app_private.staff_device_policy where id = 1),
    'devices', coalesce((select json_agg(json_build_object(
        'id', left(d.key_hash, 16), 'label', d.label, 'hint', d.hint, 'app', d.app, 'created_at', d.created_at, 'last_seen_at', d.last_seen_at,
        'approved_at', d.approved_at, 'approved_by', d.approved_by)
      order by (d.approved_at is not null), d.last_seen_at desc)
      from app_private.staff_devices d where d.revoked_at is null), '[]'::json),
    'alerts', coalesce((select json_agg(json_build_object('id', a.id, 'created_at', a.created_at, 'reason', a.reason, 'app', a.app, 'hint', a.hint,
        'acked_at', a.acked_at, 'acked_by', a.acked_by) order by a.created_at desc)
      from (select * from app_private.staff_device_alerts where created_at > now() - interval '30 days' order by created_at desc limit 50) a), '[]'::json));
end;
$function$;

-- johnny-notify（毎分）から：新しい侵入の知らせ＋ロック中は約3分ごとの送り直し
create or replace function public.staff_device_alerts_for_sender(p_secret text)
 returns json
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_alerts json; v_subs json; v_remind boolean := false;
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  with fresh as (
    update app_private.staff_device_alerts set pushed_at = now()
    where pushed_at is null and created_at > now() - interval '1 hour'
    returning id, created_at, reason, app, hint
  )
  select coalesce(json_agg(json_build_object('id', id, 'created_at', created_at, 'reason', reason, 'app', app, 'hint', hint) order by created_at), '[]'::json)
  into v_alerts from fresh;
  if v_alerts::text <> '[]' then
    update app_private.staff_device_policy set lock_reminded_at = now() where id = 1;
  else
    with r as (
      update app_private.staff_device_policy set lock_reminded_at = now()
      where id = 1 and locked_at is not null and coalesce(lock_reminded_at, locked_at) < now() - interval '170 seconds'
      returning 1
    ) select exists (select 1 from r) into v_remind;
  end if;
  if v_alerts::text = '[]' and not v_remind then return json_build_object('alerts', v_alerts, 'remind', false, 'subs', '[]'::json); end if;
  select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json) into v_subs
  from app_private.staff_push_subscriptions s;
  return json_build_object('alerts', v_alerts, 'remind', v_remind, 'subs', v_subs);
end;
$function$;
