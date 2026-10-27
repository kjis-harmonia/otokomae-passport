-- 店舗端末の2段階認証：本部で承認した端末だけ、スタッフPINでログインできる（10/27 慶一郎さん）
--   PIN が漏れても、知らない端末からは入れない。知らない端末で PIN を入れると「承認待ち」として本部に出る
--   最初は「承認なしでも入れる」（今までどおり）。本部で店の端末を承認してから「登録した端末だけ」をオンにする
--   端末は今までの app_private.staff_devices（PIN の入力ミスのロック用に端末ごとに覚えているもの）を使う

alter table app_private.staff_devices
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists label text,
  add column if not exists hint text;

-- どの端末から入ったか（端末を取り消したら、その端末のログインも切る）
alter table app_private.staff_sessions add column if not exists device_hash text;

-- 「登録した端末だけ」のスイッチ（1行だけ）
create table if not exists app_private.staff_device_policy (
  id smallint primary key default 1 check (id = 1),
  require_approval boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into app_private.staff_device_policy (id) values (1) on conflict (id) do nothing;

-- p_hint（端末の種類。例：iPad / Safari）を足すため、引数の違う古い形を外す（2つあると呼び分けられない）
drop function if exists public.staff_login(text, text);

create or replace function public.staff_login(p_pin text, p_device_key text default null, p_hint text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
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
    where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null;
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
$$;
revoke all on function public.staff_login(text, text, text) from public;
grant execute on function public.staff_login(text, text, text) to anon, authenticated;

-- ── 本部：端末の一覧・承認・取り消し・スイッチ ─────────────────────────────

/** 本部：店舗端末の一覧（承認待ちが上）と、「登録した端末だけ」のスイッチ */
create or replace function public.hq_staff_devices(p_hq text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return json_build_object(
    'require_approval', (select require_approval from app_private.staff_device_policy where id = 1),
    'devices', coalesce((select json_agg(json_build_object(
        'id', left(d.key_hash, 16), 'label', d.label, 'hint', d.hint, 'created_at', d.created_at, 'last_seen_at', d.last_seen_at,
        'approved_at', d.approved_at, 'approved_by', d.approved_by)
      order by (d.approved_at is not null), d.last_seen_at desc)
      from app_private.staff_devices d where d.revoked_at is null), '[]'::json));
end;
$$;

/** 本部：端末を承認する（名前を付ける。例：お店のiPad） */
create or replace function public.hq_approve_staff_device(p_hq text, p_id text, p_label text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_n int;
begin
  perform app_private.assert_hq(p_hq);
  if p_id is null or length(p_id) <> 16 then return json_build_object('error', 'not_found'); end if;
  update app_private.staff_devices
  set approved_at = now(), approved_by = '本部', label = nullif(left(btrim(coalesce(p_label, '')), 40), '')
  where left(key_hash, 16) = p_id and revoked_at is null;
  get diagnostics v_n = row_count;
  return case when v_n = 1 then json_build_object('ok', true) else json_build_object('error', 'not_found') end;
end;
$$;

/** 本部：端末を取り消す（その端末のログインも切る。もう一度使うには PIN を入れて承認し直す） */
create or replace function public.hq_revoke_staff_device(p_hq text, p_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_hash text;
begin
  perform app_private.assert_hq(p_hq);
  select key_hash into v_hash from app_private.staff_devices where left(key_hash, 16) = p_id and revoked_at is null;
  if v_hash is null then return json_build_object('error', 'not_found'); end if;
  update app_private.staff_devices set revoked_at = now() where key_hash = v_hash;
  update app_private.staff_sessions set revoked_at = now() where device_hash = v_hash and revoked_at is null;
  return json_build_object('ok', true);
end;
$$;

/** 本部：「登録した端末だけ」をオン・オフ。オンにしたら、承認していない端末のログインは切る（承認済みの端末はそのまま） */
create or replace function public.hq_set_staff_device_policy(p_hq text, p_require boolean)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  if p_require and not exists (select 1 from app_private.staff_devices where approved_at is not null and revoked_at is null) then
    return json_build_object('error', 'no_approved_device'); -- 1台も承認していないとお店で誰も入れなくなる
  end if;
  update app_private.staff_device_policy set require_approval = coalesce(p_require, false), updated_at = now(), updated_by = '本部' where id = 1;
  if p_require then
    update app_private.staff_sessions s set revoked_at = now()
    where s.revoked_at is null and s.expires_at > now()
      and not exists (select 1 from app_private.staff_devices d where d.key_hash = s.device_hash and d.approved_at is not null and d.revoked_at is null);
  end if;
  return json_build_object('ok', true);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.hq_staff_devices(text)',
    'public.hq_approve_staff_device(text, text, text)',
    'public.hq_revoke_staff_device(text, text)',
    'public.hq_set_staff_device_policy(text, boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
