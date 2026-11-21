-- SB にお客様のフリガナを出す（11/21 慶一郎さん：漢字の名前が読めないとスタッフさんから）。
--   フリガナは顧客台帳（clients.kana）のもの。台帳に無い HOT PEPPER の予約は、メールから取った備考の1行目
--   「HOT PEPPER予約（タナカ タロウ）」を使う。これからの HOT PEPPER の予約は、台帳が空ならフリガナを台帳にも入れる。
--   読みを機械で当てることはしない（名前の読みは当てずっぽうになる）。分からない人は出さない

-- 予約のお客様のフリガナ（分からなければ null）
create or replace function app_private.hotpepper_kana(p_note text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select nullif(btrim(substring(split_part(coalesce(p_note, ''), chr(10), 1) from '^HOT PEPPER予約（(.*)）$')), '')
$function$;

create or replace function app_private.reservation_kana(p_id uuid)
 returns text
 language sql
 stable
 set search_path to ''
as $function$
  select coalesce(
    (select nullif(btrim(c.kana), '') from public.clients c where c.id = app_private.client_root(r.client_id)),
    case when r.source = 'hotpepper' then app_private.hotpepper_kana(r.note) end)
  from public.reservations r where r.id = p_id
$function$;
revoke all on function app_private.hotpepper_kana(text) from public, anon, authenticated;
revoke all on function app_private.reservation_kana(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.sb_reservation(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
  select app_private.reservation_json(r.id) || jsonb_build_object(
    'booking_lane',r.booking_lane,'transfer_status',r.transfer_status,'updated_at',r.updated_at,
    'customer_kana', app_private.reservation_kana(r.id),
    'ginpay_paid', exists (select 1 from app_private.ginpay_holds h
                           where h.reservation_id = r.id and app_private.ginpay_hold_active(h))
                   or coalesce((select sum(t.amount) from public.ginpay_transactions t
                                where t.status = 'posted'
                                  and t.id in (select p.id from public.ginpay_transactions p
                                               join public.accounting_sessions a on a.id = p.accounting_session_id
                                               where a.reservation_id = r.id and p.type = 'payment' and p.status = 'posted'
                                               union
                                               select v.id from public.ginpay_transactions v
                                               join public.ginpay_transactions p on p.id = v.original_transaction_id
                                               join public.accounting_sessions a on a.id = p.accounting_session_id
                                               where a.reservation_id = r.id and p.type = 'payment' and v.type in ('refund', 'void'))), 0) < 0)
  from public.reservations r where r.id = p_id
$function$;

-- これからの HOT PEPPER の予約：台帳のフリガナが空なら入れる（スタッフが台帳で入れたものは上書きしない）
create or replace function app_private.hotpepper_kana_to_client()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare v_kana text := app_private.hotpepper_kana(new.note);
begin
  if new.source = 'hotpepper' and new.client_id is not null and v_kana is not null and length(v_kana) <= 60 then
    update public.clients set kana = v_kana, updated_at = now()
    where id = app_private.client_root(new.client_id) and (kana is null or btrim(kana) = '');
  end if;
  return new;
end;
$function$;
revoke all on function app_private.hotpepper_kana_to_client() from public, anon, authenticated;
drop trigger if exists hotpepper_kana_to_client on public.reservations;
create trigger hotpepper_kana_to_client after insert on public.reservations
  for each row execute function app_private.hotpepper_kana_to_client();

-- これまでの HOT PEPPER の予約から、台帳の空のフリガナを埋める（いちばん新しい予約のもの）
update public.clients c set kana = x.kana, updated_at = now()
from (select distinct on (app_private.client_root(r.client_id)) app_private.client_root(r.client_id) root, app_private.hotpepper_kana(r.note) kana
      from public.reservations r
      where r.source = 'hotpepper' and r.client_id is not null and app_private.hotpepper_kana(r.note) is not null
      order by app_private.client_root(r.client_id), r.created_at desc) x
where c.id = x.root and (c.kana is null or btrim(c.kana) = '') and length(x.kana) <= 60;
