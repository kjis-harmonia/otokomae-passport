-- ============================================================================
-- GINJIRO POS Phase 0 / P0-2：お客様提示 QR トークン（20261009000000_ginpay_reconcile_guard.sql の後に適用）
--
-- お客様の App が表示し、店舗端末が読み取って「誰が来たか」を特定する短時間・1回限りのトークン。
-- （店内 QR＝お客様が読み取って「どこへ来たか」を示すものとは別。この migration は店内 QR を扱わない）
--   * QR の中身は GJC1.<32 バイトの乱数 base64url>（43 文字）だけ。user_id・client_id・名前・残高・券の情報は含めない。
--   * DB にはトークンの SHA-256 だけを保存する（平文は発行時に一度だけ返す）。
--   * 発行：お客様のセッションが必要。有効 90 秒。発行すると同じ会員の未使用トークンは無効（revoked）になる。
--   * 読み取り：店舗端末のセッションが必要。トークン行を FOR UPDATE して検証し、1回で使用済みにして
--     20 分の POS scan session（identity_method = token）を作る。
--       - 同じ店舗端末セッションからの再送（通信の再試行）は同じ scan session を返す。
--       - 別の端末・別のセッションからの再利用は already_used で拒否する。
--       - 期限切れ・無効化・お客様セッションの失効・形式不正は拒否する。
--   * 発行・読み取り・拒否はすべて pos_scan_events に残す（拒否は例外にせず返すので監査が残る）。
--     監査には user_id・client_id・名前・残高・券・平文トークンを残さない。誰のトークンかは token_hash / scan_session_id から
--     app_private の表（service_role のみ）でたどる。
--   * 総当たり対策は「形式は正しいが存在しない GJC1 トークン」（not_found）だけを数える（端末セッションごと 10 分 20 回）。
--     他社 QR や誤読（invalid_format）は数えない（店舗端末を止めない）。
--   * 使われなかったトークンの掃除は、部分インデックスを使う小さなバッチ（SKIP LOCKED・1 回 50 行まで）で、発行のたびに少しずつ行う。
--   * 既存の会員 QR（ginjiro-member）と既存のフローは変更しない。
-- ============================================================================

create table if not exists app_private.customer_presence_tokens (
  token_hash                    text primary key,
  user_id                       text not null,
  customer_session_hash         text not null,
  created_at                    timestamptz not null default now(),
  expires_at                    timestamptz not null,
  revoked_at                    timestamptz,
  consumed_at                   timestamptz,
  consumed_by_staff_session_hash text,
  scan_session_id               uuid,
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumed_by_staff_session_hash is null)),
  check ((consumed_at is null) = (scan_session_id is null))
);
create index if not exists customer_presence_tokens_user_idx on app_private.customer_presence_tokens (user_id, created_at desc);
-- 掃除の対象（使われなかったトークン）を作成日時で引く
create index if not exists customer_presence_tokens_cleanup_idx
  on app_private.customer_presence_tokens (created_at) where scan_session_id is null;
-- 同じ会員の有効な（未使用・未失効の）トークンは常に1つだけ
create unique index if not exists customer_presence_tokens_one_active_uidx
  on app_private.customer_presence_tokens (user_id) where consumed_at is null and revoked_at is null;

create table if not exists app_private.pos_scan_sessions (
  id                  uuid primary key default gen_random_uuid(),
  token_hash          text not null unique references app_private.customer_presence_tokens(token_hash),
  client_id           uuid not null references public.clients(id),
  user_id             text not null,
  identity_method     text not null check (identity_method in ('token')),
  staff_session_hash  text not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  closed_at           timestamptz,
  check (expires_at > created_at)
);
create index if not exists pos_scan_sessions_staff_idx on app_private.pos_scan_sessions (staff_session_hash, created_at desc);

create table if not exists public.pos_scan_events (
  id                  bigint generated always as identity primary key,
  event_type          text not null check (event_type in ('issued', 'scanned', 'retry', 'rejected')),
  reason              text,
  token_hash          text,
  scan_session_id     uuid,
  staff_session_hash  text,
  created_at          timestamptz not null default now()
);
create index if not exists pos_scan_events_staff_idx on public.pos_scan_events (staff_session_hash, created_at desc);
-- 総当たりの判定（存在しないトークンの拒否だけを端末セッションごとに数える）
create index if not exists pos_scan_events_bruteforce_idx on public.pos_scan_events (staff_session_hash, created_at)
  where event_type = 'rejected' and reason = 'not_found';

alter table public.pos_scan_events enable row level security;
revoke all on public.pos_scan_events from public, anon, authenticated;
revoke all on sequence public.pos_scan_events_id_seq from public, anon, authenticated;
alter table app_private.customer_presence_tokens enable row level security;
alter table app_private.pos_scan_sessions enable row level security;
revoke all on app_private.customer_presence_tokens from public, anon, authenticated;
revoke all on app_private.pos_scan_sessions from public, anon, authenticated;

/** 30 日を過ぎた未使用トークンを少しずつ消す（部分インデックス・SKIP LOCKED。発行の待ちを作らない）。消した件数を返す */
create or replace function app_private.cleanup_presence_tokens(p_limit integer default 50)
returns integer language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_n integer;
begin
  with doomed as (
    select token_hash from app_private.customer_presence_tokens
    where scan_session_id is null and created_at < now() - interval '30 days'
    order by created_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  )
  delete from app_private.customer_presence_tokens t using doomed d where t.token_hash = d.token_hash;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/**
 * お客様：提示用トークンを発行する（App のセッションが必要）。
 * 返すのは QR に載せる文字列（GJC1.…）と期限だけ。以前の未使用トークンは無効にする。
 */
create or replace function public.customer_issue_presence_token(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid text := app_private.session_user_id(p_session);
  v_token text;
  v_hash text;
  v_expires timestamptz := now() + interval '90 seconds';
begin
  if not exists (select 1 from public.customers where user_id = v_uid) then
    return json_build_object('error', 'customer_not_found');
  end if;
  -- 同じ会員の発行を直列化（有効なトークンは常に1つ）
  perform pg_advisory_xact_lock(hashtextextended('ginjiro:presence:' || v_uid, 0));
  -- 発行の上限（1分に10回まで）
  if (select count(*) from app_private.customer_presence_tokens where user_id = v_uid and created_at > now() - interval '1 minute') >= 10 then
    insert into public.pos_scan_events (event_type, reason) values ('rejected', 'issue_rate_limited');
    return json_build_object('error', 'rate_limited');
  end if;
  update app_private.customer_presence_tokens set revoked_at = now()
  where user_id = v_uid and consumed_at is null and revoked_at is null;

  v_token := 'GJC1.' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_hash := app_private.sha256_hex(v_token);
  insert into app_private.customer_presence_tokens (token_hash, user_id, customer_session_hash, expires_at)
  values (v_hash, v_uid, app_private.sha256_hex(p_session), v_expires);
  insert into public.pos_scan_events (event_type, token_hash) values ('issued', v_hash);
  -- 使われなかったトークンの掃除（小さなバッチ。監査は pos_scan_events に残る）
  perform app_private.cleanup_presence_tokens(50);

  return json_build_object('token', v_token, 'expires_at', v_expires, 'ttl_seconds', 90);
end;
$$;

/**
 * 店舗端末：お客様の提示トークンを読み取り、顧客を特定して POS scan session（20 分）を作る。
 * 拒否は例外にせず { error } で返す（監査を残すため）。店舗端末のセッションが無効なときだけ例外（staff_auth_required）。
 */
create or replace function public.staff_resolve_presence_token(p_staff text, p_token text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_hash text;
  v_hash text;
  t app_private.customer_presence_tokens;
  s app_private.pos_scan_sessions;
  v_client uuid;
  v_reason text;
begin
  perform app_private.assert_staff(p_staff);
  v_staff_hash := app_private.sha256_hex(p_staff);

  -- 総当たり対策：この端末セッションで直近10分に「存在しない GJC1 トークン」が20回以上なら止める（形式不正は数えない）
  if (select count(*) from public.pos_scan_events
      where staff_session_hash = v_staff_hash and event_type = 'rejected' and reason = 'not_found'
        and created_at > now() - interval '10 minutes') >= 20 then
    insert into public.pos_scan_events (event_type, reason, staff_session_hash) values ('rejected', 'scan_rate_limited', v_staff_hash);
    return json_build_object('error', 'rate_limited');
  end if;

  if p_token is null or p_token !~ '^GJC1\.[A-Za-z0-9_-]{43}$' then
    insert into public.pos_scan_events (event_type, reason, staff_session_hash) values ('rejected', 'invalid_format', v_staff_hash);
    return json_build_object('error', 'invalid_token');
  end if;
  v_hash := app_private.sha256_hex(p_token);

  select * into t from app_private.customer_presence_tokens where token_hash = v_hash for update;
  if t.token_hash is null then
    insert into public.pos_scan_events (event_type, reason, token_hash, staff_session_hash) values ('rejected', 'not_found', v_hash, v_staff_hash);
    return json_build_object('error', 'invalid_token');
  end if;

  -- 使用済み：同じ端末セッションの再送なら同じ scan session（有効期間内）。それ以外は再利用として拒否
  if t.consumed_at is not null then
    select * into s from app_private.pos_scan_sessions where id = t.scan_session_id;
    if t.consumed_by_staff_session_hash = v_staff_hash and s.id is not null and s.closed_at is null and s.expires_at > now() then
      insert into public.pos_scan_events (event_type, token_hash, scan_session_id, staff_session_hash)
      values ('retry', v_hash, s.id, v_staff_hash);
      return json_build_object('scan_session_id', s.id, 'expires_at', s.expires_at, 'identity_method', s.identity_method,
        'client', (select json_build_object('id', c.id, 'name', c.display_name) from public.clients c where c.id = app_private.client_root(s.client_id)),
        'idempotent', true);
    end if;
    v_reason := case when t.consumed_by_staff_session_hash = v_staff_hash then 'scan_session_expired' else 'already_used' end;
  elsif t.revoked_at is not null then
    v_reason := 'revoked';
  elsif t.expires_at <= now() then
    v_reason := 'expired';
  elsif not exists (select 1 from app_private.customer_sessions cs
                    where cs.token_hash = t.customer_session_hash and cs.revoked_at is null and cs.user_id = t.user_id) then
    v_reason := 'customer_session_revoked';
  end if;
  if v_reason is not null then
    insert into public.pos_scan_events (event_type, reason, token_hash, staff_session_hash)
    values ('rejected', v_reason, v_hash, v_staff_hash);
    return json_build_object('error', v_reason);
  end if;

  -- 顧客の特定（App 会員の顧客。まだなければ作成する＝既存の会員と同じ扱い）
  v_client := app_private.user_client(t.user_id);
  if v_client is null then
    insert into public.pos_scan_events (event_type, reason, token_hash, staff_session_hash)
    values ('rejected', 'customer_not_found', v_hash, v_staff_hash);
    return json_build_object('error', 'customer_not_found');
  end if;

  insert into app_private.pos_scan_sessions (token_hash, client_id, user_id, identity_method, staff_session_hash, expires_at)
  values (v_hash, v_client, t.user_id, 'token', v_staff_hash, now() + interval '20 minutes')
  returning * into s;
  update app_private.customer_presence_tokens
  set consumed_at = now(), consumed_by_staff_session_hash = v_staff_hash, scan_session_id = s.id
  where token_hash = v_hash;
  insert into public.pos_scan_events (event_type, token_hash, scan_session_id, staff_session_hash)
  values ('scanned', v_hash, s.id, v_staff_hash);

  return json_build_object('scan_session_id', s.id, 'expires_at', s.expires_at, 'identity_method', s.identity_method,
    'client', (select json_build_object('id', c.id, 'name', c.display_name) from public.clients c where c.id = v_client),
    'idempotent', false);
end;
$$;

revoke all on function public.customer_issue_presence_token(text) from public;
grant execute on function public.customer_issue_presence_token(text) to anon, authenticated;
revoke all on function public.staff_resolve_presence_token(text, text) from public;
grant execute on function public.staff_resolve_presence_token(text, text) to anon, authenticated;

-- app_private の関数は外部から実行できない（他の migration と同じ）
revoke all on all functions in schema app_private from public, anon, authenticated;
