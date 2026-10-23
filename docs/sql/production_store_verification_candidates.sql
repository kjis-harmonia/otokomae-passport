-- READ ONLY: production ufyzynpmkxytnhebombq.
-- Preview again immediately before the one-off backfill. No names, phones, or tokens.
begin read only;

with evidence as (
  select user_id, 'checkin_visit_log'::text as source
  from public.visit_log
  where visit_date is not null
    and visit_date <= (now() at time zone 'Asia/Tokyo')::date
  union all
  select user_id, 'checkin_legacy'
  from public.maintenance_visits
  where last_visit_date is not null
    and last_visit_date <= (now() at time zone 'Asia/Tokyo')::date
  union all
  select user_id, 'completed_checkout'
  from public.accounting_sessions
  where status = 'completed' and created_at <= now()
  union all
  select user_id, 'ticket_usage_log'
  from public.ticket_usage_logs
  where status = 'used' and used_at is not null and used_at <= now()
    and usage_date <= (now() at time zone 'Asia/Tokyo')::date
  union all
  select user_id, 'used_ticket'
  from public.tickets
  where used is true and used_at is not null and used_at <= now()
), candidates as (
  select c.id as customer_id, c.user_id,
    bool_or(e.source in ('checkin_visit_log', 'checkin_legacy')) as checkin,
    bool_or(e.source = 'checkin_visit_log') as protected_visit_log,
    bool_or(e.source = 'completed_checkout') as checkout,
    bool_or(e.source in ('ticket_usage_log', 'used_ticket')) as ticket_usage
  from public.customers c
  join evidence e on e.user_id = c.user_id
  where nullif(btrim(c.user_id), '') is not null
  group by c.id, c.user_id
)
select
  statement_timestamp() as observed_at,
  'ufyzynpmkxytnhebombq'::text as intended_project_ref,
  (select count(*) from public.customers) as all_customers,
  count(*) as candidate_customers,
  (select count(*) from public.customers) - count(*) as excluded_customers,
  count(*) filter (where checkin) as with_checkin,
  count(*) filter (where checkout) as with_completed_checkout,
  count(*) filter (where ticket_usage) as with_ticket_usage,
  count(*) filter (where protected_visit_log) as with_protected_visit_log,
  md5(coalesce(string_agg(customer_id::text || ':' || user_id, E'\n'
    order by customer_id, user_id), '')) as candidate_fingerprint
from candidates;

commit;
