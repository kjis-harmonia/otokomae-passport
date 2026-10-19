-- Staging / 使い捨てDBのみ。全データを最後にrollbackし、実会員・実口座を使用しない。
begin;
do $test$
declare
  v_uid text := 'preflight-checkout-' || gen_random_uuid()::text;
  v_staff text := 'preflight-staff-' || gen_random_uuid()::text;
  v_hq text := 'preflight-hq-' || gen_random_uuid()::text;
  v_key text := 'preflight-checkout:' || gen_random_uuid()::text;
  v_member uuid; v_client uuid; v_stylist uuid; v_ticket uuid;
  v_sale json; v_again json; v_lookup json; v_payload jsonb; v_denied boolean := false;
  v_balance integer;
begin
  insert into app_private.staff_sessions(token_hash,expires_at)
  values(app_private.sha256_hex(v_staff),now()+interval '1 hour');
  insert into app_private.hq_sessions(token_hash,expires_at)
  values(app_private.sha256_hex(v_hq),now()+interval '1 hour');
  select id into v_stylist from public.staff_members where is_active order by sort_order limit 1;
  if v_stylist is null then raise exception 'fixture requires one active staff member'; end if;
  insert into public.customers(user_id,name,recovery_code,normalized_name)
  values(v_uid,'訂正済み検証会員',v_uid,'訂正済み検証会員') returning id into v_member;
  v_client := app_private.member_client(v_member);
  insert into public.tickets(user_id,type,title,amount,issued_by)
  values(v_uid,'discount','検証1000円券',1000,'Preflight') returning id into v_ticket;
  perform public.staff_ginpay_open_account(v_staff,v_client,'Preflight');
  perform public.staff_ginpay_charge_store(v_staff,v_client,10000,'cash','Preflight',null,v_key||':charge',null);

  v_lookup := public.staff_checkout_result(v_staff,v_key);
  if v_lookup is not null then raise exception 'lookup must not create an accounting session'; end if;
  begin
    perform public.staff_checkout_result('invalid',v_key);
  exception when others then
    if sqlerrm like '%staff_auth_required%' then v_denied := true; else raise; end if;
  end;
  if not v_denied then raise exception 'unauthenticated lookup was accepted'; end if;

  v_payload := jsonb_build_object('client_id',v_client,'stylist_id',v_stylist,
    'items',jsonb_build_array(jsonb_build_object('source','manual','name','検証カット','category','menu','unit_price',5000,'quantity',1,'discount',0)),
    'ticket_ids',jsonb_build_array(v_ticket),'payment_method','ginpay','expected_total',4000,'idempotency_key',v_key);
  v_sale := public.staff_finalize_sale(v_staff,v_payload,'Preflight');
  if v_sale->>'error' is not null or (v_sale->>'total')::int <> 4000 then raise exception 'sale failed: %',v_sale; end if;
  v_lookup := public.staff_checkout_result(v_staff,v_key);
  v_again := public.staff_finalize_sale(v_staff,v_payload,'Preflight');
  if v_sale->>'id' is distinct from v_lookup->>'id' or v_sale->>'id' is distinct from v_again->>'id' then
    raise exception 'retry did not resolve the original sale';
  end if;
  if (select count(*) from public.accounting_sessions where idempotency_key=v_key) <> 1 then raise exception 'duplicate sale'; end if;
  select balance_cached into v_balance from public.ginpay_accounts where client_id=v_client;
  if v_balance <> 6000 then raise exception 'GINPay was charged more than once: %',v_balance; end if;
  if not exists(select 1 from public.tickets where id=v_ticket and used) then raise exception 'ticket was not consumed with the sale'; end if;

  perform public.staff_register_customer(v_staff,v_uid,'古いQRの氏名');
  if (select name from public.customers where id=v_member) <> '訂正済み検証会員' then raise exception 'QR overwrote the server member name'; end if;

  perform public.hq_void_sale(v_hq,(v_sale->>'id')::uuid,'Preflight rollback verification');
  v_lookup := public.staff_checkout_result(v_staff,v_key);
  if v_lookup->>'status' <> 'voided' then raise exception 'voided sale was not returned'; end if;
  select balance_cached into v_balance from public.ginpay_accounts where client_id=v_client;
  if v_balance <> 10000 then raise exception 'void did not restore fixture balance'; end if;
  if exists(select 1 from public.tickets where id=v_ticket and used) then raise exception 'void did not restore fixture ticket'; end if;
  raise notice 'checkout safety ok';
  raise notice 'QR member name ok';
end;
$test$;
rollback;
