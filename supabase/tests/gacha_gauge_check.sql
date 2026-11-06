-- ガチャのゲージの点検。Staging 専用（試験会員 u-v2qa-claude-1024 の予約・顧客を使う）。最後に例外を出して全部取り消すので、DB には何も残らない
-- 流し方：npx -y supabase@2.121.0 db query --linked --project-ref kfufxzmucjljjouzpumi --file supabase/tests/gacha_gauge_check.sql
--   結果はエラーの文（RESULT …）に OK / NG で出る。NG が 0 なら合格

create function pg_temp.chk(p_name text, p_got text, p_want text) returns text language sql as $$
  select case when p_got is not distinct from p_want then 'OK  ' else 'NG  ' end || p_name || '：' || coalesce(p_got, 'null') || case when p_got is distinct from p_want then '（期待 ' || coalesce(p_want, 'null') || '）' else '' end || E'\n'
$$;
create function pg_temp.give(p_user text, p_code text) returns void language plpgsql as $$
declare v uuid; begin
  update app_private.gacha_draws set choice = 'old' where user_id = p_user and choice is null;
  insert into app_private.gacha_draws (user_id, draw_date, prize_code, choice) values (p_user, app_private.today_jst() - 3, p_code, 'auto') returning id into v;
  perform app_private.gacha_hold(p_user, v);
end $$;
create function pg_temp.place(p_res uuid, p_at timestamptz, p_status text default 'confirmed') returns void language sql as $$
  update public.reservations set ends_at = ends_at + (p_at - starts_at), occupied_until = occupied_until + (p_at - starts_at), starts_at = p_at, status = p_status, companion_of = null where id = p_res;
$$;
create function pg_temp.unpay(p_res uuid) returns void language plpgsql as $$
declare x uuid; begin
  for x in select id from public.accounting_sessions where reservation_id = p_res and status = 'completed' loop perform app_private.void_sale(x, '点検', 'staff', '点検'); end loop;
end $$;
create function pg_temp.err(j json) returns text language sql as $$ select coalesce(j->>'error', 'ok') $$;
create function pg_temp.sale(p_res uuid, p_items jsonb, p_total int, p_gacha boolean, p_key text) returns jsonb language sql as $$
  select app_private.finalize_sale(jsonb_build_object('reservation_id', p_res, 'stylist_id', 'f994b636-2e11-4a71-bc1c-0421f103d515',
    'items', p_items, 'ticket_ids', '[]'::jsonb, 'payment_method', 'cash', 'expected_total', p_total, 'use_gacha', p_gacha, 'idempotency_key', p_key), 'staff', '点検')
$$;
create function pg_temp.pt(p_token text) returns text language sql as $$ select public.customer_gacha_state(p_token)->'gauge'->>'points' $$;
create function pg_temp.item(p_code text, p_name text, p_price int, p_cat text default 'menu', p_src text default 'reservation') returns jsonb language sql as $$
  select jsonb_build_object('source', p_src, 'ref_id', p_code, 'name', p_name, 'category', p_cat, 'unit_price', p_price, 'quantity', 1, 'discount', 0)
$$;
create function pg_temp.goal(p_token text, p_code text) returns text language sql as $$
  select x->>'points' from json_array_elements(public.customer_gacha_state(p_token)->'gauge'->'goals') x where x->>'code' = p_code
$$;

do $t$
declare
  U text := 'u-v2qa-claude-1024'; T text := 'gauge-suite-token-0123456789abcdef0123456789';
  CL uuid := 'c8f53738-85a6-4aec-828f-f8d0cb51cfe2';
  A uuid := 'ac3d008f-e09e-4d7e-8656-dc5661c8829e';
  B uuid := 'b2bc72d8-862d-48e0-9325-0d8c92e3c625';
  TUE timestamptz := '2026-11-10 06:00+00';
  log text := ''; s jsonb; j json; v_sale uuid;
begin
  insert into app_private.customer_sessions (token_hash, user_id, created_via) values (app_private.sha256_hex(T), U, 'register');
  update app_private.gacha_settings set repeat = false, gauge_opens_on = date '2026-11-01' where id = 1;
  delete from app_private.gacha_holdings where user_id = U;
  delete from app_private.gacha_gauge where user_id = U;
  perform pg_temp.unpay(A); perform pg_temp.unpay(B);
  perform pg_temp.place(A, TUE); perform pg_temp.place(B, TUE + interval '1 hour');
  update public.reservations set user_id = U, client_id = CL where id in (A, B);
  update public.reservation_items set menu_code = 'cut-regular' where reservation_id = A;
  update public.reservation_items set menu_code = 'perm-iper' where reservation_id = B;

  log := log || E'── 狙う景品\n';
  log := log || pg_temp.chk('最初は 0pt', pg_temp.pt(T), '0');
  log := log || pg_temp.chk('ゲージに無い景品（100円引き）', pg_temp.err(public.customer_gacha_gauge_target(T, 'off100')), 'bad_target');
  log := log || pg_temp.chk('APACHI を狙う', pg_temp.err(public.customer_gacha_gauge_target(T, 'free-apachi')), 'ok');
  log := log || pg_temp.chk('APACHI は 40pt', pg_temp.goal(T, 'free-apachi'), '40.0');
  log := log || pg_temp.chk('銀パラは 40pt', pg_temp.goal(T, 'free-ginpara'), '40.0');
  log := log || pg_temp.chk('パンチは 20pt', pg_temp.goal(T, 'free-punch'), '20.0');
  log := log || pg_temp.chk('500円引きは 5pt', pg_temp.goal(T, 'off500'), '5.0');
  log := log || pg_temp.chk('たまる前に受け取る', pg_temp.err(public.customer_gacha_gauge_claim(T)), 'not_enough');

  log := log || E'── たまる\n';
  perform pg_temp.give(U, 'off300'); perform public.customer_gacha_attach(T, A);
  s := pg_temp.sale(A, jsonb_build_array(pg_temp.item('cut-regular', '通常カット', 4000)), 3700, true, 'gk-a1');
  v_sale := (s->>'id')::uuid;
  log := log || pg_temp.chk('4,000円（券で 3,700円）→ 値引き前で 0.5pt', coalesce(s->>'error', pg_temp.pt(T)), '0.5');
  perform pg_temp.give(U, 'off100'); perform public.customer_gacha_attach(T, B);
  s := pg_temp.sale(B, jsonb_build_array(pg_temp.item('perm-iper', 'アイパー', 9000)), 8900, true, 'gk-b1');
  log := log || pg_temp.chk('9,000円 → 1pt（計 1.5）', coalesce(s->>'error', pg_temp.pt(T)), '1.5');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  log := log || pg_temp.chk('アイパーの会計を取り消す → 1pt 戻る', pg_temp.pt(T), '0.5');
  perform app_private.void_sale(v_sale, '点検', 'staff', '点検');
  log := log || pg_temp.chk('カットの会計も取り消す → 0', pg_temp.pt(T), '0.0');

  log := log || E'── 付かない\n';
  perform pg_temp.place(A, TUE);
  s := pg_temp.sale(A, jsonb_build_array(pg_temp.item('cut-regular', '通常カット', 4000)), 4000, false, 'gk-a2');
  log := log || pg_temp.chk('ガチャ券を使わない会計', coalesce(s->>'error', pg_temp.pt(T)), '0.0');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  perform pg_temp.place(A, TUE);
  update public.reservation_items set menu_code = 'cut-kids-skin-fade' where reservation_id = A;
  perform pg_temp.give(U, 'off300');
  log := log || pg_temp.chk('子供スキンフェードに券を付ける', pg_temp.err(public.customer_gacha_attach(T, A)), 'ok');
  s := pg_temp.sale(A, jsonb_build_array(pg_temp.item('cut-kids-skin-fade', '子供スキンフェード', 3000)), 2700, true, 'gk-a3');
  log := log || pg_temp.chk('子供スキンフェード 3,000円 → 付かない', coalesce(s->>'error', pg_temp.pt(T)), '0.0');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  perform pg_temp.place(A, TUE);
  update public.reservation_items set menu_code = 'cut-regular' where reservation_id = A;
  perform pg_temp.give(U, 'off300'); perform public.customer_gacha_attach(T, A);
  s := pg_temp.sale(A, jsonb_build_array(pg_temp.item('cut-buzz', '丸刈り', 1500, 'menu', 'service_menu'), pg_temp.item(null, 'シャンプー（物販）', 5000, 'retail', 'manual')), 6200, true, 'gk-a4');
  log := log || pg_temp.chk('物販 5,000 ＋ 丸刈り 1,500 → 物販は数えず付かない', coalesce(s->>'error', pg_temp.pt(T)), '0.0');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');

  log := log || E'── お連れ様\n';
  perform pg_temp.place(A, TUE); perform pg_temp.place(B, TUE + interval '1 hour');
  update public.reservations set companion_of = A where id = B;
  perform pg_temp.give(U, 'free-aipa');
  log := log || pg_temp.chk('当たりの無料券はお連れ様に付く', pg_temp.err(public.customer_gacha_attach(T, B)), 'ok');
  s := pg_temp.sale(B, jsonb_build_array(pg_temp.item('perm-iper', 'アイパー', 9000)), 0, true, 'gk-c1');
  log := log || pg_temp.chk('お連れ様の会計 → 付かない', coalesce(s->>'error', pg_temp.pt(T)), '0.0');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');

  log := log || E'── 受け取る\n';
  perform pg_temp.place(A, TUE); perform pg_temp.place(B, TUE + interval '1 hour');
  update app_private.gacha_gauge set points = 40.5 where user_id = U;
  perform pg_temp.give(U, 'off100'); perform public.customer_gacha_attach(T, A);
  log := log || pg_temp.chk('予約に付いた券があるうちは受け取れない', pg_temp.err(public.customer_gacha_gauge_claim(T)), 'held_reserved');
  update app_private.gacha_holdings set reservation_id = null where user_id = U;
  j := public.customer_gacha_gauge_claim(T);
  log := log || pg_temp.chk('受け取る → APACHI 無料が持ち券に', coalesce(j->>'error', j->'held'->>'code'), 'free-apachi');
  log := log || pg_temp.chk('ゲージの券はご本人だけ', (j->'held'->>'self_only'), 'true');
  log := log || pg_temp.chk('残りは 0.5pt', (j->'gauge'->>'points'), '0.5');
  log := log || pg_temp.chk('もう一度受け取る', pg_temp.err(public.customer_gacha_gauge_claim(T)), 'not_enough');
  update public.reservations set companion_of = A where id = B;
  update public.reservation_items set menu_code = 'perm-apache' where reservation_id = B;
  log := log || pg_temp.chk('ゲージの券をお連れ様に', pg_temp.err(public.customer_gacha_attach(T, B)), 'companion');
  update public.reservations set companion_of = null where id = B;
  log := log || pg_temp.chk('ご本人の APACHI の予約には付く', pg_temp.err(public.customer_gacha_attach(T, B)), 'ok');
  s := pg_temp.sale(B, jsonb_build_array(pg_temp.item('perm-apache', 'アパッチ', 18000)), 0, true, 'gk-b2');
  log := log || pg_temp.chk('APACHI 無料の会計は 0円', coalesce(s->>'error', s->>'total'), '0');
  log := log || pg_temp.chk('無料券の来店でも値引き前 18,000 → 1pt', pg_temp.pt(T), '1.5');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  log := log || pg_temp.chk('取り消すと券が戻る', (public.customer_gacha_state(T)->'held'->>'code'), 'free-apachi');
  log := log || pg_temp.chk('取り消すとポイントも戻る', pg_temp.pt(T), '0.5');
  perform pg_temp.give(U, 'off100');
  log := log || pg_temp.chk('抽選の券に入れ替えるとご本人だけの印は外れる', (public.customer_gacha_state(T)->'held'->>'self_only'), 'false');
  log := log || pg_temp.chk('受け取りの記録', (select count(*)::text from app_private.gacha_gauge_log where user_id = U and kind = 'claim'), '1');

  log := log || E'── 解禁前\n';
  update app_private.gacha_settings set gauge_opens_on = date '2026-12-01' where id = 1;
  log := log || pg_temp.chk('解禁前は閉じている', (public.customer_gacha_state(T)->'gauge'->>'open'), 'false');
  log := log || pg_temp.chk('解禁前に狙う', pg_temp.err(public.customer_gacha_gauge_target(T, 'free-punch')), 'not_open');
  perform pg_temp.place(A, TUE); perform public.customer_gacha_attach(T, A);
  s := pg_temp.sale(A, jsonb_build_array(pg_temp.item('cut-regular', '通常カット', 4000)), 3900, true, 'gk-a5');
  log := log || pg_temp.chk('会計そのものは通る', coalesce(s->>'error', s->>'total'), '3900');
  log := log || pg_temp.chk('解禁前の会計は付かない', (select points::text from app_private.gacha_gauge where user_id = U), '0.0');

  raise exception 'RESULT%', E'\n' || log;
end $t$;
