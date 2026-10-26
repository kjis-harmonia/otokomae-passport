-- お客様ごとの「いつもの」料金（10/26 慶一郎さん決定）
--   同じメニューでも担当やお客様で料金が違うので、店で最後に払った金額（割引券を引く前のメニューの金額）を、そのお客様の料金にする。
--   ・記録は増やさない：確定した会計（accounting_sessions.status='completed'）の明細から、そのつど一番新しいものを読む
--     （会計の取消は自動で外れる。メニューは明細の ref_id＝メニューの code。予約からの明細も会計メニューからの明細も同じ）
--   ・お客様は顧客台帳（clients）でつなぐ。統合された顧客もまとめて見る（client_family）
--   ・アプリ：ホーム・JOHNNY の料金（customer_personal_prices・customer_price_quote）
--   ・予約：アプリからの予約の明細を、その人の料金で入れる（reservation_items の trigger。合計も直す）
--   ・店舗端末：予約なしの会計でメニューを選ぶとき（staff_client_menu_prices）
--   払ったことのないメニューは、今までどおりのメニューの料金

/** 顧客（統合を含む）がそのメニューで最後に払った単価。無ければ null */
create or replace function app_private.client_menu_price(p_client uuid, p_code text)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select i.price from public.accounting_session_items i
  join public.accounting_sessions s on s.id = i.session_id
  where p_client is not null and p_code is not null and s.status = 'completed'
    and s.client_id = any(app_private.client_family(app_private.client_root(p_client)))
    and i.source in ('reservation', 'service_menu') and i.ref_id = p_code and i.price is not null and i.price >= 0
  order by s.completed_at desc nulls last, s.created_at desc, i.sort_order
  limit 1
$$;

/** 顧客（統合を含む）が払ったことのあるメニューと、最後に払った単価の一覧 */
create or replace function app_private.client_menu_prices(p_client uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('menu_code', x.code, 'price', x.price) order by x.code), '[]'::jsonb) from (
    select distinct on (i.ref_id) i.ref_id as code, i.price
    from public.accounting_session_items i
    join public.accounting_sessions s on s.id = i.session_id
    where p_client is not null and s.status = 'completed'
      and s.client_id = any(app_private.client_family(app_private.client_root(p_client)))
      and i.source in ('reservation', 'service_menu') and i.ref_id is not null and i.price is not null and i.price >= 0
      and exists (select 1 from public.service_menus m where m.code = i.ref_id)
    order by i.ref_id, s.completed_at desc nulls last, s.created_at desc, i.sort_order
  ) x
$$;

/** お客様：自分の「いつもの」料金の一覧（ホーム・JOHNNY） */
create or replace function public.customer_personal_prices(p_session text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return app_private.client_menu_prices(app_private.user_client(v_uid))::json;
end $$;

/** お客様：予約の日時での料金（確認画面）。払ったことのあるメニューは、その人の料金 */
create or replace function public.customer_price_quote(p_session text, p_menu_codes text[], p_starts_at timestamptz)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_client uuid; q jsonb; v_items jsonb;
begin
  v_client := app_private.user_client(app_private.session_user_id(p_session));
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 10 or p_starts_at is null then return json_build_object('error', 'invalid_value'); end if;
  q := app_private.price_quote(p_menu_codes, p_starts_at)::jsonb;
  select coalesce(jsonb_agg(case when p.price is not null then it || jsonb_build_object('charge', p.price, 'normal_price', null, 'member_price', null, 'eligible', null, 'personal', true) else it end order by t.ord), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(q->'items') with ordinality as t(it, ord)
  cross join lateral (select app_private.client_menu_price(v_client, t.it->>'code') as price) p;
  return (q || jsonb_build_object('items', v_items,
    'total', (select sum((x->>'charge')::int) from jsonb_array_elements(v_items) x),
    'normal_total', (select sum(coalesce((x->>'normal_price')::int, (x->>'charge')::int)) from jsonb_array_elements(v_items) x)))::json;
end $$;

/** 店舗端末：そのお客様の「いつもの」料金の一覧（予約なしの会計でメニューを選ぶとき） */
create or replace function public.staff_client_menu_prices(p_staff text, p_client_id uuid)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.client_menu_prices(p_client_id)::json;
end $$;

/** アプリからの予約：明細の料金をその人の料金にする（合計も同じだけ直す） */
create or replace function app_private.reservation_item_personal_price()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.reservations; v_price int;
begin
  if new.menu_code is null then return new; end if;
  select * into r from public.reservations where id = new.reservation_id;
  if r.id is null or r.source <> 'app' or r.user_id is null then return new; end if;
  v_price := app_private.client_menu_price(app_private.user_client(r.user_id), new.menu_code);
  if v_price is null or v_price is not distinct from new.price then return new; end if;
  update public.reservations set total_price = coalesce(total_price, 0) - coalesce(new.price, 0) + v_price, updated_at = now() where id = r.id;
  new.price := v_price;
  return new;
end $$;

drop trigger if exists reservation_item_personal_price on public.reservation_items;
create trigger reservation_item_personal_price before insert on public.reservation_items
  for each row execute function app_private.reservation_item_personal_price();

revoke all on function app_private.client_menu_price(uuid, text), app_private.client_menu_prices(uuid), app_private.reservation_item_personal_price() from public, anon, authenticated;
revoke all on function public.customer_personal_prices(text), public.customer_price_quote(text, text[], timestamptz), public.staff_client_menu_prices(text, uuid) from public;
grant execute on function public.customer_personal_prices(text), public.customer_price_quote(text, text[], timestamptz), public.staff_client_menu_prices(text, uuid) to anon, authenticated, service_role;
