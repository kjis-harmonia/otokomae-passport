-- 予約の変更で担当（指名）も変えられるようにする（11/10 慶一郎さん「スタイリストの指名がねーよ！」「今すぐ変えよ！」）
--   p_staff：null＝今のまま（今までと同じ：指名の予約は同じ担当、指名なしは空いている担当）
--            'any'＝どちらでも（指名なしにする）／担当の id＝その担当に指名する
--   実際の変更（reservation_mutate）は、お客様が確認した内容（p_confirmation の new.staff_id・new.nominated）から担当を読み直す
--   → アプリの送り方（customer_change_reservation）は変えない。今までの呼び方はそのまま同じ結果
--   戻し方：supabase/rollback/20261110_change_staff_off.sql

-- 担当の指定 → 空きを探す担当（null＝だれでも）と、指名かどうか
create or replace function app_private.change_staff_target(r public.reservations, p_staff text)
returns table (target uuid, nominated boolean) language sql immutable set search_path = '' as $$
  select case when p_staff is null then case when r.nominated then r.staff_id end
              when p_staff = 'any' then null
              when p_staff ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_staff::uuid
              else '00000000-0000-0000-0000-000000000000'::uuid end,
         case when p_staff is null then r.nominated when p_staff = 'any' then false else true end
$$;

-- 確認の中身（書き込まない）。p_staff だけ増やした版。中身は 20261108072151 の reservation_review と同じで、担当の決め方だけ change_staff_target
create or replace function app_private.reservation_review(p_old uuid, p_starts timestamptz, p_codes text[], p_cancel boolean, p_staff text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare r public.reservations; s public.booking_settings; v_plan jsonb; v_staff uuid; v_effect jsonb;
  v_items jsonb; v_tickets jsonb; v_gacha jsonb; v_holds jsonb; v_now timestamptz; v_person_ok boolean;
  v_client uuid; v_line jsonb; v_new_items jsonb := '[]'; v_personal int; v_total int;
  v_family text[]; v_ticket jsonb; v_target uuid; v_nominated boolean;
begin
  select * into r from public.reservations where id = p_old;
  if r.id is null then return null; end if;
  select * into s from public.booking_settings where id = 1;
  select t.target, t.nominated into v_target, v_nominated from app_private.change_staff_target(r, p_staff) t;
  select coalesce(jsonb_agg(jsonb_build_object('menu_code', menu_code, 'name', name, 'price', price, 'duration_min', duration_min) order by sort_order), '[]')
    into v_items from public.reservation_items where reservation_id = r.id;
  if not p_cancel then
    select a.staff_id into v_staff
    from app_private.available_slots((p_starts at time zone 'Asia/Tokyo')::date, p_codes, v_target, s.min_lead_minutes, r.id) a
    join public.staff_members m on m.id = a.staff_id
    where a.starts_at = p_starts
    order by app_private.free_fragments(a.staff_id, (p_starts at time zone 'Asia/Tokyo')::date, tstzrange(a.starts_at, a.occupied_until)),
      app_private.booked_minutes(a.staff_id, (p_starts at time zone 'Asia/Tokyo')::date), m.sort_order, m.display_name, m.id limit 1;
    if v_staff is not null then v_plan := app_private.booking_plan(v_staff, p_codes); end if;
    if v_plan is not null then
      v_client := app_private.user_client(r.user_id);
      v_total := (v_plan->>'total_price')::int;
      for v_line in select value from jsonb_array_elements(v_plan->'items') loop
        v_personal := app_private.client_menu_price(v_client, v_line->>'menu_code');
        if v_personal is not null and v_personal is distinct from (v_line->>'price')::int then
          v_total := coalesce(v_total,0) - coalesce((v_line->>'price')::int,0) + v_personal;
          v_line := v_line || jsonb_build_object('price',v_personal);
        end if;
        v_new_items := v_new_items || v_line;
      end loop;
      v_plan := v_plan || jsonb_build_object('items',v_new_items,'total_price',v_total);
    end if;
  end if;
  v_person_ok := not ('maintenance' = any(p_codes)) or app_private.person_maintenance_ok(r.user_id, r.companion_id);
  v_effect := app_private.change_effects(r.id, p_starts, p_codes, (v_plan->>'total_price')::int);
  v_family := app_private.ticket_family_uids(r.user_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'type',t.type,'amount',t.amount,
      'used',t.used,'expires_at',t.expires_at,'perm_coupon',app_private.is_perm_coupon(t),
      'in_family',t.user_id=any(v_family)) order by t.id), '[]') into v_tickets
    from public.tickets t where t.id = any(coalesce((select ticket_ids from app_private.reservation_ticket_plans where reservation_id=r.id), '{}'));
  for v_ticket in select value from jsonb_array_elements(v_tickets) loop
    if (v_ticket->>'in_family')::boolean is distinct from true and (v_effect->'tickets_keep') ? (v_ticket->>'id') then
      v_effect := v_effect || jsonb_build_object('tickets_keep',(v_effect->'tickets_keep') - (v_ticket->>'id'),
        'tickets_drop',(v_effect->'tickets_drop') || jsonb_build_object('title',v_ticket->>'title','why','owner_changed'));
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('draw_id',h.draw_id,'title',h.title,'amount',h.amount,'free_menu',h.free_menu,
      'expires_at',h.expires_at,'weekday_only',h.weekday_only,'self_only',h.self_only,'menu_codes',h.menu_codes) order by h.user_id), '[]') into v_gacha
    from app_private.gacha_holdings h where h.reservation_id=r.id and h.used_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'account_id', h.account_id, 'amount', h.amount, 'status', h.status) order by h.id), '[]')
    into v_holds from app_private.ginpay_holds h where h.reservation_id=r.id and h.status='held';
  v_now := clock_timestamp();
  return jsonb_build_object('version', 'RESERVATION_REVIEW_V1',
    'old', jsonb_build_object('id', r.id, 'companion_id', r.companion_id, 'companion_of', r.companion_of,
      'starts_at', r.starts_at, 'status', r.status, 'total_price', r.total_price, 'items', v_items),
    'new', case when p_cancel then null else jsonb_build_object('starts_at', p_starts, 'menu_codes', to_jsonb(p_codes),
      'staff_id', v_staff, 'nominated', v_nominated, 'total_price', v_plan->'total_price',
      'duration_min', v_plan->'duration_min', 'buffer_min', v_plan->'buffer_min', 'items', v_plan->'items') end,
    'slot_ok', p_cancel or (v_plan is not null and app_private.customer_slot_ok(p_starts) and v_person_ok),
    'call_shop', r.starts_at < v_now + make_interval(mins=>s.customer_cancel_deadline_minutes),
    'late_penalty', not p_cancel and p_starts <> r.starts_at and r.starts_at < v_now + make_interval(mins=>s.ai_late_cancel_minutes),
    'cancel_late', p_cancel and r.starts_at < v_now + make_interval(mins=>s.ai_late_cancel_minutes),
    'impact', v_effect, 'ticket_facts', v_tickets, 'gacha_facts', v_gacha, 'hold_facts', v_holds);
end;
$$;

-- 今までの4つの引数の呼び方は「今のまま」と同じ
create or replace function app_private.reservation_review(p_old uuid, p_starts timestamptz, p_codes text[], p_cancel boolean default false)
returns jsonb language sql stable set search_path = '' as $$
  select app_private.reservation_review(p_old, p_starts, p_codes, p_cancel, null::text)
$$;

/** 変更先の空き（担当つき） */
create or replace function public.customer_change_slots(p_session text, p_reservation_id uuid, p_date date, p_menu_codes text[], p_staff text)
returns json language plpgsql stable security definer set search_path = 'public', 'extensions', 'pg_temp' as $$
declare v_user text := app_private.session_user_id(p_session); r public.reservations; v_lead int; v_target uuid;
begin
  perform app_private.require_store_verified(p_session);
  select * into r from public.reservations where id = p_reservation_id and user_id = v_user and status = 'confirmed';
  if r.id is null then return json_build_object('error', 'not_found'); end if;
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 5 then return json_build_object('error', 'invalid_menu'); end if;
  select min_lead_minutes into v_lead from public.booking_settings where id = 1;
  select t.target into v_target from app_private.change_staff_target(r, p_staff) t;
  return coalesce((select json_agg(json_build_object('starts_at', x.starts_at) order by x.starts_at) from (
    select distinct a.starts_at from app_private.available_slots(p_date, p_menu_codes, v_target, v_lead, r.id) a
    where app_private.customer_slot_ok(a.starts_at)) x), '[]'::json);
end;
$$;

create or replace function public.customer_change_open_days(p_session text, p_reservation_id uuid, p_menu_codes text[],
  p_from date, p_to date, p_weekend boolean, p_staff text)
returns json language plpgsql stable security definer set search_path='' as $$
declare d date; slots json; days date[]:='{}';
begin
  if p_from is null or p_to is null or p_to-p_from not between 0 and 6 then
    return json_build_object('error','invalid_range');
  end if;
  for offset_days in 0..(p_to-p_from) loop
    d:=p_from+offset_days;
    continue when p_weekend and extract(isodow from d)<6;
    slots:=public.customer_change_slots(p_session,p_reservation_id,d,p_menu_codes,p_staff);
    if json_typeof(slots)<>'array' then return slots; end if;
    if json_array_length(slots)>0 then days:=array_append(days,d); end if;
  end loop;
  return to_json(days);
end;
$$;

create or replace function public.customer_change_preview(p_session text, p_reservation_id uuid, p_starts_at timestamptz, p_menu_codes text[], p_staff text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare v_user text; r public.reservations; q jsonb;
begin
  v_user:=app_private.session_user_id(p_session);
  perform app_private.require_store_verified(p_session);
  select * into r from public.reservations where id=p_reservation_id and user_id=v_user;
  if r.id is null or r.status<>'confirmed' then return json_build_object('error','not_found'); end if;
  if p_starts_at is null or p_menu_codes is null or cardinality(p_menu_codes) not between 1 and 5
    or cardinality(p_menu_codes)<>(select count(distinct x) from unnest(p_menu_codes) x) then return json_build_object('error','invalid_menu'); end if;
  q:=app_private.reservation_review(r.id,p_starts_at,p_menu_codes,false,p_staff);
  if (q->>'call_shop')::boolean is distinct from false then return json_build_object('error','call_shop'); end if;
  return (jsonb_build_object('kind',case when p_starts_at=r.starts_at then 'menu' else 'time' end,
    'price_before',r.total_price,'price_after',q->'new'->'total_price','duration_after',q->'new'->'duration_min',
    'menu_names',(select jsonb_agg(x->>'name') from jsonb_array_elements(coalesce(nullif(q->'new'->'items','null'::jsonb),'[]'::jsonb)) x),
    'slot_ok',q->'slot_ok','late_penalty',q->'late_penalty','cancel_late',q->'cancel_late',
    'confirmation',q) || ((q->'impact') - 'ginpay_account'))::json;
end;
$$;

-- 実際の変更：20261108220801 の reservation_mutate と同じ。変えたのは3か所だけ（★）
--   ★1 担当はお客様が確認した内容（p_confirmation.new）から：指名なら その担当、指名なしなら 'any'
--   ★2 日時・メニューが同じでも、担当・指名が変わるなら変更として受ける
--   ★3 新しい予約の指名は確認した内容のとおり
create or replace function app_private.reservation_mutate(p_session text, p_kind text, p_old uuid,
  p_starts timestamptz, p_codes text[], p_key text, p_confirmation jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare u text; req jsonb; prior app_private.reservation_mutation_requests; r public.reservations;
  q jsonb; reply jsonb; out_res jsonb; new_id uuid; old_result jsonb; eff jsonb; keep_ids uuid[];
  acc public.ginpay_accounts; after_amount int; resume_on date; code text; c public.customers; cfg public.booking_settings;
  v_staff text; v_nom boolean;
begin
  u:=app_private.session_user_id(p_session);
  perform app_private.require_store_verified(p_session);
  if p_kind not in ('change','cancel') or p_key is null or length(p_key) not between 8 and 100 then
    return jsonb_build_object('state','unknown','code','invalid_request');
  end if;
  req:=app_private.reservation_mutation_request(p_kind,p_old,p_starts,p_codes,p_confirmation);
  perform pg_advisory_xact_lock(hashtextextended('reservation-mutation:'||u||':'||p_key,0));
  select * into prior from app_private.reservation_mutation_requests where user_id=u and idem_key=p_key;
  if found then
    if prior.request is distinct from req then return jsonb_build_object('state','conflict','code','idempotency_conflict'); end if;
    return prior.receipt;
  end if;
  if exists (select 1 from app_private.reservation_changes where user_id=u and idem_key=p_key) then
    return jsonb_build_object('state','conflict','code','idempotency_conflict');
  end if;
  if p_old is null or p_confirmation->>'version' is distinct from 'RESERVATION_REVIEW_V1'
    or p_confirmation->'old'->>'id' is distinct from p_old::text
    or (p_kind='change' and (p_starts is null or not isfinite(p_starts) or date_trunc('milliseconds',p_starts) is distinct from p_starts
      or p_codes is null or cardinality(p_codes) not between 1 and 5
      or cardinality(p_codes)<>(select count(distinct x) from unnest(p_codes) x))) then
    return jsonb_build_object('state','unknown','code','invalid_request');
  end if;
  -- ★1
  v_nom := coalesce((p_confirmation->'new'->>'nominated')::boolean, false);
  v_staff := case when p_kind <> 'change' then null when v_nom then p_confirmation->'new'->>'staff_id' else 'any' end;
  perform app_private.lock_all_staff();
  perform pg_advisory_xact_lock(hashtext('gacha:'||u));
  select * into r from public.reservations where id=p_old and user_id=u for no key update;
  select * into cfg from public.booking_settings where id=1 for share;
  if r.id is null then code:='not_found';
  elsif r.companion_id::text is distinct from p_confirmation->'old'->>'companion_id' then code:='person_changed';
  elsif r.status<>'confirmed' then code:='reservation_not_confirmed';
  elsif p_kind='change' and app_private.ai_booking_gate(p_session) is not null then code:='ai_booking_paused';
  elsif cfg.app_booking_enabled is distinct from true then code:='booking_disabled';
  elsif p_kind='change' and p_starts=r.starts_at and p_codes=
    (select array_agg(menu_code order by sort_order) from public.reservation_items where reservation_id=r.id)
    -- ★2
    and v_nom is not distinct from r.nominated and (not v_nom or (p_confirmation->'new'->>'staff_id') is not distinct from r.staff_id::text) then code:='no_change';
  end if;
  if code is null then
    perform 1 from public.service_menus m where m.code=any(p_codes) order by m.id for share;
    perform 1 from public.staff_menu_capabilities cap where cap.menu_id in (select m.id from public.service_menus m where m.code=any(p_codes)) order by cap.staff_id,cap.menu_id for share;
    perform 1 from public.tickets where id=any(coalesce((select ticket_ids from app_private.reservation_ticket_plans where reservation_id=r.id),'{}')) order by id for update;
    perform 1 from app_private.gacha_holdings where user_id=u for update;
    perform 1 from public.ginpay_accounts where id in (select account_id from app_private.ginpay_holds where reservation_id=r.id and status='held') order by id for update;
    perform 1 from app_private.ginpay_holds where reservation_id=r.id and status='held' order by id for update;
    if p_kind='cancel' then select array_agg(menu_code order by sort_order) into p_codes from public.reservation_items where reservation_id=r.id; p_starts:=r.starts_at; end if;
    q:=app_private.reservation_review(r.id,p_starts,p_codes,p_kind='cancel',v_staff);
    if (q->>'call_shop')::boolean is distinct from false then code:='call_shop';
    elsif (q->>'slot_ok')::boolean is distinct from true then code:='slot_taken';
    elsif q is distinct from p_confirmation then code:='conditions_changed'; end if;
  end if;
  if code is null then
    begin
      select * into c from public.customers where user_id=u;
      if p_kind='cancel' then
        out_res:=app_private.set_reservation_status(r.id,'cancelled','customer',coalesce(c.name,u),'お客様アプリからキャンセル');
        if out_res ? 'error' then raise exception '%',out_res->>'error'; end if;
        if (select status from public.reservations where id=r.id) is distinct from 'cancelled' then raise exception 'cancel_failed'; end if;
        if (q->>'cancel_late')::boolean then resume_on:=app_private.ai_penalty_add(r.id,'late_cancel'); end if;
        out_res:=app_private.reservation_json_customer(r.id) || jsonb_build_object('ginpay_released',
          q->'impact'->'ginpay_before','ai_paused_until',resume_on);
      else
        eff:=q->'impact';
        old_result:=app_private.set_reservation_status(r.id,'cancelled','customer',coalesce(c.name,u),'お客様アプリで予約を変更（新しい予約へ）');
        if old_result ? 'error' then raise exception '%',old_result->>'error'; end if;
        out_res:=app_private.create_reservation(jsonb_build_object('starts_at',p_starts,'menu_codes',to_jsonb(p_codes),
          'staff_id',q->'new'->'staff_id','customer_name',r.customer_name,'customer_phone',r.customer_phone,
          'customer_id',r.customer_id,'user_id',u,'source','app','note',r.note,'replaces_reservation_id',r.id),'customer',coalesce(c.name,u),cfg.min_lead_minutes);
        if out_res ? 'error' then raise exception '%',out_res->>'error'; end if;
        new_id:=(out_res->>'id')::uuid;
        -- ★3
        update public.reservations set nominated=v_nom,staff_confirmed=v_nom,
          companion_of=r.companion_of where id=new_id;
        if (select total_price from public.reservations where id=new_id) is distinct from (q->'new'->>'total_price')::int
          or (select extract(epoch from ends_at-starts_at)/60 from public.reservations where id=new_id) is distinct from (q->'new'->>'duration_min')::numeric
          or (select jsonb_agg(jsonb_build_array(menu_code, name, price, duration_min) order by sort_order)
              from public.reservation_items where reservation_id=new_id) is distinct from
             (select jsonb_agg(jsonb_build_array(i->>'menu_code',i->>'name',i->'price',i->'duration_min') order by n)
              from jsonb_array_elements(q->'new'->'items') with ordinality x(i,n)) then
          raise exception 'conditions_changed';
        end if;
        update public.reservations set companion_of=new_id where companion_of=r.id and status='confirmed';
        select array_agg(x::uuid) into keep_ids from jsonb_array_elements_text(eff->'tickets_keep') x;
        delete from app_private.reservation_ticket_plans where reservation_id=r.id;
        if cardinality(coalesce(keep_ids,'{}'))>0 then insert into app_private.reservation_ticket_plans(reservation_id,user_id,ticket_ids) values(new_id,u,keep_ids); end if;
        update app_private.gacha_holdings set reservation_id=case when coalesce((eff->'gacha'->>'keep')::boolean,false) then new_id else null end where reservation_id=r.id and used_at is null;
        after_amount:=coalesce((eff->>'ginpay_after')::int,0);
        if after_amount>0 then
          select * into acc from public.ginpay_accounts where id=(eff->>'ginpay_account')::uuid for update;
          if acc.id is null or acc.status<>'active' then raise exception 'ginpay_account_not_active'; end if;
          if acc.balance_cached-app_private.ginpay_held_sum(acc.id,new_id)<after_amount then raise exception 'insufficient_balance'; end if;
          insert into app_private.ginpay_holds(reservation_id,account_id,amount) values(new_id,acc.id,after_amount);
        end if;
        if (q->>'late_penalty')::boolean then resume_on:=app_private.ai_penalty_add(r.id,'late_cancel'); end if;
        out_res:=app_private.reservation_json_customer(new_id) || jsonb_build_object('changed_from',r.id,
          'kind',case when p_starts=r.starts_at then 'menu' else 'time' end,'tickets_drop',eff->'tickets_drop',
          'gacha',eff->'gacha','ginpay_before',eff->'ginpay_before','ginpay_after',after_amount)
          || case when resume_on is null then '{}'::jsonb else jsonb_build_object('ai_paused_until',resume_on) end;
      end if;
    exception when others then
      code:=case when sqlerrm in ('slot_taken','reservation_person_overlap','menu_not_available','date_not_open','too_late','invalid_starts_at','insufficient_balance',
        'ginpay_account_not_active','conditions_changed','cancel_deadline_passed','invalid_status') then sqlerrm else 'mutation_failed' end;
    end;
  end if;
  reply:=case when code is null then jsonb_build_object('state','completed','request',req,'result',out_res)
    else jsonb_build_object('state','rejected','request',req,'code',code) end;
  insert into app_private.reservation_mutation_requests(user_id,idem_key,request,receipt) values(u,p_key,req,reply);
  return reply;
end;
$$;

revoke all on function app_private.change_staff_target(public.reservations, text),
  app_private.reservation_review(uuid,timestamptz,text[],boolean,text), app_private.reservation_review(uuid,timestamptz,text[],boolean),
  app_private.reservation_mutate(text,text,uuid,timestamptz,text[],text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.customer_change_slots(text,uuid,date,text[],text), public.customer_change_open_days(text,uuid,text[],date,date,boolean,text),
  public.customer_change_preview(text,uuid,timestamptz,text[],text) from public;
grant execute on function public.customer_change_slots(text,uuid,date,text[],text), public.customer_change_open_days(text,uuid,text[],date,date,boolean,text),
  public.customer_change_preview(text,uuid,timestamptz,text[],text) to anon, authenticated, service_role;
