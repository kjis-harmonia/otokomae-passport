-- 8本目（20261108220801_booking_person_overlap）の重なり防止だけを外すとき（予約のデータは変えない）
alter table public.reservations drop constraint if exists reservations_treatment_person_no_overlap;
