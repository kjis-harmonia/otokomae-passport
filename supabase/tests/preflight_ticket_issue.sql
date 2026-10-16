-- Run only on Staging/a disposable DB. Synthetic accounts and tickets are rolled back.
begin;
do $test$
declare
  v_reg jsonb; v_session text; v_user text;
  v_token text := 'qa-flow-'||gen_random_uuid()::text;
  v_request uuid := gen_random_uuid();
  v_issue jsonb; v_retry jsonb; v_use jsonb; v_tickets jsonb; v_contact jsonb;
  v_ids uuid[]; v_rejected boolean := false;
begin
  v_reg := public.customer_register('QA connected flow rollback',true)::jsonb;
  v_session := v_reg->>'session'; v_user := v_reg->>'user_id';
  if v_session is null or v_user is null then raise exception 'qa_registration_failed'; end if;
  perform public.customer_set_contact(v_session,'QA connected flow rollback','09000000000');
  v_contact := public.customer_get_contact(v_session)::jsonb;
  if v_contact->>'phone' is distinct from '09000000000' then raise exception 'qa_contact_failed'; end if;
  insert into app_private.staff_sessions(token_hash,expires_at)
    values(app_private.sha256_hex(v_token),now()+interval '5 minutes');
  perform public.staff_check_in(v_token,v_user);
  if public.customer_get_last_visit(v_session) is null then raise exception 'qa_visit_not_visible'; end if;
  v_issue := public.staff_issue_tickets_once(v_token,v_request,v_user,'discount',1000,2,'QA rollback','QA connected flow rollback');
  v_retry := public.staff_issue_tickets_once(v_token,v_request,v_user,'discount',1000,2,'QA rollback','QA connected flow rollback');
  if v_retry is distinct from v_issue then raise exception 'qa_receipt_mismatch'; end if;
  if (select count(*) from public.ticket_issue_logs where user_id=v_user) <> 1 then raise exception 'qa_duplicate_log'; end if;
  select array_agg((value->>'id')::uuid) into v_ids from jsonb_array_elements(v_issue->'tickets');
  v_tickets := public.customer_get_tickets(v_session)::jsonb;
  if (select count(*) from jsonb_array_elements(v_tickets) t where t->>'id'=any(v_ids::text[]) and (t->>'used')::boolean=false) <> 2 then
    raise exception 'qa_issued_tickets_not_visible';
  end if;
  begin
    perform public.staff_issue_tickets_once(v_token,v_request,v_user,'discount',500,2,'QA rollback','QA connected flow rollback');
  exception when others then
    if sqlerrm <> 'request_payload_mismatch' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'qa_payload_mismatch_accepted'; end if;
  v_rejected := false;
  begin
    perform public.staff_issue_tickets_once('invalid-qa-token',v_request,v_user,'discount',1000,2,'QA rollback','QA connected flow rollback');
  exception when sqlstate '28000' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'qa_auth_bypass'; end if;
  v_use := public.staff_use_tickets(v_token,v_user,v_ids,'QA rollback','QA connected flow rollback')::jsonb;
  if v_use ? 'error' then raise exception 'qa_redemption_failed: %',v_use->>'error'; end if;
  v_tickets := public.customer_get_tickets(v_session)::jsonb;
  if (select count(*) from jsonb_array_elements(v_tickets) t where t->>'id'=any(v_ids::text[]) and (t->>'used')::boolean=true) <> 2 then
    raise exception 'qa_used_tickets_not_visible';
  end if;
  if has_function_privilege('anon','public.staff_issue_tickets(text,text,text,integer,integer,text,text)','execute') or
     has_function_privilege('authenticated','public.staff_issue_tickets(text,text,text,integer,integer,text,text)','execute') then
    raise exception 'qa_unsafe_legacy_issuance_executable';
  end if;
  if has_table_privilege('anon','app_private.ticket_issue_requests','select') or
     has_table_privilege('authenticated','app_private.ticket_issue_requests','select') then
    raise exception 'qa_private_receipts_readable';
  end if;
  perform set_config('qa.flow_result','registration -> contact -> check-in -> issue/retry -> customer wallet -> redeem -> customer wallet used: PASS; auth and grants: PASS',true);
end;
$test$;
select current_setting('qa.flow_result') as connected_flow_test;
rollback;
