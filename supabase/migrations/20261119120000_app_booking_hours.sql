-- アプリの新しい予約は、毎日 8:00〜21:00（日本時間）だけ受け付ける（11/19 慶一郎さん）
--   アプリの予約はお店の人が HOT PEPPER（サロンボード）へ手で入れる。夜のあいだに入ると、朝まで HOT PEPPER 側が空いたままで二重予約になる。
--   止めるのは「新しい予約の枠を押さえる」所だけ。変更・取り消し・キャンセル待ちの申し込みはそのまま（キャンセル待ちのお知らせはもともと 8:00〜21:00）
--   押さえた枠の確定（2分以内）は止めない（20:59 に押さえた方が確定できなくならないように）

create or replace function app_private.app_booking_hours_ok()
returns boolean
language sql
stable
set search_path to 'pg_catalog'
as $$
  select (now() at time zone 'Asia/Tokyo')::time >= time '08:00' and (now() at time zone 'Asia/Tokyo')::time < time '21:00'
$$;
revoke all on function app_private.app_booking_hours_ok() from public;

create or replace function public.customer_create_hold(p_session text, p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid default null::uuid)
 returns json
 language plpgsql
 security definer
 set search_path to ''
as $function$ begin
  perform app_private.require_store_verified(p_session);
  if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if;
  -- 21:00〜8:00 はアプリの新しい予約を受けない（HOT PEPPER への転記が朝までできない）
  if not app_private.app_booking_hours_ok() then return json_build_object('error', 'app_booking_hours'); end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.maintenance_ok(app_private.session_user_id(p_session)) then
    -- 画面からは来ない（14日を過ぎたら出さない）ので、既にある言葉を使う
    return json_build_object('error', 'menu_not_available');
  end if;
  return app_private.store_original_customer_create_hold($1,$2,$3,$4);
end; $function$;

create or replace function public.customer_create_hold_for(p_session text, p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid, p_companion uuid)
 returns json
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_user text; v_res json;
begin
  perform app_private.require_store_verified(p_session);
  if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if;
  -- 21:00〜8:00 はアプリの新しい予約を受けない（HOT PEPPER への転記が朝までできない）
  if not app_private.app_booking_hours_ok() then return json_build_object('error', 'app_booking_hours'); end if;
  v_user := app_private.session_user_id(p_session);
  if p_companion is not null and (app_private.own_companion(v_user, p_companion)).id is null then
    return json_build_object('error', 'companion_not_found');
  end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.person_maintenance_ok(v_user, p_companion) then
    return json_build_object('error', 'menu_not_available');
  end if;
  v_res := app_private.store_original_customer_create_hold(p_session, p_starts_at, p_menu_codes, p_staff_id);
  if (v_res->>'hold_id') is not null then
    update public.booking_holds set companion_id = p_companion where id = (v_res->>'hold_id')::uuid and holder_user_id = v_user;
  end if;
  return v_res;
end;
$function$;
