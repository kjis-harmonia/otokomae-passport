-- 新規登録の送り直しで、会員・Welcomeクーポンが二重にできないようにする（Codex R3-D002）
--   端末が登録ごとに1つの合言葉（p_request_key・端末だけが持つ乱数）を作り、届かなかった時も同じ合言葉で送り直す。
--   同じ合言葉が24時間以内に来たら、新しく作らず前回の会員を返す（新しいログインを渡す）。合言葉はハッシュだけ残す
--   中身は今の customer_register をそのまま呼ぶ（登録の決まりは変えない）。古い画面は今までどおり customer_register を使える

create table if not exists app_private.register_requests (
  key_hash   text primary key,
  user_id    text not null,
  created_at timestamptz not null default now()
);
revoke all on table app_private.register_requests from public, anon, authenticated;

create or replace function public.customer_register_once(p_name text, p_has_visited_before boolean, p_request_key text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_key  text := coalesce(p_request_key, '');
  v_hash text;
  v_uid  text;
  v_t    public.tickets;
  r      json;
begin
  if v_key !~ '^[A-Za-z0-9_-]{32,128}$' then
    return json_build_object('error', 'invalid_request');
  end if;
  v_hash := app_private.sha256_hex(v_key);
  -- 同じ合言葉の同時の送り直しは、先の1本が終わるまで待たせる
  perform pg_advisory_xact_lock(hashtextextended('register:' || v_hash, 0));
  delete from app_private.register_requests where created_at < now() - interval '1 day';

  select user_id into v_uid from app_private.register_requests where key_hash = v_hash;
  if v_uid is not null then
    select * into v_t from public.tickets where user_id = v_uid and issued_by = 'system-welcome' order by created_at limit 1;
    return json_build_object(
      'user_id', v_uid,
      'session', app_private.new_customer_session(v_uid, 'register'),
      'ticket', case when v_t.id is null then null else row_to_json(v_t) end,
      'welcome_coupon_issued', v_t.id is not null,
      'replayed', true
    );
  end if;

  r := public.customer_register(p_name, p_has_visited_before);
  if r->>'error' is null then
    insert into app_private.register_requests (key_hash, user_id) values (v_hash, r->>'user_id');
  end if;
  return r;
end;
$function$;

revoke all on function public.customer_register_once(text, boolean, text) from public;
grant execute on function public.customer_register_once(text, boolean, text) to anon, authenticated;
