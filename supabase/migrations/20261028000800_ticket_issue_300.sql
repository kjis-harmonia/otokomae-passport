-- 券の一括発行：一度に300枚まで（これまで30枚）。漢トク券をたくさん持っているお客様がいるため（10/28 慶一郎さん）
--   関数は本番の定義のまま、枚数の上限だけを変える（staff_issue_tickets_once はこの関数を呼ぶ）

CREATE OR REPLACE FUNCTION public.staff_issue_tickets(p_staff text, p_user_id text, p_type text, p_amount integer, p_quantity integer, p_staff_name text, p_customer_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_title text; v_rows json;
begin
  perform app_private.assert_staff(p_staff);
  if p_type not in ('otoku', 'discount') then raise exception 'invalid_ticket_type'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then raise exception 'invalid_amount'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 300 then raise exception 'invalid_quantity'; end if;  -- 10/28 慶一郎さん：一度に300枚まで（これまで30枚）
  if p_staff_name is null or btrim(p_staff_name) = '' then raise exception 'staff_name_required'; end if;
  if not exists (select 1 from public.customers where user_id = p_user_id) then raise exception 'customer_not_found'; end if;
  v_title := case p_type when 'otoku' then '漢トク券' else '割引券' end;

  with ins as (
    insert into public.tickets (user_id, type, title, amount, issued_by, used)
    select p_user_id, p_type, v_title, p_amount, p_staff_name, false
    from generate_series(1, p_quantity)
    returning *
  )
  select json_agg(row_to_json(ins)) into v_rows from ins;

  insert into public.ticket_issue_logs (staff_name, customer_name, user_id, ticket_type, amount, quantity, terminal, status)
  values (p_staff_name, coalesce(p_customer_name, ''), p_user_id, p_type, p_amount, p_quantity, 'staff-terminal', 'issued');

  return json_build_object('tickets', v_rows);
end;
$function$;
