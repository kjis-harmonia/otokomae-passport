-- app_private の JSON 整形の小さな関数は、PUBLIC の実行権限を外す（本番は app_private の既定権限が無いため、作ると PUBLIC に付く）。
-- anon / authenticated は app_private を使えない（USAGE が無い）ので中身は読めないが、preflight の基準どおり閉じる。動きは変えない。
do $$
declare f text;
begin
  foreach f in array array['app_private.hq_message_json(public.hq_messages)', 'app_private.hq_task_json(public.hq_tasks)',
                           'app_private.waitlist_json(public.booking_waitlist)', 'app_private.price_change_json(public.menu_price_changes)'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;
