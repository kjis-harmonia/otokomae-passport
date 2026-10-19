-- Verify latest concurrent booking run.

do $$
declare
  v_start timestamptz;
  v_count integer;
  v_cap integer;
begin
  select starts_at into v_start from public.__preflight_booking_concurrency_latest where id = 1;
  select count(*) into v_count
  from public.reservations
  where starts_at = v_start
    and customer_name like 'Preflight Concurrent Booking %'
    and status = 'confirmed';
  -- 同じ時刻に入れられるのは、担当の同時受付数（booking_capacity、銀二郎は 3）まで。それより多く入ったら二重予約
  select booking_capacity into v_cap from public.staff_members where display_name = '銀二郎';
  if v_count <> coalesce(v_cap, 1) then raise exception 'expected exactly % concurrent bookings (booking_capacity), got %', coalesce(v_cap, 1), v_count; end if;
end $$;
