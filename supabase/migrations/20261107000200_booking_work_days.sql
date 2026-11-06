-- カレンダー用：日ごとに出勤している担当（11/6 慶一郎さん「テイテイ、銀二郎の複雑な定休日もしっかり反映しといてね」）
--   ・予約と同じ勤務の決まり（app_private.effective_shifts：日付の休み・日付の出勤・通常週・営業時間・店休日）で、その日に働く担当を返す
--   ・お客様のカレンダーは、誰も出勤しない日を選べなくする。いつもの担当がいれば、その担当の休みの日も印を付ける
--   ・返すのは日付と担当の id だけ（勤務時間は出さない）。最大 70日分
create or replace function public.booking_work_days(p_from date, p_to date)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('date', d.d, 'staff',
           (select coalesce(json_agg(s.id order by s.sort_order), '[]'::json) from public.staff_members s
            where s.is_active and s.is_bookable and exists (select 1 from app_private.effective_shifts(s.id, d.d)))) order by d.d), '[]'::json)
  from (select generate_series(p_from, least(p_to, p_from + 70), interval '1 day')::date d) d
  where p_from is not null and p_to is not null and p_to >= p_from
$$;
revoke all on function public.booking_work_days(date, date) from public;
grant execute on function public.booking_work_days(date, date) to anon, authenticated, service_role;
