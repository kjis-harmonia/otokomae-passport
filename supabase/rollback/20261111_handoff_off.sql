-- 20261111160000_handoff_fixes.sql を戻す（入れる前の Staging＝本番の定義）
begin;

CREATE OR REPLACE FUNCTION app_private.gacha_gauge_on_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare h app_private.gacha_holdings; r public.reservations; v_base bigint; v_pt numeric; l app_private.gacha_gauge_log;
        v_month date := app_private.gacha_month_of(app_private.today_jst()); m app_private.gacha_gauge_month; v_add numeric;
begin
  begin
    if new.status = 'completed' and old.status is distinct from 'completed' then
      if not app_private.gacha_gauge_open() or new.reservation_id is null then return new; end if;
      select * into h from app_private.gacha_holdings where used_sale_id = new.id;
      if h.user_id is null then return new; end if;
      select * into r from public.reservations where id = new.reservation_id;
      -- ご本人の予約だけ（お連れ様の予約・ほかの会員の予約は付かない）
      if r.id is null or r.companion_of is not null or r.user_id is distinct from h.user_id then return new; end if;
      select coalesce(sum(i.price::bigint * i.quantity), 0) into v_base
      from public.accounting_session_items i
      where i.session_id = new.id and i.category in ('menu', 'option')
        and not exists (select 1 from app_private.gacha_gauge_skip_menus s where s.menu_code = i.ref_id);
      v_pt := app_private.gacha_gauge_points(v_base);
      if v_pt <= 0 then return new; end if;
      insert into app_private.gacha_gauge_log (user_id, kind, points, sale_id, base) values (h.user_id, 'earn', v_pt, new.id, v_base)
      on conflict do nothing;
      if not found then return new; end if;
      -- その月のガチャの分（まだ本物にしていない分）
      insert into app_private.gacha_gauge_month (user_id, month) values (h.user_id, v_month) on conflict do nothing;
      select * into m from app_private.gacha_gauge_month where user_id = h.user_id and month = v_month for update;
      v_add := greatest(0, m.draw_pt - m.credited);
      if v_add > 0 then
        update app_private.gacha_gauge_month set credited = draw_pt where user_id = h.user_id and month = v_month;
        insert into app_private.gacha_gauge_log (user_id, kind, points, sale_id) values (h.user_id, 'month', v_add, new.id);
      end if;
      insert into app_private.gacha_gauge (user_id, points) values (h.user_id, v_pt + v_add)
      on conflict (user_id) do update set points = app_private.gacha_gauge.points + excluded.points, updated_at = now();
    elsif new.status = 'voided' and old.status = 'completed' then
      select * into l from app_private.gacha_gauge_log where sale_id = new.id and kind = 'earn';
      if l.id is null then return new; end if;
      insert into app_private.gacha_gauge_log (user_id, kind, points, sale_id, base) values (l.user_id, 'void', -l.points, new.id, l.base)
      on conflict do nothing;
      if not found then return new; end if;
      update app_private.gacha_gauge set points = points - l.points, updated_at = now() where user_id = l.user_id;
      -- その月にほかの来店が残っていなければ、その月のガチャの分も戻す
      v_month := app_private.gacha_month_of((l.created_at at time zone 'Asia/Tokyo')::date);
      if not app_private.gacha_gauge_visited(l.user_id, v_month) then
        select * into m from app_private.gacha_gauge_month where user_id = l.user_id and month = v_month for update;
        if m.credited > 0 then
          update app_private.gacha_gauge_month set credited = 0 where user_id = l.user_id and month = v_month;
          update app_private.gacha_gauge set points = points - m.credited, updated_at = now() where user_id = l.user_id;
          insert into app_private.gacha_gauge_log (user_id, kind, points, sale_id) values (l.user_id, 'month_void', -m.credited, new.id);
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'gacha_gauge_on_sale %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.customer_create_transfer(p_session text, p_ticket_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_uid text := app_private.session_user_id(p_session); v_ticket public.tickets; v_token text;
begin
  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found or v_ticket.user_id <> v_uid then
    return json_build_object('error', 'チケットが見つかりません');
  end if;
  if v_ticket.used then return json_build_object('error', '使用済みチケットは譲渡できません'); end if;
  if exists (select 1 from public.ticket_transfers where ticket_id = p_ticket_id and status = 'pending' and expires_at > now()) then
    return json_build_object('error', 'このチケットは譲渡手続き中です');
  end if;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.ticket_transfers (token, ticket_id, from_user_id, status, expires_at)
  values (v_token, p_ticket_id, v_uid, 'pending', now() + interval '24 hours');
  return json_build_object('token', v_token);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_check_in(p_staff text, p_user_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_log public.visit_log; v_starts timestamptz; v_price int;
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  perform app_private.touch_visit(p_user_id);
  select * into v_log from public.visit_log where user_id = p_user_id and visit_date = app_private.today_jst();
  if v_log.reservation_id is not null then
    select r.starts_at, coalesce(r.total_price, (select sum(i.price) from public.reservation_items i where i.reservation_id = r.id)::int)
      into v_starts, v_price
    from public.reservations r where r.id = v_log.reservation_id;
  end if;
  return json_build_object(
    'visit_date', app_private.today_jst(),
    'menu_code', v_log.menu_code, 'menu_name', v_log.menu_name, 'menu_source', v_log.menu_source,
    'reservation_starts_at', v_starts, 'reservation_price', v_price,
    'recent', app_private.recent_visits_json(p_user_id, 6));
end;
$function$;

commit;
