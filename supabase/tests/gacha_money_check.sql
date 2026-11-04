-- ガチャ券とお金の点検（55項目）。Staging 専用（試験会員 u-v2qa-claude-1024 の予約・顧客を使う）。最後に例外を出して全部取り消すので、DB には何も残らない
-- 流し方：npx -y supabase@2.121.0 db query --linked --project-ref kfufxzmucjljjouzpumi --file supabase/tests/gacha_money_check.sql
--   結果はエラーの文（RESULT …）に OK / NG で出る。NG が 0 なら合格。本番に出す前に毎回流す

-- ガチャ券とお金の点検（すべて最後に取り消す）。各項目は 期待どおりなら OK、違えば NG
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
create function pg_temp.sale(p_res uuid, p_client uuid, p_items jsonb, p_total int, p_gacha boolean, p_key text, p_method text default 'cash', p_extra jsonb default '{}') returns jsonb language sql as $$
  select app_private.finalize_sale(jsonb_build_object('reservation_id', p_res, 'client_id', p_client, 'stylist_id', 'f994b636-2e11-4a71-bc1c-0421f103d515',
    'items', p_items, 'ticket_ids', '[]'::jsonb, 'payment_method', p_method, 'expected_total', p_total, 'use_gacha', p_gacha, 'idempotency_key', p_key) || p_extra, 'staff', '点検')
$$;

do $t$
declare
  U text := 'u-v2qa-claude-1024'; T text := 'gacha-suite-token-0123456789abcdef0123456789';
  CL uuid := 'c8f53738-85a6-4aec-828f-f8d0cb51cfe2';
  A uuid := 'ac3d008f-e09e-4d7e-8656-dc5661c8829e';   -- 通常カット 4,000
  B uuid := 'b2bc72d8-862d-48e0-9325-0d8c92e3c625';   -- アイパー 9,000
  X uuid := 'fa8c9b15-3dd9-4e15-8821-774a071c05b5';   -- ほかの会員の予約
  ST text := 'gacha-suite-staff-0123456789abcdef0123456789';
  TUE timestamptz := '2026-11-10 06:00+00'; SAT timestamptz := '2026-11-07 06:00+00'; HOL timestamptz := '2026-11-23 06:00+00';
  cut jsonb := jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', 'cut-regular', 'name', '通常カット', 'category', 'menu', 'unit_price', 4000, 'quantity', 1, 'discount', 0));
  iper jsonb := jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', 'perm-iper', 'name', 'アイパー', 'category', 'menu', 'unit_price', 9000, 'quantity', 1, 'discount', 0));
  log text := ''; j json; s jsonb; s2 jsonb; v_acc uuid; v_bal int; v_bal0 int; v_sale uuid;
begin
  insert into app_private.customer_sessions (token_hash, user_id, created_via) values (app_private.sha256_hex(T), U, 'register');
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(ST), now() + interval '10 minutes');
  update app_private.gacha_settings set repeat = false where id = 1;
  delete from app_private.gacha_holdings where user_id = U;
  perform pg_temp.place(A, TUE); perform pg_temp.place(B, TUE + interval '1 hour');
  update public.reservations set user_id = U, client_id = CL where id in (A, B);

  log := log || E'── 付ける（予約の確認）\n';
  log := log || pg_temp.chk('券なし', pg_temp.err(public.customer_gacha_attach(T, A)), 'no_ticket');
  perform pg_temp.give(U, 'off300');
  log := log || pg_temp.chk('ほかの会員の予約', pg_temp.err(public.customer_gacha_attach(T, X)), 'not_found');
  perform pg_temp.place(A, TUE, 'cancelled');
  log := log || pg_temp.chk('キャンセル済みの予約', pg_temp.err(public.customer_gacha_attach(T, A)), 'not_found');
  perform pg_temp.place(A, SAT);
  log := log || pg_temp.chk('平日のみの券を土曜に', pg_temp.err(public.customer_gacha_attach(T, A)), 'weekday');
  perform pg_temp.place(A, HOL);
  log := log || pg_temp.chk('平日のみの券を祝日（11/23）に', pg_temp.err(public.customer_gacha_attach(T, A)), 'weekday');
  perform pg_temp.place(A, TUE);
  update app_private.gacha_holdings set expires_at = '2026-11-08 15:00+00' where user_id = U;
  log := log || pg_temp.chk('予約の日には期限切れ', pg_temp.err(public.customer_gacha_attach(T, A)), 'expired');
  update app_private.gacha_holdings set expires_at = '2026-12-04 15:00+00' where user_id = U;
  update public.reservation_items set menu_code = 'maintenance' where reservation_id = A;
  log := log || pg_temp.chk('割引券をメンテナンスカットに', pg_temp.err(public.customer_gacha_attach(T, A)), 'menu');
  update public.reservation_items set menu_code = 'cut-regular' where reservation_id = A;
  log := log || pg_temp.chk('使える予約に付く', pg_temp.err(public.customer_gacha_attach(T, A)), 'ok');
  log := log || pg_temp.chk('同じ予約にもう一度（変わらない）', pg_temp.err(public.customer_gacha_attach(T, A)), 'ok');
  log := log || pg_temp.chk('付いたままほかの予約へ', pg_temp.err(public.customer_gacha_attach(T, B)), 'held_reserved');

  log := log || E'── 交換（予約に付いている間）\n';
  insert into app_private.gacha_draws (user_id, draw_date, prize_code) values (U, app_private.today_jst() - 1, 'off500');
  log := log || pg_temp.chk('確定中に新しい券へ交換', pg_temp.err(public.customer_gacha_keep(T, 'new')), 'held_reserved');
  update public.reservations set status = 'checked_in' where id = A;
  log := log || pg_temp.chk('来店（チェックイン）後に交換', pg_temp.err(public.customer_gacha_keep(T, 'new')), 'held_reserved');
  update public.reservations set status = 'awaiting_payment' where id = A;
  log := log || pg_temp.chk('会計待ちで交換', pg_temp.err(public.customer_gacha_keep(T, 'new')), 'held_reserved');
  log := log || pg_temp.chk('会計待ちでも券は予約に付いたまま', (public.customer_gacha_state(T)->'held'->'reserved'->>'id'), A::text);
  log := log || pg_temp.chk('引こうとしても選んでいない当選を返すだけ', (public.customer_gacha_draw(T)->'today'->'prize'->>'code'), 'off500');
  update public.reservations set status = 'confirmed' where id = A;

  log := log || E'── 会計\n';
  log := log || pg_temp.chk('予約なしの会計でガチャ券', (pg_temp.sale(null, CL, cut, 3700, true, 'k-walk')->>'error'), 'gacha_invalid');
  log := log || pg_temp.chk('券の付いていない予約でガチャ券', (pg_temp.sale(B, null, iper, 8700, true, 'k-b')->>'error'), 'gacha_invalid');
  log := log || pg_temp.chk('券を引かない金額で送る（ずれ）', (pg_temp.sale(A, null, cut, 4000, true, 'k-mis')->>'error'), 'total_mismatch');
  log := log || pg_temp.chk('ずれのあとも券はそのまま', (public.customer_gacha_state(T)->'held'->'reserved'->>'id'), A::text);
  -- 明細の値引き 500 ＋ 手入力の値引き 200 ＋ ガチャ券 300 → 3,000
  s := pg_temp.sale(A, null, jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', 'cut-regular', 'name', '通常カット', 'category', 'menu', 'unit_price', 4000, 'quantity', 1, 'discount', 500)),
         3000, true, 'k-a1', 'cash', jsonb_build_object('manual_discount', jsonb_build_object('amount', 200, 'label', '点検')));
  log := log || pg_temp.chk('値引きが重なっても正しい額', s->>'total', '3000');
  v_sale := (s->>'id')::uuid;
  log := log || pg_temp.chk('記録に「ガチャ券 300円引き」', (select label || ' ' || amount from public.accounting_discounts where session_id = v_sale and ticket_type = 'gacha'), 'ガチャ券 300円引き 300');
  log := log || pg_temp.chk('会計のあと券は使用済み', (select (used_at is not null)::text from app_private.gacha_holdings where user_id = U), 'true');
  log := log || pg_temp.chk('同じ取引キーで再送（二重にならない）', (pg_temp.sale(A, null, cut, 3000, true, 'k-a1')->>'id'), v_sale::text);
  log := log || pg_temp.chk('同じ予約をもう一度会計', (pg_temp.sale(A, null, cut, 3700, true, 'k-a2')->>'error'), 'already_paid');
  log := log || pg_temp.chk('使った後は保留の当選を自動で受け取る', (public.customer_gacha_state(T)->'held'->>'code'), 'off500');
  -- 取消：受け取った新しい券がある時は、使った券は戻らない（1枚しか持てない）。売上は取り消される
  s := app_private.void_sale(v_sale, '点検', 'staff', '点検');
  log := log || pg_temp.chk('取消', s->>'status', 'voided');
  log := log || pg_temp.chk('取消のあとも持ち券は新しい券のまま', (public.customer_gacha_state(T)->'held'->>'code'), 'off500');

  log := log || E'── 取消で戻る（新しい券を受け取っていない時）\n';
  perform pg_temp.place(A, TUE + interval '2 hours');
  perform pg_temp.give(U, 'off300');
  log := log || pg_temp.chk('付ける', pg_temp.err(public.customer_gacha_attach(T, B)), 'ok');
  s := pg_temp.sale(B, null, iper, 8700, true, 'k-b1');
  log := log || pg_temp.chk('アイパーで 300円引き', s->>'total', '8700');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  log := log || pg_temp.chk('取消で券が戻る', (select (used_at is null)::text from app_private.gacha_holdings where user_id = U), 'true');
  s := pg_temp.sale(B, null, iper, 8700, true, 'k-b2');
  log := log || pg_temp.chk('戻った券でもう一度会計', s->>'total', '8700');

  log := log || E'── 無料券\n';
  perform pg_temp.place(B, TUE + interval '3 hours');
  delete from app_private.gacha_holdings where user_id = U;
  perform pg_temp.give(U, 'free-aipa');
  log := log || pg_temp.chk('アイパー無料を通常カットに', pg_temp.err(public.customer_gacha_attach(T, A)), 'menu');
  -- B は会計済み（取り消していない）なので、新しい予約として A をアイパーに
  update public.reservation_items set menu_code = 'perm-iper' where reservation_id = A;
  log := log || pg_temp.chk('アイパー無料をアイパーに', pg_temp.err(public.customer_gacha_attach(T, A)), 'ok');
  s := pg_temp.sale(A, null, jsonb_build_array(jsonb_build_object('source', 'reservation', 'ref_id', 'perm-iper', 'name', 'アイパー', 'category', 'menu', 'unit_price', 9000, 'quantity', 2, 'discount', 0)), 9000, true, 'k-f1');
  log := log || pg_temp.chk('2人分の明細でも無料は1人分', s->>'total', '9000');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  log := log || pg_temp.chk('対象メニューを外した会計', (pg_temp.sale(A, null, cut, 4000, true, 'k-f2')->>'error'), 'gacha_menu');
  s := pg_temp.sale(A, null, cut, 4000, false, 'k-f3');
  log := log || pg_temp.chk('券を外して会計（店で外した）', s->>'total', '4000');
  log := log || pg_temp.chk('使わなかった券は手元に残る（予約は外れる）', (public.customer_gacha_state(T)->'held'->>'code') || '/' || coalesce(public.customer_gacha_state(T)->'held'->>'reserved', 'なし'), 'free-aipa/なし');
  update public.reservation_items set menu_code = 'cut-regular' where reservation_id = A;

  log := log || E'── 銀Pay（予約のときの仮支払い → 会計）\n';
  perform pg_temp.place(A, TUE + interval '4 hours');
  perform pg_temp.unpay(A);
  delete from app_private.gacha_holdings where user_id = U;
  perform pg_temp.give(U, 'off300');
  perform public.customer_gacha_attach(T, A);
  if not exists (select 1 from public.ginpay_accounts where client_id = CL and status = 'active') then j := public.staff_ginpay_open_account(ST, CL, '点検'); end if;
  v_bal0 := coalesce((select balance_cached from public.ginpay_accounts where client_id = CL and status = 'active'), 0);
  j := public.staff_ginpay_charge_store(ST, CL, 10000, 'cash', '点検', '点検', 'suite-charge-1');
  select id, balance_cached into v_acc, v_bal from public.ginpay_accounts where client_id = CL and status = 'active';
  log := log || pg_temp.chk('チャージで 10,000 増える', (v_bal - v_bal0)::text, '10000');
  j := public.customer_ginpay_hold(T, A, 3700);
  log := log || pg_temp.chk('券を引いた額 3,700 を仮支払い', coalesce(j->>'error', j->>'amount'), '3700');
  s := pg_temp.sale(A, null, cut, 3700, true, 'k-g1', 'ginpay', jsonb_build_object('ginpay_account_id', v_acc));
  log := log || pg_temp.chk('銀Pay で 3,700', coalesce(s->>'error', s->>'total'), '3700');
  log := log || pg_temp.chk('残高が 3,700 減る', (v_bal - (select balance_cached from public.ginpay_accounts where id = v_acc))::text, '3700');
  log := log || pg_temp.chk('仮支払いは閉じる', (select status from app_private.ginpay_holds where reservation_id = A order by updated_at desc limit 1), 'closed');
  perform app_private.void_sale((s->>'id')::uuid, '点検', 'staff', '点検');
  log := log || pg_temp.chk('取消で残高が戻る', (select balance_cached from public.ginpay_accounts where id = v_acc)::text, v_bal::text);
  log := log || pg_temp.chk('取消で券も戻る', (select (used_at is null)::text from app_private.gacha_holdings where user_id = U), 'true');
  -- 店で券を外した：仮支払い 3,700 より多い 4,000 を銀Pay で（差額は残高から・残高は足りる）
  s := pg_temp.sale(A, null, cut, 4000, false, 'k-g2', 'ginpay', jsonb_build_object('ginpay_account_id', v_acc));
  log := log || pg_temp.chk('券を外して銀Pay 4,000', coalesce(s->>'error', s->>'total'), '4000');
  log := log || pg_temp.chk('残高が 4,000 減る', (v_bal - (select balance_cached from public.ginpay_accounts where id = v_acc))::text, '4000');

  log := log || E'── お連れ様\n';
  perform pg_temp.place(A, TUE); perform pg_temp.place(B, TUE + interval '30 minutes');
  perform pg_temp.unpay(A); perform pg_temp.unpay(B);
  log := log || pg_temp.chk('つなぐ', pg_temp.err(public.customer_link_companion(T, A, B)), 'ok');
  log := log || pg_temp.chk('逆向き（お連れ様をご本人に）', pg_temp.err(public.customer_link_companion(T, B, A)), 'not_found');
  perform pg_temp.place(X, TUE + interval '1 hour');
  log := log || pg_temp.chk('ほかの会員の予約をつなぐ', pg_temp.err(public.customer_link_companion(T, A, X)), 'not_found');
  update public.reservations set companion_of = A where id = B;
  perform pg_temp.place(B, TUE + interval '1 day');
  log := log || pg_temp.chk('別の日はつなげない', pg_temp.err(public.customer_link_companion(T, A, B)), 'not_same_day');
  perform pg_temp.place(B, TUE + interval '30 minutes');
  perform public.customer_link_companion(T, A, B);
  delete from app_private.gacha_holdings where user_id = U;
  perform pg_temp.give(U, 'off300');
  log := log || pg_temp.chk('割引券はお連れ様に使えない', pg_temp.err(public.customer_gacha_attach(T, B)), 'companion');
  perform pg_temp.give(U, 'free-aipa');
  log := log || pg_temp.chk('無料券はお連れ様に使える', pg_temp.err(public.customer_gacha_attach(T, B)), 'ok');
  log := log || pg_temp.chk('お連れ様の会計は 0円', (pg_temp.sale(B, null, iper, 0, true, 'k-c1')->>'total'), '0');

  log := log || E'── 景品の表の守り\n';
  begin
    insert into app_private.gacha_prizes (code, title, amount, weight) values ('bad', '額なし', null, 0);
    log := log || pg_temp.chk('額もメニューも無い景品は登録できない', 'registered', 'rejected');
  exception when check_violation then
    log := log || pg_temp.chk('額もメニューも無い景品は登録できない', 'rejected', 'rejected');
  end;

  raise exception 'RESULT%', E'\n' || log;
end $t$;
