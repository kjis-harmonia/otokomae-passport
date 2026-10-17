-- 来店の記録：メンテナンスカットも記録できるようにする
--   メンテナンスカットはアプリのメニュー（service_menus）には無い（ホットペッパーのクーポンで予約し、店頭ではクーポン QR で使う）。
--   来店の記録では menu_code = 'maintenance'（名前「メンテナンスカット」）として扱う。
--   ・スタッフ端末の「今日のメニュー」で選べる（staff_set_visit_menu）
--   ・ホットペッパーの取り込みでクーポン名に「メンテナンス」があれば、メンテナンスカットとして記録する

create or replace function app_private.visit_menu_from_reservation(p_user_id text, p_date date)
returns table (reservation_id uuid, menu_code text, menu_name text)
language sql stable
set search_path = public, pg_temp
as $$
  with member as (
    select c.id as customer_id from public.customers c where c.user_id = p_user_id
    union
    select a.customer_id from public.customer_user_aliases a where a.user_id = p_user_id
  ),
  member_clients as (
    select ci.client_id from public.client_identifiers ci
    where ci.kind = 'app_member' and ci.removed_at is null and ci.value in (select customer_id::text from member)
    union
    select cl.merged_into from public.clients cl
    join public.client_identifiers ci on ci.client_id = cl.id
    where ci.kind = 'app_member' and ci.removed_at is null and ci.value in (select customer_id::text from member) and cl.merged_into is not null
  )
  -- HOT PEPPER の取り込みはクーポン名（menu_code = 'hotpepper'）：メンテナンスならメンテナンスカット、
  -- それ以外は名前に含まれるメニュー（いちばん長いもの）に読み替える
  select r.id,
         case when i.menu_code = 'hotpepper' and i.name like '%メンテナンス%' then 'maintenance' else coalesce(m.code, i.menu_code) end,
         case when i.menu_code = 'hotpepper' and i.name like '%メンテナンス%' then 'メンテナンスカット' else coalesce(m.name, i.name) end
  from public.reservations r
  join lateral (select ri.menu_code, ri.name from public.reservation_items ri where ri.reservation_id = r.id order by ri.sort_order, ri.name limit 1) i on true
  left join lateral (
    select sm.code, sm.name from public.service_menus sm
    where i.menu_code = 'hotpepper' and sm.is_active and length(sm.name) >= 2 and position(sm.name in i.name) > 0
    order by length(sm.name) desc limit 1
  ) m on true
  where (r.starts_at at time zone 'Asia/Tokyo')::date = p_date
    and r.status not in ('cancelled', 'no_show')
    and (r.user_id = p_user_id or r.customer_id in (select customer_id from member) or r.client_id in (select client_id from member_clients))
  order by abs(extract(epoch from (r.starts_at - now())))
  limit 1
$$;

/** 今日の来店のメニューをスタッフが選ぶ（予約が無いとき・違うとき）。'maintenance' はメンテナンスカット */
create or replace function public.staff_set_visit_menu(p_staff text, p_user_id text, p_menu_code text, p_staff_name text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_name text;
begin
  perform app_private.assert_staff(p_staff);
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'user_id_required'; end if;
  if p_menu_code = 'maintenance' then v_name := 'メンテナンスカット';
  else select m.name into v_name from public.service_menus m where m.code = p_menu_code and m.is_active;
  end if;
  if v_name is null then return json_build_object('error', 'menu_not_found'); end if;
  insert into public.visit_log (user_id, visit_date, menu_code, menu_name, menu_source, updated_by)
  values (p_user_id, app_private.today_jst(), p_menu_code, v_name, 'staff', left(p_staff_name, 40))
  on conflict (user_id, visit_date) do update
    set menu_code = excluded.menu_code, menu_name = excluded.menu_name, menu_source = 'staff',
        updated_by = excluded.updated_by, updated_at = now();
  return json_build_object('visit_date', app_private.today_jst(), 'menu_code', p_menu_code, 'menu_name', v_name, 'menu_source', 'staff');
end;
$$;

revoke all on function app_private.visit_menu_from_reservation(text, date) from public, anon, authenticated;
