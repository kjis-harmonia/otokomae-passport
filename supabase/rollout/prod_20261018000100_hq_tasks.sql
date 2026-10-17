begin;
-- 本部の「やること」。決まったこと（BOS への報告）から生まれる作業を、誰が・いつまでに、で持つ。
--   本部 JOHNNY が登録し、期限が近い・過ぎたら声をかける。終わったら BOS へ自動で【完了】の伝言を入れる。
--   BOS の JOHNNY（デスクトップ）からは owner_tasks_list（合言葉）で進み具合を見る。

create table if not exists public.hq_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 120),
  detail text check (detail is null or length(detail) <= 2000),
  assignee text not null default 'テイテイ' check (length(assignee) between 1 and 40),
  due_date date,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  source_message_id uuid references public.hq_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_note text check (done_note is null or length(done_note) <= 1000)
);
create index if not exists hq_tasks_open_idx on public.hq_tasks (status, due_date);
alter table public.hq_tasks enable row level security;
revoke all on public.hq_tasks from anon, authenticated;

create or replace function app_private.hq_task_json(t public.hq_tasks)
returns json language sql stable as $$
  select json_build_object('id', t.id, 'title', t.title, 'detail', t.detail, 'assignee', t.assignee, 'due_date', t.due_date,
    'status', t.status, 'source_message_id', t.source_message_id, 'created_at', t.created_at, 'done_at', t.done_at, 'done_note', t.done_note,
    'days_left', case when t.due_date is null then null else t.due_date - (now() at time zone 'Asia/Tokyo')::date end)
$$;

create or replace function app_private.hq_tasks_json(p_include_done boolean)
returns json language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(json_agg(app_private.hq_task_json(t) order by (t.status <> 'open'), t.due_date nulls last, t.created_at), '[]'::json)
  from (select * from public.hq_tasks
         where status = 'open' or (p_include_done and coalesce(done_at, created_at) > now() - interval '14 days')
         order by created_at desc limit 100) t
$$;

create or replace function public.hq_tasks_list(p_hq text, p_include_done boolean default false)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.hq_tasks_json(coalesce(p_include_done, false));
end $$;

create or replace function public.hq_task_add(p_hq text, p_title text, p_detail text default null, p_assignee text default 'テイテイ', p_due date default null, p_source_message_id uuid default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare t public.hq_tasks;
begin
  perform app_private.assert_hq(p_hq);
  if coalesce(btrim(p_title), '') = '' then return json_build_object('error', 'invalid_value'); end if;
  -- 同じ作業を二度入れない（開いている同じ見出し）
  select * into t from public.hq_tasks where status = 'open' and title = left(btrim(p_title), 120) limit 1;
  if t.id is not null then return app_private.hq_task_json(t); end if;
  insert into public.hq_tasks (title, detail, assignee, due_date, source_message_id)
  values (left(btrim(p_title), 120), nullif(left(btrim(coalesce(p_detail, '')), 2000), ''), coalesce(nullif(left(btrim(coalesce(p_assignee, '')), 40), ''), 'テイテイ'), p_due,
          (select id from public.hq_messages where id = p_source_message_id))
  returning * into t;
  return app_private.hq_task_json(t);
end $$;

/** 終わった（done）・やめた（cancelled）。終わったら BOS へ【完了】の伝言を入れる */
create or replace function public.hq_task_close(p_hq text, p_id uuid, p_status text default 'done', p_note text default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare t public.hq_tasks;
begin
  perform app_private.assert_hq(p_hq);
  if p_status not in ('done', 'cancelled') then return json_build_object('error', 'invalid_value'); end if;
  update public.hq_tasks set status = p_status, done_at = now(), done_note = nullif(left(btrim(coalesce(p_note, '')), 1000), '')
   where id = p_id and status = 'open'
  returning * into t;
  if t.id is null then return json_build_object('error', 'not_found'); end if;
  perform app_private.hq_message_put('to_owner', 'note',
    case when p_status = 'done' then '【完了】' else '【中止】' end || t.title,
    concat_ws(E'\n', t.assignee || 'さんが' || case when p_status = 'done' then '終わらせました。' else 'やめました。' end,
      case when t.due_date is not null then '期限：' || to_char(t.due_date, 'FMMM/FMDD') end, t.done_note), false);
  return app_private.hq_task_json(t);
end $$;

create or replace function public.owner_tasks_list(p_secret text)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_bridge(p_secret);
  return app_private.hq_tasks_json(true);
end $$;

-- 本部 JOHNNY の様子にも「やること」を入れる
create or replace function public.hq_johnny_overview(p_hq text, p_from date, p_to date)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 31 then return json_build_object('error', 'invalid_range'); end if;
  return json_build_object(
    'reservations', coalesce((select json_agg(json_build_object(
        'starts_at', to_char(r.starts_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI'),
        'ends_at', to_char(r.ends_at at time zone 'Asia/Tokyo', 'HH24:MI'),
        'staff', s.display_name, 'status', r.status, 'source', r.source, 'price', r.total_price,
        'menu', (select string_agg(i.name, '＋' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id))
        order by r.starts_at)
      from public.reservations r left join public.staff_members s on s.id = r.staff_id
      where r.starts_at >= (p_from::timestamp at time zone 'Asia/Tokyo') and r.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Tokyo')), '[]'::json),
    'closures', coalesce((select json_agg(json_build_object('date', c.d, 'reason', c.reason)) from (
      select x.date as d, x.reason from public.hq_list_schedule(p_hq, p_from, p_to) j, json_to_recordset(j -> 'closures') as x(date date, reason text)) c), '[]'::json),
    'notify', public.hq_get_notify(p_hq),
    'open_messages', (select count(*) from public.hq_messages where direction = 'to_shop' and status in ('open', 'seen')),
    'open_tasks', app_private.hq_tasks_json(false));
end $$;

revoke all on function app_private.hq_tasks_json(boolean) from public;
revoke all on function public.hq_tasks_list(text, boolean), public.hq_task_add(text, text, text, text, date, uuid),
  public.hq_task_close(text, uuid, text, text), public.owner_tasks_list(text) from public, anon, authenticated;
grant execute on function public.hq_tasks_list(text, boolean), public.hq_task_add(text, text, text, text, date, uuid),
  public.hq_task_close(text, uuid, text, text), public.owner_tasks_list(text) to anon, authenticated;
insert into supabase_migrations.schema_migrations(version, name) values ('20261018000100','hq_tasks') on conflict do nothing; commit;
