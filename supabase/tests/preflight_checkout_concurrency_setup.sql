-- Staging preflight: concurrent checkout setup.

create table if not exists public.__preflight_checkout_concurrency_cases (
  run_id uuid not null,
  worker_no integer not null,
  staff_token text not null,
  reservation_id uuid not null,
  stylist_id uuid not null,
  idempotency_key text not null,
  primary key (run_id, worker_no)
);

create table if not exists public.__preflight_checkout_concurrency_latest (
  id integer primary key default 1 check (id = 1),
  run_id uuid not null,
  reservation_id uuid not null
);

do $$
declare
  v_run uuid := gen_random_uuid();
  v_staff text := 'preflight-checkout-concurrency-staff';
  v_staff_id uuid;
  v_menu_id uuid;
  v_date date := app_private.today_jst() + 5;
  v_start timestamptz;
  v_res json;
  v_reservation uuid;
  i integer;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  select id into v_staff_id from public.staff_members where display_name = '銀二郎';
  select id into v_menu_id from public.service_menus where code = 'maintenance-ginjiro';
  if v_staff_id is null or v_menu_id is null then raise exception 'booking seed data missing'; end if;

  insert into public.staff_menu_capabilities (staff_id, menu_id) values (v_staff_id, v_menu_id) on conflict do nothing;
  -- 20261006 以降、予約できるのは booking_enabled（所要時間・担当あり）のサービスだけ
  update public.service_menus set is_active = true, duration_min = 30, buffer_after_min = 0, booking_enabled = true where id = v_menu_id;
  insert into public.staff_shift_templates (staff_id, weekday, start_time, end_time)
  values (v_staff_id, extract(dow from v_date)::int, time '09:00', time '18:00')
  on conflict (staff_id, weekday) do update set start_time = excluded.start_time, end_time = excluded.end_time;

  v_start := app_private.jst_ts(v_date, time '11:00');
  v_res := public.staff_create_reservation(v_staff, jsonb_build_object(
    'starts_at', v_start,
    'menu_codes', jsonb_build_array('maintenance-ginjiro'),
    'staff_id', v_staff_id,
    'customer_name', 'Preflight Checkout Concurrent',
    'customer_phone', '080-0000-0099',
    'source', 'phone'
  ), 'Preflight');
  if v_res->>'error' is not null then raise exception 'reservation setup failed: %', v_res; end if;
  v_reservation := (v_res->>'id')::uuid;

  for i in 0..9 loop
    insert into public.__preflight_checkout_concurrency_cases (run_id, worker_no, staff_token, reservation_id, stylist_id, idempotency_key)
    values (v_run, i, v_staff, v_reservation, v_staff_id, 'preflight-checkout-concurrency:' || v_run::text || ':' || i::text);
  end loop;

  insert into public.__preflight_checkout_concurrency_latest (id, run_id, reservation_id)
  values (1, v_run, v_reservation)
  on conflict (id) do update set run_id = excluded.run_id, reservation_id = excluded.reservation_id;
end $$;
