-- 本部 JOHNNY と 慶一郎さんの JOHNNY（デスクトップ）をつなぐ「伝言の箱」。
--   to_owner：本部（テイテイ）→ 慶一郎さん。本部 JOHNNY が「伝えといて」をまとめて入れる
--   to_shop ：慶一郎さん → 本部。「確認して」（kind=request）は、本部で OK / NG / 返事が付くまで待つ
-- 本部からは hq_*（本部セッション）、慶一郎さんの JOHNNY からは owner_*（合言葉 app_private.bridge_secret）で読み書きする。

create table if not exists public.hq_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('to_owner', 'to_shop')),
  kind text not null default 'note' check (kind in ('note', 'request')),
  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 4000),
  urgent boolean not null default false,
  status text not null default 'open' check (status in ('open', 'seen', 'approved', 'rejected', 'answered')),
  reply text check (reply is null or length(reply) <= 2000),
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  answered_at timestamptz
);
create index if not exists hq_messages_created_idx on public.hq_messages (created_at desc);
alter table public.hq_messages enable row level security;
revoke all on public.hq_messages from anon, authenticated;

create table if not exists app_private.bridge_secret (id int primary key default 1 check (id = 1), secret_hash text not null);

create or replace function app_private.hq_message_json(m public.hq_messages)
returns json language sql stable as $$
  select json_build_object('id', m.id, 'direction', m.direction, 'kind', m.kind, 'title', m.title, 'body', m.body,
    'urgent', m.urgent, 'status', m.status, 'reply', m.reply, 'created_at', m.created_at, 'seen_at', m.seen_at, 'answered_at', m.answered_at)
$$;

/** 新しく入れる（両方向で共通） */
create or replace function app_private.hq_message_put(p_direction text, p_kind text, p_title text, p_body text, p_urgent boolean)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.hq_messages;
begin
  if coalesce(btrim(p_title), '') = '' or coalesce(btrim(p_body), '') = '' then return json_build_object('error', 'invalid_value'); end if;
  insert into public.hq_messages (direction, kind, title, body, urgent)
  values (p_direction, coalesce(nullif(p_kind, ''), 'note'), left(btrim(p_title), 120), left(btrim(p_body), 4000), coalesce(p_urgent, false))
  returning * into m;
  return app_private.hq_message_json(m);
end $$;

/** 受け取った側が 見た / OK / NG / 返事 を付ける（自分あての伝言だけ） */
create or replace function app_private.hq_message_mark(p_direction text, p_id uuid, p_status text, p_reply text)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.hq_messages;
begin
  if p_status not in ('seen', 'approved', 'rejected', 'answered') then return json_build_object('error', 'invalid_value'); end if;
  update public.hq_messages
     set status = case when p_status = 'seen' and status <> 'open' then status else p_status end,
         seen_at = coalesce(seen_at, now()),
         reply = case when p_status = 'seen' then reply else coalesce(nullif(left(btrim(coalesce(p_reply, '')), 2000), ''), reply) end,
         answered_at = case when p_status = 'seen' then answered_at else now() end
   where id = p_id and direction = p_direction
  returning * into m;
  if m.id is null then return json_build_object('error', 'not_found'); end if;
  return app_private.hq_message_json(m);
end $$;

-- ── 本部（テイテイ）から ────────────────────────────────────────────────

create or replace function public.hq_messages_list(p_hq text, p_limit int default 50)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return coalesce((select json_agg(app_private.hq_message_json(m) order by m.created_at desc)
    from (select * from public.hq_messages order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) m), '[]'::json);
end $$;

create or replace function public.hq_message_send(p_hq text, p_title text, p_body text, p_urgent boolean default false, p_kind text default 'note')
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.hq_message_put('to_owner', p_kind, p_title, p_body, p_urgent);
end $$;

create or replace function public.hq_message_answer(p_hq text, p_id uuid, p_status text, p_reply text default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.hq_message_mark('to_shop', p_id, p_status, p_reply);
end $$;

/** 本部 JOHNNY が答えるためのお店の様子（期間の予約：日時・メニュー・担当・状態。お客様の名前と電話は出さない） */
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
    'open_messages', (select count(*) from public.hq_messages where direction = 'to_shop' and status in ('open', 'seen')));
end $$;

-- ── 慶一郎さんの JOHNNY から（合言葉） ─────────────────────────────────────

create or replace function app_private.assert_bridge(p_secret text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from app_private.bridge_secret where secret_hash = app_private.sha256_hex(coalesce(p_secret, ''))) then raise exception 'forbidden'; end if;
end $$;

create or replace function public.owner_messages_list(p_secret text, p_since timestamptz default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_bridge(p_secret);
  return coalesce((select json_agg(app_private.hq_message_json(m) order by m.created_at desc) from (
    select * from public.hq_messages
     where p_since is null or created_at > p_since or answered_at > p_since or seen_at > p_since
     order by created_at desc limit 100) m), '[]'::json);
end $$;

create or replace function public.owner_message_send(p_secret text, p_title text, p_body text, p_urgent boolean default false, p_kind text default 'note')
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_bridge(p_secret);
  return app_private.hq_message_put('to_shop', p_kind, p_title, p_body, p_urgent);
end $$;

create or replace function public.owner_message_answer(p_secret text, p_id uuid, p_status text, p_reply text default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform app_private.assert_bridge(p_secret);
  return app_private.hq_message_mark('to_owner', p_id, p_status, p_reply);
end $$;

revoke all on function app_private.hq_message_put(text, text, text, text, boolean) from public;
revoke all on function app_private.hq_message_mark(text, uuid, text, text) from public;
revoke all on function app_private.assert_bridge(text) from public;
revoke all on function public.hq_messages_list(text, int), public.hq_message_send(text, text, text, boolean, text),
  public.hq_message_answer(text, uuid, text, text), public.hq_johnny_overview(text, date, date),
  public.owner_messages_list(text, timestamptz), public.owner_message_send(text, text, text, boolean, text),
  public.owner_message_answer(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.hq_messages_list(text, int), public.hq_message_send(text, text, text, boolean, text),
  public.hq_message_answer(text, uuid, text, text), public.hq_johnny_overview(text, date, date),
  public.owner_messages_list(text, timestamptz), public.owner_message_send(text, text, text, boolean, text),
  public.owner_message_answer(text, uuid, text, text) to anon, authenticated;
