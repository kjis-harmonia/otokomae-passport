-- 予約の変更（銀ちゃんの会話から・11/8 慶一郎さん）
--   ・変更は1つの手続き（1つのトランザクション）：元の予約を「変更のため取り消し」→ 新しい予約を確定 → 券の予定・ガチャ券・銀Pay の押さえを新しい予約へ
--     どこかで失敗したら全部取り消し（元の予約はそのまま残る）
--   ・ほかのお客様と同じ枠を取り合っても二重予約にならない：予約の書き込みと同じ店全体のロック（lock_all_staff）の中で、空きを確かめて書く
--   ・同じ変更が2回届いても（押し直し・通信の再送）1回分だけ：idempotency key（reservation_changes.idem_key）
--   ・開始30分前を切ったら受けない（お電話）。開始2時間前を切ってからの「日時の変更」は直前キャンセルと同じ扱い（AI予約を止める）
--     同じ日時のままメニューだけ変えるのは止めない（空きと担当に問題がなければ）
--   ・銀Pay の押さえはアプリの中の残高の押さえ（外の決済は動かない）。新しい押さえは min(元の押さえ, 新しい料金)。差額はお店で
--   ・お連れ様と一緒の予約で1人だけ変えても、ほかの方の予約・券は触らない（つながりだけ新しい予約へ付け替える）

create table if not exists app_private.reservation_changes (
  id                 uuid primary key default gen_random_uuid(),
  idem_key           text not null unique check (length(idem_key) between 8 and 100),
  user_id            text not null,
  old_reservation_id uuid not null,
  new_reservation_id uuid not null,
  kind               text not null check (kind in ('menu', 'time')),
  result             jsonb not null,
  created_at         timestamptz not null default now()
);
revoke all on table app_private.reservation_changes from public, anon, authenticated;

/** 変更したときに、券・ガチャ券・銀Pay の押さえがどうなるか（確認の画面と、実際の変更で同じ答え） */
create or replace function app_private.change_effects(p_old uuid, p_starts timestamptz, p_codes text[], p_new_total integer)
returns jsonb language plpgsql stable set search_path = '' as $$
declare r public.reservations; v_ids uuid[]; v_keep uuid[] := '{}'; v_drop jsonb := '[]'; t public.tickets; h app_private.gacha_holdings;
        v_gacha_keep boolean := null; v_gacha_why text; v_hold app_private.ginpay_holds; v_comp boolean; v_perm boolean;
begin
  select * into r from public.reservations where id = p_old;
  v_comp := app_private.res_is_companion(r.companion_id, r.companion_of, r.note);
  v_perm := exists (select 1 from unnest(p_codes) c where c ~ '^(perm|set)-');
  -- 割引券の予定（予約に付けた券）
  select ticket_ids into v_ids from app_private.reservation_ticket_plans where reservation_id = p_old;
  for t in select * from public.tickets where id = any(coalesce(v_ids, '{}')) order by id loop
    if t.used then v_drop := v_drop || jsonb_build_object('title', t.title, 'why', 'used');
    elsif t.expires_at is not null and t.expires_at <= p_starts then v_drop := v_drop || jsonb_build_object('title', t.title, 'why', 'expired');
    elsif app_private.is_perm_coupon(t) and (v_comp or not v_perm or app_private.gacha_offday(p_starts)) then
      v_drop := v_drop || jsonb_build_object('title', t.title, 'why', case when v_comp then 'owner_only' when not v_perm then 'menu' else 'weekday' end);
    else v_keep := v_keep || t.id; end if;
  end loop;
  -- ガチャ券
  select * into h from app_private.gacha_holdings where reservation_id = p_old and used_at is null;
  if h.user_id is not null then
    v_gacha_why := case
      when h.expires_at <= p_starts then 'expired'
      when h.weekday_only and app_private.gacha_offday(p_starts) then 'weekday'
      when v_comp and (h.free_menu is null or h.self_only) then 'owner_only'
      when h.menu_codes is not null and not (p_codes && h.menu_codes) then 'menu'
      when h.menu_codes is null and not exists (select 1 from unnest(p_codes) c where c <> 'maintenance') then 'menu'
      else null end;
    v_gacha_keep := v_gacha_why is null;
  end if;
  -- 銀Pay の押さえ
  select * into v_hold from app_private.ginpay_holds where reservation_id = p_old and status = 'held' order by updated_at desc limit 1;
  return jsonb_build_object(
    'tickets_keep', to_jsonb(v_keep), 'tickets_drop', v_drop,
    'gacha', case when h.user_id is null then null else jsonb_build_object('title', h.title, 'keep', v_gacha_keep, 'why', v_gacha_why) end,
    'ginpay_before', coalesce(v_hold.amount, 0),
    'ginpay_after', case when v_hold.id is null then 0 when p_new_total is null then v_hold.amount else least(v_hold.amount, greatest(p_new_total, 0)) end,
    'ginpay_account', v_hold.account_id);
end;
$$;
revoke all on function app_private.change_effects(uuid, timestamptz, text[], integer) from public, anon, authenticated;

/** 新しいメニューの料金（担当で変わらない正式マスタの合計。予約の確定は booking_plan で決まる） */
create or replace function app_private.codes_total(p_codes text[])
returns integer language sql stable set search_path = '' as $$
  select sum(m.price)::int from public.service_menus m where m.code = any(p_codes) and m.is_active
$$;
revoke all on function app_private.codes_total(text[]) from public, anon, authenticated;

/** 変更先の空き（元の予約の枠は空いている扱い。指名の予約は同じ担当で） */
create or replace function public.customer_change_slots(p_session text, p_reservation_id uuid, p_date date, p_menu_codes text[])
returns json language plpgsql stable security definer set search_path = 'public', 'extensions', 'pg_temp' as $$
declare v_user text := app_private.session_user_id(p_session); r public.reservations; v_lead int;
begin
  perform app_private.require_store_verified(p_session);
  select * into r from public.reservations where id = p_reservation_id and user_id = v_user and status = 'confirmed';
  if r.id is null then return json_build_object('error', 'not_found'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 5 then return json_build_object('error', 'invalid_menu'); end if;
  select min_lead_minutes into v_lead from public.booking_settings where id = 1;
  return coalesce((select json_agg(json_build_object('starts_at', x.starts_at) order by x.starts_at) from (
    select distinct a.starts_at from app_private.available_slots(p_date, p_menu_codes, case when r.nominated then r.staff_id end, v_lead, r.id) a
    where app_private.customer_slot_ok(a.starts_at)) x), '[]'::json);
end;
$$;

/** 変更の確認（書き込まない）：変更の種類・直前の扱い・料金・銀Pay・外れる券。実際の変更と同じ判定 */
create or replace function public.customer_change_preview(p_session text, p_reservation_id uuid, p_starts_at timestamptz, p_menu_codes text[])
returns json language plpgsql stable security definer set search_path = 'public', 'extensions', 'pg_temp' as $$
declare v_user text := app_private.session_user_id(p_session); r public.reservations; v_lead int; v_late int; v_total int; v_free boolean;
begin
  perform app_private.require_store_verified(p_session);
  select min_lead_minutes, ai_late_cancel_minutes into v_lead, v_late from public.booking_settings where id = 1;
  select * into r from public.reservations where id = p_reservation_id and user_id = v_user;
  if r.id is null or r.status <> 'confirmed' then return json_build_object('error', 'not_found'); end if;
  if r.starts_at < now() + make_interval(mins => (select customer_cancel_deadline_minutes from public.booking_settings where id = 1)) then
    return json_build_object('error', 'call_shop');
  end if;
  v_total := app_private.codes_total(p_menu_codes);
  v_free := app_private.customer_slot_ok(p_starts_at) and exists (
    select 1 from app_private.available_slots((p_starts_at at time zone 'Asia/Tokyo')::date, p_menu_codes, case when r.nominated then r.staff_id end, v_lead, r.id) a
    where a.starts_at = p_starts_at);
  return (jsonb_build_object(
    'kind', case when p_starts_at = r.starts_at then 'menu' else 'time' end,
    'late_penalty', p_starts_at <> r.starts_at and r.starts_at < now() + make_interval(mins => v_late),
    'price_before', r.total_price, 'price_after', v_total, 'slot_ok', v_free,
    'cancel_late', r.starts_at < now() + make_interval(mins => v_late))
    || app_private.change_effects(r.id, p_starts_at, p_menu_codes, v_total) - 'ginpay_account')::json;
end;
$$;

/** 予約の変更（1つの手続き）。失敗したら元の予約はそのまま */
create or replace function public.customer_change_reservation(p_session text, p_reservation_id uuid, p_starts_at timestamptz, p_menu_codes text[], p_idem_key text)
returns json language plpgsql security definer set search_path = 'public', 'extensions', 'pg_temp' as $$
declare v_user text; r public.reservations; v_c public.customers; v_prev jsonb; v_set public.booking_settings; v_kind text; v_late boolean;
        v_eff jsonb; v_new jsonb; v_new_id uuid; v_res jsonb; v_keep uuid[]; v_acc public.ginpay_accounts; v_after int; v_resume date; v_out jsonb;
        v_gate json; v_total int;
begin
  v_user := app_private.session_user_id(p_session);
  perform app_private.require_store_verified(p_session);
  v_gate := app_private.ai_booking_gate(p_session);
  if v_gate is not null then return v_gate; end if;
  if p_idem_key is null or length(p_idem_key) < 8 or length(p_idem_key) > 100 then return json_build_object('error', 'invalid_request'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 5 then return json_build_object('error', 'invalid_menu'); end if;
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  -- 予約の書き込みは店全体で1つずつ（新規予約と同じロック）。この中で空きを確かめて書くので、同じ枠を取り合っても二重にならない
  perform app_private.lock_all_staff();
  -- 二重送信：同じキーはロックのあとで見直す（同時に2回届いても、2回目は1回目の結果を返す）
  select result into v_prev from app_private.reservation_changes where idem_key = p_idem_key and user_id = v_user;
  if v_prev is not null then return (v_prev || jsonb_build_object('idempotent', true))::json; end if;
  select * into v_set from public.booking_settings where id = 1;
  select * into r from public.reservations where id = p_reservation_id and user_id = v_user for update;
  if r.id is null or r.status <> 'confirmed' then return json_build_object('error', 'not_found'); end if;
  if r.starts_at < now() + make_interval(mins => v_set.customer_cancel_deadline_minutes) then return json_build_object('error', 'call_shop'); end if;
  if p_starts_at = r.starts_at and (select array_agg(menu_code order by sort_order) from public.reservation_items where reservation_id = r.id) = p_menu_codes then
    return json_build_object('error', 'no_change');
  end if;
  if 'maintenance' = any(p_menu_codes) and not app_private.person_maintenance_ok(v_user, r.companion_id) then return json_build_object('error', 'menu_not_available'); end if;
  if not app_private.customer_slot_ok(p_starts_at) then return json_build_object('error', 'slot_unavailable'); end if;
  v_kind := case when p_starts_at = r.starts_at then 'menu' else 'time' end;
  v_late := v_kind = 'time' and r.starts_at < now() + make_interval(mins => v_set.ai_late_cancel_minutes);
  v_total := app_private.codes_total(p_menu_codes);
  v_eff := app_private.change_effects(r.id, p_starts_at, p_menu_codes, v_total);
  select * into v_c from public.customers where user_id = v_user;
  begin
    -- 1) 元の予約を「変更のため取り消し」（銀Pay の押さえは自動で外れる）
    v_res := app_private.set_reservation_status(r.id, 'cancelled', 'customer', coalesce(v_c.name, v_user), 'お客様アプリで予約を変更（新しい予約へ）');
    if v_res ? 'error' then raise exception '%', v_res->>'error'; end if;
    -- 2) 新しい予約（同じお名前・お連れ様の印・メモ。指名の予約は同じ担当）
    v_new := app_private.create_reservation(jsonb_build_object(
        'starts_at', p_starts_at, 'menu_codes', to_jsonb(p_menu_codes), 'staff_id', case when r.nominated then r.staff_id end,
        'customer_name', r.customer_name, 'customer_phone', r.customer_phone, 'customer_id', r.customer_id, 'user_id', r.user_id,
        'source', 'app', 'note', r.note),
      'customer', coalesce(v_c.name, v_user), v_set.min_lead_minutes);
    if v_new ? 'error' then raise exception '%', v_new->>'error'; end if;
    v_new_id := (v_new->>'id')::uuid;
    update public.reservations set companion_id = r.companion_id, companion_of = r.companion_of where id = v_new_id;
    -- 一緒の予約のつながりだけ新しい予約へ（ほかの方の予約そのものは変えない）
    update public.reservations set companion_of = v_new_id where companion_of = r.id and status = 'confirmed';
    -- 3) 券の予定：使える券だけ新しい予約へ
    select array_agg(x::uuid) into v_keep from jsonb_array_elements_text(v_eff->'tickets_keep') x;
    delete from app_private.reservation_ticket_plans where reservation_id = r.id;
    if cardinality(coalesce(v_keep, '{}')) > 0 then
      insert into app_private.reservation_ticket_plans (reservation_id, user_id, ticket_ids) values (v_new_id, v_user, v_keep);
    end if;
    -- 4) ガチャ券：使えれば新しい予約へ、使えなければ外す（券そのものはお客様の手元に残る）
    update app_private.gacha_holdings set reservation_id = case when coalesce((v_eff->'gacha'->>'keep')::boolean, false) then v_new_id else null end
    where reservation_id = r.id and used_at is null;
    -- 5) 銀Pay の押さえ：同じ口座で新しい予約に（元の押さえは 1) で外れている）
    v_after := coalesce((v_eff->>'ginpay_after')::int, 0);
    if v_after > 0 then
      select * into v_acc from public.ginpay_accounts where id = (v_eff->>'ginpay_account')::uuid for update;
      if v_acc.id is null or v_acc.status <> 'active' then raise exception 'ginpay_account_not_active'; end if;
      if v_acc.balance_cached - app_private.ginpay_held_sum(v_acc.id, v_new_id) < v_after then raise exception 'insufficient_balance'; end if;
      insert into app_private.ginpay_holds (reservation_id, account_id, amount) values (v_new_id, v_acc.id, v_after);
    end if;
    -- 6) 開始2時間前を切ってからの日時の変更は、直前キャンセルと同じ扱い
    if v_late then v_resume := app_private.ai_penalty_add(r.id, 'late_cancel'); end if;
    v_out := app_private.reservation_json_customer(v_new_id) || jsonb_build_object(
      'changed_from', r.id, 'kind', v_kind, 'tickets_drop', v_eff->'tickets_drop', 'gacha', v_eff->'gacha',
      'ginpay_before', v_eff->'ginpay_before', 'ginpay_after', v_after)
      || case when v_resume is not null then jsonb_build_object('ai_paused_until', v_resume) else '{}'::jsonb end;
    insert into app_private.reservation_changes (idem_key, user_id, old_reservation_id, new_reservation_id, kind, result)
    values (p_idem_key, v_user, r.id, v_new_id, v_kind, v_out);
  exception when others then
    -- ここまでの書き込みは全部取り消される（元の予約・券・押さえはそのまま）
    return json_build_object('error', case when sqlerrm in ('slot_taken', 'menu_not_available', 'date_not_open', 'too_late', 'invalid_starts_at', 'insufficient_balance', 'ginpay_account_not_active') then sqlerrm else 'change_failed' end,
      'kept', r.id);
  end;
  return v_out::json;
end;
$$;

revoke all on function public.customer_change_slots(text, uuid, date, text[]), public.customer_change_preview(text, uuid, timestamptz, text[]),
  public.customer_change_reservation(text, uuid, timestamptz, text[], text) from public;
grant execute on function public.customer_change_slots(text, uuid, date, text[]), public.customer_change_preview(text, uuid, timestamptz, text[]),
  public.customer_change_reservation(text, uuid, timestamptz, text[], text) to anon, authenticated, service_role;
