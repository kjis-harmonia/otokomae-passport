-- SB：電話予約など、サロンボードに入れた時間を「クローズ」して、AI 予約が入らないようにする（10/24 慶一郎さん決定）。
--   ・正本はホットペッパーのサロンボード。SB は AI 予約のために時間を押さえるだけの道具
--   ・入れ物は time_blocks（kind=unavailable、created_by='SB:操作者'）。予約の空き計算・SB の段はすでにこれを避ける
--   ・担当は1人ずつ（両方なら2行）。すでに入っている予約は消さない（件数だけ返して画面で知らせる）
--   ・外せるのは SB で閉めた時間だけ（本部の休憩などは本部で）

/** SB：この時間を閉める。p_staff_ids＝閉める担当（1〜2人）。15分刻み・14時間以内・終わりが今より後 */
create or replace function public.staff_close_time(p_staff text, p_staff_ids uuid[], p_starts_at timestamptz, p_ends_at timestamptz,
  p_actor text, p_note text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_actor text := left(coalesce(nullif(btrim(coalesce(p_actor, '')), ''), 'SB'), 40); v_out uuid[]; v_overlap int;
begin
  perform app_private.assert_staff(p_staff);
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '14 hours'
     or extract(epoch from p_starts_at)::bigint % 900 <> 0 or extract(epoch from p_ends_at)::bigint % 900 <> 0 then
    return json_build_object('error', 'invalid_range');
  end if;
  if p_ends_at <= now() then return json_build_object('error', 'past'); end if;
  select array_agg(distinct s.id) into v_ids from public.staff_members s where s.id = any(coalesce(p_staff_ids, '{}')) and s.is_active and s.is_bookable;
  if v_ids is null or cardinality(v_ids) <> cardinality(array(select distinct unnest(p_staff_ids))) then return json_build_object('error', 'invalid_staff'); end if;
  perform app_private.lock_staff(v_ids);
  with ins as (
    insert into public.time_blocks (staff_id, starts_at, ends_at, kind, note, created_by)
    select unnest(v_ids), p_starts_at, p_ends_at, 'unavailable', left(nullif(btrim(coalesce(p_note, '')), ''), 120), 'SB:' || v_actor
    returning id
  ) select array_agg(id) into v_out from ins;
  select count(*) into v_overlap from public.reservations r
  where r.staff_id = any(v_ids) and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment')
    and tstzrange(r.starts_at, r.occupied_until) && tstzrange(p_starts_at, p_ends_at);
  return json_build_object('ok', true, 'ids', to_json(v_out), 'overlap', v_overlap);
end;
$$;

/** SB：閉めた時間を外す（SB で閉めたものだけ） */
create or replace function public.staff_reopen_time(p_staff text, p_block_id uuid, p_actor text)
returns json language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform app_private.assert_staff(p_staff);
  delete from public.time_blocks where id = p_block_id and kind = 'unavailable' and created_by like 'SB:%';
  get diagnostics n = row_count;
  if n = 0 then return json_build_object('error', 'not_found'); end if;
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.staff_close_time(text, uuid[], timestamptz, timestamptz, text, text), public.staff_reopen_time(text, uuid, text) from public;
grant execute on function public.staff_close_time(text, uuid[], timestamptz, timestamptz, text, text), public.staff_reopen_time(text, uuid, text) to anon, authenticated, service_role;
