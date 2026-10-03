-- ============================================================================
-- GINJIRO OS 顧客台帳・顧客統合（20261002_booking_phase1.sql の後に適用。追加のみ・何度実行しても同じ結果）
--
-- 顧客（clients）＝銀二郎を利用する一人の人物。App 会員はその顧客に紐付く ID の一つ（client_identifiers）。
-- 予約台帳から顧客を開き、App 会員でなくても同じ台帳（基本情報・来店回数・前回来店・来店周期・累計売上・予約履歴・
-- 施術履歴・担当履歴・メモ）を表示する。App 会員の顧客だけ App 連携・クーポンを追加表示する。
--
-- 統合の方針（安全側）：
--   * 名前・電話番号だけでは自動で統合しない。候補（電話番号一致・電話下4桁一致・名前一致を明示）を人が見て選ぶ。
--   * 統合は、統合元の予約・メモ・会計・識別 ID を統合先へ移し、移した行を監査履歴（client_events）に記録する。
--   * 統合の解除は、記録した行だけを統合元へ戻す（統合後に統合先で増えた予約などは統合先に残る）。
--   * 台帳の集計は「顧客＋その顧客へ統合された顧客」をまとめて数える（統合と同時に作られた予約も漏れない）。
--
-- テーブルへは直接アクセスさせない（既存のロックダウンのまま）。店舗端末（staff_*）・本部（hq_*）の RPC のみ。
-- ============================================================================

-- ── 会計との接続（会計 UI を作り直さずに、どの会計画面からでも同じ規則で顧客に紐付く） ──
--   会計（accounting_sessions）の顧客は、client_id が空のときだけ次の順に決める。名前（customer_name）は使わない。
--     1. 会計で明示的に選んだ顧客（client_id。手入力会計では顧客検索から選ぶ）
--     2. 予約から会計へ進んだ場合は、その予約の顧客（reservation_id）
--     3. QR / App 会員の会計は、その App 会員の顧客（user_id。端末変更前の user_id を含む）
--     4. どれもなければ顧客なし（匿名の会計）
--   既存の会計は 3 の規則でだけ紐付ける（売上の金額・明細は変えない）。
alter table public.accounting_sessions add column if not exists reservation_id uuid references public.reservations(id) on delete set null;

/** user_id（現在または端末変更前）の App 会員の顧客 */
create or replace function app_private.user_client(p_user_id text)
returns uuid language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_customer uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' then return null; end if;
  select id into v_customer from public.customers where user_id = p_user_id;
  if v_customer is null then select customer_id into v_customer from public.customer_user_aliases where user_id = p_user_id; end if;
  if v_customer is null then return null; end if;
  return app_private.member_client(v_customer);
end;
$$;

create or replace function app_private.on_accounting_session_write()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  -- client_id が空のときだけ呼ばれる（明示的に選んだ顧客はそのまま。統合済みでも台帳は統合先にまとめて数える）
  if new.reservation_id is not null then
    new.client_id := (select app_private.client_root(r.client_id) from public.reservations r where r.id = new.reservation_id);
  end if;
  if new.client_id is null then new.client_id := app_private.user_client(new.user_id); end if;
  return new;
end;
$$;
drop trigger if exists accounting_sessions_client_before_write on public.accounting_sessions;
create trigger accounting_sessions_client_before_write before insert or update of client_id, reservation_id, user_id on public.accounting_sessions
  for each row when (new.client_id is null) execute function app_private.on_accounting_session_write();

-- 既存の会計：App 会員の会計だけ、その会員の顧客へ（何度実行しても同じ結果）
update public.accounting_sessions s set client_id = app_private.user_client(s.user_id)
where s.client_id is null and s.user_id is not null;

-- ── 内部関数（app_private：外部から実行不可） ─────────────────────────────────

/** 顧客と、その顧客へ統合された顧客（統合の連鎖を含む） */
create or replace function app_private.client_family(p_root uuid)
returns uuid[] language sql stable
set search_path = public, extensions, pg_temp
as $$
  with recursive f(id) as (
    select p_root
    union
    select c.id from public.clients c join f on c.merged_into = f.id
  )
  select coalesce(array_agg(id), '{}') from f
$$;

/** 顧客の App 会員（有効な App 会員 ID） */
create or replace function app_private.client_members(p_ids uuid[])
returns uuid[] language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(distinct i.value::uuid), '{}') from public.client_identifiers i
  where i.client_id = any(p_ids) and i.kind = 'app_member' and i.removed_at is null
$$;

/** App 会員の user_id（現在の user_id ＋ 端末変更前の user_id） */
create or replace function app_private.member_user_ids(p_member_ids uuid[])
returns text[] language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(distinct u), '{}') from (
    select user_id u from public.customers where id = any(p_member_ids)
    union select user_id from public.customer_user_aliases where customer_id = any(p_member_ids)
  ) x where u is not null
$$;

/**
 * 来店の集計。来店＝会計完了の日（顧客に紐付いた会計、または App 会員の user_id の会計）。
 * 会計が無い日は完了した予約の日も来店として数える（同じ日は1回）。
 */
create or replace function app_private.client_stats_json(p_root uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_ids uuid[] := app_private.client_family(p_root); v_out jsonb;
begin
  with sales as (
    select s.id, (s.created_at at time zone 'Asia/Tokyo')::date d, s.created_at, s.total, s.stylist_name
    from public.accounting_sessions s
    where s.status = 'completed' and s.client_id = any(v_ids)
  ),
  done_res as (
    select (r.starts_at at time zone 'Asia/Tokyo')::date d, m.display_name stylist
    from public.reservations r join public.staff_members m on m.id = r.staff_id
    where r.client_id = any(v_ids) and r.status = 'completed'
  ),
  visits as (
    select d, (array_agg(stylist_name order by created_at desc) filter (where stylist_name is not null))[1] stylist from sales group by d
    union all
    select d, (array_agg(stylist))[1] from done_res where d not in (select d from sales) group by d
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
    'treatments', (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', s.id, 'date', (s.created_at at time zone 'Asia/Tokyo')::date, 'total', s.total, 'stylist_name', s.stylist_name,
                      'items', (select coalesce(jsonb_agg(jsonb_build_object('name', i.item_name, 'category', i.category, 'quantity', coalesce(i.quantity, 1))
                                  order by i.created_at), '[]'::jsonb)
                                from public.accounting_session_items i where i.session_id = s.id)
                    ) order by s.created_at desc), '[]'::jsonb)
                   from (select * from public.accounting_sessions s
                         where s.status = 'completed' and s.client_id = any(v_ids)
                         order by s.created_at desc limit 30) s),
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

/** 予約から顧客台帳を開く（すべての予約に顧客がいる） */
create or replace function app_private.reservation_client_json(p_reservation_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation_id;
  if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
  return app_private.client_ledger_json(r.client_id) || jsonb_build_object('reservation', app_private.reservation_json(r.id));
end;
$$;

/**
 * 顧客の候補。統合の候補（p_client_id あり・検索語なし）は電話番号一致・電話下4桁一致・名前一致を示すだけで、
 * 自動では統合しない。検索語があれば名前・電話番号で探す（新規予約で既存の顧客を選ぶとき）。
 */
create or replace function app_private.client_candidates_json(p_client_id uuid, p_query text)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_root uuid; v_c public.clients; v_ids uuid[] := '{}'; v_phones text[] := '{}'; v_last4 text[] := '{}'; v_name text := '';
        v_q text := btrim(coalesce(p_query, '')); v_qn text; v_qd text;
begin
  if p_client_id is not null then
    v_root := app_private.client_root(p_client_id);
    if v_root is null then return jsonb_build_object('error', 'client_not_found'); end if;
    select * into v_c from public.clients where id = v_root;
    v_ids := app_private.client_family(v_root);
    select coalesce(array_agg(distinct value), '{}') into v_phones from public.client_identifiers
    where client_id = any(v_ids) and kind = 'phone' and removed_at is null;
    select coalesce(array_agg(distinct x), '{}') into v_last4 from (
      select right(unnest(v_phones), 4) x union select unnest(app_private.client_last4(v_ids))
    ) y where x is not null;
    v_name := v_c.normalized_name;
  end if;
  v_qn := app_private.norm_name(v_q);
  v_qd := coalesce(app_private.norm_phone(v_q), '');
  if v_q = '' and p_client_id is null then return '[]'::jsonb; end if;
  return (
    with cand as (
      select c.*,
        exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'phone' and i.removed_at is null
                and (i.value = any(v_phones) or (length(v_qd) >= 8 and i.value = v_qd))) phone_match,
        (app_private.client_last4(array[c.id]) && v_last4 or exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'phone'
                and i.removed_at is null and right(i.value, 4) = any(v_last4))) last4_match,
        (v_name <> '' and c.normalized_name = v_name) or (v_qn <> '' and c.normalized_name = v_qn) name_match
      from public.clients c
      where c.merged_into is null and not (c.id = any(v_ids))
        and case when v_q <> '' then
              c.display_name ilike '%' || v_q || '%' or (v_qn <> '' and c.normalized_name like '%' || v_qn || '%')
              or (length(v_qd) >= 4 and (length(v_qd) = 4 and v_qd = any(app_private.client_last4(array[c.id]))
                  or exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'phone' and i.removed_at is null
                             and i.value like '%' || v_qd || '%')))
            else
              c.normalized_name = v_name
              or exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'phone' and i.removed_at is null
                         and (i.value = any(v_phones) or right(i.value, 4) = any(v_last4)))
              or app_private.client_last4(array[c.id]) && v_last4
            end
      order by c.updated_at desc limit 20
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.display_name, 'created_at', c.created_at, 'created_via', c.created_via,
      'phone', (select coalesce(i.label, i.value) from public.client_identifiers i where i.client_id = c.id and i.kind = 'phone' and i.removed_at is null
                order by i.created_at desc limit 1),
      'phone_last4', (app_private.client_last4(array[c.id]))[1],
      'app_linked', exists (select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'app_member' and i.removed_at is null),
      'phone_match', c.phone_match, 'last4_match', c.last4_match and not c.phone_match, 'name_match', c.name_match,
      'visit_count', (app_private.client_stats_json(c.id)->>'visit_count')::int,
      'last_visit', app_private.client_stats_json(c.id)->>'last_visit'
    ) order by c.phone_match desc, c.last4_match desc, c.name_match desc, c.updated_at desc), '[]'::jsonb)
    from cand c
  );
end;
$$;

/**
 * 顧客の統合（人が確認してから）。統合元の予約・メモ・会計・識別 ID を統合先へ移し、移した行を記録する。
 * 統合元は削除せず merged_into で統合先を指す（解除できるように）。
 */
create or replace function app_private.merge_clients(p_target uuid, p_source uuid, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_t uuid := app_private.client_root(p_target); v_s uuid := app_private.client_root(p_source);
        v_res uuid[]; v_notes uuid[]; v_sales uuid[]; v_idents uuid[]; v_event bigint; c record;
begin
  if v_t is null or v_s is null then return jsonb_build_object('error', 'client_not_found'); end if;
  if v_t = v_s then return jsonb_build_object('error', 'same_client'); end if;
  -- 2人の顧客を id 順に行ロック（予約作成は顧客行を共有ロックするので、統合と同時の予約は統合の前後どちらかに並ぶ）
  for c in select id, merged_into from public.clients where id in (v_t, v_s) order by id for update loop
    if c.merged_into is not null then return jsonb_build_object('error', 'try_again'); end if;
  end loop;
  with m as (update public.reservations set client_id = v_t, updated_at = now() where client_id = v_s returning id)
  select coalesce(array_agg(id), '{}') into v_res from m;
  with m as (update public.customer_notes set client_id = v_t where client_id = v_s returning id)
  select coalesce(array_agg(id), '{}') into v_notes from m;
  with m as (update public.accounting_sessions set client_id = v_t where client_id = v_s returning id)
  select coalesce(array_agg(id), '{}') into v_sales from m;
  with m as (update public.client_identifiers set client_id = v_t where client_id = v_s and removed_at is null returning id)
  select coalesce(array_agg(id), '{}') into v_idents from m;
  update public.clients set merged_into = v_t, merged_at = now(), updated_at = now() where id = v_s;
  update public.clients set updated_at = now() where id = v_t;
  insert into public.client_events (client_id, event_type, other_client_id, actor_type, actor_name, detail)
  values (v_t, 'merged', v_s, p_actor_type, p_actor_name,
          jsonb_build_object('reservations', to_jsonb(v_res), 'notes', to_jsonb(v_notes), 'sales', to_jsonb(v_sales), 'identifiers', to_jsonb(v_idents)))
  returning id into v_event;
  insert into public.client_events (client_id, event_type, other_client_id, actor_type, actor_name, detail)
  values (v_s, 'merged_into', v_t, p_actor_type, p_actor_name, jsonb_build_object('event_id', v_event));
  return jsonb_build_object('ok', true, 'client_id', v_t, 'event_id', v_event, 'reservations', cardinality(v_res));
end;
$$;

/** 統合の解除。統合で移した行だけを統合元へ戻す（解除も監査履歴に残す） */
create or replace function app_private.unmerge_clients(p_event_id bigint, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare e public.client_events; c record;
begin
  select * into e from public.client_events where id = p_event_id and event_type = 'merged';
  if e.id is null then return jsonb_build_object('error', 'not_found'); end if;
  for c in select id, merged_into from public.clients where id in (e.client_id, e.other_client_id) order by id for update loop
    if c.id = e.client_id and c.merged_into is not null then return jsonb_build_object('error', 'merged_again'); end if;
    if c.id = e.other_client_id and c.merged_into is distinct from e.client_id then return jsonb_build_object('error', 'already_unmerged'); end if;
  end loop;
  select * into e from public.client_events where id = p_event_id for update;
  if e.undone_at is not null then return jsonb_build_object('error', 'already_unmerged'); end if;
  update public.reservations set client_id = e.other_client_id, updated_at = now()
  where client_id = e.client_id and id in (select (jsonb_array_elements_text(e.detail->'reservations'))::uuid);
  update public.customer_notes set client_id = e.other_client_id
  where client_id = e.client_id and id in (select (jsonb_array_elements_text(e.detail->'notes'))::uuid);
  update public.accounting_sessions set client_id = e.other_client_id
  where client_id = e.client_id and id in (select (jsonb_array_elements_text(e.detail->'sales'))::uuid);
  update public.client_identifiers set client_id = e.other_client_id
  where client_id = e.client_id and id in (select (jsonb_array_elements_text(e.detail->'identifiers'))::uuid);
  update public.clients set merged_into = null, merged_at = null, updated_at = now() where id = e.other_client_id;
  update public.client_events set undone_at = now() where id = e.id;
  insert into public.client_events (client_id, event_type, other_client_id, actor_type, actor_name, detail) values
    (e.client_id, 'unmerged', e.other_client_id, p_actor_type, p_actor_name, jsonb_build_object('event_id', e.id)),
    (e.other_client_id, 'unmerged', e.client_id, p_actor_type, p_actor_name, jsonb_build_object('event_id', e.id));
  return jsonb_build_object('ok', true, 'client_id', e.other_client_id);
end;
$$;

/**
 * 顧客一覧（本部・店舗）。検索：氏名・フリガナ・電話番号（一部）・電話下4桁・HOT PEPPER 予約番号。
 * 絞り込み：App 連携あり／なし。並び：前回来店が新しい順（来店なしは登録が新しい順）。50件ずつ。
 * 来店・主担当は顧客台帳と同じ数え方（会計完了の日、会計のない日は完了した予約の日）。
 */
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
      select app_private.client_root(s.client_id) root, (s.created_at at time zone 'Asia/Tokyo')::date d, s.created_at, s.stylist_name, s.total
      from public.accounting_sessions s where s.status = 'completed' and s.client_id is not null
    ),
    done_res as (
      select app_private.client_root(r.client_id) root, (r.starts_at at time zone 'Asia/Tokyo')::date d, m.display_name stylist
      from public.reservations r join public.staff_members m on m.id = r.staff_id where r.status = 'completed'
    ),
    visits as (
      select root, d, (array_agg(stylist_name order by created_at desc) filter (where stylist_name is not null))[1] stylist from sales group by root, d
      union all
      select root, d, (array_agg(stylist))[1] from done_res x where not exists (select 1 from sales y where y.root = x.root and y.d = x.d) group by root, d
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

/**
 * 顧客情報の編集（氏名・フリガナ・電話番号）。App 会員の情報（user_id・認証・復旧コード）には触れない。
 * 電話番号を変えても他の顧客へ自動で統合しない（候補は台帳で人が確認する）。変更は監査履歴に残す。
 *   p：name, kana, phone（キーがあるものだけ更新。phone を空にすると電話番号を外す）
 */
create or replace function app_private.update_client(p_client_id uuid, p jsonb, p_actor_type text, p_actor_name text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_root uuid := app_private.client_root(p_client_id); v_c public.clients; v_name text; v_kana text; v_phone text; v_label text;
        v_before jsonb; v_after jsonb;
begin
  if v_root is null then return jsonb_build_object('error', 'client_not_found'); end if;
  select * into v_c from public.clients where id = v_root for update;
  if v_c.merged_into is not null then return jsonb_build_object('error', 'try_again'); end if;
  v_before := jsonb_build_object('name', v_c.display_name, 'kana', v_c.kana,
    'phones', (select coalesce(jsonb_agg(value order by created_at), '[]'::jsonb) from public.client_identifiers where client_id = v_root and kind = 'phone' and removed_at is null));
  v_name := case when p ? 'name' then btrim(coalesce(p->>'name', '')) else v_c.display_name end;
  if v_name = '' or length(v_name) > 60 then return jsonb_build_object('error', 'invalid_name'); end if;
  v_kana := case when p ? 'kana' then nullif(btrim(coalesce(p->>'kana', '')), '') else v_c.kana end;
  if v_kana is not null and length(v_kana) > 60 then return jsonb_build_object('error', 'invalid_kana'); end if;
  update public.clients set display_name = v_name, normalized_name = app_private.norm_name(v_name), kana = v_kana, updated_at = now() where id = v_root;
  if p ? 'phone' then
    v_label := nullif(btrim(coalesce(p->>'phone', '')), '');
    v_phone := app_private.norm_phone(v_label);
    if v_label is not null and (v_phone is null or length(v_phone) < 8 or length(v_phone) > 15 or length(v_label) > 20) then
      return jsonb_build_object('error', 'invalid_phone');
    end if;
    -- 以前の電話番号は無効にして履歴として残す（同じ番号なら表記だけ直す）
    update public.client_identifiers set removed_at = now()
    where client_id = v_root and kind = 'phone' and removed_at is null and value is distinct from v_phone;
    update public.client_identifiers set label = v_label where client_id = v_root and kind = 'phone' and removed_at is null and value = v_phone;
    if v_phone is not null then perform app_private.add_client_identifier(v_root, 'phone', v_phone, v_label, p_actor_name); end if;
  end if;
  v_after := jsonb_build_object('name', v_name, 'kana', v_kana,
    'phones', (select coalesce(jsonb_agg(value order by created_at), '[]'::jsonb) from public.client_identifiers where client_id = v_root and kind = 'phone' and removed_at is null));
  if v_after is distinct from v_before then
    insert into public.client_events (client_id, event_type, actor_type, actor_name, detail)
    values (v_root, 'updated', p_actor_type, p_actor_name, jsonb_build_object('before', v_before, 'after', v_after));
  end if;
  return jsonb_build_object('ok', true, 'client_id', v_root);
end;
$$;

/** 顧客のメモ。App 会員の顧客は会員のメモとしても残す（既存の本部カルテから見えるように） */
create or replace function app_private.create_client_note(p_client_id uuid, p_note text, p_created_by text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_root uuid := app_private.client_root(p_client_id); v public.customer_notes;
begin
  if p_note is null or btrim(p_note) = '' or length(p_note) > 2000 then return jsonb_build_object('error', 'invalid_note'); end if;
  if p_created_by is null or btrim(p_created_by) = '' then return jsonb_build_object('error', 'created_by_required'); end if;
  if v_root is null then return jsonb_build_object('error', 'client_not_found'); end if;
  insert into public.customer_notes (client_id, customer_id, note, created_by)
  values (v_root, (app_private.client_members(array[v_root]))[1], btrim(p_note), btrim(p_created_by)) returning * into v;
  return jsonb_build_object('id', v.id, 'note', v.note, 'created_by', v.created_by, 'created_at', v.created_at);
end;
$$;

-- ── 店舗端末（スタッフセッション必須） ─────────────────────────────────────────

create or replace function public.staff_reservation_client(p_staff text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.reservation_client_json(p_reservation_id)::json;
end;
$$;

create or replace function public.staff_client_candidates(p_staff text, p_client_id uuid, p_query text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.client_candidates_json(p_client_id, p_query)::json;
end;
$$;

create or replace function public.staff_merge_clients(p_staff text, p_target uuid, p_source uuid, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  return app_private.merge_clients(p_target, p_source, 'staff', btrim(p_staff_name))::json;
end;
$$;

create or replace function public.staff_unmerge_client(p_staff text, p_event_id bigint, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  return app_private.unmerge_clients(p_event_id, 'staff', btrim(p_staff_name))::json;
end;
$$;

create or replace function public.staff_create_client_note(p_staff text, p_client_id uuid, p_note text, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.create_client_note(p_client_id, p_note, p_staff_name)::json;
end;
$$;

create or replace function public.staff_list_clients(p_staff text, p_query text, p_app text, p_offset integer)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.list_clients_json(p_query, p_app, p_offset)::json;
end;
$$;

create or replace function public.staff_client_ledger(p_staff text, p_client_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.client_ledger_json(p_client_id)::json;
end;
$$;

create or replace function public.staff_update_client(p_staff text, p_client_id uuid, p jsonb, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  if p_staff_name is null or btrim(p_staff_name) = '' then return json_build_object('error', 'created_by_required'); end if;
  return app_private.update_client(p_client_id, p, 'staff', btrim(p_staff_name))::json;
end;
$$;

-- ── 本部（本部セッション必須。記録上の操作者は「本部」） ─────────────────────────

create or replace function public.hq_list_clients(p_hq text, p_query text, p_app text, p_offset integer)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.list_clients_json(p_query, p_app, p_offset)::json;
end;
$$;

create or replace function public.hq_client_ledger(p_hq text, p_client_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.client_ledger_json(p_client_id)::json;
end;
$$;

create or replace function public.hq_update_client(p_hq text, p_client_id uuid, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.update_client(p_client_id, p, 'hq', '本部')::json;
end;
$$;

create or replace function public.hq_reservation_client(p_hq text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.reservation_client_json(p_reservation_id)::json;
end;
$$;

create or replace function public.hq_client_candidates(p_hq text, p_client_id uuid, p_query text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.client_candidates_json(p_client_id, p_query)::json;
end;
$$;

create or replace function public.hq_merge_clients(p_hq text, p_target uuid, p_source uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.merge_clients(p_target, p_source, 'hq', '本部')::json;
end;
$$;

create or replace function public.hq_unmerge_client(p_hq text, p_event_id bigint)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.unmerge_clients(p_event_id, 'hq', '本部')::json;
end;
$$;

create or replace function public.hq_create_client_note(p_hq text, p_client_id uuid, p_note text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.create_client_note(p_client_id, p_note, '本部')::json;
end;
$$;

-- ── 実行権限：上の RPC だけを anon / authenticated に許可。内部関数は外部から実行不可 ──
do $$
declare f text;
begin
  foreach f in array array[
    'public.staff_reservation_client(text, uuid)',
    'public.staff_list_clients(text, text, text, integer)',
    'public.staff_client_ledger(text, uuid)',
    'public.staff_update_client(text, uuid, jsonb, text)',
    'public.hq_list_clients(text, text, text, integer)',
    'public.hq_client_ledger(text, uuid)',
    'public.hq_update_client(text, uuid, jsonb)',
    'public.staff_client_candidates(text, uuid, text)',
    'public.staff_merge_clients(text, uuid, uuid, text)',
    'public.staff_unmerge_client(text, bigint, text)',
    'public.staff_create_client_note(text, uuid, text, text)',
    'public.hq_reservation_client(text, uuid)',
    'public.hq_client_candidates(text, uuid, text)',
    'public.hq_merge_clients(text, uuid, uuid)',
    'public.hq_unmerge_client(text, bigint)',
    'public.hq_create_client_note(text, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke all on all functions in schema app_private from public, anon, authenticated;
