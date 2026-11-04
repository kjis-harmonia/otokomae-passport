-- お店で一度も読み取られていない会員QR（アプリの会員番号がまだ本番に無い）でも、本人確認まで進めるようにする（11/4）
--   11/4 朝、シゲタ様のQRを読むと「会員情報を確認できませんでした」で止まった。アプリの番号は6月からのものだが、まだ会員登録されていなかった。
--   スタッフ画面は会員がいなければ先に登録する（ふつうの会員QRと同じ）。その時点の確認依頼はまだ会員とつながっていないので、
--   承認のときに、依頼の番号と同じ会員を探してつなぐ。照合（依頼の番号＝会員の番号＝スタッフ画面の番号）はこれまでどおり。
create or replace function public.staff_approve_store_access(p_staff text,p_request_id uuid,p_user_id text,p_staff_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r app_private.customer_store_requests; c public.customers;
begin
  perform app_private.assert_staff(p_staff);
  if nullif(btrim(p_staff_name),'') is null or length(p_staff_name)>100 then raise exception 'staff_name_required'; end if;
  select * into r from app_private.customer_store_requests where id=p_request_id and expires_at>now() for update;
  if r.id is not null and r.customer_id is null then
    -- 依頼を出したあとで会員登録された場合：依頼の番号の会員につなぐ
    select * into c from public.customers where user_id=r.original_user_id for update;
    if c.id is not null then
      update app_private.customer_store_requests set customer_id=c.id where id=r.id;
      r.customer_id:=c.id;
    end if;
  else
    select * into c from public.customers where id=r.customer_id for update;
  end if;
  if r.id is null or c.id is null or c.user_id is distinct from r.original_user_id or c.user_id is distinct from p_user_id then raise exception 'store_request_invalid'; end if;
  if r.state in ('approved','claimed') then return '{"ok":true}'; end if;
  insert into app_private.customer_store_verifications(customer_id,verified_by,staff_session_hash)
    values(c.id,btrim(p_staff_name),app_private.sha256_hex(p_staff)) on conflict(customer_id) do nothing;
  update app_private.customer_store_requests set state='approved',approved_by=btrim(p_staff_name),staff_session_hash=app_private.sha256_hex(p_staff) where id=r.id;
  return '{"ok":true}';
end;
$$;
revoke all on function public.staff_approve_store_access(text,uuid,text,text) from public;
grant execute on function public.staff_approve_store_access(text,uuid,text,text) to anon,authenticated,service_role;
