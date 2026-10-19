-- Staging preflight: service master (20261006000000_service_master.sql) matches the confirmed state.
-- Read-only. Fails if the master differs from the expected counts or if anything ambiguous was merged / enabled.

do $$
declare
  v_services integer;
  v_offers integer;
  v_bookable text;
  m public.service_menus;
  v_staff text;
begin
  select count(*) into v_services from public.service_menus where category is distinct from '旧App会員メニュー';
  if v_services <> 43 then raise exception 'expected 43 canonical services, got %', v_services; end if;

  select count(*) into v_offers from public.service_offers;
  if v_offers <> 23 then raise exception 'expected 23 offers, got %', v_offers; end if;

  -- 予約可にするかは本部（お店）が決める（10/06 時点はギンパラカーリーだけ、その後お店が順に予約可にした）。
  -- ここでは件数を決め打ちせず、予約可のものに所要時間・担当があること（下）と、ギンパラカーリーが予約可であることだけ確かめる
  select string_agg(code, ',' order by code) into v_bookable from public.service_menus where booking_enabled;
  if v_bookable is null or position('perm-ginpara-curly' in v_bookable) = 0 then raise exception 'expected perm-ginpara-curly to be bookable, got %', v_bookable; end if;

  select * into m from public.service_menus where code = 'perm-ginpara-curly';
  select string_agg(s.display_name, ',' order by s.display_name) into v_staff
  from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id where c.menu_id = m.id;
  if m.name <> 'ギンパラカーリー' or m.price <> 15000 or m.duration_min <> 180 or not m.is_active or v_staff is distinct from 'テイテイ,銀二郎' then
    raise exception 'ギンパラカーリー mismatch: price %, duration %, staff %', m.price, m.duration_min, v_staff;
  end if;

  -- 予約可には所要時間と担当が必要（どの行も）
  if exists (select 1 from public.service_menus sm where sm.booking_enabled
             and (not sm.is_active or sm.duration_min is null
                  or not exists (select 1 from public.staff_menu_capabilities c where c.menu_id = sm.id))) then
    raise exception 'bookable service without duration or staff';
  end if;

  -- 参考所要時間は記録として 9 件に残す。予約可にするのは、お店が本部で所要時間を確定してから（予約可なら所要時間があることは上で確かめている）
  if (select count(*) from public.service_menus where reference_duration_min is not null) <> 9 then
    raise exception 'reference durations must be recorded on 9 services';
  end if;
  if exists (select 1 from public.service_menus where reference_duration_min is not null and booking_enabled and duration_min is null) then
    raise exception 'reference duration must not be used as the booking duration';
  end if;

  -- 旧会計の「カット ¥3,300」は統合しない。曖昧なものも統合しない
  if exists (select 1 from public.accounting_items where name in ('カット', 'カット＋シェービング', '【メンテナンスカット限定】顔剃り追加') and service_menu_id is not null) then
    raise exception 'ambiguous legacy accounting items were merged';
  end if;
  -- 銀パラ ¥15,000 は確定済み（ギンパラカーリー）
  if exists (select 1 from public.accounting_items a where a.name = '銀パラ' and a.price = 15000
             and a.service_menu_id is distinct from m.id) then
    raise exception '銀パラ ¥15,000 is not linked to ギンパラカーリー';
  end if;

  -- 対象が未確認のオファー（シニア割・14日メンテナンス）は対象サービスを持たない
  if exists (select 1 from public.service_offer_menus om join public.service_offers o on o.id = om.offer_id where o.code in ('hp-senior', 'hp-cp-11140746')) then
    raise exception 'unconfirmed offer targets were filled in';
  end if;
end $$;
