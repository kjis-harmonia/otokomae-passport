-- 再来店パーマクーポンの期限を「最後の日の 23:59:59」に（10/29 慶一郎さん：カードに翌日の日付が出ていた）
--   これまでは最後の日の翌日 0:00 を入れていたので、使える期間は同じまま、表示だけ正しくなる。配ってある券もそろえる

create or replace function app_private.perm_return_issue(p_user_id text, p_visit_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_last date := p_visit_date + 60;
begin
  if p_user_id is null or p_visit_date is null then return null; end if;
  if exists (select 1 from app_private.perm_return_grants where user_id = p_user_id) then return null; end if;
  insert into public.tickets (user_id, type, title, amount, memo, issued_by, expires_at)
  values (p_user_id, 'discount', '再来店パーマクーポン', 500,
          '対象: パーマ全種類（パーマのセットを含む） / 平日のみ（土日利用不可） / ' || extract(month from v_last) || '月' || extract(day from v_last) || '日まで',
          'system-perm-return', ((v_last + 1)::timestamp at time zone 'Asia/Tokyo') - interval '1 second')
  returning id into v_id;
  insert into app_private.perm_return_grants (user_id, visit_date, ticket_id) values (p_user_id, p_visit_date, v_id);
  return v_id;
end;
$$;

update public.tickets set expires_at = expires_at - interval '1 second'
where issued_by = 'system-perm-return' and (expires_at at time zone 'Asia/Tokyo')::time = time '00:00';
