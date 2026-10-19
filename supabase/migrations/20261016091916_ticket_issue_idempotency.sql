-- Staging first. Each request is committed together with its tickets and receipt.
create table app_private.ticket_issue_requests (
  request_id uuid primary key,
  payload jsonb not null,
  response jsonb,
  created_at timestamptz not null default now()
);
alter table app_private.ticket_issue_requests enable row level security;
revoke all on app_private.ticket_issue_requests from public, anon, authenticated;

create function public.staff_issue_tickets_once(
  p_staff text, p_request_id uuid, p_user_id text, p_type text,
  p_amount integer, p_quantity integer, p_staff_name text, p_customer_name text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_payload jsonb;
  v_saved app_private.ticket_issue_requests%rowtype;
  v_response jsonb;
begin
  perform app_private.assert_staff(p_staff);
  if p_request_id is null then raise exception 'request_id_required'; end if;
  v_payload := jsonb_build_object(
    'user_id', p_user_id, 'type', p_type, 'amount', p_amount, 'quantity', p_quantity,
    'staff_name', p_staff_name, 'customer_name', p_customer_name
  );
  -- The primary key serializes concurrent retries, including different HTTP connections.
  insert into app_private.ticket_issue_requests(request_id, payload)
    values(p_request_id, v_payload) on conflict(request_id) do nothing;
  select * into strict v_saved from app_private.ticket_issue_requests
    where request_id = p_request_id for update;
  if v_saved.payload is distinct from v_payload then raise exception 'request_payload_mismatch'; end if;
  if v_saved.response is not null then return v_saved.response; end if;
  v_response := public.staff_issue_tickets(
    p_staff, p_user_id, p_type, p_amount, p_quantity, p_staff_name, p_customer_name
  )::jsonb;
  if jsonb_typeof(v_response->'tickets') is distinct from 'array'
     or jsonb_array_length(v_response->'tickets') is distinct from p_quantity then
    raise exception 'invalid_issue_receipt';
  end if;
  update app_private.ticket_issue_requests set response = v_response where request_id = p_request_id;
  return v_response;
end;
$$;
revoke all on function public.staff_issue_tickets_once(text, uuid, text, text, integer, integer, text, text) from public;
grant execute on function public.staff_issue_tickets_once(text, uuid, text, text, integer, integer, text, text) to anon, authenticated;
comment on function public.staff_issue_tickets_once(text, uuid, text, text, integer, integer, text, text)
  is 'Staff token required. Retry the same UUID and immutable payload to retrieve the committed receipt.';
