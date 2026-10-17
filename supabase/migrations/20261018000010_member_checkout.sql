-- ============================================================================
-- 店舗端末：会員QR → 来店チェックイン → そのままお会計（銀Pay・現金ほか）
-- ----------------------------------------------------------------------------
-- 前提：20261017050000_ginpay_member_lookup.sql・20261017000000_visit_log.sql 適用済み。置き換えのみ・何度実行しても同じ結果。
-- staff_client_for_member に、今日の来店（visit_log）につながる予約 reservation_id を足す。
-- 予約があれば予約から会計（メニュー・担当・料金を引き継ぎ、確定で予約は完了）、無ければ顧客を選んだ店頭会計。
-- キャンセル・無断キャンセルの予約は返さない。会計済みかどうかは会計画面（staff_checkout_context）が判断する。
-- ============================================================================

create or replace function public.staff_client_for_member(p_staff text, p_user_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_client uuid; v_reservation uuid;
begin
  perform app_private.assert_staff(p_staff);
  v_client := app_private.client_root(app_private.user_client(p_user_id));
  if v_client is null then return json_build_object('error', 'client_not_found'); end if;
  select v.reservation_id into v_reservation
  from public.visit_log v join public.reservations r on r.id = v.reservation_id
  where v.user_id = p_user_id and v.visit_date = app_private.today_jst()
    and r.status not in ('cancelled', 'no_show');
  return (
    select json_build_object('client_id', c.id, 'name', c.display_name,
                             'phone_last4', (app_private.client_last4(app_private.client_family(c.id)))[1],
                             'reservation_id', v_reservation)
    from public.clients c where c.id = v_client
  );
end;
$$;

revoke all on function public.staff_client_for_member(text, text) from public;
grant execute on function public.staff_client_for_member(text, text) to anon, authenticated;
