-- アプリ会員のフリガナ（11/21 慶一郎さん：SB で漢字の名前が読めないとスタッフさんから）。
--   会員登録と、銀ちゃんでの予約のあと（まだ無い方に一度だけ）に入れてもらい、SB に出す。
--   SB に出す順：顧客台帳（スタッフが入れたもの）→ 会員が入れたもの → HOT PEPPER のメール

alter table public.customers add column if not exists contact_kana text;

-- 自分の連絡先：フリガナも返す
CREATE OR REPLACE FUNCTION public.customer_get_contact(p_session text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_uid text := app_private.session_user_id(p_session); v_c public.customers;
begin
  select * into v_c from public.customers where user_id = v_uid;
  if v_c.id is null then return json_build_object('error', 'customer_not_found'); end if;
  return json_build_object('name', coalesce(v_c.contact_name, v_c.name), 'phone', v_c.contact_phone,
                           'registered', v_c.contact_phone is not null, 'kana', v_c.contact_kana);
end;
$function$;

-- フリガナを入れる（全角カタカナ・空白・ー・・ だけ。ひらがなはアプリでカタカナにして送る）
create or replace function public.customer_set_kana(p_session text, p_kana text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_uid text := app_private.session_user_id(p_session);
  v_kana text := btrim(regexp_replace(coalesce(p_kana, ''), '[[:space:]　]+', ' ', 'g'));
  v_c public.customers;
begin
  if v_kana = '' or length(v_kana) > 40 or v_kana !~ '^[ァ-ヶー・ ]+$' then return json_build_object('error', 'invalid_kana'); end if;
  -- 1つの端末からの書き換えは 10 分に 10 回まで
  if (select count(*) from app_private.auth_attempts
      where kind = 'set_kana' and subject = v_uid and attempted_at > now() - interval '10 minutes') >= 10 then
    return json_build_object('error', 'rate_limited');
  end if;
  insert into app_private.auth_attempts (kind, success, subject) values ('set_kana', true, v_uid);
  update public.customers set contact_kana = v_kana, updated_at = now() where user_id = v_uid returning * into v_c;
  if v_c.id is null then return json_build_object('error', 'customer_not_found'); end if;
  return json_build_object('kana', v_c.contact_kana);
end;
$function$;
revoke all on function public.customer_set_kana(text, text) from public;
grant execute on function public.customer_set_kana(text, text) to anon, authenticated;

-- SB に出すフリガナ：会員が入れたものも使う
create or replace function app_private.reservation_kana(p_id uuid)
 returns text
 language sql
 stable
 set search_path to ''
as $function$
  select coalesce(
    (select nullif(btrim(c.kana), '') from public.clients c where c.id = app_private.client_root(r.client_id)),
    (select nullif(btrim(m.contact_kana), '') from public.customers m where r.user_id is not null and m.user_id = r.user_id),
    case when r.source = 'hotpepper' then app_private.hotpepper_kana(r.note) end)
  from public.reservations r where r.id = p_id
$function$;
revoke all on function app_private.reservation_kana(uuid) from public, anon, authenticated;
