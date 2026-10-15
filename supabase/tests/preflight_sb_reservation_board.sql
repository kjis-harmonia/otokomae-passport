-- 銀二郎SB（staff_sb_*）の確認。使い捨てのローカル DB だけで実行する（全体を最後に rollback）。
--   同時受付の枠（1 → 3）、4件目の拒否、取消で空いた枠の再利用、同じ依頼 ID の再送（成功・拒否とも同じ結果）、
--   同じ ID で内容違い、古い版での変更、見積もり（plan_hash）の不一致、操作者の確認、
--   枠数を減らすときの確認、DB の枠数ガード、既存の予約機能（1人1枠のまま）との共存
begin;

create function pg_temp.sb_input(p_staff uuid, p_start timestamptz, p_name text, p_codes text[] default array['sbtest-cut'])
returns jsonb language sql as $$
  select jsonb_build_object('starts_at', p_start, 'menu_codes', to_jsonb(p_codes), 'staff_id', p_staff,
    'customer_name', p_name, 'customer_phone', '080-1111-2222', 'source', 'phone')
$$;

-- 見積もり → 登録（新しい依頼 ID）
create function pg_temp.sb_create(p_token text, p_input jsonb, p_request uuid default gen_random_uuid())
returns jsonb language plpgsql as $$
declare v_preview jsonb;
begin
  v_preview := public.staff_sb_preview(p_token, p_input, null);
  if v_preview ? 'error' then return v_preview; end if;
  return public.staff_sb_mutate(p_token, p_request,
    jsonb_build_object('kind', 'create', 'input', p_input, 'plan_hash', v_preview->>'plan_hash'), 'SBテスト');
end $$;

do $$
declare
  v_token text := 'sb-preflight-staff-token';
  v_hq text := 'sb-preflight-hq-token';
  v_staff uuid;
  v_menu uuid;
  v_date date := app_private.today_jst() + 3;
  v_ten timestamptz;
  a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; f jsonb;
  v_req uuid := gen_random_uuid();
  v_refused uuid := gen_random_uuid();
  v_preview jsonb;
  v_cmd jsonb;
  v_res jsonb;
  v_opts jsonb;
  v_n int;
begin
  -- ── 準備：スタッフ端末のセッション・本部セッション・担当・メニュー・勤務・操作者 ──
  insert into app_private.staff_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_token), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;
  insert into app_private.hq_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_hq), now() + interval '1 hour')
  on conflict (token_hash) do update set expires_at = excluded.expires_at, revoked_at = null;
  select id into v_staff from public.staff_members where display_name = '銀二郎';
  if v_staff is null then raise exception 'seed staff missing'; end if;
  -- 20261015000100：テイテイ・銀二郎は SALON BOARD と同じ「受付可能数 3」。ほかのスタッフは 1 のまま
  if exists (select 1 from public.staff_members where display_name in ('テイテイ', '銀二郎') and booking_capacity <> 3) then
    raise exception 'capacity setting migration did not set テイテイ/銀二郎 to 3';
  end if;
  if exists (select 1 from public.staff_members where display_name not in ('テイテイ', '銀二郎') and booking_capacity <> 1) then
    raise exception 'capacity setting migration changed other staff';
  end if;
  -- 以下は枠 1 から確かめる（本部の設定で 1 に戻せることも確認）
  if public.hq_set_booking_capacity(v_hq, v_staff, 1)->>'ok' is distinct from 'true' then raise exception 'set capacity 1 failed'; end if;
  update public.staff_members set is_active = true, is_bookable = true where id = v_staff;
  insert into public.staff_members (display_name, is_active, is_bookable, sort_order)
  select 'SBテスト', true, false, 999 where not exists (select 1 from public.staff_members where display_name = 'SBテスト');
  insert into public.service_menus (code, name, category, price, duration_min, buffer_after_min, is_active, booking_enabled, sort_order)
  values ('sbtest-cut', 'SBテストカット', 'カット', 5000, 60, 0, true, true, 999)
  on conflict (code) do update set duration_min = 60, buffer_after_min = 0, is_active = true, booking_enabled = true, price = 5000
  returning id into v_menu;
  insert into public.staff_menu_capabilities (staff_id, menu_id) values (v_staff, v_menu) on conflict do nothing;
  insert into public.staff_shift_templates (staff_id, weekday, start_time, end_time)
  values (v_staff, extract(dow from v_date)::int, time '09:00', time '19:00')
  on conflict (staff_id, weekday) do update set start_time = excluded.start_time, end_time = excluded.end_time;
  v_ten := app_private.jst_ts(v_date, time '10:00');

  -- ── 選択肢：操作者は勤務中のスタッフ全員、予約の担当は予約できるスタッフだけ（枠数つき） ──
  v_opts := public.staff_sb_options(v_token);
  if not exists (select 1 from jsonb_array_elements(v_opts->'actors') x where x->>'name' = 'SBテスト') then raise exception 'actors missing non-bookable staff: %', v_opts->'actors'; end if;
  if exists (select 1 from jsonb_array_elements(v_opts->'staff') x where x->>'name' = 'SBテスト') then raise exception 'non-bookable staff listed as resource'; end if;
  if (select (x->>'capacity')::int from jsonb_array_elements(v_opts->'staff') x where (x->>'id')::uuid = v_staff) <> 1 then raise exception 'default capacity is not 1'; end if;

  -- ── 枠1（初期値）：1件目は入り、重なる2件目は断る ──
  a := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten, 'SB顧客A'), v_req);
  if a ? 'error' then raise exception 'create A failed: %', a; end if;
  if (a->>'booking_lane')::int <> 0 or a->>'transfer_status' <> 'pending' then raise exception 'A lane/transfer wrong: %', a; end if;
  b := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten + interval '30 minutes', 'SB顧客B'));
  if b->>'error' is distinct from 'slot_taken' then raise exception 'capacity 1 allowed overlap: %', b; end if;

  -- ── 同じ依頼 ID の再送：同じ結果（新しい予約を作らない）。同じ ID で内容が違えば idempotency_conflict ──
  v_preview := public.staff_sb_preview(v_token, pg_temp.sb_input(v_staff, v_ten, 'SB顧客A'), null);
  -- 1件目が入ったので同じ時刻の見積もりは slot_taken。再送は保存済みの結果を返すので見積もりは要らない（元の plan_hash で送る）
  v_cmd := (select jsonb_build_object('kind', 'create', 'input', pg_temp.sb_input(v_staff, v_ten, 'SB顧客A'), 'plan_hash', '0'));
  v_res := public.staff_sb_mutate(v_token, v_req, v_cmd, 'SBテスト');
  if v_res->>'error' is distinct from 'idempotency_conflict' then raise exception 'altered same-id command not refused: %', v_res; end if;
  select count(*) into v_n from public.reservations where customer_name = 'SB顧客A';
  if v_n <> 1 then raise exception 'replay created a second reservation (% rows)', v_n; end if;

  -- 断られた依頼も結果として残る：同じ ID の再送は、あとで枠が空いても同じ拒否を返す（遅れた元の依頼が後から通らない）
  v_cmd := jsonb_build_object('kind', 'create', 'input', pg_temp.sb_input(v_staff, v_ten, 'SB顧客R'), 'plan_hash', repeat('a', 64));
  v_res := public.staff_sb_mutate(v_token, v_refused, v_cmd, 'SBテスト');
  if v_res->>'error' is null then raise exception 'refusal expected: %', v_res; end if;
  e := public.staff_sb_mutate(v_token, v_refused, v_cmd, 'SBテスト');
  if e is distinct from v_res then raise exception 'refusal replay differs: % vs %', e, v_res; end if;

  -- ── 見積もりの不一致・操作者 ──
  v_cmd := jsonb_build_object('kind', 'create', 'input', pg_temp.sb_input(v_staff, v_ten + interval '3 hours', 'SB顧客P'), 'plan_hash', repeat('b', 64));
  v_res := public.staff_sb_mutate(v_token, gen_random_uuid(), v_cmd, 'SBテスト');
  if v_res->>'error' is distinct from 'preview_changed' then raise exception 'wrong plan hash accepted: %', v_res; end if;
  v_preview := public.staff_sb_preview(v_token, pg_temp.sb_input(v_staff, v_ten + interval '3 hours', 'SB顧客P'), null);
  v_res := public.staff_sb_mutate(v_token, gen_random_uuid(),
    jsonb_build_object('kind', 'create', 'input', pg_temp.sb_input(v_staff, v_ten + interval '3 hours', 'SB顧客P'), 'plan_hash', v_preview->>'plan_hash'), '存在しない人');
  if v_res->>'error' is distinct from 'staff_name_required' then raise exception 'unknown actor accepted: %', v_res; end if;

  -- ── 枠3：2件目・3件目は別の枠、4件目は断る ──
  v_res := public.hq_set_booking_capacity(v_hq, v_staff, 3);
  if v_res->>'ok' is distinct from 'true' then raise exception 'set capacity 3 failed: %', v_res; end if;
  b := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten + interval '30 minutes', 'SB顧客B'));
  c := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten, 'SB顧客C'));
  if b ? 'error' or c ? 'error' then raise exception 'capacity 3 create failed: % / %', b, c; end if;
  if (select array_agg(x order by x) from unnest(array[(a->>'booking_lane')::int, (b->>'booking_lane')::int, (c->>'booking_lane')::int]) x) <> array[0, 1, 2] then
    raise exception 'lanes not distinct: % % %', a->>'booking_lane', b->>'booking_lane', c->>'booking_lane';
  end if;
  d := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten + interval '15 minutes', 'SB顧客D'));
  if d->>'error' is distinct from 'slot_taken' then raise exception 'fourth overlap accepted: %', d; end if;
  -- 空き時間：3件が重なる 10:30 は出さない。勤務の中で空いている 15:00 は出す
  v_res := public.staff_sb_slots(v_token, v_date, array['sbtest-cut'], v_staff, null);
  if exists (select 1 from jsonb_array_elements(v_res) x where (x->>'starts_at')::timestamptz = v_ten + interval '30 minutes') then
    raise exception 'slots offered a fully booked time';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_res) x where (x->>'starts_at')::timestamptz = v_ten + interval '5 hours') then
    raise exception 'slots missed a free time: %', v_res;
  end if;
  -- 境界：A の終わり（11:00）ちょうどに始まる予約は重ならない
  f := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten + interval '60 minutes', 'SB顧客F'));
  if f ? 'error' then raise exception 'boundary start refused: %', f; end if;
  delete from public.reservations where id = (f->>'id')::uuid;  -- 以降の確認に影響しないよう取り除く（rollback する）

  -- ── 枠数を減らすとき：これからの予約が上の枠にあれば断る ──
  v_res := public.hq_set_booking_capacity(v_hq, v_staff, 1);
  if v_res->>'error' is distinct from 'has_reservations' then raise exception 'capacity reduction with bookings accepted: %', v_res; end if;

  -- ── DB の枠数ガード：枠数を超える枠の直接書き込みは失敗する ──
  begin
    update public.reservations set booking_lane = 2 where id = (a->>'id')::uuid;
    update public.staff_members set booking_capacity = 2 where id = v_staff;
    raise exception 'capacity guard did not fire';
  exception when others then
    if sqlerrm = 'capacity guard did not fire' then raise; end if;
  end;

  -- ── 古い版での変更は断る（別の端末で先に変わった予約） ──
  v_res := public.staff_sb_mutate(v_token, gen_random_uuid(), jsonb_build_object('kind', 'transfer', 'reservation_id', a->>'id',
    'expected_updated_at', '2000-01-01T00:00:00Z', 'transfer_status', 'done'), 'SBテスト');
  if v_res->>'error' is distinct from 'reservation_changed' then raise exception 'stale version accepted: %', v_res; end if;
  v_res := public.staff_sb_mutate(v_token, gen_random_uuid(), jsonb_build_object('kind', 'transfer', 'reservation_id', a->>'id',
    'expected_updated_at', a->>'updated_at', 'transfer_status', 'done'), 'SBテスト');
  if v_res->>'transfer_status' is distinct from 'done' then raise exception 'transfer update failed: %', v_res; end if;

  -- ── 取消で空いた枠は再利用できる ──
  v_res := public.staff_sb_mutate(v_token, gen_random_uuid(), jsonb_build_object('kind', 'cancel', 'reservation_id', c->>'id',
    'expected_updated_at', c->>'updated_at', 'reason', 'テスト'), 'SBテスト');
  if v_res->>'status' is distinct from 'cancelled' then raise exception 'cancel failed: %', v_res; end if;
  d := pg_temp.sb_create(v_token, pg_temp.sb_input(v_staff, v_ten + interval '15 minutes', 'SB顧客D'));
  if d ? 'error' then raise exception 'freed lane not reusable: %', d; end if;

  -- ── 同じ担当・同じメニューの変更（時刻だけ）は予約時の明細を保つ ──
  update public.service_menus set price = 7777 where id = v_menu;
  v_preview := public.staff_sb_preview(v_token, pg_temp.sb_input(v_staff, v_ten + interval '4 hours', 'SB顧客A'), (a->>'id')::uuid);
  if v_preview ? 'error' or (v_preview->>'total_price')::int <> 5000 then raise exception 'edit preview did not keep booked price: %', v_preview; end if;
  select row_to_json(r)::jsonb into v_res from (select updated_at from public.reservations where id = (a->>'id')::uuid) r;
  v_res := public.staff_sb_mutate(v_token, gen_random_uuid(), jsonb_build_object('kind', 'edit', 'reservation_id', a->>'id',
    'expected_updated_at', v_res->>'updated_at', 'input', pg_temp.sb_input(v_staff, v_ten + interval '4 hours', 'SB顧客A')
      || jsonb_build_object('client_id', a->>'client_id'), 'plan_hash', v_preview->>'plan_hash'), 'SBテスト');
  if v_res ? 'error' or (v_res->>'total_price')::int <> 5000 then raise exception 'edit failed or repriced: %', v_res; end if;

  -- ── 既存の予約機能（店舗端末・アプリ）は1人1枠のまま：SB の予約がある時間には入れない ──
  v_res := public.staff_create_reservation(v_token, jsonb_build_object('starts_at', v_ten + interval '30 minutes',
    'menu_codes', jsonb_build_array('sbtest-cut'), 'staff_id', v_staff, 'customer_name', '旧経路', 'source', 'phone'), 'SBテスト')::jsonb;
  if v_res->>'error' is null then raise exception 'legacy path overbooked a busy stylist: %', v_res; end if;

  -- ── 台帳：枠数・枠番号・転記状態が出る ──
  v_res := public.staff_sb_ledger(v_token, v_date);
  if not exists (select 1 from jsonb_array_elements(v_res->'staff') x where (x->>'id')::uuid = v_staff and (x->>'capacity')::int = 3) then
    raise exception 'ledger capacity missing: %', v_res->'staff';
  end if;
  if exists (select 1 from jsonb_array_elements(v_res->'reservations') x where not (x ? 'booking_lane' and x ? 'transfer_status' and x ? 'updated_at')) then
    raise exception 'ledger reservations missing SB fields';
  end if;

  -- ── 認証：スタッフの端末セッションが無ければ何もできない ──
  begin
    perform public.staff_sb_ledger('wrong-token', v_date);
    raise exception 'unauthenticated ledger allowed';
  exception when others then
    if sqlerrm = 'unauthenticated ledger allowed' then raise; end if;
  end;

  raise notice 'sb reservation board ok';
end $$;

-- 権限：SB の内部関数はクライアントのロールから呼べない。staff_sb_* と本部の設定だけ呼べる
do $$
begin
  if has_function_privilege('anon', 'app_private.sb_apply(jsonb, text)', 'execute') then raise exception 'sb_apply executable by anon'; end if;
  if has_function_privilege('anon', 'app_private.sb_plan(jsonb, uuid)', 'execute') then raise exception 'sb_plan executable by anon'; end if;
  if not has_function_privilege('anon', 'public.staff_sb_mutate(text, uuid, jsonb, text)', 'execute') then raise exception 'staff_sb_mutate not executable'; end if;
  if has_table_privilege('anon', 'app_private.sb_requests', 'select') then raise exception 'sb_requests readable by anon'; end if;
  raise notice 'sb grants ok';
end $$;

rollback;
