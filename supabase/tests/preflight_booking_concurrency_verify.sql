-- Verify latest concurrent booking run.

do $$
declare
  v_start timestamptz;
  v_count integer;
begin
  select starts_at into v_start from public.__preflight_booking_concurrency_latest where id = 1;
  select count(*) into v_count
  from public.reservations
  where starts_at = v_start
    and customer_name like 'Preflight Concurrent Booking %'
    and status = 'confirmed';
  if v_count <> 1 then raise exception 'expected exactly one concurrent booking, got %', v_count; end if;
end $$;
