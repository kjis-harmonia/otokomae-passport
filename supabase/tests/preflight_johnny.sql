-- Staging preflight: JOHNNY Phase 1 (20261008000000_johnny_phase1.sql).
-- Regression for the independent review: no false visit-flow facts, STYLE is not a source of price / duration /
-- unconfirmed mappings, HQ snapshot counts each sale once, action intents follow approval / expiry / re-validation,
-- idempotency mismatches fail, audit tables are closed to clients.
-- Wrapped in a transaction and rolled back (no data is left behind).

begin;

do $$
declare
  v_count integer;
  v_detail text;
  v_hq text := 'preflight-johnny-hq-token-0123456789abcdef';
  v_snap jsonb;
  v_snap2 jsonb;
  v_staff uuid;
  v_client uuid;
  v_sale uuid;
  v_cat jsonb;
  v_r json;
  v_intent uuid;
  v_sess uuid;
begin
  -- RLS / grants
  select count(*) into v_count from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    and c.relname in ('johnny_style_catalog', 'johnny_style_service_links', 'johnny_sessions', 'johnny_messages', 'johnny_tool_calls', 'johnny_action_intents');
  if v_count <> 6 then raise exception 'johnny_rls_missing: %', v_count; end if;
  select string_agg(distinct table_name || ':' || grantee || ':' || privilege_type, ', ') into v_detail
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name like 'johnny\_%' and grantee in ('anon', 'authenticated');
  if v_detail is not null then raise exception 'johnny_direct_table_grants: %', v_detail; end if;
  if has_function_privilege('anon', 'public.johnny_record_session(text, text, uuid, uuid, timestamptz, text, text, uuid, jsonb)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.johnny_transition_action_intent(uuid, text, text, text, jsonb, text)'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role', 'public.johnny_create_action_intent(uuid, text, text, jsonb, text, timestamptz, uuid, uuid, timestamptz, text)'::regprocedure, 'EXECUTE') then
    raise exception 'johnny_audit_write_grants_wrong';
  end if;
  begin
    perform public.customer_johnny_profile('bad-session');
    raise exception 'customer_johnny_profile_accepted_bad_session';
  exception when invalid_authorization_specification then null;
  end;
  begin
    perform public.hq_johnny_snapshot('bad-session', null, null);
    raise exception 'hq_johnny_snapshot_accepted_bad_session';
  exception when invalid_authorization_specification then null;
  end;

  -- No false visit-flow facts
  if to_regprocedure('public.hq_johnny_visit_flow_contract(text)') is not null then raise exception 'false_visit_flow_contract_present'; end if;
  select string_agg(p.proname, ', ') into v_detail from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%johnny%'
    and (pg_get_functiondef(p.oid) ~* 'room_id|treatment_completed|maintenance_start|starts_maintenance|visit_flow');
  if v_detail is not null then raise exception 'johnny_functions_state_unimplemented_flow: %', v_detail; end if;

  -- STYLE: no price / duration / unconfirmed mappings
  select string_agg(column_name, ', ') into v_detail from information_schema.columns
  where table_schema = 'public' and table_name = 'johnny_style_catalog' and column_name in ('price', 'duration_minutes', 'service_menu_codes');
  if v_detail is not null then raise exception 'style_catalog_has_price_or_mapping_columns: %', v_detail; end if;
  select string_agg(style_slug || '→' || menu_code, ',' order by style_slug) into v_detail from public.johnny_style_service_links;
  if v_detail is distinct from 'bachibachi-punch→perm-punch,curl-iper→perm-curl-iper,ginpara→perm-ginpara-curly,nurepan→perm-nurepan,spain-perm→perm-spain,teitei-gari→store-teitei-gari' then
    raise exception 'style_service_links_not_the_confirmed_set: %', v_detail;
  end if;
  insert into app_private.customer_sessions (token_hash, user_id, created_via)
  values (app_private.sha256_hex('preflight-johnny-customer-0123456789abcdef'), 'preflight-johnny-user', 'register');
  v_cat := public.customer_johnny_style_catalog('preflight-johnny-customer-0123456789abcdef')::jsonb;
  if exists (select 1 from jsonb_array_elements(v_cat) s where s ? 'price' or s ? 'duration_minutes' or s ? 'service_menu_codes') then
    raise exception 'style_catalog_returns_price_or_mapping';
  end if;
  if exists (select 1 from jsonb_array_elements(v_cat) s
             where s->>'slug' in ('truck-yaro', 'sea-man', 'choiwaru-showa', 'kakusei-color', 'salaryman-girigiri-perm', 'shinsai-punch', 'rejent-punch', 'yanki-punch', 'jamaican-afro', 'natsu-nigro', 'shinsaigari', 'showa-iper')
               and s->'booking_menu' <> 'null'::jsonb) then
    raise exception 'unconfirmed_style_has_booking_menu';
  end if;
  if (select s->'booking_menu'->>'code' from jsonb_array_elements(v_cat) s where s->>'slug' = 'ginpara') is distinct from 'perm-ginpara-curly' then
    raise exception 'confirmed_style_mapping_missing (ginpara)';
  end if;

  -- HQ snapshot: a ¥1,000 sale stays ¥1,000 with several reservations for the same stylist
  insert into app_private.hq_sessions (token_hash, expires_at) values (app_private.sha256_hex(v_hq), now() + interval '1 hour');
  select id into v_staff from public.staff_members where display_name = '銀二郎';
  v_client := app_private.create_client('Preflight Johnny Fanout', 'staff', 'staff', 'Preflight');
  insert into public.accounting_sessions (client_id, customer_name, staff_name, stylist_name, stylist_id, status, subtotal, total, created_at)
  values (v_client, 'Preflight Johnny Fanout', 'Preflight', '銀二郎', v_staff, 'pending', 1000, 1000, timestamptz '2000-01-03 12:00+09')
  returning id into v_sale;
  update public.accounting_sessions set status = 'completed' where id = v_sale;
  insert into public.reservations (staff_id, nominated, client_id, customer_name, starts_at, ends_at, occupied_until, status, source)
  values (v_staff, true, v_client, 'Preflight Johnny Fanout', timestamptz '2000-01-03 10:00+09', timestamptz '2000-01-03 10:30+09', timestamptz '2000-01-03 10:30+09', 'completed', 'staff'),
         (v_staff, true, v_client, 'Preflight Johnny Fanout', timestamptz '2000-01-03 14:00+09', timestamptz '2000-01-03 14:30+09', timestamptz '2000-01-03 14:30+09', 'completed', 'staff'),
         (v_staff, true, v_client, 'Preflight Johnny Fanout', timestamptz '2000-01-03 16:00+09', timestamptz '2000-01-03 16:30+09', timestamptz '2000-01-03 16:30+09', 'cancelled', 'staff');
  v_snap := public.hq_johnny_snapshot(v_hq, date '2000-01-01', date '2000-01-10')::jsonb;
  if (select (x->>'gross_sales')::int from jsonb_array_elements(v_snap->'staff') x where x->>'staff_name' = '銀二郎') <> 1000
     or (select (x->>'completed_sales')::int from jsonb_array_elements(v_snap->'staff') x where x->>'staff_name' = '銀二郎') <> 1
     or (select (x->>'completed_reservations')::int from jsonb_array_elements(v_snap->'staff') x where x->>'staff_name' = '銀二郎') <> 2
     or (v_snap->'sales'->>'gross_sales')::int <> 1000 then
    raise exception 'hq_snapshot_fanout: %', v_snap->'staff';
  end if;
  if v_snap ? 'deterministic_visit_flow' or v_snap->'ginpay' ? 'accounts' then raise exception 'hq_snapshot_returns_flow_or_account_details'; end if;
  v_snap2 := public.hq_johnny_snapshot(v_hq, date '2000-01-01', date '2000-01-10')::jsonb;
  if v_snap->>'source_fact_version' not like 'sha256:%' or v_snap->>'source_fact_version' <> v_snap2->>'source_fact_version' then
    raise exception 'hq_snapshot_fact_version_not_reproducible';
  end if;

  -- Action intents
  v_sess := public.johnny_record_session('booking', 'customer', gen_random_uuid(), null, now(), 'sha256:test', 'preflight-johnny-user', null, '{}');
  v_r := public.johnny_create_action_intent(v_sess, 'booking', 'reservation_create', '{"menu":"perm-ginpara-curly"}', 'preflight-intent-1', now() - interval '1 minute', gen_random_uuid(), null, now(), 'sha256:a');
  if v_r->>'error' <> 'invalid_expiry' then raise exception 'expired_intent_created: %', v_r; end if;
  v_r := public.johnny_create_action_intent(v_sess, 'booking', 'reservation_create', '{"menu":"perm-ginpara-curly"}', 'preflight-intent-1', now() + interval '1 hour', gen_random_uuid(), null, now(), 'sha256:a');
  v_intent := (v_r->>'id')::uuid;
  if v_intent is null then raise exception 'intent_not_created: %', v_r; end if;
  v_r := public.johnny_create_action_intent(v_sess, 'booking', 'reservation_create', '{"menu":"perm-ginpara-curly"}', 'preflight-intent-1', now() + interval '1 hour', gen_random_uuid(), null, now(), 'sha256:a');
  if (v_r->>'idempotent')::boolean is not true or (v_r->>'id')::uuid <> v_intent then raise exception 'idempotent_resend_failed: %', v_r; end if;
  v_r := public.johnny_create_action_intent(v_sess, 'hq', 'price_change', '{"menu":"perm-punch"}', 'preflight-intent-1', now() + interval '1 hour', gen_random_uuid(), null, now(), 'sha256:a');
  if v_r->>'error' <> 'idempotency_conflict' then raise exception 'idempotency_mismatch_accepted: %', v_r; end if;
  v_r := public.johnny_transition_action_intent(v_intent, 'execute', null, 'sha256:a', '{}', null);
  if v_r->>'error' <> 'not_approved' or (select status from public.johnny_action_intents where id = v_intent) <> 'proposed' then
    raise exception 'unapproved_intent_executed: %', v_r;
  end if;
  begin
    update public.johnny_action_intents set status = 'executed', executed_at = now() where id = v_intent;
    raise exception 'direct_unapproved_execute_allowed';
  exception when check_violation then null;
  end;
  v_r := public.johnny_transition_action_intent(v_intent, 'approve', 'HQ 本部', 'sha256:a', null, null);
  if v_r->>'status' <> 'approved' then raise exception 'approve_failed: %', v_r; end if;
  v_r := public.johnny_transition_action_intent(v_intent, 'execute', null, 'sha256:b', '{}', null);
  if v_r->>'error' <> 'facts_changed_reapproval_required'
     or (select status from public.johnny_action_intents where id = v_intent) <> 'proposed' then
    raise exception 'changed_facts_executed: %', v_r;
  end if;
  perform public.johnny_transition_action_intent(v_intent, 'approve', 'HQ 本部', 'sha256:b', null, null);
  v_r := public.johnny_transition_action_intent(v_intent, 'execute', null, 'sha256:b', '{"ok":true}', null);
  if v_r->>'status' <> 'executed' then raise exception 'approved_same_facts_not_executed: %', v_r; end if;
  v_r := public.johnny_create_action_intent(v_sess, 'booking', 'reservation_create', '{"menu":"perm-nurepan"}', 'preflight-intent-2', now() + interval '1 hour', gen_random_uuid(), null, now(), 'sha256:a');
  update public.johnny_action_intents set expires_at = now() - interval '1 second' where id = (v_r->>'id')::uuid;
  v_r := public.johnny_transition_action_intent((v_r->>'id')::uuid, 'approve', 'HQ 本部', 'sha256:a', null, null);
  if v_r->>'error' <> 'expired' then raise exception 'expired_intent_approved: %', v_r; end if;

  -- request_id cannot be reused across modes / actors
  select request_id into v_detail from public.johnny_sessions where id = v_sess;
  begin
    perform public.johnny_record_session('hq', 'hq', v_detail::uuid, null, now(), 'sha256:test', null, null, '{}');
    raise exception 'request_id_reused_across_modes';
  exception when unique_violation then null;
  end;
end $$;

rollback;
