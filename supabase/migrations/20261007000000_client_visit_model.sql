-- GINJIRO OS 顧客台帳：来店の数え方を1つに統一する（20261006000000_service_master.sql の後に適用。関数の置き換えのみ・何度実行しても同じ結果）
--
-- 来店モデル（顧客台帳・顧客一覧で共通。app_private.client_visit_rows）
--   予約による来店：完了した予約、または完了した会計が紐づく予約（accounting_sessions.reservation_id）を1回の来店とする。
--     来店日は予約の開始日時（reservations.starts_at）。紐づく会計は来店回数を増やさない（会計日が予約日と違っても同じ来店）。
--     担当は紐づく会計の担当（実際に施術した人）。会計がなければ予約の担当。
--   予約なしの来店：予約に紐づかない完了した会計（店頭会計・旧会計アシスト）を、会計日時（completed_at、無ければ created_at）の日付で数える。
--     予約なしの会計どうしは同じ日なら1回にまとめる。
--   例外（自動の突き合わせ。二重カウント防止のため条件を限定）：予約に紐づかない会計は、同じ顧客・同じ日に
--     「会計が紐づいていない完了予約」がちょうど1件だけあるときに限り、その予約の来店に含める（会計なしで完了 → 店頭会計、旧会計データ）。
--     候補が0件なら予約なしの来店、2件以上なら自動では突き合わせず予約なしの来店として数える。
--   来店回数・前回来店・平均来店周期・担当別回数はこの来店から計算し、施術履歴の日付も同じ規則（予約に紐づく会計は予約日）にする。
-- 売上・会計・予約・GINPay のデータ自体は変更しない（集計と表示の関数だけを置き換える）。

/** 来店の一覧（顧客の代表 root ごと）。予約による来店＋予約なしの来店 */
create or replace function app_private.client_visit_rows()
returns table (root uuid, visit_date date, stylist text, reservation_id uuid)
language sql stable
set search_path = public, extensions, pg_temp
as $$
  with linked as (     -- 予約に紐づく完了した会計
    select s.reservation_id, coalesce(s.completed_at, s.created_at) at_time, s.stylist_name
    from public.accounting_sessions s
    where s.status = 'completed' and s.reservation_id is not null
  ),
  res as (             -- 予約による来店（完了した予約、または完了した会計が紐づく予約）
    select r.id, app_private.client_root(r.client_id) root, (r.starts_at at time zone 'Asia/Tokyo')::date d, m.display_name staff_name,
           r.status = 'completed' and not exists (select 1 from linked l where l.reservation_id = r.id) open_candidate
    from public.reservations r
    join public.staff_members m on m.id = r.staff_id
    where r.status = 'completed' or exists (select 1 from linked l where l.reservation_id = r.id)
  ),
  candidates as (      -- 同じ顧客・同じ日の「会計が紐づいていない完了予約」がちょうど1件のときだけ突き合わせの対象
    select root, d, (array_agg(id))[1] reservation_id
    from res where open_candidate
    group by root, d
    having count(*) = 1
  ),
  unlinked as (        -- 予約に紐づかない完了した会計
    select app_private.client_root(s.client_id) root, (coalesce(s.completed_at, s.created_at) at time zone 'Asia/Tokyo')::date d,
           coalesce(s.completed_at, s.created_at) at_time, s.stylist_name
    from public.accounting_sessions s
    where s.status = 'completed' and s.reservation_id is null and s.client_id is not null
  ),
  absorbed as (        -- 突き合わせた会計（その予約の来店に含める）
    select c.reservation_id, u.at_time, u.stylist_name
    from unlinked u join candidates c on c.root = u.root and c.d = u.d
  ),
  res_stylist as (     -- 担当は実際の会計の担当（最新）。会計がなければ予約の担当
    select reservation_id, (array_agg(stylist_name order by at_time desc) filter (where stylist_name is not null))[1] stylist
    from (select reservation_id, at_time, stylist_name from linked union all select reservation_id, at_time, stylist_name from absorbed) x
    group by reservation_id
  )
  select res.root, res.d, coalesce(rs.stylist, res.staff_name), res.id
  from res left join res_stylist rs on rs.reservation_id = res.id
  union all
  select u.root, u.d, (array_agg(u.stylist_name order by u.at_time desc) filter (where u.stylist_name is not null))[1], null::uuid
  from unlinked u
  where not exists (select 1 from candidates c where c.root = u.root and c.d = u.d)
  group by u.root, u.d
$$;

/** 来店回数・前回来店・平均来店周期・累計売上・担当別回数・よく使うメニュー */
create or replace function app_private.client_stats_json(p_root uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_ids uuid[] := app_private.client_family(p_root); v_out jsonb;
begin
  with sales as (
    select s.id, s.total
    from public.accounting_sessions s
    where s.status = 'completed' and s.client_id = any(v_ids)
  ),
  visits as (
    select v.visit_date d, v.stylist from app_private.client_visit_rows() v where v.root = p_root
  ),
  days as (select d, lag(d) over (order by d) prev from visits)
  select jsonb_build_object(
    'visit_count', (select count(*) from visits),
    'last_visit', (select max(d) from visits),
    'avg_interval_days', (select round(avg(d - prev))::int from days where prev is not null),
    'total_sales', (select coalesce(sum(total), 0) from sales),
    'sales_count', (select count(*) from sales),
    'item_usage', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'category', category, 'count', n) order by n desc, name) filter (where rn <= 8), '[]'::jsonb)
                   from (select i.item_name name, i.category, sum(coalesce(i.quantity, 1))::int n,
                                row_number() over (order by sum(coalesce(i.quantity, 1)) desc, i.item_name) rn
                         from public.accounting_session_items i join sales on sales.id = i.session_id
                         group by i.item_name, i.category) u),
    'stylists', (select coalesce(jsonb_agg(jsonb_build_object('name', stylist, 'count', n, 'last', last) order by n desc, last desc), '[]'::jsonb)
                 from (select stylist, count(*) n, max(d) last from visits where stylist is not null group by stylist) x)
  ) into v_out;
  return v_out;
end;
$$;

/** 顧客台帳（App 会員でも、そうでなくても同じ形。App 会員だけ app が入る） */
create or replace function app_private.client_ledger_json(p_client_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_root uuid := app_private.client_root(p_client_id); v_c public.clients; v_ids uuid[]; v_members uuid[]; v_uids text[]; v_stats jsonb;
begin
  if v_root is null then return jsonb_build_object('error', 'client_not_found'); end if;
  select * into v_c from public.clients where id = v_root;
  v_ids := app_private.client_family(v_root);
  v_members := app_private.client_members(v_ids);
  v_uids := app_private.member_user_ids(v_members);
  v_stats := app_private.client_stats_json(v_root);
  return jsonb_build_object(
    'client', jsonb_build_object('id', v_c.id, 'name', v_c.display_name, 'kana', v_c.kana, 'phone_last4', (app_private.client_last4(v_ids))[1], 'created_via', v_c.created_via, 'created_at', v_c.created_at,
      'phones', (select coalesce(jsonb_agg(distinct coalesce(i.label, i.value)), '[]'::jsonb) from public.client_identifiers i
                 where i.client_id = any(v_ids) and i.kind = 'phone' and i.removed_at is null)),
    'app', case when cardinality(v_members) = 0 then null else jsonb_build_object(
      'members', (select coalesce(jsonb_agg(jsonb_build_object('name', cu.name, 'phone_last4', cu.phone_last4, 'created_at', cu.created_at) order by cu.created_at), '[]'::jsonb)
                  from public.customers cu where cu.id = any(v_members)),
      'coupons', (select coalesce(jsonb_agg(app_private.ticket_json(t)::jsonb order by t.expires_at nulls last, t.created_at), '[]'::jsonb)
                  from public.tickets t where t.user_id = any(v_uids) and not t.used and (t.expires_at is null or t.expires_at > now()))
    ) end,
    'stats', v_stats - 'stylists' - 'item_usage',
    'stylists', v_stats->'stylists',
    'item_usage', v_stats->'item_usage',
    'next_reservation', (select app_private.reservation_json(r.id) from public.reservations r
                         where r.client_id = any(v_ids) and r.status = 'confirmed' and r.starts_at > now() order by r.starts_at limit 1),
    'reservations', (select coalesce(jsonb_agg(app_private.reservation_json(r.id) order by r.starts_at desc), '[]'::jsonb)
                     from (select id, starts_at from public.reservations where client_id = any(v_ids) order by starts_at desc limit 50) r),
    -- 施術履歴の日付は来店モデルと同じ（予約に紐づく会計は予約日、予約なしの会計は会計日）
    'treatments', (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', s.id, 'date', s.visit_date, 'total', s.total, 'stylist_name', s.stylist_name,
                      'items', (select coalesce(jsonb_agg(jsonb_build_object('name', i.item_name, 'category', i.category, 'quantity', coalesce(i.quantity, 1))
                                  order by i.created_at), '[]'::jsonb)
                                from public.accounting_session_items i where i.session_id = s.id)
                    ) order by s.visit_date desc, s.at_time desc), '[]'::jsonb)
                   from (select s.id, s.total, s.stylist_name, coalesce(s.completed_at, s.created_at) at_time,
                                coalesce((r.starts_at at time zone 'Asia/Tokyo')::date, (coalesce(s.completed_at, s.created_at) at time zone 'Asia/Tokyo')::date) visit_date
                         from public.accounting_sessions s
                         left join public.reservations r on r.id = s.reservation_id
                         where s.status = 'completed' and s.client_id = any(v_ids)
                         order by 5 desc, 4 desc limit 30) s),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'note', n.note, 'created_by', n.created_by, 'created_at', n.created_at)
                order by n.created_at desc), '[]'::jsonb)
              from (select * from public.customer_notes where client_id = any(v_ids) order by created_at desc limit 50) n),
    'merges', (select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'client_id', e.other_client_id, 'name', o.display_name,
                  'created_at', e.created_at, 'actor_name', e.actor_name,
                  'reservations', jsonb_array_length(coalesce(e.detail->'reservations', '[]'::jsonb)))
                order by e.created_at desc), '[]'::jsonb)
               from public.client_events e left join public.clients o on o.id = e.other_client_id
               where e.client_id = v_root and e.event_type = 'merged' and e.undone_at is null)
  );
end;
$$;

/** 顧客一覧（来店回数・前回来店・主な担当は来店モデルから） */
create or replace function app_private.list_clients_json(p_query text, p_app text, p_offset integer)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_q text := btrim(coalesce(p_query, '')); v_qn text; v_qd text; v_off int := greatest(coalesce(p_offset, 0), 0);
begin
  v_qn := app_private.norm_name(v_q);
  v_qd := coalesce(app_private.norm_phone(v_q), '');
  return (
    with base as (
      select c.*, exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'app_member' and i.removed_at is null) app_linked
      from public.clients c
      where c.merged_into is null
        and (v_q = ''
          or c.display_name ilike '%' || v_q || '%' or (v_qn <> '' and c.normalized_name like '%' || v_qn || '%')
          or coalesce(c.kana, '') ilike '%' || v_q || '%'
          or exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.removed_at is null and (
                (i.kind = 'phone' and length(v_qd) >= 4 and i.value like '%' || v_qd || '%')
                or (i.kind = 'hotpepper_ref' and length(v_q) >= 3 and upper(i.value) like '%' || upper(v_q) || '%')))
          or (length(v_qd) = 4 and v_qd = any(app_private.client_last4(array[c.id]))))
    ),
    filtered as (
      select * from base where coalesce(p_app, 'all') = 'all' or (p_app = 'app' and app_linked) or (p_app = 'non_app' and not app_linked)
    ),
    sales as (
      select app_private.client_root(s.client_id) root, s.total
      from public.accounting_sessions s where s.status = 'completed' and s.client_id is not null
    ),
    visits as (
      select v.root, v.visit_date d, v.stylist from app_private.client_visit_rows() v
    ),
    agg as (
      select root, count(*)::int visit_count, max(d) last_visit,
             mode() within group (order by stylist) filter (where stylist is not null) main_stylist
      from visits group by root
    ),
    nxt as (
      select distinct on (app_private.client_root(r.client_id)) app_private.client_root(r.client_id) root, r.starts_at, m.display_name staff_name, r.nominated
      from public.reservations r join public.staff_members m on m.id = r.staff_id
      where r.status = 'confirmed' and r.starts_at > now()
      order by app_private.client_root(r.client_id), r.starts_at
    ),
    rows as (
      select f.id, f.display_name, f.kana, f.created_at, f.created_via, f.app_linked, a.visit_count, a.last_visit, a.main_stylist,
             n.starts_at next_at, n.staff_name next_staff, n.nominated next_nominated,
             (select coalesce(sum(total), 0) from sales where sales.root = f.id) total_sales
      from filtered f left join agg a on a.root = f.id left join nxt n on n.root = f.id
    )
    select jsonb_build_object(
      'total', (select count(*) from rows),
      'offset', v_off,
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'name', r.display_name, 'kana', r.kana, 'created_via', r.created_via, 'created_at', r.created_at,
          'app_linked', r.app_linked, 'visit_count', coalesce(r.visit_count, 0), 'last_visit', r.last_visit, 'main_stylist', r.main_stylist,
          'next_reservation', case when r.next_at is null then null else jsonb_build_object('starts_at', r.next_at, 'staff_name', r.next_staff, 'nominated', r.next_nominated) end,
          'total_sales', r.total_sales,
          'phone', (select coalesce(i.label, i.value) from public.client_identifiers i where i.client_id = r.id and i.kind = 'phone' and i.removed_at is null
                    order by i.created_at desc limit 1),
          'phone_last4', (app_private.client_last4(array[r.id]))[1]
        ) order by r.last_visit desc nulls last, r.created_at desc)
        from (select * from rows order by last_visit desc nulls last, created_at desc offset v_off limit 50) r), '[]'::jsonb)
    )
  );
end;
$$;

-- app_private の関数は外部から実行できない（他の migration と同じ。この migration で追加・置き換えた関数を含む）
revoke all on all functions in schema app_private from public, anon, authenticated;
