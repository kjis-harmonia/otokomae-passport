-- 店舗端末・銀二郎SB の台数制限と、登録していない端末からの侵入の知らせ（10/28 慶一郎さん）
--   1) 端末に「店舗端末（staff）／SB（sb）」の種類を持たせる。承認できる台数：店舗端末 2台・SB 6台（staff_device_policy で変えられる）
--   2) 「登録した端末だけ」がオンのとき、登録していない端末が PIN で入ろうとしたら（正しい PIN・3回続けて間違い）記録する
--      → 登録済みの端末の画面全体に警告（了解を押すまで）・SB のお知らせ（johnny-notify が毎分送る）
--   3) 開いている端末は種類と最終利用を本部へ知らせる（本部の一覧でどれが店舗端末か分かるように）

alter table app_private.staff_devices add column if not exists app text check (app in ('staff', 'sb'));
alter table app_private.staff_device_policy add column if not exists staff_limit int not null default 2 check (staff_limit between 1 and 20);
alter table app_private.staff_device_policy add column if not exists sb_limit int not null default 6 check (sb_limit between 1 and 30);

create table if not exists app_private.staff_device_alerts (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  reason      text not null check (reason in ('pin_ok', 'pin_fail')),
  app         text,
  hint        text,
  device_hash text,
  pushed_at   timestamptz,
  acked_at    timestamptz,
  acked_by    text
);
create index if not exists staff_device_alerts_open on app_private.staff_device_alerts (created_at) where acked_at is null;
alter table app_private.staff_device_alerts enable row level security;
revoke all on app_private.staff_device_alerts from anon, authenticated;

-- 侵入の記録：同じ端末（端末キーが無いときは同じ理由）の未確認の記録が10分以内にあれば重ねない
create or replace function app_private.staff_device_alert(p_reason text, p_app text, p_hint text, p_device_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from app_private.staff_device_alerts a
             where a.acked_at is null and a.created_at > now() - interval '10 minutes'
               and (a.device_hash = p_device_hash or (p_device_hash is null and a.device_hash is null and a.reason = p_reason))) then
    return;
  end if;
  insert into app_private.staff_device_alerts (reason, app, hint, device_hash) values (p_reason, p_app, p_hint, p_device_hash);
end;
$$;
revoke all on function app_private.staff_device_alert(text, text, text, text) from public, anon, authenticated;

-- ログイン：端末の種類を受け取る（p_app）。登録していない端末からの試みを記録する
drop function if exists public.staff_login(text, text, text);
create or replace function public.staff_login(p_pin text, p_device_key text default null, p_hint text default null, p_app text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
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
grant execute on function public.staff_login(text, text, text, text) to anon, authenticated;

-- 開いている端末から：種類と最終利用を記録し、未確認の侵入の知らせを返す（30秒ごと・画面に戻ったとき）
create or replace function public.staff_security_check(p_staff text, p_app text default null, p_hint text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_dev text;
begin
  perform app_private.assert_staff(p_staff);
  select s.device_hash into v_dev from app_private.staff_sessions s where s.token_hash = app_private.sha256_hex(p_staff);
  if v_dev is not null then
    update app_private.staff_devices
    set app = coalesce(app, case when p_app in ('staff', 'sb') then p_app end),
        hint = coalesce(nullif(left(btrim(coalesce(p_hint, '')), 80), ''), hint),
        last_seen_at = now()
    where key_hash = v_dev and last_seen_at < now() - interval '1 minute';
  end if;
  return json_build_object('alerts', coalesce((select json_agg(json_build_object('id', a.id, 'created_at', a.created_at, 'reason', a.reason, 'app', a.app, 'hint', a.hint) order by a.created_at)
    from app_private.staff_device_alerts a where a.acked_at is null and a.created_at > now() - interval '1 day'), '[]'::json));
end;
$function$;
grant execute on function public.staff_security_check(text, text, text) to anon, authenticated;

-- 了解：どの端末で押しても、全部の端末で消える
create or replace function public.staff_ack_device_alerts(p_staff text, p_ids bigint[], p_staff_name text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  perform app_private.assert_staff(p_staff);
  update app_private.staff_device_alerts
  set acked_at = now(), acked_by = coalesce(nullif(left(btrim(coalesce(p_staff_name, '')), 40), ''), 'スタッフ')
  where id = any(p_ids) and acked_at is null;
  return json_build_object('ok', true);
end;
$function$;
grant execute on function public.staff_ack_device_alerts(text, bigint[], text) to anon, authenticated;

-- 本部の一覧：種類・台数の上限・最近の侵入の記録も返す
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

-- 承認：種類ごとの上限まで（店舗端末 2台・SB 6台）。種類が分からない古い端末は、本部で選んだ種類で
drop function if exists public.hq_approve_staff_device(text, text, text);
create or replace function public.hq_approve_staff_device(p_hq text, p_id text, p_label text, p_app text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_dev app_private.staff_devices; v_app text; v_limit int; v_used int;
begin
  perform app_private.assert_hq(p_hq);
  if p_id is null or length(p_id) <> 16 then return json_build_object('error', 'not_found'); end if;
  -- 承認は1つずつ順番に（同時に押して上限を超えない）
  perform 1 from app_private.staff_device_policy where id = 1 for update;
  select * into v_dev from app_private.staff_devices where left(key_hash, 16) = p_id and revoked_at is null for update;
  if v_dev.key_hash is null then return json_build_object('error', 'not_found'); end if;
  v_app := coalesce(case when p_app in ('staff', 'sb') then p_app end, v_dev.app, 'staff');
  select case when v_app = 'sb' then sb_limit else staff_limit end into v_limit from app_private.staff_device_policy where id = 1;
  select count(*) into v_used from app_private.staff_devices
  where revoked_at is null and approved_at is not null and coalesce(app, 'staff') = v_app and key_hash <> v_dev.key_hash;
  if v_used >= v_limit then
    return json_build_object('error', 'limit_reached', 'app', v_app, 'limit', v_limit);
  end if;
  update app_private.staff_devices
  set approved_at = coalesce(approved_at, now()), approved_by = '本部', app = v_app,
      label = coalesce(nullif(left(btrim(coalesce(p_label, '')), 40), ''), label)
  where key_hash = v_dev.key_hash;
  return json_build_object('ok', true);
end;
$function$;
revoke all on function public.hq_approve_staff_device(text, text, text, text) from public;
grant execute on function public.hq_approve_staff_device(text, text, text, text) to anon, authenticated;

-- johnny-notify（毎分）から：まだ送っていない侵入の知らせと、SB のお知らせの送り先
create or replace function public.staff_device_alerts_for_sender(p_secret text)
 returns json
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_alerts json; v_subs json;
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  with fresh as (
    update app_private.staff_device_alerts set pushed_at = now()
    where pushed_at is null and acked_at is null and created_at > now() - interval '1 hour'
    returning id, created_at, reason, app, hint
  )
  select coalesce(json_agg(json_build_object('id', id, 'created_at', created_at, 'reason', reason, 'app', app, 'hint', hint) order by created_at), '[]'::json)
  into v_alerts from fresh;
  if v_alerts::text = '[]' then return json_build_object('alerts', v_alerts, 'subs', '[]'::json); end if;
  select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json) into v_subs
  from app_private.staff_push_subscriptions s;
  return json_build_object('alerts', v_alerts, 'subs', v_subs);
end;
$function$;
revoke all on function public.staff_device_alerts_for_sender(text) from public;
grant execute on function public.staff_device_alerts_for_sender(text) to anon, authenticated;
