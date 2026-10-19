-- Legacy tabs must reload; all new issuance uses staff_issue_tickets_once with a durable UUID.
-- The SECURITY DEFINER wrapper still calls this implementation as its owner.
revoke execute on function public.staff_issue_tickets(text,text,text,integer,integer,text,text)
  from public, anon, authenticated;
comment on function public.staff_issue_tickets(text,text,text,integer,integer,text,text)
  is 'Internal issuance implementation. Clients must use staff_issue_tickets_once with p_request_id.';
