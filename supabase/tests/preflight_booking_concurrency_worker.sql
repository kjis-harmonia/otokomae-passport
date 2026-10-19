-- pgbench worker: all clients try to create the same reservation slot.

select public.staff_create_reservation(
  c.staff_token,
  jsonb_build_object(
    'starts_at', c.starts_at,
    'menu_codes', jsonb_build_array(c.menu_code),
    'staff_id', c.staff_id,
    'customer_name', 'Preflight Concurrent Booking ' || c.worker_no::text,
    'customer_phone', '080-0000-00' || lpad(c.worker_no::text, 2, '0'),
    'source', 'phone',
    'note', 'preflight concurrency'
  ),
  'Preflight'
)
from public.__preflight_booking_concurrency_cases c
join public.__preflight_booking_concurrency_latest l on l.run_id = c.run_id
where c.worker_no = :client_id;
