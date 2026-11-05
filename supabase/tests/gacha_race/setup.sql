-- 同時操作の試験の準備（試験会員だけ。終わったら teardown.sql）
do $$
declare U text := 'u-v2qa-claude-1024'; CL uuid := 'c8f53738-85a6-4aec-828f-f8d0cb51cfe2';
  A uuid := 'ac3d008f-e09e-4d7e-8656-dc5661c8829e'; B uuid := 'b2bc72d8-862d-48e0-9325-0d8c92e3c625'; v uuid; x uuid;
begin
  insert into app_private.customer_sessions (token_hash, user_id, created_via) values (app_private.sha256_hex('race-cust-token-0123456789abcdef0123456789'), U, 'register') on conflict (token_hash) do update set revoked_at = null;
  insert into app_private.customer_sessions (token_hash, user_id, created_via) values (app_private.sha256_hex('race-cust-token2-0123456789abcdef012345678'), U, 'register') on conflict (token_hash) do update set revoked_at = null;
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex('race-staff-token-0123456789abcdef0123456789'), now() + interval '1 hour') on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;
  for x in select id from public.accounting_sessions where reservation_id in (A, B) and status = 'completed' loop perform app_private.void_sale(x, '同時試験', 'staff', '同時試験'); end loop;
  update public.reservations set ends_at = ends_at + ('2026-11-10 06:00+00'::timestamptz - starts_at), occupied_until = occupied_until + ('2026-11-10 06:00+00'::timestamptz - starts_at),
    starts_at = '2026-11-10 06:00+00', status = 'confirmed', companion_of = null, user_id = U, client_id = CL where id = A;
  update public.reservations set ends_at = ends_at + ('2026-11-10 08:00+00'::timestamptz - starts_at), occupied_until = occupied_until + ('2026-11-10 08:00+00'::timestamptz - starts_at),
    starts_at = '2026-11-10 08:00+00', status = 'confirmed', companion_of = null, user_id = U, client_id = CL where id = B;
  update public.reservation_items set menu_code = 'cut-regular' where reservation_id = A;
  update app_private.gacha_draws set choice = 'old' where user_id = U and choice is null;
  update app_private.gacha_settings set repeat = false where id = 1;
  delete from app_private.gacha_draws where user_id = U and draw_date = app_private.today_jst();
  insert into app_private.gacha_draws (user_id, draw_date, prize_code, choice) values (U, app_private.today_jst() - 2, 'off300', 'auto') returning id into v;
  perform app_private.gacha_hold(U, v);
  update app_private.gacha_holdings set reservation_id = A where user_id = U;
  -- 選んでいない当選（交換を試すため）
  insert into app_private.gacha_draws (user_id, draw_date, prize_code) values (U, app_private.today_jst() - 1, 'off500');
end $$;
select json_build_object('held', app_private.gacha_held_json('u-v2qa-claude-1024'), 'pending', (app_private.gacha_pending('u-v2qa-claude-1024')).prize_code) j;
