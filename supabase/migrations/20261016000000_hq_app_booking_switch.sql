-- 本部で「お客様アプリからの予約」を始める・止める。
-- 始めるときは、予約を受けるスタッフにいつものシフトがあり、予約に使えるメニューがあることを確かめる
-- （どちらも無いと、お客様には空き時間が1つも出ない）。止めるのはいつでもできる。
create or replace function public.hq_set_app_booking(p_hq text, p_enabled boolean)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  if p_enabled is null then return json_build_object('error', 'invalid_value'); end if;
  if p_enabled and not exists (
       select 1 from public.staff_members s
       join public.staff_shift_templates t on t.staff_id = s.id
       join public.staff_menu_capabilities c on c.staff_id = s.id
       join public.service_menus m on m.id = c.menu_id and m.is_active and m.booking_enabled and m.duration_min is not null
       where s.is_active and s.is_bookable) then
    return json_build_object('error', 'not_ready');
  end if;
  update public.booking_settings set app_booking_enabled = p_enabled, updated_at = now() where id = 1;
  return (select row_to_json(b) from public.booking_settings b where id = 1);
end;
$$;

revoke all on function public.hq_set_app_booking(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.hq_set_app_booking(text, boolean) to anon, authenticated;
