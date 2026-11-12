-- 20261112_ginoku_fix2.sql を戻す（Staging だけ）。出品の関数は 20261112_ginoku_free_and_hold.sql を流し直すと元に戻る
CREATE OR REPLACE FUNCTION app_private.checkout_context_json(p_reservation_id uuid, p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r public.reservations; v_client uuid; v_paid uuid;
begin
  if p_reservation_id is not null then
    select * into r from public.reservations where id = p_reservation_id;
    if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
    v_client := app_private.client_root(r.client_id);
    select id into v_paid from public.accounting_sessions where reservation_id = r.id and status = 'completed';
  elsif p_client_id is not null then
    v_client := app_private.client_root(p_client_id);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
  end if;
  return jsonb_build_object(
    'reservation', case when r.id is null then null else app_private.reservation_json(r.id) end,
    'paid_sale_id', v_paid,
    'client', case when v_client is null then null else (select jsonb_build_object('id', c.id, 'name', c.display_name,
                'app_linked', cardinality(app_private.client_members(app_private.client_family(c.id))) > 0)
              from public.clients c where c.id = v_client) end,
    'gacha', app_private.gacha_for_reservation(r.id),
    'tickets', case when v_client is null then '[]'::jsonb else app_private.client_tickets_json(v_client) end,
    'ginpay_accounts', case when v_client is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'client_name', c.display_name, 'balance', a.balance_cached,
                 'is_current_client', a.client_id = v_client) order by (a.client_id = v_client) desc, a.created_at), '[]'::jsonb)
       from public.ginpay_accounts a join public.clients c on c.id = a.client_id
       where a.id = any(app_private.ginpay_family_accounts(v_client))) end,
    -- 有効な口座がなく停止中の口座だけがある（会計画面で「口座がありません」と誤って案内しない）
    'ginpay_suspended', v_client is not null and exists (select 1 from public.ginpay_accounts a
      where a.client_id = any(app_private.client_family(app_private.client_root(v_client))) and a.status = 'suspended'),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name) order by m.sort_order), '[]'::jsonb)
              from public.staff_members m where m.is_active and (m.is_bookable or m.id = r.staff_id)),
    'tax', (select jsonb_build_object('mode', tax_mode, 'rate', tax_rate) from public.accounting_settings where id = 1)
  );
end;
$function$;
notify pgrst, 'reload schema';
