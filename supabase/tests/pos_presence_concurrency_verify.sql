-- POS 提示トークンの同時読み取りの検証
do $$
declare v_run uuid; v_a text; v_b text; v_ha text; v_hb text; v_n int; v_scanned int; v_used int; v_retry int;
begin
  select run_id into v_run from public.__pos_presence_latest where id = 1;
  if v_run is null then raise exception 'run_id missing'; end if;
  select token_a, token_b into v_a, v_b from public.__pos_presence_cases where run_id = v_run limit 1;
  v_ha := app_private.sha256_hex(v_a); v_hb := app_private.sha256_hex(v_b);

  -- A：別々の端末 10 台 → scan session 1 つ、scanned 1、already_used 9
  select count(*) into v_n from app_private.pos_scan_sessions where token_hash = v_ha;
  select count(*) filter (where event_type = 'scanned'), count(*) filter (where event_type = 'rejected' and reason = 'already_used')
    into v_scanned, v_used from public.pos_scan_events where token_hash = v_ha;
  if v_n <> 1 or v_scanned <> 1 or v_used <> 9 then
    raise exception 'presence A: scan_sessions=% scanned=% already_used=% (expected 1/1/9)', v_n, v_scanned, v_used;
  end if;

  -- B：同じ端末から 10 件 → scan session 1 つ、scanned 1、retry 9（すべて同じ scan session）
  select count(*) into v_n from app_private.pos_scan_sessions where token_hash = v_hb;
  select count(*) filter (where event_type = 'scanned'), count(*) filter (where event_type = 'retry')
    into v_scanned, v_retry from public.pos_scan_events where token_hash = v_hb;
  if v_n <> 1 or v_scanned <> 1 or v_retry <> 9
     or (select count(distinct scan_session_id) from public.pos_scan_events where token_hash = v_hb and event_type in ('scanned', 'retry')) <> 1 then
    raise exception 'presence B: scan_sessions=% scanned=% retry=% (expected 1/1/9, one session)', v_n, v_scanned, v_retry;
  end if;
  raise notice 'presence token concurrency ok: A 1 scanned / 9 already_used, B 1 scanned / 9 retry (same session)';
end $$;
