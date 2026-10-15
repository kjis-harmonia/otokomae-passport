-- Staging 用：SB で予約できるメニューを有効にする（所要時間はお店と相談して決めた仮の値。2026-10-15）
-- 予約表を実際に動かしながら詰めるための設定。本番の所要時間は SALON BOARD の設定と合わせてから決める。
--   ・下の一覧のメニューを「予約で使える」にし、所要時間を入れる（片付け時間は 0 分）
--   ・担当はテイテイ・銀二郎の2人（ほかのスタッフは変えない）
--   ・回数券（カットこ券）と「カット（小学生未満）」は予約に出さない（一覧に入れていない）
-- 安全装置：SB の migration（20261015000000）が入っていない DB（＝今の本番）では何もせずに止まる。
-- 何度実行しても同じ結果。見つからないメニューは止めずに一覧で知らせる。
do $$
declare
  v_missing text[] := '{}';
  v_updated int := 0;
  v_staff uuid[];
  r record;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'SB の migration（20261015000000）が無い DB です。Staging 以外では実行しないでください';
  end if;
  execute 'select exists (select 1 from supabase_migrations.schema_migrations where version = ''20261015000000'')' into r;
  if not coalesce((to_jsonb(r) ->> 'exists')::boolean, false) then
    raise exception 'SB の migration（20261015000000）が無い DB です。Staging 以外では実行しないでください';
  end if;

  select array_agg(id) into v_staff from public.staff_members where display_name in ('テイテイ', '銀二郎') and is_active;
  if cardinality(v_staff) is distinct from 2 then raise exception 'テイテイ・銀二郎が見つかりません'; end if;

  for r in select * from (values
    -- カット
    ('cut-regular', 45), ('cut-skin-fade', 60), ('cut-skin-fade-plus', 75), ('cut-buzz', 30),
    ('cut-elementary', 30), ('cut-kids-skin-fade', 45), ('cut-bangs', 15),
    -- カラー
    ('color-gray', 60), ('color-regular', 60), ('color-mesh', 60), ('color-double-mesh', 90),
    ('color-bleach-1', 90), ('color-bleach-2', 150),
    -- パーマ
    ('perm-nurepan', 120), ('perm-punch', 120), ('perm-iper', 120), ('perm-curl-iper', 120), ('perm-spain', 120),
    ('perm-curly', 120), ('perm-normal', 120), ('perm-twist', 150), ('perm-negro', 150), ('perm-afro', 150),
    ('perm-ginpara-curly', 180),
    -- セット
    ('set-cut-color', 90), ('set-fade-color', 120), ('set-punch-color', 150), ('set-punch-gray', 150), ('set-iper-gray', 150),
    ('set-twist-mesh', 180), ('set-twist-double-mesh', 210), ('set-spain-mesh', 180), ('set-spain-double-mesh', 210),
    -- その他（追加メニュー）
    ('shave-men', 30), ('shave-ladies', 45), ('opt-brow', 15), ('opt-shampoo', 15), ('opt-face-pack', 15),
    ('opt-cool-shampoo', 15), ('opt-line', 15), ('opt-gosso', 10)
  ) as t(code, minutes) loop
    update public.service_menus
    set duration_min = r.minutes, buffer_after_min = 0, booking_enabled = true, is_active = true
    where code = r.code;
    if not found then
      v_missing := v_missing || r.code;
    else
      v_updated := v_updated + 1;
      insert into public.staff_menu_capabilities (staff_id, menu_id)
      select s, m.id from unnest(v_staff) s, public.service_menus m where m.code = r.code
      on conflict do nothing;
    end if;
  end loop;

  raise notice '予約で使えるメニューにした：% 件', v_updated;
  if cardinality(v_missing) > 0 then raise notice '見つからなかったメニュー：%', array_to_string(v_missing, ', '); end if;
end $$;

-- 結果の確認（予約で使えるメニューと所要時間・担当の人数）
select m.code, m.name, m.duration_min, m.price,
       (select count(*) from public.staff_menu_capabilities c where c.menu_id = m.id) as staff_count
from public.service_menus m
where m.booking_enabled and m.is_active
order by m.sort_order, m.name;
