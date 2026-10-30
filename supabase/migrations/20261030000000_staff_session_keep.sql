-- 本部で登録（承認）した店舗端末・SB は、一度 PIN を入れたら入れ直さなくてよい（10/30 慶一郎さん：スタッフ以外は端末を触らない・端末の登録制と侵入のロックがある）
--   これまでは PIN から14時間で一律に切れ、夜や早朝に入れた日は次の日の営業中に PIN を聞き直していた。
--   開いている端末は 20 秒ごとに staff_security_check を呼ぶので、そのときに登録済みの端末なら期限を「いまから10年」に延ばし、その期限を返す（端末はそれを覚える）。
--   登録していない端末・取り消した端末・ロック中は延ばさない（これまでどおり14時間）。
--   止めるときは今までどおり：本部の「端末を取り消す」（その端末のログインも切れる）、PIN の変更（全端末のログインが切れる）、侵入のロック（操作を止める）

create or replace function public.staff_security_check(p_staff text, p_app text default null, p_hint text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_dev text; v_locked timestamptz; v_exp timestamptz;
begin
  if not public.staff_session_valid(p_staff) then raise exception 'staff_auth_required' using errcode = '28000'; end if;
  select s.device_hash, s.expires_at into v_dev, v_exp from app_private.staff_sessions s where s.token_hash = app_private.sha256_hex(p_staff);
  if v_dev is not null then
    update app_private.staff_devices
    set app = coalesce(app, case when p_app in ('staff', 'sb') then p_app end),
        hint = coalesce(nullif(left(btrim(coalesce(p_hint, '')), 80), ''), hint),
        last_seen_at = now()
    where key_hash = v_dev and last_seen_at < now() - interval '1 minute';
  end if;
  select locked_at into v_locked from app_private.staff_device_policy where id = 1;
  -- 登録済みの端末：期限を10年に（もう延ばしてあれば書かない）
  if v_locked is null and v_dev is not null and v_exp < now() + interval '9 years'
     and exists (select 1 from app_private.staff_devices dv where dv.key_hash = v_dev and dv.revoked_at is null and dv.approved_at is not null) then
    update app_private.staff_sessions
    set expires_at = now() + interval '10 years'
    where token_hash = app_private.sha256_hex(p_staff) and revoked_at is null and expires_at > now()
    returning expires_at into v_exp;
  end if;
  return json_build_object('locked', v_locked is not null, 'since', v_locked, 'expires_at', v_exp,
    'alerts', coalesce((select json_agg(json_build_object('id', a.id, 'created_at', a.created_at, 'reason', a.reason, 'app', a.app, 'hint', a.hint, 'acked_at', a.acked_at, 'acked_by', a.acked_by) order by a.created_at)
      from app_private.staff_device_alerts a
      where (v_locked is not null and a.created_at >= v_locked - interval '1 minute') or (a.acked_at is null and a.created_at > now() - interval '1 day')), '[]'::json));
end;
$function$;
