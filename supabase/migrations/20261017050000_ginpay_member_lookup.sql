-- ============================================================================
-- 銀Payチャージ画面：お客様の会員QR（アプリの user_id）から顧客を引く
-- ----------------------------------------------------------------------------
-- 前提：20261003000000_customer_ledger.sql（app_private.user_client）適用済み。追加のみ・何度実行しても同じ結果。
-- 店舗端末のスタッフだけが使える。返すのは顧客ID・名前・電話の下4桁だけ。
-- ============================================================================

create or replace function public.staff_client_for_member(p_staff text, p_user_id text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_client uuid;
begin
  perform app_private.assert_staff(p_staff);
  v_client := app_private.client_root(app_private.user_client(p_user_id));
  if v_client is null then return json_build_object('error', 'client_not_found'); end if;
  return (
    select json_build_object('client_id', c.id, 'name', c.display_name,
                             'phone_last4', (app_private.client_last4(app_private.client_family(c.id)))[1])
    from public.clients c where c.id = v_client
  );
end;
$$;

revoke all on function public.staff_client_for_member(text, text) from public;
grant execute on function public.staff_client_for_member(text, text) to anon, authenticated;
