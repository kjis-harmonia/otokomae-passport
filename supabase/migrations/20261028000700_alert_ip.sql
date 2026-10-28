-- 侵入の記録に IP アドレスと詳しい端末情報（User-Agent）を残す（10/28 慶一郎さん）
--   警察に相談するときの手がかり（日時＋IP で回線の会社に照会できる）。本部の「登録していない端末からの試み」にだけ出す

alter table app_private.staff_device_alerts add column if not exists ip text;
alter table app_private.staff_device_alerts add column if not exists user_agent text;

-- いまの通信の送り元（Supabase の入口が付ける見出しから）。取れなければ null
create or replace function app_private.request_ip()
returns text language plpgsql stable set search_path = '' as $$
declare h json;
begin
  h := nullif(current_setting('request.headers', true), '')::json;
  if h is null then return null; end if;
  return left(nullif(btrim(coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1))), ''), 64);
exception when others then return null;
end;
$$;
create or replace function app_private.request_user_agent()
returns text language plpgsql stable set search_path = '' as $$
begin
  return left(nullif(nullif(current_setting('request.headers', true), '')::json->>'user-agent', ''), 300);
exception when others then return null;
end;
$$;
revoke all on function app_private.request_ip() from public, anon, authenticated;
revoke all on function app_private.request_user_agent() from public, anon, authenticated;

create or replace function app_private.staff_device_alert(p_reason text, p_app text, p_hint text, p_device_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update app_private.staff_device_policy set locked_at = coalesce(locked_at, now()) where id = 1;
  if exists (select 1 from app_private.staff_device_alerts a
             where a.acked_at is null and a.created_at > now() - interval '10 minutes'
               and (a.device_hash = p_device_hash or (p_device_hash is null and a.device_hash is null and a.reason = p_reason))) then
    return;
  end if;
  insert into app_private.staff_device_alerts (reason, app, hint, device_hash, ip, user_agent)
  values (p_reason, p_app, p_hint, p_device_hash, app_private.request_ip(), app_private.request_user_agent());
end;
$$;
revoke all on function app_private.staff_device_alert(text, text, text, text) from public, anon, authenticated;

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
        'acked_at', a.acked_at, 'acked_by', a.acked_by, 'ip', a.ip, 'user_agent', a.user_agent) order by a.created_at desc)
      from (select * from app_private.staff_device_alerts where created_at > now() - interval '30 days' order by created_at desc limit 50) a), '[]'::json));
end;
$function$;
