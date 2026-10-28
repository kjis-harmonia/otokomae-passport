-- 本部も登録した端末だけ（10/28 慶一郎さん：テイテイさんも本部を使うため、本部 PIN だけに頼らない）
--   本部の端末を承認制にする（上限3台）。「本部も登録した端末だけ」がオンのとき、登録していない端末は本部 PIN が合っていても入れない
--   登録していない端末で本部 PIN を入れたら（合っていても・1回の間違いでも）、店舗端末と同じく記録してロック（砂嵐・お知らせ）
--   ロック中も、登録した本部の端末は入れる（解除するため）

alter table app_private.hq_devices add column if not exists approved_at timestamptz;
alter table app_private.hq_devices add column if not exists approved_by text;
alter table app_private.hq_devices add column if not exists label text;
alter table app_private.hq_devices add column if not exists hint text;
alter table app_private.hq_sessions add column if not exists device_hash text;
alter table app_private.staff_device_policy add column if not exists hq_require_approval boolean not null default false;
alter table app_private.staff_device_policy add column if not exists hq_limit int not null default 3 check (hq_limit between 1 and 10);

-- 本部のセッション：本部も登録制がオンなら、承認した端末のセッションだけ
create or replace function app_private.hq_session_ok(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_token is not null and exists (
    select 1 from app_private.hq_sessions hs
    where hs.token_hash = app_private.sha256_hex(p_token) and hs.revoked_at is null and hs.expires_at > now()
      and (
        not coalesce((select pol.hq_require_approval from app_private.staff_device_policy pol where pol.id = 1), false)
        or exists (select 1 from app_private.hq_devices dv where dv.key_hash = hs.device_hash and dv.revoked_at is null and dv.approved_at is not null)
      )
  )
$$;
revoke all on function app_private.hq_session_ok(text) from public, anon, authenticated;

create or replace function app_private.assert_hq(p_token text)
 returns void
 language plpgsql
 stable
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  if not app_private.hq_session_ok(p_token) then
    raise exception 'hq_auth_required' using errcode = '28000';
  end if;
end;
$function$;

create or replace function public.hq_session_valid(p_token text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  select app_private.hq_session_ok(p_token)
$function$;

-- 本部のログイン：端末の種類（p_hint）を受け取る。登録していない端末は記録してロック
drop function if exists public.hq_login(text, text);
create or replace function public.hq_login(p_pin text, p_device_key text default null, p_hint text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
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
grant execute on function public.hq_login(text, text, text) to anon, authenticated;

-- 本部の端末の一覧（いま使っている端末も分かるように）
create or replace function public.hq_hq_devices(p_hq text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_mine text;
begin
  perform app_private.assert_hq(p_hq);
  select device_hash into v_mine from app_private.hq_sessions where token_hash = app_private.sha256_hex(p_hq);
  return json_build_object(
    'require_approval', (select hq_require_approval from app_private.staff_device_policy where id = 1),
    'limit', (select hq_limit from app_private.staff_device_policy where id = 1),
    'devices', coalesce((select json_agg(json_build_object(
        'id', left(d.key_hash, 16), 'label', d.label, 'hint', d.hint, 'created_at', d.created_at, 'last_seen_at', d.last_seen_at,
        'approved_at', d.approved_at, 'mine', d.key_hash = v_mine)
      order by (d.approved_at is not null), d.last_seen_at desc)
      from app_private.hq_devices d where d.revoked_at is null), '[]'::json));
end;
$function$;
grant execute on function public.hq_hq_devices(text) to anon, authenticated;

create or replace function public.hq_approve_hq_device(p_hq text, p_id text, p_label text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_dev app_private.hq_devices; v_used int; v_limit int;
begin
  perform app_private.assert_hq(p_hq);
  if p_id is null or length(p_id) <> 16 then return json_build_object('error', 'not_found'); end if;
  perform 1 from app_private.staff_device_policy where id = 1 for update;
  select * into v_dev from app_private.hq_devices where left(key_hash, 16) = p_id and revoked_at is null for update;
  if v_dev.key_hash is null then return json_build_object('error', 'not_found'); end if;
  select hq_limit into v_limit from app_private.staff_device_policy where id = 1;
  select count(*) into v_used from app_private.hq_devices where revoked_at is null and approved_at is not null and key_hash <> v_dev.key_hash;
  if v_used >= v_limit then return json_build_object('error', 'limit_reached', 'limit', v_limit); end if;
  update app_private.hq_devices
  set approved_at = coalesce(approved_at, now()), approved_by = '本部',
      label = coalesce(nullif(left(btrim(coalesce(p_label, '')), 40), ''), label)
  where key_hash = v_dev.key_hash;
  return json_build_object('ok', true);
end;
$function$;
grant execute on function public.hq_approve_hq_device(text, text, text) to anon, authenticated;

-- 取消：その端末の本部のログインも切る。いま使っている端末は取り消せない（自分を締め出さない）
create or replace function public.hq_revoke_hq_device(p_hq text, p_id text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_hash text; v_mine text;
begin
  perform app_private.assert_hq(p_hq);
  select device_hash into v_mine from app_private.hq_sessions where token_hash = app_private.sha256_hex(p_hq);
  select key_hash into v_hash from app_private.hq_devices where left(key_hash, 16) = p_id and revoked_at is null;
  if v_hash is null then return json_build_object('error', 'not_found'); end if;
  if v_hash = v_mine then return json_build_object('error', 'own_device'); end if;
  update app_private.hq_devices set revoked_at = now() where key_hash = v_hash;
  update app_private.hq_sessions set revoked_at = now() where device_hash = v_hash and revoked_at is null;
  return json_build_object('ok', true);
end;
$function$;
grant execute on function public.hq_revoke_hq_device(text, text) to anon, authenticated;

-- 本部も登録した端末だけ：オンにできるのは、いま使っている端末が承認済みのときだけ（自分を締め出さない）
create or replace function public.hq_set_hq_device_policy(p_hq text, p_require boolean)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_mine text;
begin
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
grant execute on function public.hq_set_hq_device_policy(text, boolean) to anon, authenticated;

-- 開いている本部から：この端末の番号とセッションを結びつける（この仕組みの前にログインしたセッション用）・最終利用を記録
create or replace function public.hq_bind_device(p_hq text, p_device_key text, p_hint text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_dev text;
begin
  perform app_private.assert_hq(p_hq);
  if p_device_key is null or length(p_device_key) < 32 then return json_build_object('ok', false); end if;
  select key_hash into v_dev from app_private.hq_devices where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null;
  if v_dev is null then return json_build_object('ok', false); end if;
  update app_private.hq_sessions set device_hash = v_dev where token_hash = app_private.sha256_hex(p_hq) and device_hash is null;
  update app_private.hq_devices set last_seen_at = now(), hint = coalesce(nullif(left(btrim(coalesce(p_hint, '')), 80), ''), hint)
  where key_hash = v_dev and last_seen_at < now() - interval '1 minute';
  return json_build_object('ok', true);
end;
$function$;
grant execute on function public.hq_bind_device(text, text, text) to anon, authenticated;
