-- 同時に10件送っても、入ったのはちょうど3件（枠 0・1・2 に1件ずつ）。片付けて終わる
do $$
declare v_n int; v_lanes int[];
begin
  select count(*), array_agg(booking_lane order by booking_lane) into v_n, v_lanes
  from public.reservations where customer_name like 'SB同時客%' and status = 'confirmed';
  if v_n is distinct from 3 or v_lanes is distinct from array[0, 1, 2]::int[] then
    raise exception 'sb concurrency: expected 3 bookings in lanes 0,1,2, got % in %', v_n, v_lanes;
  end if;
  delete from public.reservation_events where reservation_id in (select id from public.reservations where customer_name like 'SB同時客%');
  delete from public.reservation_items where reservation_id in (select id from public.reservations where customer_name like 'SB同時客%');
  delete from public.reservations where customer_name like 'SB同時客%';
  raise notice 'sb concurrency ok (3 of 10 accepted)';
end $$;
drop schema sb_conc cascade;
