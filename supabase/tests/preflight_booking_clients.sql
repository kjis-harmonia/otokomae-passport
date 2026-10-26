-- Staging preflight: booking + clients smoke test.

begin;

do $$
declare
  v_staff text := 'preflight-staff-token';
  v_hq text := 'preflight-hq-token';
  v_staff_id uuid;
  v_menu_id uuid;
  v_date date := app_private.today_jst() + 3;
  v_start timestamptz;
  v_res json;
  v_res_id uuid;
  v_client uuid;
  v_source uuid;
  v_merge json;
  v_event bigint;
  v_list json;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;

  insert into app_private.hq_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_hq), now() + interval '1 hour')
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

  v_start := app_private.jst_ts(v_date, time '09:00');
  v_res := public.staff_create_reservation(v_staff, jsonb_build_object(
    'starts_at', v_start,
    'menu_codes', jsonb_build_array('maintenance-ginjiro'),
    'staff_id', v_staff_id,
    'customer_name', 'Preflight Booking',
    'customer_phone', '080-0000-0000',
    'source', 'phone',
    'note', 'preflight'
  ), 'Preflight');
  if v_res->>'error' is not null then raise exception 'booking_create_failed: %', v_res; end if;
  v_res_id := (v_res->>'id')::uuid;
  select client_id into v_client from public.reservations where id = v_res_id;
  if v_client is null then raise exception 'booking did not attach client'; end if;

  v_res := public.staff_day_ledger(v_staff, v_date);
  if json_array_length(v_res->'reservations') = 0 then raise exception 'day ledger did not include reservation: %', v_res; end if;

  v_list := public.staff_list_clients(v_staff, 'Preflight Booking', 'all', 0);
  if json_array_length(v_list->'rows') = 0 then raise exception 'client search failed: %', v_list; end if;

  v_res := public.staff_client_ledger(v_staff, v_client);
  if v_res->'client'->>'name' <> 'Preflight Booking' then raise exception 'client ledger mismatch: %', v_res; end if;

  v_source := app_private.create_client('Preflight Merge Source', 'staff', 'staff', 'Preflight');
  v_merge := public.staff_merge_clients(v_staff, v_client, v_source, 'Preflight');
  if v_merge->>'error' is not null then raise exception 'client merge failed: %', v_merge; end if;
  v_event := (v_merge->>'event_id')::bigint;
  v_merge := public.staff_unmerge_client(v_staff, v_event, 'Preflight');
  if v_merge->>'error' is not null then raise exception 'client unmerge failed: %', v_merge; end if;
end $$;

rollback;
