-- ============================================================================
-- お客様の連絡先（本名・電話番号）
--
-- 予約（アプリの予約アシスタント）とお店からの連絡に使う。本人確認（SMS・LINE）はまだ行わない。
-- そのため電話番号は「連絡先」としてだけ使い、会員データ（チケットなど）の引き継ぎや本人確認には使わない。
--   customers.contact_name   本名（男前証の名前 customers.name とは別。空なら name を使う）
--   customers.contact_phone  電話番号（数字だけ・0 始まり 10〜11 桁）
--
-- 呼び出しは顧客セッション必須（customer_*）。他人の連絡先は読めない・書けない。
-- 既存の表・関数は変えない（列の追加と新しい関数だけ）。
-- ============================================================================

alter table public.customers add column if not exists contact_name text;
alter table public.customers add column if not exists contact_phone text;
alter table public.customers add column if not exists contact_updated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_contact_phone_format' and conrelid = 'public.customers'::regclass) then
    alter table public.customers add constraint customers_contact_phone_format
      check (contact_phone is null or contact_phone ~ '^0[0-9]{9,10}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customers_contact_name_length' and conrelid = 'public.customers'::regclass) then
    alter table public.customers add constraint customers_contact_name_length
      check (contact_name is null or (length(btrim(contact_name)) between 1 and 40));
  end if;
end $$;

create index if not exists customers_contact_phone_idx on public.customers (contact_phone) where contact_phone is not null;

/** 電話番号を数字だけにする（全角・ハイフン・空白・+81 を吸収）。形式が違えば null */
create or replace function app_private.normalize_contact_phone(p text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case when d ~ '^0[0-9]{9,10}$' then d end
  from (select regexp_replace(regexp_replace(translate(coalesce(p, ''), '０１２３４５６７８９＋', '0123456789+'), '[^0-9+]', '', 'g'),
                              '^\+?81', '0') as d) x
$$;

/** 自分の連絡先 */
create or replace function public.customer_get_contact(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session); v_c public.customers;
begin
  select * into v_c from public.customers where user_id = v_uid;
  if v_c.id is null then return json_build_object('error', 'customer_not_found'); end if;
  return json_build_object('name', coalesce(v_c.contact_name, v_c.name), 'phone', v_c.contact_phone,
                           'registered', v_c.contact_phone is not null);
end;
$$;

/** 自分の連絡先を登録・変更する（本名と電話番号） */
create or replace function public.customer_set_contact(p_session text, p_name text, p_phone text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid text := app_private.session_user_id(p_session);
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := app_private.normalize_contact_phone(p_phone);
  v_c public.customers;
begin
  if v_name = '' or length(v_name) > 40 then return json_build_object('error', 'invalid_name'); end if;
  if v_phone is null then return json_build_object('error', 'invalid_phone'); end if;
  -- 1つの端末からの書き換えは 10 分に 10 回まで
  if (select count(*) from app_private.auth_attempts
      where kind = 'set_contact' and subject = v_uid and attempted_at > now() - interval '10 minutes') >= 10 then
    return json_build_object('error', 'rate_limited');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('set_contact', true, v_uid);
  update public.customers
  set contact_name = v_name, contact_phone = v_phone, contact_updated_at = now(), updated_at = now()
  where user_id = v_uid
  returning * into v_c;
  if v_c.id is null then return json_build_object('error', 'customer_not_found'); end if;
  return json_build_object('name', v_c.contact_name, 'phone', v_c.contact_phone, 'registered', true);
end;
$$;

revoke all on function app_private.normalize_contact_phone(text) from public, anon, authenticated;
revoke all on function public.customer_get_contact(text) from public;
revoke all on function public.customer_set_contact(text, text, text) from public;
grant execute on function public.customer_get_contact(text) to anon, authenticated;
grant execute on function public.customer_set_contact(text, text, text) to anon, authenticated;
