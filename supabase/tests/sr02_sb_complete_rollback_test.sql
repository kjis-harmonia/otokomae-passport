do $test$
declare
  a_id uuid := 'e601b7af-98d5-422a-afc8-d050e082d3c6';  -- ご本人 11/23（月）アイパー：Black Monday の印あり ＋ 銀Pay の押さえ
  b_id uuid := '16e53436-d083-4693-b057-36fd6492bc4e';  -- 11/21（土）：予約に付けた券だけ
  c_id uuid := 'd46b48a7-9838-4a5c-8c7a-d08135ed916e';  -- 11/21（土）：会計で使うもの無し
  d_id uuid := '4ac53f2d-4e78-421b-9541-a99ef274c73d';  -- 12/28：押さえ → 取消で戻る
  acc uuid := '49783bd7-1ff5-4ac6-8bf4-2d228e99b72e';
  actor text := 'リアン';
  stylist uuid := 'ce7d46e2-30c6-4e95-9662-f378b7fa7ad5';
  res jsonb; st text; hs text; n0 int; n1 int; tk uuid; log text := ''; sale jsonb; items jsonb;
begin
  -- 準備：試験に関係する券・ガチャ・押さえを外す
  delete from app_private.reservation_ticket_plans where reservation_id in (a_id, b_id, c_id, d_id);
  update app_private.gacha_holdings set reservation_id = null where reservation_id in (a_id, b_id, c_id, d_id);
  delete from app_private.ginpay_holds where reservation_id in (a_id, b_id, c_id, d_id);

  -- ── A：Black Monday ＋ 銀Pay の押さえ ──
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (a_id, acc, 3000);
  perform app_private.store_set_status(a_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', a_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = a_id)), actor);
  select status into st from public.reservations where id = a_id;
  select status into hs from app_private.ginpay_holds where reservation_id = a_id;
  if st <> 'awaiting_payment' or hs <> 'held' then raise exception 'NG A1 施術完了 % / 押さえ % / %', st, hs, res; end if;
  log := log || 'A1 施術完了→会計待ち・押さえ残る OK; ';
  -- 押し直し
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', a_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = a_id)), actor);
  select status into st from public.reservations where id = a_id;
  if st <> 'awaiting_payment' or res ? 'error' then raise exception 'NG A2 押し直し % / %', st, res; end if;
  log := log || 'A2 押し直しても会計待ち OK; ';
  -- 会員QRの会計が同じ予約を拾う（staff_client_for_member と同じ探し方：今日でなくても状態で拾えるか）
  if (select status from public.reservations where id = a_id) not in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment') then raise exception 'NG A3'; end if;
  if app_private.checkout_context_json(a_id, null)->'black_monday'->>'eligible' <> 'true' then raise exception 'NG A3 BM %', app_private.checkout_context_json(a_id, null)->'black_monday'; end if;
  log := log || 'A3 会計の画面に同じ予約・Black Monday が出る OK; ';
  -- 現金で会計：引き落とし0件・押さえ終了・完了
  select count(*) into n0 from public.ginpay_transactions where account_id = acc;
  items := jsonb_build_array(jsonb_build_object('name', 'アイパー', 'category', 'menu', 'unit_price', 8000, 'quantity', 1, 'source', 'reservation', 'ref_id', 'perm-iper'));
  sale := app_private.finalize_sale(jsonb_build_object('reservation_id', a_id, 'stylist_id', stylist, 'payment_method', 'cash', 'items', items, 'expected_total', 0, 'idempotency_key', 'sr02-test-a'), 'staff', actor);
  if sale->>'error' = 'total_mismatch' then
    sale := app_private.finalize_sale(jsonb_build_object('reservation_id', a_id, 'stylist_id', stylist, 'payment_method', 'cash', 'items', items, 'expected_total', (sale->>'total')::int, 'idempotency_key', 'sr02-test-a'), 'staff', actor);
  end if;
  if sale ? 'error' then raise exception 'NG A4 会計 %', sale; end if;
  select status into st from public.reservations where id = a_id;
  select status into hs from app_private.ginpay_holds where reservation_id = a_id;
  select count(*) into n1 from public.ginpay_transactions where account_id = acc;
  if st <> 'completed' or hs <> 'closed' or n1 <> n0 then raise exception 'NG A4 予約 % 押さえ % 引き落とし % → %', st, hs, n0, n1; end if;
  log := log || format('A4 現金会計 %s円（Black Monday 込み）→完了・押さえ閉じ・銀Pay 引き落とし0件 OK; ', sale->>'total');

  -- ── B：予約に付けた通常の券だけ ──
  select t.id into tk from public.tickets t join public.reservations r on r.id = b_id
   where t.user_id = any(app_private.ticket_family_uids(r.user_id)) and not t.used and t.type in ('discount', 'otoku') limit 1;
  if tk is null then
    insert into public.tickets (user_id, type, title, amount, issued_by) select r.user_id, 'discount', '試験の割引券', 500, 'sr02-test' from public.reservations r where r.id = b_id returning id into tk;
  end if;
  insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) select b_id, r.user_id, array[tk] from public.reservations r where r.id = b_id;
  if exists (select 1 from app_private.black_monday_marks where reservation_id = b_id and amount > 0) then raise exception 'NG B0 BM が付いている'; end if;
  perform app_private.store_set_status(b_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', b_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = b_id)), actor);
  select status into st from public.reservations where id = b_id;
  if st <> 'awaiting_payment' then raise exception 'NG B1 % / %', st, res; end if;
  log := log || 'B1 通常の券だけ→会計待ち OK; ';

  -- ── C：会計で使うもの無し→今までどおり完了 ──
  perform app_private.store_set_status(c_id, 'checked_in', 'staff', actor, null);
  res := app_private.sb_apply(jsonb_build_object('kind', 'status', 'reservation_id', c_id, 'status', 'completed',
           'expected_updated_at', (select updated_at from public.reservations where id = c_id)), actor);
  select status into st from public.reservations where id = c_id;
  if st <> 'completed' then raise exception 'NG C1 % / %', st, res; end if;
  log := log || 'C1 会計で使うもの無し→完了（今までどおり） OK; ';

  -- ── D：取消・不来店で押さえが戻る（今までどおり） ──
  insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (d_id, acc, 2000);
  res := app_private.sb_apply(jsonb_build_object('kind', 'cancel', 'reservation_id', d_id, 'reason', '試験',
           'expected_updated_at', (select updated_at from public.reservations where id = d_id)), actor);
  select status into hs from app_private.ginpay_holds where reservation_id = d_id;
  if hs <> 'released' then raise exception 'NG D1 % / %', hs, res; end if;
  log := log || 'D1 取消で押さえが戻る OK; ';

  raise exception 'ROLLBACK_OK %', log;
end $test$;
