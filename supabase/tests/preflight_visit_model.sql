-- Staging preflight: client visit model (20261007000000_client_visit_model.sql).
-- One visit per reservation (dated by reservations.starts_at) even when checkout happens on another day;
-- unlinked sales are walk-ins, except when the same client has exactly one completed reservation without a sale on that day.
-- Wrapped in a transaction and rolled back (no data is left behind).

begin;

do $$
declare
  v_staff text := 'preflight-visit-staff';
  v_hq text := 'preflight-visit-hq';
  v_gin uuid;
  v_tei uuid;
  v_date date := app_private.today_jst() + 6;
  v_res json;
  v_res_id uuid;
  v_client uuid;
  v_sale json;
  v_sale_id uuid;
  v_ledger jsonb;
  v_row jsonb;
  v_res2 uuid;
  v_client2 uuid;
  st text;
begin
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_staff), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;
  insert into app_private.hq_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_hq), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;
  select id into v_gin from public.staff_members where display_name = '銀二郎';
  select id into v_tei from public.staff_members where display_name = 'テイテイ';
  if v_gin is null or v_tei is null or not exists (select 1 from public.service_menus where code = 'perm-ginpara-curly' and booking_enabled) then
    raise exception 'seed data missing (stylists / bookable ギンパラカーリー)';
  end if;
  insert into public.staff_shift_templates (staff_id, weekday, start_time, end_time)
  values (v_gin, extract(dow from v_date)::int, time '09:00', time '20:00')
  on conflict (staff_id, weekday) do update set start_time = excluded.start_time, end_time = excluded.end_time;

  -- 予約（6日後）を今日会計：来店は1回、日付は予約日
  v_res := public.staff_create_reservation(v_staff, jsonb_build_object('starts_at', app_private.jst_ts(v_date, time '10:00'),
    'menu_codes', jsonb_build_array('perm-ginpara-curly'), 'staff_id', v_gin, 'customer_name', 'Preflight Visit', 'source', 'staff'), 'Preflight');
  if v_res->>'error' is not null then raise exception 'reservation failed: %', v_res; end if;
  v_res_id := (v_res->>'id')::uuid;
  v_client := (v_res->>'client_id')::uuid;
  foreach st in array array['checked_in', 'in_service', 'awaiting_payment'] loop
    perform public.staff_set_reservation_status(v_staff, v_res_id, st, 'Preflight');
  end loop;
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object('reservation_id', v_res_id, 'stylist_id', v_gin,
    'items', jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', 'perm-ginpara-curly', 'name', 'ギンパラカーリー', 'category', 'menu', 'unit_price', 15000, 'quantity', 1)),
    'payment_method', 'cash', 'expected_total', 15000, 'idempotency_key', 'preflight-visit-1'), 'Preflight');
  if v_sale->>'status' <> 'completed' then raise exception 'checkout failed: %', v_sale; end if;
  v_sale_id := (v_sale->>'id')::uuid;
  v_ledger := app_private.client_ledger_json(v_client);
  if (v_ledger->'stats'->>'visit_count')::int <> 1 or v_ledger->'stats'->>'last_visit' <> v_date::text
     or v_ledger->'treatments'->0->>'date' <> v_date::text
     or jsonb_array_length(v_ledger->'stylists') <> 1 or (v_ledger->'stylists'->0->>'count')::int <> 1 then
    raise exception 'reservation sale must be one visit dated by the reservation: %', v_ledger->'stats';
  end if;
  select r into v_row from jsonb_array_elements(app_private.list_clients_json('Preflight Visit', 'all', 0)->'rows') r where (r->>'id')::uuid = v_client;
  if (v_row->>'visit_count')::int <> 1 then raise exception 'customer list disagrees: %', v_row; end if;

  -- 予約なしの店頭会計（今日）は1回の来店として増える
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object('client_id', v_client, 'stylist_id', v_tei,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 3000, 'quantity', 1)),
    'payment_method', 'cash', 'expected_total', 3000, 'idempotency_key', 'preflight-visit-2'), 'Preflight');
  v_ledger := app_private.client_ledger_json(v_client);
  if (v_ledger->'stats'->>'visit_count')::int <> 2 or (v_ledger->'stats'->>'total_sales')::int <> 18000 then
    raise exception 'walk-in must add one visit: %', v_ledger->'stats';
  end if;

  -- 予約の会計を取消：来店（完了した予約）は残り、売上から外れる
  v_sale := public.hq_void_sale(v_hq, v_sale_id, 'preflight visit');
  v_ledger := app_private.client_ledger_json(v_client);
  if v_sale->>'status' <> 'voided' or (v_ledger->'stats'->>'visit_count')::int <> 2 or (v_ledger->'stats'->>'total_sales')::int <> 3000 then
    raise exception 'void must keep the visit and drop the sale: %', v_ledger->'stats';
  end if;

  -- 自動の突き合わせ：同じ顧客・同じ日の「会計が紐づいていない完了予約」が1件だけ → 予約なしの会計はその来店に含める
  v_res := public.staff_create_reservation(v_staff, jsonb_build_object('starts_at', app_private.jst_ts(v_date, time '15:00'),
    'menu_codes', jsonb_build_array('perm-ginpara-curly'), 'staff_id', v_gin, 'customer_name', 'Preflight Visit Match', 'source', 'staff'), 'Preflight');
  if v_res->>'error' is not null then raise exception 'reservation 2 failed: %', v_res; end if;
  v_res2 := (v_res->>'id')::uuid;
  v_client2 := (v_res->>'client_id')::uuid;
  update public.reservations set status = 'completed', starts_at = app_private.jst_ts(app_private.today_jst(), time '06:00'),
    ends_at = app_private.jst_ts(app_private.today_jst(), time '06:30'), occupied_until = app_private.jst_ts(app_private.today_jst(), time '06:30')
  where id = v_res2;
  v_sale := public.staff_finalize_sale(v_staff, jsonb_build_object('client_id', v_client2, 'stylist_id', v_gin,
    'items', jsonb_build_array(jsonb_build_object('name', 'カット', 'category', 'menu', 'unit_price', 3300, 'quantity', 1)),
    'payment_method', 'cash', 'expected_total', 3300, 'idempotency_key', 'preflight-visit-3'), 'Preflight');
  v_ledger := app_private.client_ledger_json(v_client2);
  if (v_ledger->'stats'->>'visit_count')::int <> 1 or (v_ledger->'stats'->>'total_sales')::int <> 3300 then
    raise exception 'one same-day candidate must be matched (one visit): %', v_ledger->'stats';
  end if;
end $$;

rollback;
