-- お連れ様の予約を DB でご本人の予約につなぐ（11/4・Sランク C1）
--   これまでお客様アプリは、お連れ様の予約を「その端末に覚えた id」だけで見分けていた。
--   別の端末（機種変更・家族のスマホ・ホーム画面アプリと Safari）では見分けられず、AI 予約の「ご予約は1つ」の入れ替えで
--   お連れ様の予約をご本人の予約と思ってキャンセルするおそれがあった。
--   ・reservations.companion_of：お連れ様の予約 → ご本人の予約
--   ・customer_link_companion：AI 予約でお二人を取ったときにアプリがつなぐ（同じ会員・同じ日・確定・お連れ様は1名）
--   ・お客様の予約一覧に companion_of と companion_name（予約メモ「お連れ様：〇〇様」の名前）を出す
--   ・今までのお連れ様の予約（メモが「お連れ様：」）も、同じ会員・同じ日のご本人の予約につなぐ
--   ガチャ工程③（20261104000200_gacha_companion）と同じ列・同じ関数。どちらが先に流れても同じ結果になる

alter table public.reservations add column if not exists companion_of uuid references public.reservations(id) on delete set null;
create index if not exists reservations_companion_of on public.reservations (companion_of) where companion_of is not null;

create or replace function public.customer_link_companion(p_session text, p_primary uuid, p_companion uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user text := app_private.session_user_id(p_session); a public.reservations; b public.reservations;
begin
  if v_user is null then return json_build_object('error', 'not_signed_in'); end if;
  select * into a from public.reservations where id = p_primary and user_id = v_user and status = 'confirmed' for update;
  select * into b from public.reservations where id = p_companion and user_id = v_user and status = 'confirmed' for update;
  if a.id is null or b.id is null or a.id = b.id or a.companion_of is not null then return json_build_object('error', 'not_found'); end if;
  if (a.starts_at at time zone 'Asia/Tokyo')::date <> (b.starts_at at time zone 'Asia/Tokyo')::date then return json_build_object('error', 'not_same_day'); end if;
  if exists (select 1 from public.reservations x where x.companion_of = a.id and x.id <> b.id and x.status = 'confirmed') then
    return json_build_object('error', 'companion_exists');
  end if;
  update public.reservations set companion_of = a.id where id = b.id;
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.customer_link_companion(text, uuid, uuid) from public;
grant execute on function public.customer_link_companion(text, uuid, uuid) to anon, authenticated, service_role;

-- お客様向けの予約：これまでの中身に companion_of・companion_name を足す（メモそのものは出さない）
create or replace function app_private.reservation_json_customer(p_id uuid)
returns jsonb language sql stable set search_path = public, extensions, pg_temp as $$
  select (app_private.reservation_json(p_id) - 'customer_phone' - 'note' - 'created_by' - 'customer_id' - 'client_id' - 'external_ref' - 'occupied_until')
    || (select jsonb_build_object('companion_of', r.companion_of,
          'companion_name', case when r.companion_of is not null or r.note like 'お連れ様：%'
                                 then nullif(btrim(substring(split_part(r.note, E'\n', 1) from '^お連れ様：(.*?)様?$')), '') end)
        from public.reservations r where r.id = p_id)
$$;

-- 今までのお連れ様の予約をつなぐ：同じ会員・同じ日で、お連れ様ではない予約のうち、先に作られた一番近い時間のもの
update public.reservations b set companion_of = x.primary_id
from (
  select distinct on (c.id) c.id as companion_id, p.id as primary_id
  from public.reservations c
  join public.reservations p on p.user_id = c.user_id and p.id <> c.id
   and (p.starts_at at time zone 'Asia/Tokyo')::date = (c.starts_at at time zone 'Asia/Tokyo')::date
   and coalesce(p.note, '') not like 'お連れ様：%' and p.created_at <= c.created_at + interval '1 minute'
  where c.user_id is not null and c.note like 'お連れ様：%' and c.companion_of is null
  order by c.id, abs(extract(epoch from p.starts_at - c.starts_at)), p.created_at desc
) x
where b.id = x.companion_id;
