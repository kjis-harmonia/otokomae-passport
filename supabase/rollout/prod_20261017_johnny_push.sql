-- 本番に当てる：JOHNNY の先回りのお知らせ（20261017000300_johnny_push.sql）。表と関数を足すだけ（お知らせは本部でオンにするまで送らない）
begin;
-- JOHNNY の先回りのお知らせ（プッシュ通知）
--   お客様：アプリで「お知らせを受け取る」を押すと、そのスマホの受け取り先（push subscription）を登録する
--   毎日11時（日本時間）：メンテナンスカットの期限が近いお客様に、JOHNNY からお知らせ（johnny-notify が送る）
--   決まり：お店が本部でオンにしたときだけ送る（最初はオフ）・1日に送る人数の上限（既定 5 人）・1人に週1回まで・
--           これからの予約がある人には送らない・届かなくなった受け取り先は止める

create table if not exists public.push_subscriptions (
  endpoint      text primary key check (length(endpoint) <= 1000),
  user_id       text not null,
  p256dh        text not null check (length(p256dh) <= 200),
  auth          text not null check (length(auth) <= 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  failed_count  int not null default 0,
  disabled_at   timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id) where disabled_at is null;
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;

create table if not exists public.notification_log (
  id        bigserial primary key,
  user_id   text not null,
  kind      text not null,
  title     text,
  body      text,
  sent_at   timestamptz not null default now(),
  delivered int not null default 0
);
create index if not exists notification_log_user_idx on public.notification_log (user_id, sent_at desc);
alter table public.notification_log enable row level security;
revoke all on table public.notification_log from public, anon, authenticated;

create table if not exists app_private.notify_settings (
  id         int primary key default 1 check (id = 1),
  enabled    boolean not null default false,
  daily_cap  int not null default 5 check (daily_cap between 0 and 100),
  updated_at timestamptz not null default now()
);
insert into app_private.notify_settings (id) values (1) on conflict do nothing;

/** お客様：このスマホでお知らせを受け取る（同じ受け取り先は付け替え） */
create or replace function public.customer_save_push(p_session text, p_endpoint text, p_p256dh text, p_auth text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or p_p256dh is null or p_auth is null then return json_build_object('error', 'invalid_subscription'); end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, v_uid, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    updated_at = now(), failed_count = 0, disabled_at = null;
  return json_build_object('ok', true);
end;
$$;

/** お客様：お知らせを止める（このスマホ） */
create or replace function public.customer_delete_push(p_session text, p_endpoint text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  update public.push_subscriptions set disabled_at = now(), updated_at = now() where endpoint = p_endpoint and user_id = v_uid;
  return json_build_object('ok', true);
end;
$$;

/** 本部：お知らせの設定を見る・変える */
create or replace function public.hq_get_notify(p_hq text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return (select json_build_object(
    'enabled', s.enabled, 'daily_cap', s.daily_cap,
    'subscribers', (select count(distinct user_id) from public.push_subscriptions where disabled_at is null),
    'sent_7d', (select count(*) from public.notification_log where sent_at > now() - interval '7 days' and delivered > 0))
  from app_private.notify_settings s where s.id = 1);
end;
$$;

create or replace function public.hq_set_notify(p_hq text, p_enabled boolean, p_daily_cap int)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  if p_enabled is null or p_daily_cap is null or p_daily_cap < 0 or p_daily_cap > 100 then return json_build_object('error', 'invalid_value'); end if;
  update app_private.notify_settings set enabled = p_enabled, daily_cap = p_daily_cap, updated_at = now() where id = 1;
  return public.hq_get_notify(p_hq);
end;
$$;

/**
 * 今日お知らせを送る人（johnny-notify だけが使う）。
 *   メンテナンスカットの残りが 1〜3 日・これからの予約が無い・この7日に送っていない・受け取り先がある。
 *   残りの少ない人から、今日の上限まで。最近のメニュー（いつもの）も添える
 */
create or replace function app_private.notify_due()
returns json language sql stable
set search_path = public, pg_temp
as $$
  with s as (select * from app_private.notify_settings where id = 1),
  sent_today as (select count(distinct user_id) n from public.notification_log where sent_at >= (app_private.today_jst()::timestamp at time zone 'Asia/Tokyo')),
  cand as (
    select v.user_id, app_private.maintenance_days_remaining(v.user_id) as days_left
    from public.maintenance_visits v
    where exists (select 1 from public.push_subscriptions p where p.user_id = v.user_id and p.disabled_at is null)
      and not exists (select 1 from public.notification_log l where l.user_id = v.user_id and l.sent_at > now() - interval '7 days')
      and not exists (select 1 from public.reservations r where r.user_id = v.user_id and r.starts_at > now() and r.status = 'confirmed')
  )
  select coalesce(json_agg(json_build_object(
      'user_id', c.user_id, 'kind', 'maintenance', 'days_left', c.days_left,
      'usual', (select v.menu_name from public.visit_log v where v.user_id = c.user_id and v.menu_code is not null and v.menu_code <> 'maintenance'
                group by v.menu_name order by count(*) desc, max(v.visit_date) desc limit 1),
      'subs', (select json_agg(json_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
               from public.push_subscriptions p where p.user_id = c.user_id and p.disabled_at is null))
    order by c.days_left), '[]'::json)
  from (
    select * from cand where days_left between 1 and 3
    order by days_left
    limit greatest(0, (select daily_cap from s) - (select n from sent_today))
  ) c
  where (select enabled from s)
$$;

/** 送った結果を残す（届いた数。届かなくなった受け取り先は止める） */
create or replace function app_private.notify_record(p_user_id text, p_kind text, p_title text, p_body text, p_delivered int, p_gone text[])
returns void language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.notification_log (user_id, kind, title, body, delivered) values (p_user_id, p_kind, p_title, p_body, coalesce(p_delivered, 0));
  if p_gone is not null and cardinality(p_gone) > 0 then
    update public.push_subscriptions set disabled_at = now(), failed_count = failed_count + 1, updated_at = now() where endpoint = any(p_gone);
  end if;
end;
$$;

/** johnny-notify（サーバー）から呼ぶ入口。合言葉（app_private.notify_secret）で確かめる */
create table if not exists app_private.notify_secret (id int primary key default 1 check (id = 1), secret_hash text not null);

create or replace function public.notify_due_for_sender(p_secret text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  return app_private.notify_due();
end;
$$;

create or replace function public.notify_record_for_sender(p_secret text, p_user_id text, p_kind text, p_title text, p_body text, p_delivered int, p_gone text[])
returns void language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  perform app_private.notify_record(p_user_id, p_kind, p_title, p_body, p_delivered, p_gone);
end;
$$;

revoke all on function public.customer_save_push(text, text, text, text) from public, anon, authenticated;
revoke all on function public.customer_delete_push(text, text) from public, anon, authenticated;
revoke all on function public.hq_get_notify(text) from public, anon, authenticated;
revoke all on function public.hq_set_notify(text, boolean, int) from public, anon, authenticated;
revoke all on function public.notify_due_for_sender(text) from public, anon, authenticated;
revoke all on function public.notify_record_for_sender(text, text, text, text, text, int, text[]) from public, anon, authenticated;
revoke all on function app_private.notify_due() from public, anon, authenticated;
revoke all on function app_private.notify_record(text, text, text, text, int, text[]) from public, anon, authenticated;
grant execute on function public.customer_save_push(text, text, text, text) to anon, authenticated;
grant execute on function public.customer_delete_push(text, text) to anon, authenticated;
grant execute on function public.hq_get_notify(text) to anon, authenticated;
grant execute on function public.hq_set_notify(text, boolean, int) to anon, authenticated;
grant execute on function public.notify_due_for_sender(text) to anon, authenticated;
grant execute on function public.notify_record_for_sender(text, text, text, text, text, int, text[]) to anon, authenticated;

/** 試し送り用：その人の受け取り先（johnny-notify の test だけが使う。決まりは通さない） */
create or replace function public.notify_subs_for_sender(p_secret text, p_user_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  return coalesce((select json_agg(json_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
                   from public.push_subscriptions where user_id = p_user_id and disabled_at is null), '[]'::json);
end;
$$;
revoke all on function public.notify_subs_for_sender(text, text) from public, anon, authenticated;
grant execute on function public.notify_subs_for_sender(text, text) to anon, authenticated;
insert into supabase_migrations.schema_migrations(version, name) values ('20261017000300', 'johnny_push') on conflict (version) do nothing;
commit;
select 'johnny_push applied' as result, (select enabled from app_private.notify_settings where id = 1) as notify_enabled;
