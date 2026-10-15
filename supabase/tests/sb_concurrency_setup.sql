-- 銀二郎SB 同時実行：同じ担当・同じ時刻に10件が同時に予約しても、入るのは同時受付の枠（3）までであること。
-- 使い捨てのローカル DB だけで使う（pgbench：setup → worker × 10 → verify）。
create schema if not exists sb_conc;
create table if not exists sb_conc.config (id int primary key, token text, staff_id uuid, starts_at timestamptz);
delete from sb_conc.config;

do $$
declare
  v_token text := 'sb-conc-staff-token';
  v_staff uuid;
  v_menu uuid;
  v_date date := app_private.today_jst() + 5;
begin
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_token), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;
  select id into v_staff from public.staff_members where display_name = 'テイテイ';
  if v_staff is null then raise exception 'seed staff missing'; end if;
  update public.staff_members set is_active = true, is_bookable = true, booking_capacity = 3 where id = v_staff;
  insert into public.staff_members (display_name, is_active, is_bookable, sort_order)
  select 'SB同時', true, false, 998 where not exists (select 1 from public.staff_members where display_name = 'SB同時');
  insert into public.service_menus (code, name, category, price, duration_min, buffer_after_min, is_active, booking_enabled, sort_order)
  values ('sbconc-cut', 'SB同時カット', 'カット', 4000, 60, 0, true, true, 998)
  on conflict (code) do update set duration_min = 60, buffer_after_min = 0, is_active = true, booking_enabled = true
  returning id into v_menu;
  insert into public.staff_menu_capabilities (staff_id, menu_id) values (v_staff, v_menu) on conflict do nothing;
  insert into public.staff_shift_templates (staff_id, weekday, start_time, end_time)
  values (v_staff, extract(dow from v_date)::int, time '09:00', time '19:00')
  on conflict (staff_id, weekday) do update set start_time = excluded.start_time, end_time = excluded.end_time;
  delete from public.reservation_items where reservation_id in (select id from public.reservations where customer_name like 'SB同時客%');
  delete from public.reservations where customer_name like 'SB同時客%';
  insert into sb_conc.config values (1, v_token, v_staff, app_private.jst_ts(v_date, time '13:00'));
end $$;

-- 各 worker：見積もり → 登録（新しい依頼 ID）。断られても失敗にはしない（結果は verify で数える）
create or replace function sb_conc.try_book(p_client int)
returns jsonb language plpgsql as $$
declare c sb_conc.config; v_input jsonb; v_preview jsonb;
begin
  select * into c from sb_conc.config where id = 1;
  v_input := jsonb_build_object('starts_at', c.starts_at, 'menu_codes', jsonb_build_array('sbconc-cut'), 'staff_id', c.staff_id,
    'customer_name', 'SB同時客' || p_client, 'source', 'phone');
  v_preview := public.staff_sb_preview(c.token, v_input, null);
  if v_preview ? 'error' then return v_preview; end if;
  return public.staff_sb_mutate(c.token, gen_random_uuid(),
    jsonb_build_object('kind', 'create', 'input', v_input, 'plan_hash', v_preview->>'plan_hash'), 'SB同時');
end $$;
