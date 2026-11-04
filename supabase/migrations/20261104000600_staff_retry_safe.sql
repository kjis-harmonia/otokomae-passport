-- 店舗端末：会員復旧とメンテナンスクーポンの「押し直し」を成功として返す（11/4 Sランク点検）
--   返事が消えて押し直すと、会員復旧は「顧客が見つかりません」、クーポンは「使用済み」のエラーになり、
--   成功していたのに失敗に見えていた（データとお金は正しい）。
--   ・会員復旧：同じ旧→新の引き継ぎ記録があれば success（already）
--   ・クーポン：30分以内に確定したものは ok（already・時刻・担当つき）。それより前は今までどおり already_used

CREATE OR REPLACE FUNCTION public.staff_recover_member(p_staff text, p_old_user_id text, p_new_user_id text, p_staff_name text, p_reason text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_old public.customers; v_new public.customers; v_old_had_welcome boolean;
begin
  perform app_private.assert_staff(p_staff);
  if p_new_user_id is null or btrim(p_new_user_id) = '' or p_new_user_id = p_old_user_id then
    return json_build_object('error', 'invalid_new_user_id');
  end if;

  select * into v_old from public.customers where user_id = p_old_user_id for update;
  if not found then
    -- 同じ引き継ぎの再送（返事が消えて押し直した）：もう新しい端末へ移っていれば成功として返す（11/4 Sランク点検）
    if exists (select 1 from public.customer_recovery_logs where old_user_id = p_old_user_id and new_user_id = p_new_user_id) then
      return json_build_object('success', true, 'already', true);
    end if;
    return json_build_object('error', 'customer_not_found');
  end if;

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
$function$;

CREATE OR REPLACE FUNCTION public.staff_redeem_maintenance_coupon(p_staff text, p_token uuid, p_staff_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_t public.maintenance_coupon_tokens; v_days int; v_name text;
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;

  select * into v_t from public.maintenance_coupon_tokens where token = p_token for update;
  if not found                    then return json_build_object('error', 'not_found'); end if;
  if v_t.used_at is not null then
    -- 30分以内に確定したもの（返事が消えて押し直した）は、確定済みとして時刻と担当を返す。それより前は今までどおり「使用済み」
    if v_t.used_at > now() - interval '30 minutes' then
      select name into v_name from public.customers where user_id = v_t.user_id;
      return json_build_object('ok', true, 'already', true, 'used_at', v_t.used_at, 'used_by', v_t.used_by,
        'user_id', v_t.user_id, 'customer_name', v_name);
    end if;
    return json_build_object('error', 'already_used');
  end if;
  if v_t.revoked_at is not null   then return json_build_object('error', 'revoked'); end if;
  if v_t.expires_at <= now()      then return json_build_object('error', 'qr_expired'); end if;

  v_days := app_private.maintenance_days_remaining(v_t.user_id);
  if v_days is null then return json_build_object('error', 'no_visit'); end if;
  if v_days < 0     then return json_build_object('error', 'cycle_expired'); end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-day:' || (app_private.ticket_family_uids(v_t.user_id))[1] || ':' || app_private.today_jst()::text, 0));
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
$function$;
