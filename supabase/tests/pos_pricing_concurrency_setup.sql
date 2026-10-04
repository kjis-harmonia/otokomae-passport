-- POS Pricing 同時実行テスト準備（使い捨て DB で実行）
--   1 つの確定リクエスト（同じ quote_hash, 同じ idempotency_key）に対して 10 クライアントが同時に staff_finalize_sale を実行する
--   → 会計作成はちょうど 1 件、二重作成・二重決済・デッドロックが発生せず全て同一会計を返すことを検証する

create table if not exists public.__pos_pricing_cases (
  run_id        uuid not null,
  worker_no     integer not null,
  staff_token   text not null,
  payload       jsonb not null,
  primary key (run_id, worker_no)
);

create table if not exists public.__pos_pricing_latest (
  id      integer primary key default 1 check (id = 1),
  run_id  uuid not null
);

do $$
declare
  v_run         uuid := gen_random_uuid();
  v_staff       text := 'pos-pricing-conc-staff-' || v_run::text;
  v_op_id       uuid;
  v_stylist_id  uuid;
  v_op_tok      text;
  v_client_id   uuid;
  v_service_code text := 'p04-conc-cut-' || substr(v_run::text, 1, 6);
  v_quote       jsonb;
  v_qhash       text;
  v_payload     jsonb;
  i             integer;
begin
  insert into app_private.staff_sessions (token_hash, expires_at)
  values (app_private.sha256_hex(v_staff), now() + interval '1 hour');

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('POS_価格同時_担当_' || substr(v_run::text, 1, 6), true, true, 301) returning id into v_stylist_id;

  insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
  values ('POS_価格同時_操作者_' || substr(v_run::text, 1, 6), true, true, 302) returning id into v_op_id;

  perform app_private.set_staff_operator_credentials(v_op_id, '1111', 'staff');
  v_op_tok := (public.staff_operator_verify(v_staff, v_op_id, '1111')->>'operator_token');

  v_client_id := app_private.create_client('POS_価格同時_顧客_' || substr(v_run::text, 1, 6), 'staff', 'staff', 'ConcurrencyTester');

  insert into public.service_menus (code, name, price, is_active, checkout_enabled, price_from, duration_min)
  values (v_service_code, 'POS同時テストカット', 5000, true, true, false, 60);

  -- quote を取得して quote_hash を発行
  v_quote := public.staff_pos_quote(v_staff, v_op_tok, null, jsonb_build_object(
    'client_id', v_client_id,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code))
  ))::jsonb;
  v_qhash := v_quote->>'quote_hash';

  v_payload := jsonb_build_object(
    'client_id', v_client_id,
    'stylist_id', v_stylist_id,
    'operator_token', v_op_tok,
    'items', jsonb_build_array(jsonb_build_object('source', 'service_menu', 'ref_id', v_service_code)),
    'payment_method', 'cash',
    'expected_total', 5000,
    'quote_hash', v_qhash,
    'idempotency_key', 'pos-pricing-conc-idem-' || v_run::text
  );

  for i in 0..9 loop
    insert into public.__pos_pricing_cases (
      run_id, worker_no, staff_token, payload
    ) values (
      v_run, i, v_staff, v_payload
    );
  end loop;

  insert into public.__pos_pricing_latest (id, run_id)
  values (1, v_run)
  on conflict (id) do update set run_id = excluded.run_id;
end $$;
