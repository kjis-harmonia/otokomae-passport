-- Verify latest concurrent checkout run.

do $$
declare
  v_reservation uuid;
  v_count integer;
begin
  select reservation_id into v_reservation from public.__preflight_checkout_concurrency_latest where id = 1;
  select count(*) into v_count
  from public.accounting_sessions
  where reservation_id = v_reservation and status = 'completed';
  if v_count <> 1 then raise exception 'expected exactly one completed checkout, got %', v_count; end if;
end $$;
