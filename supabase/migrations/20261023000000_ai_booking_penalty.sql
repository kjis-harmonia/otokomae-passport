-- AI 予約の当日キャンセル防止（2026-10-23 慶一郎さん決定）
--   ・開始 2 時間前を切ってからアプリ（AI）でキャンセル → 受け付けたうえで 30 日間 AI の新規予約を止める
--   ・店舗端末・本部で「不来店」にした → 同じく 30 日間止める（予約時刻を過ぎただけでは止めない）
--   ・電話でのキャンセル（店がキャンセルにする）は対象外
--   ・止めるのは新規予約（仮押さえ・確定・キャンセル待ち）だけ。今ある予約の確認・キャンセルはできる
--   ・店舗端末から解除できる（体調不良など）
-- 再開日は日本時間の日付で決める：止めた日 + 30 日の 0 時から使える。

alter table public.booking_settings add column if not exists ai_late_cancel_minutes integer not null default 120
  check (ai_late_cancel_minutes between 0 and 1440);
alter table public.booking_settings add column if not exists ai_penalty_days integer not null default 30
  check (ai_penalty_days between 1 and 365);

create table if not exists app_private.ai_booking_penalties (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.customers(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete set null,
  reason         text not null check (reason in ('late_cancel', 'no_show')),
  created_at     timestamptz not null default now(),
  resume_on      date not null,
  lifted_at      timestamptz,
  lifted_by      text
);
create unique index if not exists ai_booking_penalties_reservation_uidx on app_private.ai_booking_penalties (reservation_id) where reservation_id is not null;
create index if not exists ai_booking_penalties_customer_idx on app_private.ai_booking_penalties (customer_id, resume_on desc);
alter table app_private.ai_booking_penalties enable row level security;
revoke all on app_private.ai_booking_penalties from public, anon, authenticated;

/** 日本時間の今日 */
create or replace function app_private.jst_today()
returns date language sql stable set search_path = '' as $$ select (now() at time zone 'Asia/Tokyo')::date $$;

/** いま止まっていれば再開日、止まっていなければ null */
create or replace function app_private.ai_paused_until(p_customer_id uuid)
returns date language sql stable set search_path = '' as $$
  select max(p.resume_on) from app_private.ai_booking_penalties p
  where p.customer_id = p_customer_id and p.lifted_at is null and p.resume_on > app_private.jst_today()
$$;

/** 予約に対して停止を記録（同じ予約で二重に付けない）。会員でない予約（ホットペッパーなど）は何もしない */
create or replace function app_private.ai_penalty_add(p_reservation_id uuid, p_reason text)
returns date language plpgsql security definer set search_path = '' as $$
declare v_customer uuid; v_resume date;
begin
  select c.id into v_customer from public.reservations r join public.customers c on c.user_id = r.user_id where r.id = p_reservation_id;
  if v_customer is null then return null; end if;
  v_resume := app_private.jst_today() + (select ai_penalty_days from public.booking_settings where id = 1);
  insert into app_private.ai_booking_penalties (customer_id, reservation_id, reason, resume_on)
  values (v_customer, p_reservation_id, p_reason, v_resume)
  on conflict (reservation_id) where reservation_id is not null do nothing;
  return app_private.ai_paused_until(v_customer);
end;
$$;

/** 不来店になったら止める（店舗端末・本部・SB のどこから付けても同じ） */
create or replace function app_private.ai_penalty_on_no_show()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'no_show' and old.status is distinct from 'no_show' then
    perform app_private.ai_penalty_add(new.id, 'no_show');
  end if;
  return new;
end;
$$;
drop trigger if exists ai_penalty_on_no_show on public.reservations;
create trigger ai_penalty_on_no_show after update of status on public.reservations
  for each row execute function app_private.ai_penalty_on_no_show();

revoke all on function app_private.jst_today(), app_private.ai_paused_until(uuid), app_private.ai_penalty_add(uuid, text),
  app_private.ai_penalty_on_no_show() from public, anon, authenticated;

/** お客様：いま AI 予約が止まっているか */
create or replace function public.customer_ai_booking_status(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid text := app_private.session_user_id(p_session); v_customer uuid; v_resume date; v_reason text;
begin
  select id into v_customer from public.customers where user_id = v_uid;
  v_resume := app_private.ai_paused_until(v_customer);
  if v_resume is null then return json_build_object('paused', false); end if;
  select reason into v_reason from app_private.ai_booking_penalties
  where customer_id = v_customer and lifted_at is null and resume_on = v_resume order by created_at desc limit 1;
  return json_build_object('paused', true, 'resume_on', v_resume, 'reason', v_reason);
end;
$$;

/** お客様のキャンセル：締め切り（booking_settings.customer_cancel_deadline_minutes）までは受け付け、
    開始 ai_late_cancel_minutes 分前を切っていたら停止を記録して、再開日を一緒に返す */
create or replace function public.customer_cancel_reservation(p_session text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session); r public.reservations; v_c public.customers; v_res jsonb; v_late boolean; v_resume date;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select * into r from public.reservations where id = p_reservation_id and user_id = v_uid;
  if r.id is null then return json_build_object('error', 'not_found'); end if;
  if r.starts_at < now() + make_interval(mins => (select customer_cancel_deadline_minutes from public.booking_settings where id = 1)) then
    return json_build_object('error', 'cancel_deadline_passed');
  end if;
  v_late := r.status = 'confirmed' and r.starts_at < now() + make_interval(mins => (select ai_late_cancel_minutes from public.booking_settings where id = 1));
  select * into v_c from public.customers where user_id = v_uid;
  v_res := app_private.set_reservation_status(p_reservation_id, 'cancelled', 'customer', coalesce(v_c.name, v_uid), 'お客様アプリからキャンセル');
  if v_res ? 'error' then return v_res::json; end if;
  if v_late then v_resume := app_private.ai_penalty_add(p_reservation_id, 'late_cancel'); end if;
  return (app_private.reservation_json_customer(p_reservation_id)::jsonb
    || case when v_resume is not null then jsonb_build_object('ai_paused_until', v_resume) else '{}'::jsonb end)::json;
end;
$$;

/** 新規予約の入口（仮押さえ・確定・キャンセル待ち）で、止まっていれば断る */
create or replace function app_private.ai_booking_gate(p_session text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_resume date;
begin
  select app_private.ai_paused_until(c.id) into v_resume from public.customers c where c.user_id = app_private.session_user_id(p_session);
  if v_resume is null then return null; end if;
  return json_build_object('error', 'ai_booking_paused', 'resume_on', v_resume);
end;
$$;
revoke all on function app_private.ai_booking_gate(text) from public, anon, authenticated;

do $migration$
declare f record; args text; call_args text; result_type text; target text; body text; done int := 0;
begin
  for f in select p.oid, p.proname, p.pronargs, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('customer_create_hold', 'customer_confirm_reservation', 'customer_join_waitlist') order by p.proname loop
    done := done + 1;
    continue when f.prosrc like '%ai_booking_gate%';  -- もう一度流したとき
    args := pg_get_function_arguments(f.oid); result_type := pg_get_function_result(f.oid);
    if result_type not in ('json', 'jsonb') then raise exception 'unexpected booking result: %', f.proname; end if;
    select string_agg('$' || i, ',' order by i) into call_args from generate_series(1, f.pronargs) i;
    if f.prosrc like '%require_store_verified%' then
      -- 来店確認の入口（15番）の中身を、停止の判定つきで作り直す
      target := 'store_original_' || f.proname;
      body := format('begin perform app_private.require_store_verified(p_session); if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::%s; end if; return app_private.%I(%s); end;', result_type, target, call_args);
      execute format('create or replace function public.%I(%s) returns %s language plpgsql security definer set search_path = '''' as $wrapper$ %s $wrapper$', f.proname, args, result_type, body);
    else
      -- キャンセル待ちの入口：元の処理を app_private に移して、停止の判定つきの入口を作る
      target := 'ai_original_' || f.proname;
      execute format('drop function if exists app_private.%I(%s)', target, pg_get_function_identity_arguments(f.oid));
      execute format('alter function %s rename to %I', f.oid::regprocedure, target);
      execute format('alter function %s set schema app_private', f.oid::regprocedure);
      execute format('revoke all on function %s from public, anon, authenticated', f.oid::regprocedure);
      body := format('begin if app_private.ai_booking_gate(p_session) is not null then return app_private.ai_booking_gate(p_session)::%s; end if; return app_private.%I(%s); end;', result_type, target, call_args);
      execute format('create function public.%I(%s) returns %s language plpgsql security definer set search_path = '''' as $wrapper$ %s $wrapper$', f.proname, args, result_type, body);
    end if;
    execute format('revoke all on function public.%I(%s) from public', f.proname, pg_get_function_identity_arguments(f.oid));
    execute format('grant execute on function public.%I(%s) to anon, authenticated, service_role', f.proname, pg_get_function_identity_arguments(f.oid));
  end loop;
  if done <> 3 then raise exception 'expected three booking entry points, found %', done; end if;
end;
$migration$;

/** 店舗端末：この予約のお客様が AI 予約を止められているか */
create or replace function public.staff_ai_penalty_for_reservation(p_staff text, p_reservation_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_customer uuid; v_resume date; v_reason text;
begin
  perform app_private.assert_staff(p_staff);
  select c.id into v_customer from public.reservations r join public.customers c on c.user_id = r.user_id where r.id = p_reservation_id;
  v_resume := app_private.ai_paused_until(v_customer);
  if v_resume is null then return json_build_object('paused', false); end if;
  select reason into v_reason from app_private.ai_booking_penalties
  where customer_id = v_customer and lifted_at is null and resume_on = v_resume order by created_at desc limit 1;
  return json_build_object('paused', true, 'resume_on', v_resume, 'reason', v_reason);
end;
$$;

/** 店舗端末：止めているのを解除（その方の止め全部） */
create or replace function public.staff_lift_ai_penalty(p_staff text, p_reservation_id uuid, p_staff_name text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_customer uuid; v_actor text; n int;
begin
  perform app_private.assert_staff(p_staff);
  v_actor := app_private.require_actor(p_staff_name);
  select c.id into v_customer from public.reservations r join public.customers c on c.user_id = r.user_id where r.id = p_reservation_id;
  if v_customer is null then return json_build_object('error', 'not_member'); end if;
  update app_private.ai_booking_penalties set lifted_at = now(), lifted_by = v_actor
  where customer_id = v_customer and lifted_at is null and resume_on > app_private.jst_today();
  get diagnostics n = row_count;
  return json_build_object('lifted', n);
end;
$$;

revoke all on function public.customer_ai_booking_status(text), public.customer_cancel_reservation(text, uuid),
  public.staff_ai_penalty_for_reservation(text, uuid), public.staff_lift_ai_penalty(text, uuid, text) from public;
grant execute on function public.customer_ai_booking_status(text), public.customer_cancel_reservation(text, uuid),
  public.staff_ai_penalty_for_reservation(text, uuid), public.staff_lift_ai_penalty(text, uuid, text) to anon, authenticated, service_role;
