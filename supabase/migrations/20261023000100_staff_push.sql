-- SB（スタッフ端末）へのお知らせ：AI 予約（アプリからの予約）が入ったら、SB を入れたすべての端末に「予約が入りました」
--   ・受け取り先は SB の「通知を受け取る」で登録（スタッフのセッション必須）
--   ・送るのは johnny-notify（毎分のキャンセル待ちの見回りのついで）。送った予約はここに記録して二重に送らない
--   ・ホットペッパー・電話・店で入れた予約は送らない（店がもう知っている）

create table if not exists app_private.staff_push_subscriptions (
  endpoint   text primary key check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh     text not null check (length(p256dh) <= 200),
  auth       text not null check (length(auth) <= 100),
  label      text check (label is null or length(label) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists app_private.staff_push_sent (
  reservation_id uuid primary key references public.reservations(id) on delete cascade,
  sent_at        timestamptz not null default now()
);
alter table app_private.staff_push_subscriptions enable row level security;
alter table app_private.staff_push_sent enable row level security;
revoke all on app_private.staff_push_subscriptions, app_private.staff_push_sent from public, anon, authenticated;

-- 入れる前からある予約は送らない
insert into app_private.staff_push_sent (reservation_id)
select id from public.reservations where source = 'app' on conflict do nothing;

/** SB：この端末で受け取る */
create or replace function public.staff_save_push(p_staff text, p_endpoint text, p_p256dh text, p_auth text, p_label text default null)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  insert into app_private.staff_push_subscriptions (endpoint, p256dh, auth, label)
  values (p_endpoint, p_p256dh, p_auth, nullif(btrim(coalesce(p_label, '')), ''))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, label = coalesce(excluded.label, app_private.staff_push_subscriptions.label), updated_at = now();
  return json_build_object('ok', true);
end;
$$;

/** SB：この端末で受け取るのをやめる */
create or replace function public.staff_delete_push(p_staff text, p_endpoint text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_staff(p_staff);
  delete from app_private.staff_push_subscriptions where endpoint = p_endpoint;
  return json_build_object('ok', true);
end;
$$;

/** johnny-notify から：まだ知らせていない AI 予約（1日以内・取り消し以外）と受け取り先。返した予約は「送った」にする */
create or replace function public.staff_push_pending_for_sender(p_secret text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_list json; v_subs json;
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  with fresh as (
    insert into app_private.staff_push_sent (reservation_id)
    select r.id from public.reservations r
    where r.source = 'app' and r.created_at > now() - interval '1 day' and r.status not in ('cancelled', 'no_show')
      and not exists (select 1 from app_private.staff_push_sent s where s.reservation_id = r.id)
    on conflict do nothing
    returning reservation_id
  )
  select coalesce(json_agg(json_build_object(
      'id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name, 'staff_name', m.name,
      'menus', (select string_agg(i.name, '・' order by i.sort_order) from public.reservation_items i where i.reservation_id = r.id)
    ) order by r.starts_at), '[]'::json)
  into v_list
  from fresh f join public.reservations r on r.id = f.reservation_id join public.staff_members m on m.id = r.staff_id;
  select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json) into v_subs
  from app_private.staff_push_subscriptions s;
  return json_build_object('reservations', v_list, 'subs', v_subs);
end;
$$;

/** johnny-notify から：届かなくなった受け取り先（404・410）を消す */
create or replace function public.staff_push_gone_for_sender(p_secret text, p_gone text[])
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app_private.notify_secret where secret_hash = app_private.sha256_hex(p_secret)) then raise exception 'forbidden'; end if;
  delete from app_private.staff_push_subscriptions where endpoint = any(coalesce(p_gone, '{}'));
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.staff_save_push(text, text, text, text, text), public.staff_delete_push(text, text),
  public.staff_push_pending_for_sender(text), public.staff_push_gone_for_sender(text, text[]) from public;
grant execute on function public.staff_save_push(text, text, text, text, text), public.staff_delete_push(text, text) to anon, authenticated, service_role;
grant execute on function public.staff_push_pending_for_sender(text), public.staff_push_gone_for_sender(text, text[]) to anon, authenticated, service_role;
