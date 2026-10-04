-- GINJIRO POS Phase 0 / P0-2：お客様提示 QR トークン（begin … rollback。データは残さない）
--   形式（GJC1.<43文字>・PII なし）、DB はハッシュのみ、90 秒、1 回限り、前回分の無効化、同じ端末の再送は同じ scan session、
--   別端末の再利用・期限切れ・無効化・お客様セッション失効・形式不正の拒否、店舗端末セッション必須、監査、権限、既存フロー
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_uid text := 'preflight-pos-presence-user';
  v_name text := 'Preflight 提示 太郎';
  v_session text := 'preflight-pos-presence-customer-session-0123456789abcdef';
  v_staff_a text := 'preflight-pos-presence-staff-a-0123456789abcdef';
  v_staff_b text := 'preflight-pos-presence-staff-b-0123456789abcdef';
  v_r jsonb; v_r2 jsonb; v_tok text; v_tok_old text; v_scan uuid; v_client uuid; v_ok boolean; i int;
begin
  insert into public.customers (user_id, name, recovery_code) values (v_uid, v_name, 'PFPOS0001');
  insert into app_private.customer_sessions (token_hash, user_id, created_via) values (app_private.sha256_hex(v_session), v_uid, 'register');
  insert into app_private.staff_sessions (token_hash, expires_at) values
    (app_private.sha256_hex(v_staff_a), now() + interval '1 hour'), (app_private.sha256_hex(v_staff_b), now() + interval '1 hour');

  -- 発行：形式・期限・PII なし・DB はハッシュのみ
  v_r := public.customer_issue_presence_token(v_session)::jsonb;
  v_tok := v_r->>'token';
  if v_tok !~ '^GJC1\.[A-Za-z0-9_-]{43}$' or length(v_tok) <> 48 then raise exception 'token_format: %', v_tok; end if;
  if (v_r->>'ttl_seconds')::int <> 90 or abs(extract(epoch from ((v_r->>'expires_at')::timestamptz - now())) - 90) > 5 then raise exception 'token_ttl: %', v_r; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v_r) k) <> array['expires_at', 'token', 'ttl_seconds'] then raise exception 'issue_returns_extra: %', v_r; end if;
  v_client := app_private.user_client(v_uid);
  if position(v_uid in v_tok) > 0 or position(v_client::text in v_tok) > 0 or position(v_name in v_tok) > 0
     or position(replace(v_client::text, '-', '') in v_tok) > 0 then
    raise exception 'token_contains_identity';
  end if;
  if exists (select 1 from app_private.customer_presence_tokens t where t.token_hash = v_tok or t.customer_session_hash = v_session
             or row_to_json(t)::text like '%' || substr(v_tok, 6) || '%') then
    raise exception 'plaintext_token_stored';
  end if;
  if not exists (select 1 from app_private.customer_presence_tokens where token_hash = app_private.sha256_hex(v_tok)) then raise exception 'hash_not_stored'; end if;

  -- 再発行で前回分は無効（1会員1つ）
  v_tok_old := v_tok;
  v_tok := public.customer_issue_presence_token(v_session)::jsonb->>'token';
  if (select count(*) from app_private.customer_presence_tokens where user_id = v_uid and consumed_at is null and revoked_at is null) <> 1 then
    raise exception 'more_than_one_active_token';
  end if;
  if public.staff_resolve_presence_token(v_staff_a, v_tok_old)::jsonb->>'error' is distinct from 'revoked' then raise exception 'old_token_not_revoked'; end if;

  -- 読み取り：scan session（20 分・identity_method=token・顧客）
  v_r := public.staff_resolve_presence_token(v_staff_a, v_tok)::jsonb;
  if v_r ? 'error' then raise exception 'resolve_failed: %', v_r; end if;
  v_scan := (v_r->>'scan_session_id')::uuid;
  if v_r->>'identity_method' <> 'token' or (v_r->'client'->>'id')::uuid <> v_client or (v_r->>'idempotent')::boolean then raise exception 'resolve_result: %', v_r; end if;
  if abs(extract(epoch from ((v_r->>'expires_at')::timestamptz - now())) - 1200) > 5 then raise exception 'scan_session_ttl: %', v_r; end if;
  if not exists (select 1 from app_private.pos_scan_sessions where id = v_scan and staff_session_hash = app_private.sha256_hex(v_staff_a) and user_id = v_uid) then
    raise exception 'scan_session_not_bound';
  end if;

  -- 同じ端末セッションの再送：同じ scan session
  v_r2 := public.staff_resolve_presence_token(v_staff_a, v_tok)::jsonb;
  if (v_r2->>'scan_session_id')::uuid is distinct from v_scan or not (v_r2->>'idempotent')::boolean then raise exception 'retry_not_idempotent: %', v_r2; end if;
  -- 別の端末セッション：再利用は拒否
  if public.staff_resolve_presence_token(v_staff_b, v_tok)::jsonb->>'error' is distinct from 'already_used' then raise exception 'reuse_not_rejected'; end if;
  if (select count(*) from app_private.pos_scan_sessions where token_hash = app_private.sha256_hex(v_tok)) <> 1 then raise exception 'second_scan_session'; end if;

  -- scan session の期限切れ後は、同じ端末でも再送扱いにしない
  update app_private.pos_scan_sessions set expires_at = now() - interval '1 second', created_at = now() - interval '21 minutes' where id = v_scan;
  if public.staff_resolve_presence_token(v_staff_a, v_tok)::jsonb->>'error' is distinct from 'scan_session_expired' then raise exception 'expired_scan_session_reused'; end if;

  -- 期限切れのトークン
  v_tok := public.customer_issue_presence_token(v_session)::jsonb->>'token';
  update app_private.customer_presence_tokens set created_at = now() - interval '91 seconds', expires_at = now() - interval '1 second'
  where token_hash = app_private.sha256_hex(v_tok);
  if public.staff_resolve_presence_token(v_staff_a, v_tok)::jsonb->>'error' is distinct from 'expired' then raise exception 'expired_not_rejected'; end if;

  -- お客様セッションの失効
  v_tok := public.customer_issue_presence_token(v_session)::jsonb->>'token';
  update app_private.customer_sessions set revoked_at = now() where token_hash = app_private.sha256_hex(v_session);
  if public.staff_resolve_presence_token(v_staff_a, v_tok)::jsonb->>'error' is distinct from 'customer_session_revoked' then raise exception 'revoked_session_not_rejected'; end if;
  v_ok := false;
  begin perform public.customer_issue_presence_token(v_session); exception when others then v_ok := sqlerrm = 'customer_auth_required'; end;
  if not v_ok then raise exception 'issue_without_valid_session'; end if;
  update app_private.customer_sessions set revoked_at = null where token_hash = app_private.sha256_hex(v_session);

  -- 形式不正・存在しないトークン・旧会員 QR
  if public.staff_resolve_presence_token(v_staff_a, 'GJC1.short')::jsonb->>'error' <> 'invalid_token' then raise exception 'bad_format_accepted'; end if;
  if public.staff_resolve_presence_token(v_staff_a, 'GJC1.' || repeat('A', 43))::jsonb->>'error' <> 'invalid_token' then raise exception 'unknown_token_accepted'; end if;
  if public.staff_resolve_presence_token(v_staff_a, json_build_object('type', 'ginjiro-member', 'userId', v_uid, 'name', v_name)::text)::jsonb->>'error' <> 'invalid_token' then
    raise exception 'legacy_member_qr_accepted';
  end if;

  -- 店舗端末セッションが必要
  v_ok := false;
  begin perform public.staff_resolve_presence_token('not-a-staff-session-0123456789abcdef', v_tok); exception when others then v_ok := sqlerrm = 'staff_auth_required'; end;
  if not v_ok then raise exception 'resolve_without_staff_session'; end if;

  -- 発行の上限（1分に10回）
  for i in 1..12 loop v_r := public.customer_issue_presence_token(v_session)::jsonb; end loop;
  if v_r->>'error' is distinct from 'rate_limited' then raise exception 'issue_rate_limit_missing: %', v_r; end if;

  -- 監査：発行・読取・再送・拒否（理由つき）
  if not exists (select 1 from public.pos_scan_events where user_id = v_uid and event_type = 'issued')
     or (select count(*) from public.pos_scan_events where scan_session_id = v_scan and event_type = 'scanned') <> 1
     or not exists (select 1 from public.pos_scan_events where scan_session_id = v_scan and event_type = 'retry')
     or (select array_agg(distinct reason order by reason) from public.pos_scan_events where event_type = 'rejected'
         and (user_id = v_uid or staff_session_hash = app_private.sha256_hex(v_staff_a)))
        @> array['already_used', 'customer_session_revoked', 'expired', 'invalid_format', 'issue_rate_limited', 'not_found', 'revoked', 'scan_session_expired'] is not true then
    raise exception 'scan_audit_incomplete';
  end if;
  if exists (select 1 from public.pos_scan_events e where row_to_json(e)::text like '%' || substr(v_tok, 6) || '%') then raise exception 'plaintext_token_in_audit'; end if;

  -- 総当たり対策（拒否が続く端末は止める）
  for i in 1..25 loop v_r := public.staff_resolve_presence_token(v_staff_b, 'GJC1.' || repeat('B', 43))::jsonb; end loop;
  if v_r->>'error' is distinct from 'rate_limited' then raise exception 'scan_rate_limit_missing: %', v_r; end if;

  -- 権限：RPC は anon / authenticated から実行可（セッションで保護）、表・内部関数は不可、SECURITY DEFINER と search_path 固定
  if not has_function_privilege('anon', 'public.customer_issue_presence_token(text)', 'EXECUTE')
     or not has_function_privilege('anon', 'public.staff_resolve_presence_token(text, text)', 'EXECUTE') then raise exception 'rpc_grant_missing'; end if;
  if has_table_privilege('anon', 'public.pos_scan_events', 'SELECT') or has_table_privilege('authenticated', 'public.pos_scan_events', 'SELECT')
     or has_table_privilege('anon', 'app_private.customer_presence_tokens', 'SELECT') or has_table_privilege('anon', 'app_private.pos_scan_sessions', 'SELECT') then
    raise exception 'token_tables_readable_by_client';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('customer_issue_presence_token', 'staff_resolve_presence_token')
               and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))) then
    raise exception 'presence_rpc_not_definer_or_search_path';
  end if;

  -- 既存のフローは変わらない（旧会員 QR で使う店舗端末の RPC）
  v_r := public.staff_customer_context(v_staff_a, v_uid)::jsonb;
  if v_r->'customer'->>'user_id' is distinct from v_uid then raise exception 'legacy_customer_context_broken'; end if;
  raise notice 'pos presence token ok';
end $$;
rollback;
