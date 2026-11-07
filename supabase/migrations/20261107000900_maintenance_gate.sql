-- メンテナンスカット（maintenance）は、お店で会員QRを読んだ日（初回の来店チェックインも含む）から14日以内のお客様だけ予約できる（11/7 慶一郎さん）
-- アプリの画面と AI はすでに出さないが、サーバーでも止める。数え方はアプリと同じ：maintenance_visits（QR を読んだ日）と visit_log の新しい方
create or replace function app_private.maintenance_ok(p_user_id text)
returns boolean language sql stable
set search_path to ''
as $$
  select coalesce(app_private.today_jst() - greatest(
    (select v.last_visit_date from public.maintenance_visits v where v.user_id = p_user_id and v.last_visit_date <= app_private.today_jst()),
    (select max(l.visit_date) from public.visit_log l where l.user_id = p_user_id and l.visit_date <= app_private.today_jst())
  ) <= 14, false)
$$;
revoke all on function app_private.maintenance_ok(text) from public, anon, authenticated;

create or replace function public.customer_create_hold(p_session text, p_starts_at timestamp with time zone, p_menu_codes text[], p_staff_id uuid default null::uuid)
returns json language plpgsql security definer
set search_path to ''
as $function$ begin
  perform app_private.require_store_verified(p_session);
  if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::json; end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.maintenance_ok(app_private.session_user_id(p_session)) then
    -- 画面からは来ない（14日を過ぎたら出さない）ので、既にある言葉を使う
    return json_build_object('error', 'menu_not_available');
  end if;
  return app_private.store_original_customer_create_hold($1,$2,$3,$4);
end; $function$;
