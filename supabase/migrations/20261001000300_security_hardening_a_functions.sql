-- =============================================================================
-- 20261001_security_hardening_a_functions.sql   【ステップA：追加のみ】
--
-- 新しい RPC・トークン表・PIN/パスコード保存先を追加するだけで、既存テーブルの
-- アクセス権は変更しない。適用しても今のアプリはそのまま動く。
-- 閉鎖（allow_all 廃止・旧RPCの anon 実行権削除）は新アプリ公開後に ..._b_lockdown.sql で行う。
--
-- 前提：20261001_welcome_coupon_onboarding.sql 適用済み（customers の first_visit_* 列）
--
-- 認可モデル
--   店舗端末  : PIN をサーバーで照合 → スタッフセッショントークン（14時間）。staff_* RPC の p_staff。
--               一度成功した端末には「端末キー」を発行し、ロック判定を端末ごとに分ける。
--   本部画面  : 本部専用 PIN（6桁・店舗スタッフ PIN とは別）をサーバーで照合 → 本部セッション（14時間）。
--               hq_* RPC の p_hq。店舗スタッフセッションでは本部 RPC を使えない。
--   お客様    : 顧客セッショントークン（長期・失効可）。customer_* RPC の p_session。
--               user_id はサーバーがトークンから特定する。p_user_id を本人確認に使う RPC は無い。
--               新規会員：customer_register がサーバー側で user_id を採番し、同時にトークンを発行。
--               既存会員：店頭でスタッフが発行する 10分有効・1回限りの紐付けコードでのみトークン発行。
--
-- 対象外（今回は allow_all を維持＝残存リスク）:
--   本部画面(/headquarters)が直接使う accounting_items / accounting_sessions /
--   accounting_session_items / products / daily_reports / customer_notes
--
-- 適用前に必ず docs/security-hardening.md の「適用手順」を確認すること。
-- このファイルは何度実行しても同じ状態になる（冪等）ように書いている。
-- =============================================================================

create extension if not exists pgcrypto;

-- ── 0. 非公開スキーマ（PostgREST からは見えない） ───────────────────────────
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- スタッフPIN / SHOPパスコード（bcrypt ハッシュのみ保存）
create table if not exists app_private.secrets (
  key         text        primary key,           -- 'staff_pin' | 'shop_passcode'
  hash        text        not null,
  updated_at  timestamptz not null default now()
);

-- スタッフセッション（トークンは SHA-256 ハッシュのみ保存）
create table if not exists app_private.staff_sessions (
  token_hash  text        primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index if not exists staff_sessions_expires_idx on app_private.staff_sessions (expires_at);

-- 総当たり対策用の試行ログ（subject: 'device:<hash>' / 'session:<hash>' / 'unregistered'）
create table if not exists app_private.auth_attempts (
  id            bigserial   primary key,
  kind          text        not null,             -- 'staff_pin' | 'shop_passcode' | 'register'
  success       boolean     not null,
  attempted_at  timestamptz not null default now()
);
alter table app_private.auth_attempts add column if not exists subject text not null default 'unregistered';
create index if not exists auth_attempts_kind_time_idx on app_private.auth_attempts (kind, attempted_at desc);
create index if not exists auth_attempts_subject_idx on app_private.auth_attempts (kind, subject, attempted_at desc);

-- 店舗端末の端末キー（PIN 成功時に発行。ハッシュのみ保存）
create table if not exists app_private.staff_devices (
  key_hash      text        primary key,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz
);

-- 顧客セッション（お客様端末の長期トークン。ハッシュのみ保存）
create table if not exists app_private.customer_sessions (
  token_hash    text        primary key,
  user_id       text        not null,
  created_via   text        not null,             -- 'register' | 'bind_code'
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz
);
create index if not exists customer_sessions_user_idx on app_private.customer_sessions (user_id);

-- 既存会員の紐付けコード（店頭でスタッフが発行。10分有効・1回限り・5回失敗で無効）
create table if not exists app_private.customer_bind_codes (
  id          bigserial   primary key,
  user_id     text        not null,
  code_hash   text        not null,
  created_by  text        not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    integer     not null default 0
);
create index if not exists customer_bind_codes_user_idx on app_private.customer_bind_codes (user_id, created_at desc);

-- 本部セッション（本部画面専用。店舗スタッフセッションとは別表。ハッシュのみ保存）
create table if not exists app_private.hq_sessions (
  token_hash  text        primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index if not exists hq_sessions_expires_idx on app_private.hq_sessions (expires_at);

-- 本部端末キー（本部 PIN 成功時に発行。ロック判定を端末ごとに分ける）
create table if not exists app_private.hq_devices (
  key_hash      text        primary key,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz
);

-- ── 0-1. 内部ヘルパー ─────────────────────────────────────────────────────────

create or replace function app_private.today_jst()
returns date language sql stable
set search_path = pg_catalog
as $$ select (now() at time zone 'Asia/Tokyo')::date $$;

create or replace function app_private.sha256_hex(p text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$ select encode(digest(p, 'sha256'), 'hex') $$;

/** 直近 p_minutes 分の失敗回数（kind × subject 単位） */
create or replace function app_private.recent_failures(p_kind text, p_subject text, p_minutes integer)
returns integer language sql stable
set search_path = pg_catalog
as $$
  select count(*)::int
  from app_private.auth_attempts
  where kind = p_kind and subject = p_subject and success = false
    and attempted_at > now() - make_interval(mins => p_minutes)
$$;

/** 顧客セッション → user_id。無効なら例外 customer_auth_required */
create or replace function app_private.session_user_id(p_session text)
returns text language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_uid text; v_seen timestamptz; v_hash text;
begin
  if p_session is null or length(p_session) < 32 then
    raise exception 'customer_auth_required' using errcode = '28000';
  end if;
  v_hash := app_private.sha256_hex(p_session);
  select user_id, last_seen_at into v_uid, v_seen
  from app_private.customer_sessions where token_hash = v_hash and revoked_at is null;
  if v_uid is null then
    raise exception 'customer_auth_required' using errcode = '28000';
  end if;
  if v_seen < now() - interval '1 hour' then
    update app_private.customer_sessions set last_seen_at = now() where token_hash = v_hash;
  end if;
  return v_uid;
end;
$$;

/** 顧客セッション発行（平文トークンを返す。DBにはハッシュのみ） */
create or replace function app_private.new_customer_session(p_user_id text, p_via text)
returns text language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_token text := encode(gen_random_bytes(32), 'hex');
begin
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex(v_token), p_user_id, p_via);
  return v_token;
end;
$$;

/** Welcomeクーポン判定（特殊パーマ ¥2,000） */
create or replace function app_private.is_welcome(t public.tickets)
returns boolean language sql immutable
set search_path = pg_catalog
as $$ select t.issued_by = 'system-welcome' or (t.title = '特殊パーマ Welcomeクーポン' and t.amount = 2000) $$;

/** スタッフセッション検証。無効なら例外 staff_auth_required */
create or replace function app_private.assert_staff(p_token text)
returns void language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
begin
  if p_token is null or not exists (
    select 1 from app_private.staff_sessions
    where token_hash = app_private.sha256_hex(p_token)
      and revoked_at is null
      and expires_at > now()
  ) then
    raise exception 'staff_auth_required' using errcode = '28000';
  end if;
end;
$$;

/** 本部セッション検証。無効なら例外 hq_auth_required（スタッフセッションでは通らない） */
create or replace function app_private.assert_hq(p_token text)
returns void language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
begin
  if p_token is null or not exists (
    select 1 from app_private.hq_sessions
    where token_hash = app_private.sha256_hex(p_token)
      and revoked_at is null
      and expires_at > now()
  ) then
    raise exception 'hq_auth_required' using errcode = '28000';
  end if;
end;
$$;

/** 管理者が SQL Editor から実行する：PIN / パスコードの設定（アプリからは呼べない） */
create or replace function app_private.set_secret(p_key text, p_plain text)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if p_key not in ('staff_pin', 'shop_passcode', 'hq_pin') then
    raise exception 'unknown secret key: %', p_key;
  end if;
  if p_key = 'staff_pin' and (p_plain is null or p_plain !~ '^[0-9]{6}$') then
    raise exception 'staff_pin must be 6 digits';
  end if;
  if p_key = 'hq_pin' and (p_plain is null or p_plain !~ '^[0-9]{6}$') then
    raise exception 'hq_pin must be 6 digits';
  end if;
  if p_plain is null or length(p_plain) < 4 then
    raise exception 'secret too short';
  end if;
  insert into app_private.secrets (key, hash, updated_at)
  values (p_key, crypt(p_plain, gen_salt('bf', 10)), now())
  on conflict (key) do update set hash = excluded.hash, updated_at = now();
  -- PIN変更時は既存セッションをすべて失効
  if p_key = 'staff_pin' then
    update app_private.staff_sessions set revoked_at = now() where revoked_at is null;
  end if;
  if p_key = 'hq_pin' then
    update app_private.hq_sessions set revoked_at = now() where revoked_at is null;
  end if;
end;
$$;

-- ── 1. 認証 RPC（anon から呼べる） ────────────────────────────────────────────

drop function if exists public.staff_login(text);

/**
 * PIN照合 → スタッフセッショントークン発行（14時間有効）
 *   登録済み端末（p_device_key が有効）：その端末の失敗が10分で5回以上ならその端末だけロック
 *   未登録端末：未登録端末全体の失敗が10分で10回以上なら未登録端末からのログインを一時停止
 *   → 第三者がわざと失敗しても、登録済みの店舗端末はロックされない
 *   成功時、未登録端末には端末キーを発行して返す（device_key）。
 */
create or replace function public.staff_login(p_pin text, p_device_key text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash     text;
  v_token    text;
  v_exp      timestamptz := now() + interval '14 hours';
  v_dev_hash text;
  v_subject  text;
  v_new_key  text;
begin
  if p_device_key is not null and length(p_device_key) >= 32 then
    select key_hash into v_dev_hash from app_private.staff_devices
    where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null;
  end if;
  v_subject := case when v_dev_hash is not null then 'device:' || v_dev_hash else 'unregistered' end;

  if (v_dev_hash is not null and app_private.recent_failures('staff_pin', v_subject, 10) >= 5)
     or (v_dev_hash is null and app_private.recent_failures('staff_pin', 'unregistered', 10) >= 10) then
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

  if v_dev_hash is null then
    v_new_key := encode(gen_random_bytes(32), 'hex');
    insert into app_private.staff_devices (key_hash) values (app_private.sha256_hex(v_new_key));
  else
    update app_private.staff_devices set last_seen_at = now() where key_hash = v_dev_hash;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_token), v_exp);
  delete from app_private.staff_sessions where expires_at < now() - interval '7 days';
  delete from app_private.auth_attempts where attempted_at < now() - interval '30 days';
  return json_build_object('token', v_token, 'expires_at', v_exp, 'device_key', v_new_key);
end;
$$;

/** 管理者が SQL Editor から実行：端末キーを全て失効（端末紛失時など） */
create or replace function app_private.revoke_staff_devices()
returns void language sql
set search_path = pg_catalog
as $$ update app_private.staff_devices set revoked_at = now() where revoked_at is null $$;

create or replace function public.staff_session_valid(p_token text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from app_private.staff_sessions
    where token_hash = app_private.sha256_hex(p_token) and revoked_at is null and expires_at > now()
  )
$$;

create or replace function public.staff_logout(p_token text)
returns void language sql security definer
set search_path = public, extensions, pg_temp
as $$
  update app_private.staff_sessions set revoked_at = now()
  where token_hash = app_private.sha256_hex(p_token) and revoked_at is null
$$;

drop function if exists public.verify_shop_passcode(text);

/**
 * SHOPパスコード照合（正誤のみ返す）
 *   顧客セッションあり：その端末の失敗が10分で5回以上ならその端末だけロック
 *   顧客セッションなし：セッション無し全体の失敗が10分で30回以上なら一時停止
 */
create or replace function public.verify_shop_passcode(p_passcode text, p_session text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_hash text; v_subject text := 'unregistered'; v_uid text;
begin
  if p_session is not null then
    begin
      v_uid := app_private.session_user_id(p_session);
      v_subject := 'session:' || app_private.sha256_hex(p_session);
    exception when others then
      v_subject := 'unregistered';
    end;
  end if;
  if (v_subject <> 'unregistered' and app_private.recent_failures('shop_passcode', v_subject, 10) >= 5)
     or (v_subject = 'unregistered' and app_private.recent_failures('shop_passcode', 'unregistered', 10) >= 30) then
    return json_build_object('ok', false, 'error', 'locked');
  end if;
  select hash into v_hash from app_private.secrets where key = 'shop_passcode';
  if v_hash is null then
    return json_build_object('ok', false, 'error', 'not_configured');
  end if;
  if p_passcode is null or crypt(p_passcode, v_hash) <> v_hash then
    insert into app_private.auth_attempts (kind, success, subject) values ('shop_passcode', false, v_subject);
    return json_build_object('ok', false, 'error', 'invalid');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('shop_passcode', true, v_subject);
  return json_build_object('ok', true);
end;
$$;

-- ── 2. メンテナンスクーポン用トークン表 ───────────────────────────────────────

create table if not exists public.maintenance_coupon_tokens (
  token        uuid        primary key default gen_random_uuid(),
  user_id      text        not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_by      text,
  revoked_at   timestamptz
);
create index if not exists maintenance_coupon_tokens_user_idx on public.maintenance_coupon_tokens (user_id, created_at desc);
alter table public.maintenance_coupon_tokens enable row level security;
-- ポリシー無し = anon からは一切読み書き不可（RPC 経由のみ）

-- ── 2-1. 内部ヘルパー（業務ルール） ───────────────────────────────────────────

/** 14日判定：登録日 = 残り14、翌日 = 13 … 15日目に期限切れ */
create or replace function app_private.maintenance_days_remaining(p_user_id text)
returns integer language sql stable
set search_path = pg_catalog
as $$
  select 14 - (app_private.today_jst() - v.last_visit_date)
  from public.maintenance_visits v where v.user_id = p_user_id
$$;

/**
 * 当日の割引利用ルール（既存 canUseDiscountType と同一）
 *   - 当日未使用 → 可
 *   - 異なる種別の併用 → 不可
 *   - メンテナンスクーポン(coupon) は1日1回
 *   - 漢トク券・割引券は同種なら複数枚可
 */
create or replace function app_private.today_used_type(p_user_id text)
returns text language sql stable
set search_path = pg_catalog
as $$
  select ticket_type from public.ticket_usage_logs
  where user_id = p_user_id and usage_date = app_private.today_jst() and status = 'used'
  order by used_at limit 1
$$;

create or replace function app_private.can_use_type(p_used text, p_attempted text)
returns boolean language sql immutable
set search_path = pg_catalog
as $$
  select case
    when p_used is null then true
    when p_used <> p_attempted then false
    else p_attempted <> 'coupon'
  end
$$;

create or replace function app_private.touch_visit(p_user_id text)
returns void language sql
set search_path = pg_catalog
as $$
  insert into public.maintenance_visits (user_id, last_visit_date, updated_at)
  values (p_user_id, app_private.today_jst(), now())
  on conflict (user_id) do update
    set last_visit_date = excluded.last_visit_date, updated_at = now()
$$;

create or replace function app_private.ticket_json(t public.tickets)
returns json language sql stable
set search_path = pg_catalog
as $$
  select (to_jsonb(t) || jsonb_build_object('pending_transfer', exists (
    select 1 from public.ticket_transfers x
    where x.ticket_id = t.id and x.status = 'pending' and x.expires_at > now()
  )))::json
$$;

-- ── 3. お客様アプリ用 RPC（顧客セッション必須。user_id はサーバーが特定） ─────

-- 旧設計（p_user_id を本人として信用する）関数は作らない。過去に作成済みなら削除。
drop function if exists public.get_my_tickets(text);
drop function if exists public.get_my_last_visit(text);
drop function if exists public.get_my_customer(text);
drop function if exists public.get_my_today_usage(text);
drop function if exists public.create_ticket_transfer(text, uuid);
drop function if exists public.cancel_ticket_transfer(text, uuid);
drop function if exists public.issue_maintenance_coupon_token(text);

/**
 * 新規会員登録（初回オンボーディング）。
 *   user_id はサーバーが採番し、同時に顧客セッションを発行して返す（クライアントは user_id を選べない）。
 *   p_has_visited_before = false（「いいえ」）のときだけ Welcomeクーポンを1枚発行。
 *   大量登録によるクーポン目的の濫用対策として、全体で10分100件を超えると一時停止。
 */
create or replace function public.customer_register(p_name text, p_has_visited_before boolean)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_uid     text;
  v_code    text;
  v_c       public.customers;
  v_ticket  public.tickets;
  v_session text;
  i int;
begin
  if v_name = '' or length(v_name) > 40 then
    return json_build_object('error', 'invalid_name');
  end if;
  if (select count(*) from app_private.auth_attempts
      where kind = 'register' and attempted_at > now() - interval '10 minutes') >= 100 then
    return json_build_object('error', 'rate_limited');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('register', true, 'unregistered');

  v_uid := 'u-' || encode(gen_random_bytes(12), 'hex');
  for i in 1..5 loop
    v_code := 'GIN-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 4)) || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 4));
    exit when not exists (select 1 from public.customers where recovery_code = v_code);
  end loop;

  insert into public.customers (user_id, name, recovery_code, normalized_name,
                                first_visit_answered_at, first_visit_has_visited_before)
  values (v_uid, v_name, v_code, lower(regexp_replace(replace(v_name, '　', ''), '\s+', '', 'g')),
          now(), coalesce(p_has_visited_before, true))
  returning * into v_c;
  insert into public.customer_user_aliases (customer_id, user_id, is_current)
  values (v_c.id, v_uid, true) on conflict (user_id) do nothing;

  if p_has_visited_before is false then
    insert into public.tickets (user_id, type, title, amount, memo, issued_by, used)
    values (v_uid, 'discount', '特殊パーマ Welcomeクーポン', 2000,
            '対象: 特殊パーマ / 平日のみ（土日利用不可） / 新規のお客様限定', 'system-welcome', false)
    returning * into v_ticket;
    update public.customers set welcome_coupon_issued_at = now() where id = v_c.id;
  end if;

  v_session := app_private.new_customer_session(v_uid, 'register');
  return json_build_object(
    'user_id', v_uid,
    'session', v_session,
    'ticket', case when v_ticket.id is null then null else row_to_json(v_ticket) end,
    'welcome_coupon_issued', v_ticket.id is not null
  );
end;
$$;

/**
 * 既存会員の紐付け：店頭でスタッフが発行した紐付けコードで顧客セッションを発行。
 *   コードは10分有効・1回限り・5回失敗で無効。成功時はその会員の既存セッションをすべて失効させる。
 */
create or replace function public.customer_bind_with_code(p_user_id text, p_code text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_row app_private.customer_bind_codes; v_session text;
begin
  select * into v_row from app_private.customer_bind_codes
  where user_id = p_user_id and used_at is null and expires_at > now()
  order by created_at desc limit 1
  for update;
  if not found then return json_build_object('error', 'bind_code_invalid'); end if;
  if v_row.attempts >= 5 then return json_build_object('error', 'bind_code_locked'); end if;
  if p_code is null or app_private.sha256_hex(btrim(p_code)) <> v_row.code_hash then
    update app_private.customer_bind_codes set attempts = attempts + 1 where id = v_row.id;
    return json_build_object('error', 'bind_code_invalid');
  end if;
  update app_private.customer_bind_codes set used_at = now() where id = v_row.id;
  update app_private.customer_sessions set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  v_session := app_private.new_customer_session(p_user_id, 'bind_code');
  return json_build_object('user_id', p_user_id, 'session', v_session);
end;
$$;

create or replace function public.customer_get_tickets(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return (select coalesce(json_agg(app_private.ticket_json(t) order by t.created_at desc), '[]'::json)
          from public.tickets t where t.user_id = v_uid);
end;
$$;

create or replace function public.customer_get_last_visit(p_session text)
returns date language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return (select last_visit_date from public.maintenance_visits where user_id = v_uid);
end;
$$;

/** 本人の会員情報（復旧コードを含む。セッションの持ち主にだけ返す） */
create or replace function public.customer_get_profile(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return (select row_to_json(c) from (
    select id, user_id, name, phone_last4, recovery_code, created_at, updated_at
    from public.customers where user_id = v_uid
  ) c);
end;
$$;

create or replace function public.customer_get_today_usage(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return json_build_object('used_type', app_private.today_used_type(v_uid));
end;
$$;

/** 譲渡開始（本人の未使用チケットのみ） */
create or replace function public.customer_create_transfer(p_session text, p_ticket_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session); v_ticket public.tickets; v_token text;
begin
  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found or v_ticket.user_id <> v_uid then
    return json_build_object('error', 'チケットが見つかりません');
  end if;
  if v_ticket.used then return json_build_object('error', '使用済みチケットは譲渡できません'); end if;
  if exists (select 1 from public.ticket_transfers where ticket_id = p_ticket_id and status = 'pending' and expires_at > now()) then
    return json_build_object('error', 'このチケットは譲渡手続き中です');
  end if;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.ticket_transfers (token, ticket_id, from_user_id, status, expires_at)
  values (v_token, p_ticket_id, v_uid, 'pending', now() + interval '24 hours');
  return json_build_object('token', v_token);
end;
$$;

create or replace function public.customer_cancel_transfer(p_session text, p_ticket_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  update public.ticket_transfers set status = 'cancelled'
  where ticket_id = p_ticket_id and from_user_id = v_uid and status = 'pending';
  return json_build_object('ok', true);
end;
$$;

/** 譲渡の受け取り（受け取る人もセッションで特定） */
create or replace function public.customer_claim_transfer(p_session text, p_token text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return public.claim_ticket_transfer(p_token, v_uid);
end;
$$;

/** 受け取り前プレビュー（譲渡トークンを知っている人だけ） */
create or replace function public.get_transfer_preview(p_token text)
returns json language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select app_private.ticket_json(t)
  from public.ticket_transfers x join public.tickets t on t.id = x.ticket_id
  where x.token = p_token and x.status = 'pending' and x.expires_at > now()
$$;

/**
 * メンテナンスクーポン提示用トークン発行（5分有効・使い捨て）
 * 発行時点でも14日以内を確認。発行すると同じ会員の未使用（未確保）トークンは失効。
 */
create or replace function public.customer_issue_maintenance_coupon(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session); v_days integer; v_row public.maintenance_coupon_tokens;
begin
  v_days := app_private.maintenance_days_remaining(v_uid);
  if v_days is null then return json_build_object('error', 'no_visit'); end if;
  if v_days < 0 then return json_build_object('error', 'expired'); end if;
  if not app_private.can_use_type(app_private.today_used_type(v_uid), 'coupon') then
    return json_build_object('error', 'used_today');
  end if;
  update public.maintenance_coupon_tokens set revoked_at = now()
  where user_id = v_uid and used_at is null and revoked_at is null;
  insert into public.maintenance_coupon_tokens (user_id, expires_at)
  values (v_uid, now() + interval '5 minutes')
  returning * into v_row;
  delete from public.maintenance_coupon_tokens where created_at < now() - interval '30 days' and used_at is null;
  return json_build_object('token', v_row.token, 'expires_at', v_row.expires_at, 'days_remaining', v_days);
end;
$$;

-- ── 4. 店舗端末用 RPC（第1引数にスタッフセッショントークン必須） ─────────────

/** 会員QR読み取り時：会員登録(upsert)＋来店情報・チケット・当日利用状況を一括取得 */
create or replace function public.staff_register_customer(p_staff text, p_user_id text, p_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_c public.customers; v_code text; i int;
begin
  perform app_private.assert_staff(p_staff);
  select * into v_c from public.customers where user_id = p_user_id;
  if found then
    if p_name is not null and btrim(p_name) <> '' and p_name <> '名前未設定' and v_c.name <> p_name then
      update public.customers
      set name = p_name, normalized_name = lower(regexp_replace(replace(p_name, '　', ''), '\s+', '', 'g')), updated_at = now()
      where id = v_c.id returning * into v_c;
    end if;
  else
    for i in 1..5 loop
      v_code := 'GIN-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 4)) || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 4));
      exit when not exists (select 1 from public.customers where recovery_code = v_code);
    end loop;
    insert into public.customers (user_id, name, recovery_code, normalized_name)
    values (p_user_id, coalesce(nullif(btrim(p_name), ''), '名前未設定'), v_code,
            lower(regexp_replace(replace(coalesce(p_name, ''), '　', ''), '\s+', '', 'g')))
    returning * into v_c;
    insert into public.customer_user_aliases (customer_id, user_id, is_current)
    values (v_c.id, p_user_id, true) on conflict (user_id) do nothing;
  end if;
  return public.staff_customer_context(p_staff, p_user_id);
end;
$$;

create or replace function public.staff_customer_context(p_staff text, p_user_id text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return json_build_object(
    'customer',        (select row_to_json(c) from public.customers c where c.user_id = p_user_id),
    'last_visit_date', (select last_visit_date from public.maintenance_visits where user_id = p_user_id),
    'days_remaining',  app_private.maintenance_days_remaining(p_user_id),
    'today_used_type', app_private.today_used_type(p_user_id),
    'tickets',         (select coalesce(json_agg(app_private.ticket_json(t) order by t.created_at desc), '[]'::json)
                        from public.tickets t where t.user_id = p_user_id)
  );
end;
$$;

drop function if exists public.staff_search_customers(text, text, boolean);

/** 会員復旧の名前検索（スタッフ端末） */
create or replace function public.staff_search_customers(p_staff text, p_query text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare v_norm text := lower(regexp_replace(replace(coalesce(p_query, ''), '　', ''), '\s+', '', 'g'));
begin
  perform app_private.assert_staff(p_staff);
  if v_norm = '' then return '[]'::json; end if;
  return (
    select coalesce(json_agg(row_to_json(c) order by c.updated_at desc), '[]'::json)
    from (
      select * from public.customers
      where name ilike '%' || p_query || '%' or normalized_name like '%' || v_norm || '%'
      order by updated_at desc limit 30
    ) c
  );
end;
$$;

/**
 * チケット一括発行（全件成功 or 全件失敗）＋発行ログ
 * 失敗時は例外 → トランザクション全体がロールバックされ、1枚も発行されない。
 */
create or replace function public.staff_issue_tickets(
  p_staff text, p_user_id text, p_type text, p_amount integer, p_quantity integer,
  p_staff_name text, p_customer_name text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_title text; v_rows json;
begin
  perform app_private.assert_staff(p_staff);
  if p_type not in ('otoku', 'discount') then raise exception 'invalid_ticket_type'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then raise exception 'invalid_amount'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 30 then raise exception 'invalid_quantity'; end if;
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;
  if not exists (select 1 from public.customers where user_id = p_user_id) then raise exception 'customer_not_found'; end if;
  v_title := case p_type when 'otoku' then '漢トク券' else '割引券' end;

  with ins as (
    insert into public.tickets (user_id, type, title, amount, issued_by, used)
    select p_user_id, p_type, v_title, p_amount, p_staff_name, false
    from generate_series(1, p_quantity)
    returning *
  )
  select json_agg(row_to_json(ins)) into v_rows from ins;

  insert into public.ticket_issue_logs (staff_name, customer_name, user_id, ticket_type, amount, quantity, terminal, status)
  values (p_staff_name, coalesce(p_customer_name, ''), p_user_id, p_type, p_amount, p_quantity, 'staff-terminal', 'issued');

  return json_build_object('tickets', v_rows);
end;
$$;

/**
 * チケット使用確定（1枚でも複数枚でも1トランザクション）
 *   本人のチケットか / 未使用か / 同一種別か / 当日の併用ルール を検証し、
 *   used化・使用ログ・来店日更新をまとめて行う。1つでも不正なら何も変更しない。
 */
create or replace function public.staff_use_tickets(
  p_staff text, p_user_id text, p_ticket_ids uuid[], p_staff_name text, p_customer_name text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_types text[]; v_count int; v_used_type text; v_rows json;
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
  if cardinality(v_types) <> 1 then
    return json_build_object('error', 'mixed_types');
  end if;
  if exists (select 1 from public.ticket_transfers where ticket_id = any(p_ticket_ids) and status = 'pending' and expires_at > now()) then
    return json_build_object('error', 'transfer_pending');
  end if;
  -- Welcomeクーポン（特殊パーマ ¥2,000）は平日のみ
  if extract(isodow from (now() at time zone 'Asia/Tokyo')) in (6, 7) and exists (
    select 1 from public.tickets
    where id = any(p_ticket_ids)
      and (issued_by = 'system-welcome' or (title = '特殊パーマ Welcomeクーポン' and amount = 2000))
  ) then
    return json_build_object('error', 'welcome_weekend');
  end if;
  v_used_type := app_private.today_used_type(p_user_id);
  if not app_private.can_use_type(v_used_type, v_types[1]) then
    return json_build_object('error', 'daily_rule', 'used_type', v_used_type);
  end if;

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
$$;

/** 来店チェックイン（来店日 = 本日JST） */
create or replace function public.staff_check_in(p_staff text, p_user_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  perform app_private.touch_visit(p_user_id);
  return json_build_object('visit_date', app_private.today_jst());
end;
$$;

/** メンテナンスクーポン：読み取り時の確認（消費しない） */
create or replace function public.staff_preview_maintenance_coupon(p_staff text, p_token uuid)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare v_t public.maintenance_coupon_tokens; v_days int; v_reason text;
begin
  perform app_private.assert_staff(p_staff);
  select * into v_t from public.maintenance_coupon_tokens where token = p_token;
  if not found then return json_build_object('valid', false, 'reason', 'not_found'); end if;
  v_days := app_private.maintenance_days_remaining(v_t.user_id);
  v_reason := case
    when v_t.used_at is not null    then 'already_used'
    when v_t.revoked_at is not null then 'revoked'
    when v_t.expires_at <= now()    then 'qr_expired'
    when v_days is null             then 'no_visit'
    when v_days < 0                 then 'cycle_expired'
    when not app_private.can_use_type(app_private.today_used_type(v_t.user_id), 'coupon') then 'used_today'
    else null end;
  return json_build_object(
    'valid', v_reason is null, 'reason', v_reason,
    'user_id', v_t.user_id,
    'customer_name', (select name from public.customers where user_id = v_t.user_id),
    'days_remaining', v_days,
    'qr_expires_at', v_t.expires_at,
    'menu', json_build_object('name', '銀二郎Only メンテナンスカット', 'stylist', '銀二郎', 'normal_price', 3000, 'member_price', 2500)
  );
end;
$$;

/**
 * メンテナンスクーポン：使用確定（サーバー側で再検証・使い捨て）
 *   トークン未使用・未失効・5分以内 / 14日以内 / 当日ルール を検証し、
 *   トークン消費・使用ログ・来店日更新を1トランザクションで行う。
 */
create or replace function public.staff_redeem_maintenance_coupon(p_staff text, p_token uuid, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
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
$$;

/**
 * 会員復旧（端末変更）。1トランザクション。
 *   1. 新端末が初回登録で作った仮の会員行を統合（削除）する
 *   2. 旧会員に Welcomeクーポンが一度でも発行されていれば（使用済み含む）、新端末側の Welcome を無効化
 *   3. 旧会員の会員行・未使用チケット・来店日を新 user_id へ移す
 *   4. 旧 user_id の顧客セッションをすべて失効（新端末のセッションはそのまま有効）
 */
create or replace function public.staff_recover_member(
  p_staff text, p_old_user_id text, p_new_user_id text, p_staff_name text, p_reason text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_old public.customers; v_new public.customers; v_old_had_welcome boolean;
begin
  perform app_private.assert_staff(p_staff);
  if p_new_user_id is null or btrim(p_new_user_id) = '' or p_new_user_id = p_old_user_id then
    return json_build_object('error', 'invalid_new_user_id');
  end if;

  select * into v_old from public.customers where user_id = p_old_user_id for update;
  if not found then return json_build_object('error', 'customer_not_found'); end if;

  v_old_had_welcome := v_old.welcome_coupon_issued_at is not null or exists (
    select 1 from public.tickets t where t.user_id = p_old_user_id and app_private.is_welcome(t));

  -- 2. 新端末側の Welcome を無効化（旧会員が過去に一度でも受け取っていれば）
  if v_old_had_welcome then
    update public.tickets t
    set used = true, used_at = now(),
        memo = coalesce(t.memo || ' / ', '') || '無効：端末変更による重複Welcome'
    where t.user_id = p_new_user_id and t.used = false and app_private.is_welcome(t);
  end if;

  -- 1. 新端末の仮会員行を統合（旧会員行が新 user_id を引き継ぐため削除）
  select * into v_new from public.customers where user_id = p_new_user_id for update;
  if found then
    if exists (select 1 from public.customer_notes where customer_id = v_new.id)
       or exists (select 1 from public.customer_recovery_logs where customer_id = v_new.id) then
      return json_build_object('error', 'new_user_has_history');
    end if;
    delete from public.customer_user_aliases where customer_id = v_new.id;
    delete from public.customers where id = v_new.id;
  end if;

  -- 3. 会員行・未使用チケット・来店日を移行
  update public.customers
  set user_id = p_new_user_id,
      welcome_coupon_issued_at = coalesce(welcome_coupon_issued_at, v_new.welcome_coupon_issued_at),
      updated_at = now()
  where id = v_old.id;
  update public.tickets set user_id = p_new_user_id where user_id = p_old_user_id and used = false;
  insert into public.maintenance_visits (user_id, last_visit_date, updated_at)
  select p_new_user_id, last_visit_date, now() from public.maintenance_visits where user_id = p_old_user_id
  on conflict (user_id) do update
    set last_visit_date = greatest(public.maintenance_visits.last_visit_date, excluded.last_visit_date), updated_at = now();

  update public.customer_user_aliases set is_current = false where customer_id = v_old.id;
  insert into public.customer_user_aliases (customer_id, user_id, is_current)
  values (v_old.id, p_new_user_id, true)
  on conflict (user_id) do update set is_current = true, customer_id = v_old.id;

  insert into public.customer_recovery_logs (customer_id, old_user_id, new_user_id, staff_name, recovery_reason)
  values (v_old.id, p_old_user_id, p_new_user_id, p_staff_name, p_reason);

  -- 4. 旧端末のセッションを失効
  update app_private.customer_sessions set revoked_at = now() where user_id = p_old_user_id and revoked_at is null;

  return json_build_object('success', true, 'welcome_revoked', v_old_had_welcome);
end;
$$;

/**
 * 既存会員のアプリ紐付けコード発行（店頭で本人確認のうえ）。6桁・10分有効・1回限り。
 * 発行すると同じ会員の未使用コードは無効になる。
 */
create or replace function public.staff_issue_bind_code(p_staff text, p_user_id text, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_code text; v_exp timestamptz := now() + interval '10 minutes';
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;
  if not exists (select 1 from public.customers where user_id = p_user_id) then
    return json_build_object('error', 'customer_not_found');
  end if;
  update app_private.customer_bind_codes set used_at = now()
  where user_id = p_user_id and used_at is null;
  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into app_private.customer_bind_codes (user_id, code_hash, created_by, expires_at)
  values (p_user_id, app_private.sha256_hex(v_code), p_staff_name, v_exp);
  return json_build_object('code', v_code, 'expires_at', v_exp);
end;
$$;

-- ── 4-1. 本部画面用 RPC（本部セッション必須。店舗スタッフセッションでは使えない） ─

/**
 * 本部 PIN 照合 → 本部セッション発行（14時間有効）。ロックは店舗端末と同じ方式で本部専用に分離：
 *   登録済み本部端末：その端末の失敗が10分で5回以上ならその端末だけロック
 *   未登録端末：未登録全体の失敗が10分で10回以上なら一時停止（登録済み本部端末は影響なし）
 */
create or replace function public.hq_login(p_pin text, p_device_key text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash     text;
  v_token    text;
  v_exp      timestamptz := now() + interval '14 hours';
  v_dev_hash text;
  v_subject  text;
  v_new_key  text;
begin
  if p_device_key is not null and length(p_device_key) >= 32 then
    select key_hash into v_dev_hash from app_private.hq_devices
    where key_hash = app_private.sha256_hex(p_device_key) and revoked_at is null;
  end if;
  v_subject := case when v_dev_hash is not null then 'device:' || v_dev_hash else 'unregistered' end;

  if (v_dev_hash is not null and app_private.recent_failures('hq_pin', v_subject, 10) >= 5)
     or (v_dev_hash is null and app_private.recent_failures('hq_pin', 'unregistered', 10) >= 10) then
    return json_build_object('error', 'locked');
  end if;
  select hash into v_hash from app_private.secrets where key = 'hq_pin';
  if v_hash is null then
    return json_build_object('error', 'not_configured');
  end if;
  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then
    insert into app_private.auth_attempts (kind, success, subject) values ('hq_pin', false, v_subject);
    return json_build_object('error', 'invalid_pin');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('hq_pin', true, v_subject);

  if v_dev_hash is null then
    v_new_key := encode(gen_random_bytes(32), 'hex');
    insert into app_private.hq_devices (key_hash) values (app_private.sha256_hex(v_new_key));
  else
    update app_private.hq_devices set last_seen_at = now() where key_hash = v_dev_hash;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into app_private.hq_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_token), v_exp);
  delete from app_private.hq_sessions where expires_at < now() - interval '7 days';
  return json_build_object('token', v_token, 'expires_at', v_exp, 'device_key', v_new_key);
end;
$$;

create or replace function public.hq_session_valid(p_token text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from app_private.hq_sessions
    where token_hash = app_private.sha256_hex(p_token) and revoked_at is null and expires_at > now()
  )
$$;

create or replace function public.hq_logout(p_token text)
returns void language sql security definer
set search_path = public, extensions, pg_temp
as $$
  update app_private.hq_sessions set revoked_at = now()
  where token_hash = app_private.sha256_hex(p_token) and revoked_at is null
$$;

/** 本部カルテ：会員一覧（復旧コードは返さない） */
create or replace function public.hq_list_customers(p_hq text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select coalesce(json_agg(row_to_json(c) order by c.created_at desc), '[]'::json)
          from (select id, user_id, name, phone_last4, created_at from public.customers) c);
end;
$$;

/** 本部カルテ：会員詳細（復旧コードは返さない）。該当なしは null */
create or replace function public.hq_get_customer(p_hq text, p_user_id text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select row_to_json(c) from (
    select id, user_id, name, phone_last4, created_at from public.customers where user_id = p_user_id
  ) c);
end;
$$;

/** 管理者が SQL Editor から実行：本部端末キーを全て失効 */
create or replace function app_private.revoke_hq_devices()
returns void language sql
set search_path = pg_catalog
as $$ update app_private.hq_devices set revoked_at = now() where revoked_at is null $$;

-- ── 4-2. 本部系データ（売上・会計・日報・カルテメモ・在庫） ─────────────────────
--   本部画面：本部セッション（p_hq）必須の hq_* RPC（売上履歴の読み取り・日報・カルテメモ・在庫）
--   店舗端末：在庫管理だけスタッフセッション（p_staff）必須の staff_product* RPC
--   会計の書き込み・会計メニュー・LIVE STATUS・営業状態の RPC は無い（機能廃止）
--   テーブルへの直接アクセスはステップB で全面禁止（products のみ SHOP 表示用に店販の公開読み取り）

/** 在庫一覧（論理削除済みを除く・名前順） */
create or replace function app_private.products_list()
returns json language sql stable
set search_path = pg_catalog
as $$
  select coalesce(json_agg(row_to_json(p) order by p.name), '[]'::json)
  from public.products p where p.is_active is not false
$$;

create or replace function app_private.product_create(p jsonb)
returns json language plpgsql
set search_path = pg_catalog
as $$
declare v public.products; v_name text := btrim(coalesce(p->>'name', ''));
begin
  if v_name = '' or length(v_name) > 80 then raise exception 'invalid_product_name'; end if;
  insert into public.products (name, category, current_stock, min_stock, price, accounting_group)
  values (v_name,
          coalesce(p->>'category', '店販'),
          greatest(0, coalesce((p->>'current_stock')::int, 0)),
          greatest(0, coalesce((p->>'min_stock')::int, 0)),
          greatest(0, coalesce((p->>'price')::int, 0)),
          nullif(btrim(coalesce(p->>'accounting_group', '')), ''))
  returning * into v;
  return row_to_json(v);
end;
$$;

/** 指定されたキーだけ更新（name / category / min_stock / price / accounting_group） */
create or replace function app_private.product_update(p_id uuid, p jsonb)
returns json language plpgsql
set search_path = pg_catalog
as $$
declare v public.products;
begin
  if p ? 'name' and (btrim(coalesce(p->>'name', '')) = '' or length(p->>'name') > 80) then
    raise exception 'invalid_product_name';
  end if;
  update public.products set
    name             = case when p ? 'name' then btrim(p->>'name') else name end,
    category         = case when p ? 'category' then p->>'category' else category end,
    min_stock        = case when p ? 'min_stock' then greatest(0, (p->>'min_stock')::int) else min_stock end,
    price            = case when p ? 'price' then greatest(0, (p->>'price')::int) else price end,
    accounting_group = case when p ? 'accounting_group' then nullif(btrim(coalesce(p->>'accounting_group', '')), '') else accounting_group end,
    updated_at       = now()
  where id = p_id
  returning * into v;
  if not found then raise exception 'product_not_found'; end if;
  return row_to_json(v);
end;
$$;

/** 論理削除（過去の会計・日報との整合性のため物理削除はしない） */
create or replace function app_private.product_delete(p_id uuid)
returns json language plpgsql
set search_path = pg_catalog
as $$
begin
  update public.products set is_active = false, updated_at = now() where id = p_id;
  if not found then raise exception 'product_not_found'; end if;
  return json_build_object('ok', true);
end;
$$;

/** 在庫増減（0未満にはしない） */
create or replace function app_private.product_adjust(p_id uuid, p_delta integer)
returns json language plpgsql
set search_path = pg_catalog
as $$
declare v public.products;
begin
  update public.products set current_stock = greatest(0, current_stock + coalesce(p_delta, 0)), updated_at = now()
  where id = p_id returning * into v;
  if not found then raise exception 'product_not_found'; end if;
  return row_to_json(v);
end;
$$;

/** 日報の集計元（本日JSTの completed 会計・明細・在庫）。集計自体は従来どおり画面側で行う */
create or replace function app_private.daily_report_source()
returns json language sql stable
set search_path = pg_catalog
as $$
  with today as (
    select s.id, s.total, s.stylist_name, s.payment_method
    from public.accounting_sessions s
    where s.status = 'completed' and (s.created_at at time zone 'Asia/Tokyo')::date = app_private.today_jst()
  )
  select json_build_object(
    'report_date', app_private.today_jst(),
    'sessions', (select coalesce(json_agg(row_to_json(t)), '[]'::json) from today t),
    'items', (select coalesce(json_agg(json_build_object('item_name', i.item_name, 'category', i.category, 'quantity', i.quantity)), '[]'::json)
              from public.accounting_session_items i join today t on t.id = i.session_id
              where i.category in ('menu', 'retail')),
    'products', app_private.products_list()
  )
$$;

/** 日報の保存（report_date は本日JST 固定・同日は上書き） */
create or replace function app_private.save_daily_report(p jsonb)
returns json language plpgsql
set search_path = pg_catalog
as $$
declare v public.daily_reports;
begin
  insert into public.daily_reports (report_date, total_sales, customer_count, average_spend,
    stylist_summary, menu_summary, retail_summary, inventory_alerts, payment_summary)
  values (app_private.today_jst(),
          coalesce((p->>'total_sales')::int, 0), coalesce((p->>'customer_count')::int, 0), coalesce((p->>'average_spend')::int, 0),
          coalesce(p->'stylist_summary', '[]'::jsonb), coalesce(p->'menu_summary', '[]'::jsonb),
          coalesce(p->'retail_summary', '[]'::jsonb), coalesce(p->'inventory_alerts', '[]'::jsonb),
          coalesce(p->'payment_summary', '[]'::jsonb))
  on conflict (report_date) do update set
    total_sales = excluded.total_sales, customer_count = excluded.customer_count, average_spend = excluded.average_spend,
    stylist_summary = excluded.stylist_summary, menu_summary = excluded.menu_summary,
    retail_summary = excluded.retail_summary, inventory_alerts = excluded.inventory_alerts,
    payment_summary = excluded.payment_summary
  returning * into v;
  return row_to_json(v);
end;
$$;

-- ── 店舗端末：在庫管理（共通処理のスタッフ版） ──
create or replace function public.staff_products_list(p_staff text) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.products_list(); end; $$;
create or replace function public.staff_product_create(p_staff text, p jsonb) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.product_create(p); end; $$;
create or replace function public.staff_product_update(p_staff text, p_id uuid, p jsonb) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.product_update(p_id, p); end; $$;
create or replace function public.staff_product_delete(p_staff text, p_id uuid) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.product_delete(p_id); end; $$;
create or replace function public.staff_product_adjust(p_staff text, p_id uuid, p_delta integer) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_staff(p_staff); return app_private.product_adjust(p_id, p_delta); end; $$;
-- ── 本部画面：在庫・日報（共通処理の本部版） ──
create or replace function public.hq_products_list(p_hq text) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.products_list(); end; $$;
create or replace function public.hq_product_create(p_hq text, p jsonb) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.product_create(p); end; $$;
create or replace function public.hq_product_update(p_hq text, p_id uuid, p jsonb) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.product_update(p_id, p); end; $$;
create or replace function public.hq_product_delete(p_hq text, p_id uuid) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.product_delete(p_id); end; $$;
create or replace function public.hq_product_adjust(p_hq text, p_id uuid, p_delta integer) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.product_adjust(p_id, p_delta); end; $$;
create or replace function public.hq_daily_report_source(p_hq text) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.daily_report_source(); end; $$;
create or replace function public.hq_save_daily_report(p_hq text, p jsonb) returns json language plpgsql security definer set search_path = public, extensions, pg_temp
as $$ begin perform app_private.assert_hq(p_hq); return app_private.save_daily_report(p); end; $$;

-- ── 本部画面専用：売上・会計履歴・日報一覧・カルテメモ ──

/** completed 会計の一覧（期間・会員で絞り込み。どれも省略可） */
create or replace function public.hq_accounting_sessions(p_hq text, p_from timestamptz default null, p_to timestamptz default null, p_user_id text default null)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select coalesce(json_agg(json_build_object(
            'id', s.id, 'user_id', s.user_id, 'total', s.total, 'stylist_name', s.stylist_name,
            'staff_name', s.staff_name, 'payment_method', s.payment_method, 'created_at', s.created_at)
          order by s.created_at desc), '[]'::json)
          from public.accounting_sessions s
          where s.status = 'completed'
            and (p_from is null or s.created_at >= p_from)
            and (p_to is null or s.created_at < p_to)
            and (p_user_id is null or s.user_id = p_user_id));
end;
$$;

/** 会計明細（指定した会計ID分） */
create or replace function public.hq_accounting_session_items(p_hq text, p_session_ids uuid[])
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select coalesce(json_agg(json_build_object('session_id', i.session_id, 'item_name', i.item_name,
            'category', i.category, 'quantity', i.quantity)), '[]'::json)
          from public.accounting_session_items i where i.session_id = any(coalesce(p_session_ids, '{}')));
end;
$$;

create or replace function public.hq_daily_reports(p_hq text, p_limit integer default 30)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select coalesce(json_agg(row_to_json(d) order by d.report_date desc), '[]'::json)
          from (select * from public.daily_reports order by report_date desc limit least(greatest(coalesce(p_limit, 30), 1), 366)) d);
end;
$$;

create or replace function public.hq_customer_notes(p_hq text, p_customer_id uuid, p_limit integer default 50)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select coalesce(json_agg(row_to_json(n) order by n.created_at desc), '[]'::json)
          from (select * from public.customer_notes where customer_id = p_customer_id
                order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) n);
end;
$$;

create or replace function public.hq_create_customer_note(p_hq text, p_customer_id uuid, p_note text, p_created_by text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.customer_notes;
begin
  perform app_private.assert_hq(p_hq);
  if p_note is null or btrim(p_note) = '' or length(p_note) > 2000 then raise exception 'invalid_note'; end if;
  if p_created_by is null or btrim(p_created_by) = '' then raise exception 'created_by_required'; end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then raise exception 'customer_not_found'; end if;
  insert into public.customer_notes (customer_id, note, created_by)
  values (p_customer_id, btrim(p_note), btrim(p_created_by)) returning * into v;
  return row_to_json(v);
end;
$$;

-- ── 5. 権限 ───────────────────────────────────────────────────────────────────


-- 新 RPC：既定の PUBLIC 実行権を外したうえで必要なものだけ anon に付与
do $$
declare f text;
begin
  foreach f in array array[
    'public.staff_login(text, text)',
    'public.staff_session_valid(text)',
    'public.staff_logout(text)',
    'public.verify_shop_passcode(text, text)',
    'public.customer_register(text, boolean)',
    'public.customer_bind_with_code(text, text)',
    'public.customer_get_tickets(text)',
    'public.customer_get_last_visit(text)',
    'public.customer_get_profile(text)',
    'public.customer_get_today_usage(text)',
    'public.customer_create_transfer(text, uuid)',
    'public.customer_cancel_transfer(text, uuid)',
    'public.customer_claim_transfer(text, text)',
    'public.get_transfer_preview(text)',
    'public.customer_issue_maintenance_coupon(text)',
    'public.staff_register_customer(text, text, text)',
    'public.staff_customer_context(text, text)',
    'public.staff_search_customers(text, text)',
    'public.staff_issue_tickets(text, text, text, integer, integer, text, text)',
    'public.staff_use_tickets(text, text, uuid[], text, text)',
    'public.staff_check_in(text, text)',
    'public.staff_preview_maintenance_coupon(text, uuid)',
    'public.staff_redeem_maintenance_coupon(text, uuid, text)',
    'public.staff_recover_member(text, text, text, text, text)',
    'public.staff_issue_bind_code(text, text, text)',
    'public.hq_login(text, text)',
    'public.hq_session_valid(text)',
    'public.hq_logout(text)',
    'public.hq_list_customers(text)',
    'public.hq_get_customer(text, text)',
    'public.staff_products_list(text)',
    'public.staff_product_create(text, jsonb)',
    'public.staff_product_update(text, uuid, jsonb)',
    'public.staff_product_delete(text, uuid)',
    'public.staff_product_adjust(text, uuid, integer)',
    'public.hq_products_list(text)',
    'public.hq_product_create(text, jsonb)',
    'public.hq_product_update(text, uuid, jsonb)',
    'public.hq_product_delete(text, uuid)',
    'public.hq_product_adjust(text, uuid, integer)',
    'public.hq_daily_report_source(text)',
    'public.hq_save_daily_report(text, jsonb)',
    'public.hq_accounting_sessions(text, timestamptz, timestamptz, text)',
    'public.hq_accounting_session_items(text, uuid[])',
    'public.hq_daily_reports(text, integer)',
    'public.hq_customer_notes(text, uuid, integer)',
    'public.hq_create_customer_note(text, uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

drop function if exists app_private.is_locked(text);

-- 内部関数は anon から実行不可
revoke all on all functions in schema app_private from public, anon, authenticated;

-- =============================================================================
-- 適用後に SQL Editor で一度だけ実行（値はここに書かず、その場で入力すること）:
--   select app_private.set_secret('staff_pin',     '＜新しいスタッフPIN：6桁の数字＞');
--   select app_private.set_secret('shop_passcode', '＜新しいSHOPパスコード＞');
--   select app_private.set_secret('hq_pin',        '＜本部専用PIN：6桁の数字（スタッフPINとは別の値）＞');
-- =============================================================================
