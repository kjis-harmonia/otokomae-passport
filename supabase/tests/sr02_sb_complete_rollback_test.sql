-- SR-02 の回帰試験（2版目・11/18）。Staging で「begin; <migration>; <この DO>; commit;」として流す。
-- 最後に ROLLBACK_OK を投げるので、migration も試験のデータも全部巻き戻る（共有 Staging DB は変わらない）
do $test$
declare
  a_id uuid := 'e601b7af-98d5-422a-afc8-d050e082d3c6';  -- ご本人 11/23（月）アイパー：Black Monday の印あり
  b_id uuid := '16e53436-d083-4693-b057-36fd6492bc4e';  -- 11/21（土）：予約に付けた通常の券
  c_id uuid := 'd46b48a7-9838-4a5c-8c7a-d08135ed916e';  -- 今日に動かして、会員QRの会計の引き当てを見る
  d_id uuid := '4ac53f2d-4e78-421b-9541-a99ef274c73d';  -- 銀Pay 払いの再送（12/28 は月曜：濡れパン 8,000 − Black Monday 2,000 = 6,000）
  acc uuid := '49783bd7-1ff5-4ac6-8bf4-2d228e99b72e';
  actor text := 'リアン';
  stylist uuid := 'ce7d46e2-30c6-4e95-9662-f378b7fa7ad5';
  tok text := 'sr02-test-staff-token';
  uid text; res jsonb; st text; hs text; n0 int; n1 int; tk uuid; log text := ''; sale jsonb; sale2 jsonb; items jsonb;
  e_id uuid; f_id uuid; g_id uuid; v0 int; v1 int; today_at timestamptz;
begin
  select user_id into uid from public.reservations where id = a_id;
  -- 準備：店舗端末の認証（試験だけ）・試験に関係する券・ガチャ・押さえを外す
  update app_private.staff_device_policy set require_approval = false, locked_at = null where id = 1;
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(tok), now() + interval '1 hour');
  delete from app_private.reservation_ticket_plans where reservation_id in (a_id, b_id, c_id, d_id);
  update app_private.gacha_holdings set reservation_id = null where reservation_id in (a_id, b_id, c_id, d_id);
  delete from app_private.ginpay_holds where reservation_id in (a_id, b_id, c_id, d_id);
  -- 試験用の予約（c をもとに、ずっと先の日に3件）
  for i in 1..3 loop
    insert into public.reservations select (jsonb_populate_record(null::public.reservations, to_jsonb(r) || jsonb_build_object(
      'id', gen_random_uuid(), 'status', 'confirmed', 'external_ref', null, 'companion_id', null, 'companion_of', null,
      'starts_at', timestamptz '2027-03-01 10:00+09' + make_interval(days => i), 'ends_at', timestamptz '2027-03-01 11:00+09' + make_interval(days => i),
      'occupied_until', timestamptz '2027-03-01 11:00+09' + make_interval(days => i)))).* from public.reservations r where r.id = c_id
    returning id into g_id;
    if i = 1 then e_id := g_id; elsif i = 2 then f_id := g_id; end if;
  end loop;

  -- ── Q：今日の予約。施術完了→会計待ちになっても、会員QRの会計（staff_client_for_member）で同じ予約を引ける ──
  today_at := date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo' + interval '23 hours 15 minutes';
  update public.reservations set starts_at = today_at, ends_at = today_at + interval '30 minutes', occupied_until = today_at + interval '30 minutes' where id = c_id;
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (c_id, acc, 1000);
  perform app_private.store_set_status(c_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', c_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = c_id)), actor);
  if (select status from public.reservations where id = c_id) <> 'awaiting_payment' then raise exception 'NG Q1 %', res; end if;
  delete from public.visit_log where user_id = uid and visit_date = app_private.today_jst();  -- 来店登録の予約に頼らず、予約の状態で引けるか
  res := public.staff_client_for_member(tok, uid)::jsonb;
  if res->>'reservation_id' is distinct from c_id::text then raise exception 'NG Q2 会員QRの引き当て % （期待 %）', res, c_id; end if;
  log := log || 'Q 会計待ちの予約を会員QRの会計で引ける OK; ';

  -- ── H1：会計待ちになったあと押さえが外れても、SB の押し直しは会計待ちのまま ──
  update app_private.ginpay_holds set status = 'released' where reservation_id = c_id;
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', c_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = c_id)), actor);
  if (select status from public.reservations where id = c_id) <> 'awaiting_payment' then raise exception 'NG H1 %', res; end if;
  if (select count(*) from public.accounting_sessions where reservation_id = c_id) <> 0 then raise exception 'NG H1 会計ができた'; end if;
  log := log || 'H1 押さえ解除後に押し直しても会計待ち・会計0件 OK; ';

  -- ── H2：旧スタッフ RPC（staff_set_reservation_status）でも、会計の要る予約は完了にできない ──
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (e_id, acc, 1000);
  perform app_private.store_set_status(e_id, 'checked_in', 'staff', actor, null);
  res := public.staff_set_reservation_status(tok, e_id, 'completed', actor, null)::jsonb;
  select status into st from public.reservations where id = e_id;
  select status into hs from app_private.ginpay_holds where reservation_id = e_id;
  if res->>'error' is distinct from 'checkout_required' or st <> 'checked_in' or hs <> 'held' then raise exception 'NG H2 % / % / %', res, st, hs; end if;
  -- 会計待ちからも旧 RPC で完了にできない
  perform app_private.store_set_status(c_id, 'completed', 'staff', actor, null);
  if (select status from public.reservations where id = c_id) <> 'awaiting_payment' then raise exception 'NG H2b 会計待ちが完了になった'; end if;
  log := log || 'H2 旧スタッフRPCでも完了にできない・押さえは残る OK; ';

  -- ── M2：受付前の会計の要る予約に施術完了：断る。来店の記録を作らない ──
  select t.id into tk from public.tickets t where t.user_id = any(app_private.ticket_family_uids(uid)) and not t.used and t.type in ('discount', 'otoku')
    and (t.expires_at is null or t.expires_at > now() + interval '30 days') limit 1;
  if tk is null then
    insert into public.tickets (user_id, type, title, amount, issued_by) values (uid, 'discount', '試験の割引券', 500, 'sr02-test') returning id into tk;
  end if;
  insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) values (b_id, uid, array[tk]);
  select count(*) into v0 from public.visit_log where user_id = uid;
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', b_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = b_id)), actor);
  select count(*) into v1 from public.visit_log where user_id = uid;
  if res->>'error' is distinct from 'check_in_required' or (select status from public.reservations where id = b_id) <> 'confirmed' or v1 <> v0 then
    raise exception 'NG M2 % / 来店 % → %', res, v0, v1;
  end if;
  log := log || 'M2 受付前は断る・来店の記録を作らない OK; ';

  -- ── B1：予約に付けた通常の券だけ：受付後の施術完了で会計待ち ──
  perform app_private.store_set_status(b_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', b_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = b_id)), actor);
  if (select status from public.reservations where id = b_id) <> 'awaiting_payment' then raise exception 'NG B1 %', res; end if;
  log := log || 'B1 通常の券だけ→会計待ち OK; ';

  -- ── M1：期限切れの券だけ：会計の要るものに数えず、今までどおり完了 ──
  insert into public.tickets (user_id, type, title, amount, issued_by, expires_at) values (uid, 'discount', '期限切れの試験券', 500, 'sr02-test', now() - interval '1 day') returning id into tk;
  insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) values (f_id, uid, array[tk]);
  perform app_private.store_set_status(f_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', f_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = f_id)), actor);
  if (select status from public.reservations where id = f_id) <> 'completed' then raise exception 'NG M1 %', res; end if;
  log := log || 'M1 期限切れの券だけ→完了 OK; ';

  -- ── A：Black Monday ＋ 押さえ。現金会計は固定の値（Black Monday −2,000・支払い 6,000）で確定 ──
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (a_id, acc, 3000);
  perform app_private.store_set_status(a_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', a_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = a_id)), actor);
  if (select status from public.reservations where id = a_id) <> 'awaiting_payment' or (select status from app_private.ginpay_holds where reservation_id = a_id) <> 'held' then
    raise exception 'NG A1 %', res;
  end if;
  select count(*) into n0 from public.ginpay_transactions where account_id = acc;
  items := jsonb_build_array(jsonb_build_object('name', 'アイパー', 'category', 'menu', 'unit_price', 8000, 'quantity', 1, 'source', 'reservation', 'ref_id', 'perm-iper'));
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', a_id, 'stylist_id', stylist, 'payment_method', 'cash', 'items', items,
            'expected_total', 6000, 'idempotency_key', 'sr02-test-a'), 'staff', actor);
  if sale ? 'error' or (sale->>'total')::int <> 6000 then raise exception 'NG A2 会計 %', sale; end if;
  if (select amount from public.accounting_discounts where session_id = (sale->>'id')::uuid and kind = 'campaign') is distinct from 2000 then
    raise exception 'NG A2 Black Monday の値引きが 2000 でない';
  end if;
  select count(*) into n1 from public.ginpay_transactions where account_id = acc;
  if (select status from public.reservations where id = a_id) <> 'completed' or (select status from app_private.ginpay_holds where reservation_id = a_id) <> 'closed' or n1 <> n0 then
    raise exception 'NG A3 予約 / 押さえ / 引き落とし % → %', n0, n1;
  end if;
  log := log || 'A 現金 6,000円（Black Monday −2,000）→完了・押さえ閉じ・引き落とし0件 OK; ';
  -- R：会計の確定のあとに SB の施術完了が来ても、会計は1件のまま（予約は完了から動かない）
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', a_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = a_id)), actor);
  if (select count(*) from public.accounting_sessions where reservation_id = a_id and status = 'completed') <> 1
     or (select status from public.reservations where id = a_id) <> 'completed' then raise exception 'NG R %', res; end if;
  log := log || 'R 会計のあとの施術完了でも会計1件・完了のまま OK; ';

  -- ── G：銀Pay 払い。同じキーで再送しても引き落としは1件 ──
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (d_id, acc, 2000);
  perform app_private.store_set_status(d_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', d_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = d_id)), actor);
  if (select status from public.reservations where id = d_id) <> 'awaiting_payment' then raise exception 'NG G1 %', res; end if;
  select count(*) into n0 from public.ginpay_transactions where account_id = acc;
  items := jsonb_build_array(jsonb_build_object('name', '濡れパン', 'category', 'menu', 'unit_price', 8000, 'quantity', 1, 'source', 'reservation', 'ref_id', 'perm-nurepan'));
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', d_id, 'stylist_id', stylist, 'payment_method', 'ginpay', 'ginpay_account_id', acc,
            'items', items, 'expected_total', 6000, 'idempotency_key', 'sr02-test-g'), 'staff', actor);
  sale2 := app_private.finalize_sale(jsonb_build_object('reservation_id', d_id, 'stylist_id', stylist, 'payment_method', 'ginpay', 'ginpay_account_id', acc,
            'items', items, 'expected_total', 6000, 'idempotency_key', 'sr02-test-g'), 'staff', actor);
  select count(*) into n1 from public.ginpay_transactions where account_id = acc;
  if sale ? 'error' or sale2 ? 'error' or (sale2->>'idempotent') is distinct from 'true' or n1 <> n0 + 1
     or (select status from public.reservations where id = d_id) <> 'completed' or (select status from app_private.ginpay_holds where reservation_id = d_id) <> 'closed' then
    raise exception 'NG G2 % / % / 引き落とし % → %', sale, sale2, n0, n1;
  end if;
  log := log || 'G 銀Pay 6,000円（Black Monday 込み）・再送でも引き落とし1件・押さえ閉じ OK; ';

  -- ── E：取消で押さえが戻る（今までどおり）・会計で使うもの無しの予約は施術完了で完了（今までどおり） ──
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (g_id, acc, 1000);
  res := app_private.sb_apply(jsonb_build_object('kind', 'cancel', 'reservation_id', g_id, 'reason', '試験',
           'expected_updated_at', (select updated_at from public.reservations where id = g_id)), actor);
  if (select status from app_private.ginpay_holds where reservation_id = g_id) <> 'released' then raise exception 'NG E1 %', res; end if;
  delete from app_private.ginpay_holds where reservation_id = e_id;
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', e_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = e_id)), actor);
  if (select status from public.reservations where id = e_id) <> 'completed' then raise exception 'NG E2 %', res; end if;
  log := log || 'E 取消で押さえが戻る・会計で使うもの無し→完了 OK; ';

  raise exception 'ROLLBACK_OK %', log;
end $test$;
