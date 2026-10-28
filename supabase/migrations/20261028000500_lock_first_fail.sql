-- 侵入のロック：登録していない端末で PIN を1回でも間違えたらロックする（これまでは3回。10/28 慶一郎さん）
--   関数は本番の定義（20261028000400 適用後）の、その1行だけを変える

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
