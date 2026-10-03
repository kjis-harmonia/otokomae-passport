-- GINJIRO OS 正規サービスマスター（20261005_checkout.sql の後に適用。追加のみ・何度実行しても同じ結果）
--
-- 予約と会計は同じ service_menus（正規サービスマスター）を参照する。
--   正規サービス → 予約（reservation_items に名称・時間・価格の snapshot）→ 会計（accounting_session_items に snapshot）
--   マスターの価格を変えても、過去の予約・会計の金額は変わらない。
-- 区分：kind = service（基本サービス）/ option（オプション）/ set（セット・コース）。
--   販促オファー（HOT PEPPER クーポン・App 会員価格）は service_offers に分け、正規サービスへの価格・条件として持つ（サービスの複製を作らない）。
--   店販は products、前売り券・内部チケットは tickets / GINPay のまま（サービスマスターに入れない）。
-- 利用可否：is_active（マスターで有効）、booking_enabled（予約できる）、checkout_enabled（会計で選べる）。
--   予約できるのは、所要時間と担当できるスタッフ（1人以上）が揃ったサービスだけ（DB で強制）。
-- 価格：price は税込の表示価格（price_tax_included）。税率・内税計算・端数処理は決めない（会計の税設定は未設定のまま）。
-- 旧・会計アシストの accounting_items は、正規サービスと同じものに service_menu_id を付け、会計の候補から外す（互換用に行は残す）。
-- 照合の根拠は docs/service-master-reconciliation.md。

-- ── 正規サービスマスター：区分・利用可否・税込表示 ────────────────────────────

alter table public.service_menus add column if not exists kind text not null default 'service';
alter table public.service_menus add column if not exists category text;
alter table public.service_menus add column if not exists checkout_enabled boolean not null default true;
alter table public.service_menus add column if not exists price_tax_included boolean not null default true;
alter table public.service_menus add column if not exists price_from boolean not null default false;
-- 参考所要時間：確定していない所要時間の記録（公式サイトの記載など）。予約の計算・予約可否には使わない
alter table public.service_menus add column if not exists reference_duration_min integer;
alter table public.service_menus add column if not exists reference_duration_note text;
alter table public.service_menus drop constraint if exists service_menus_reference_duration_check;
alter table public.service_menus add constraint service_menus_reference_duration_check
  check ((reference_duration_min is null or reference_duration_min between 5 and 600)
         and (reference_duration_note is null or length(reference_duration_note) <= 100));
-- 予約可否：これまでは is_active が「予約できる」を兼ねていた。初回だけ、予約できる条件を満たす行を引き継ぐ
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'service_menus' and column_name = 'booking_enabled') then
    alter table public.service_menus add column booking_enabled boolean not null default false;
    update public.service_menus m set booking_enabled = true
    where m.is_active and m.duration_min is not null
      and exists (select 1 from public.staff_menu_capabilities c where c.menu_id = m.id);
  end if;
end $$;

alter table public.service_menus drop constraint if exists service_menus_kind_check;
alter table public.service_menus add constraint service_menus_kind_check check (kind in ('service', 'option', 'set'));
alter table public.service_menus drop constraint if exists service_menus_category_check;
alter table public.service_menus add constraint service_menus_category_check
  check (category is null or (btrim(category) <> '' and length(category) <= 20));
-- 予約できるのは、マスターで有効かつ所要時間があるサービスだけ
alter table public.service_menus drop constraint if exists service_menus_booking_check;
alter table public.service_menus add constraint service_menus_booking_check
  check (not booking_enabled or (is_active and duration_min is not null));

-- 予約できるサービスには担当できるスタッフが1人以上必要（担当の置き換えは同じトランザクション内なので、確定時に確認する）
-- 確定時（RPC の外）に呼び出し元の権限で動くため security definer（app_private なので外部からは実行できない）
create or replace function app_private.service_menu_staff_guard()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_menu uuid;
begin
  if tg_table_name = 'service_menus' then v_menu := new.id; else v_menu := old.menu_id; end if;
  if exists (select 1 from public.service_menus m
             where m.id = v_menu and m.booking_enabled
               and not exists (select 1 from public.staff_menu_capabilities c where c.menu_id = m.id)) then
    raise exception 'staff_required' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists service_menus_staff_guard on public.service_menus;
create constraint trigger service_menus_staff_guard
  after insert or update on public.service_menus
  deferrable initially deferred
  for each row execute function app_private.service_menu_staff_guard();
drop trigger if exists staff_menu_capabilities_staff_guard on public.staff_menu_capabilities;
create constraint trigger staff_menu_capabilities_staff_guard
  after delete or update on public.staff_menu_capabilities
  deferrable initially deferred
  for each row execute function app_private.service_menu_staff_guard();

-- ── 販促オファー（HOT PEPPER クーポン・App 会員価格）──────────────────────────
-- 内部チケット（Welcome・漢トク券など）とは別物。オファーを使ってもチケットは消費しない。
-- offer_price が null のものは価格未確認（予約・会計の価格には使わない）。
create table if not exists public.service_offers (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  channel             text not null check (channel in ('hotpepper', 'app')),
  external_id         text check (external_id is null or (btrim(external_id) <> '' and length(external_id) <= 64)),
  name                text not null check (btrim(name) <> '' and length(name) <= 80),
  offer_price         integer check (offer_price between 0 and 1000000),
  price_tax_included  boolean not null default true,
  conditions          text check (conditions is null or length(conditions) <= 200),
  weekdays_only       boolean not null default false,   -- 土日祝は不可
  time_from           time,                             -- 受付時間帯（開始時刻がこの範囲）
  time_to             time,
  first_visit_only    boolean not null default false,   -- 初回来店のみ
  is_active           boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table public.service_offers add column if not exists weekdays_only boolean not null default false;
alter table public.service_offers add column if not exists time_from time;
alter table public.service_offers add column if not exists time_to time;
alter table public.service_offers add column if not exists first_visit_only boolean not null default false;
create unique index if not exists service_offers_external_uq on public.service_offers (channel, external_id) where external_id is not null;

-- オファーが価格・条件を与える正規サービス（同じクーポンが複数のサービスに使える場合は複数行）
create table if not exists public.service_offer_menus (
  offer_id  uuid not null references public.service_offers(id) on delete cascade,
  menu_id   uuid not null references public.service_menus(id) on delete restrict,
  primary key (offer_id, menu_id)
);
create index if not exists service_offer_menus_menu_idx on public.service_offer_menus (menu_id);

-- オファーの担当条件（行がなければ担当の指定なし）
create table if not exists public.service_offer_staff (
  offer_id  uuid not null references public.service_offers(id) on delete cascade,
  staff_id  uuid not null references public.staff_members(id) on delete cascade,
  primary key (offer_id, staff_id)
);

alter table public.service_offers enable row level security;
alter table public.service_offer_menus enable row level security;
alter table public.service_offer_staff enable row level security;
revoke all on public.service_offers from public, anon, authenticated;
revoke all on public.service_offer_menus from public, anon, authenticated;
revoke all on public.service_offer_staff from public, anon, authenticated;

-- 予約の snapshot に、使ったオファー（HOT PEPPER のクーポンIDなど）を残せるようにする
alter table public.reservation_items add column if not exists offer_id uuid references public.service_offers(id) on delete set null;
alter table public.reservation_items add column if not exists offer_name text;
alter table public.reservation_items add column if not exists external_offer_id text;

-- 旧・会計アシストの商品マスター：正規サービスと同じものを指す（指しているものは会計の候補に出さない）
alter table public.accounting_items add column if not exists service_menu_id uuid references public.service_menus(id) on delete set null;

-- ── 初期データ：正規サービス（HOT PEPPER 掲載・税込）。既存の行は変更しない ─────────
-- 所要時間・担当スタッフは確認できないため未設定 → 会計では使え、予約は不可（本部で所要時間と担当を決めてから予約可にする）
insert into public.service_menus (code, name, kind, category, price, price_from, is_active, booking_enabled, checkout_enabled, sort_order) values
  ('cut-regular',            '通常カット',                      'service', 'カット',       4000,  false, true, false, true, 110),
  ('cut-skin-fade',          'スキンフェードカット',            'service', 'カット',       5000,  false, true, false, true, 120),
  ('cut-skin-fade-plus',     'ワンランク上のスキンフェード',    'service', 'カット',       6000,  false, true, false, true, 130),
  ('cut-buzz',               '丸刈り',                          'service', 'カット',       1500,  false, true, false, true, 140),
  ('cut-elementary',         '小学生',                          'service', 'カット',       2000,  false, true, false, true, 150),
  ('cut-kids-skin-fade',     '子供スキンフェード',              'service', 'カット',       3000,  false, true, false, true, 160),
  ('cut-bangs',              '前髪',                            'service', 'カット',       500,   false, true, false, true, 170),
  ('color-gray',             '白髪染め/ぼかし',                 'service', 'カラー',       3000,  false, true, false, true, 210),
  ('color-regular',          'ヘアカラー',                      'service', 'カラー',       4000,  false, true, false, true, 220),
  ('color-mesh',             'メッシュ',                        'service', 'カラー',       4000,  false, true, false, true, 230),
  ('color-double-mesh',      'ダブルメッシュ',                  'service', 'カラー',       6000,  false, true, false, true, 240),
  ('color-bleach-1',         'ブリーチ1回',                     'service', 'カラー',       5000,  false, true, false, true, 250),
  ('color-bleach-2',         'ブリーチ2回',                     'service', 'カラー',       7000,  false, true, false, true, 260),
  ('perm-nurepan',           '濡れパン',                        'service', 'パーマ',       8000,  false, true, false, true, 310),
  ('perm-curl-iper',         'カールアイパー',                  'service', 'パーマ',       8000,  false, true, false, true, 320),
  ('perm-punch',             'パンチパーマ',                    'service', 'パーマ',       8000,  false, true, false, true, 330),
  ('perm-iper',              'アイパー',                        'service', 'パーマ',       8000,  false, true, false, true, 340),
  ('perm-spain',             'スペインパーマ',                  'service', 'パーマ',       8000,  false, true, false, true, 350),
  ('perm-curly',             'カーリーパーマ',                  'service', 'パーマ',       8000,  false, true, false, true, 360),
  ('perm-normal',            'ノーマルパーマ',                  'service', 'パーマ',       8000,  false, true, false, true, 370),
  ('perm-negro',             'ニグロパーマ',                    'service', 'パーマ',       9000,  false, true, false, true, 380),
  ('perm-afro',              'アフロ系',                        'service', 'パーマ',       9000,  true,  true, false, true, 390),
  ('perm-twist',             'ツイスト系',                      'service', 'パーマ',       12000, false, true, false, true, 400),
  ('perm-ginpara-curly',     'ギンパラカーリー',                'service', 'パーマ',       15000, false, true, false, true, 410),
  ('shave-men',              '顔そり男性',                      'service', 'シェービング', 2000,  false, true, false, true, 510),
  ('shave-ladies',           'レディースシェービング',          'service', 'シェービング', 3000,  false, true, false, true, 520),
  ('opt-brow',               '眉手入れ',                        'option',  'オプション',   500,   false, true, false, true, 610),
  ('opt-shampoo',            'シャンプー',                      'option',  'オプション',   1000,  false, true, false, true, 620),
  ('opt-line',               'ライン1本',                       'option',  'オプション',   300,   false, true, false, true, 630),
  ('opt-gosso',              'ゴッソ',                          'option',  'オプション',   300,   false, true, false, true, 640),
  ('opt-face-pack',          'フェイスパック',                  'option',  'オプション',   500,   false, true, false, true, 650),
  ('opt-cool-shampoo',       'クールシャンプー',                'option',  'オプション',   300,   false, true, false, true, 660),
  ('set-cut-color',          '通常カット&カラー',               'set',     'セット',       6500,  false, true, false, true, 710),
  ('set-fade-color',         'スキンフェード&カラー',           'set',     'セット',       7500,  false, true, false, true, 720),
  ('set-punch-color',        'パンチ&カラー',                   'set',     'セット',       15000, false, true, false, true, 730),
  ('set-punch-gray',         'パンチ&白髪染め',                 'set',     'セット',       12000, false, true, false, true, 740),
  ('set-iper-gray',          'アイパー&白髪染め',               'set',     'セット',       12000, false, true, false, true, 750),
  ('set-twist-mesh',         'ツイスト&メッシュ',               'set',     'セット',       15000, false, true, false, true, 760),
  ('set-twist-double-mesh',  'ツイスト&ダブルメッシュ',         'set',     'セット',       18000, false, true, false, true, 770),
  ('set-spain-mesh',         'スペインパーマ&メッシュ',         'set',     'セット',       13000, false, true, false, true, 780),
  ('set-spain-double-mesh',  'スペインパーマ&ダブルメッシュ',   'set',     'セット',       15000, false, true, false, true, 790),
  -- 店舗・App のメニュー（HOT PEPPER の通常メニュー一覧にはないが、会計・App・HOT PEPPER クーポンで使われている）
  ('store-teitei-gari',      'テイテイ刈り',                    'service', 'カット',       8000,  false, true, false, true, 180),
  ('store-kaigun',           '海軍御用達',                      'service', 'カット',       5000,  false, false, false, true, 190)
on conflict (code) do nothing;

-- 旧予約メニュー（App 会員クーポンの区分。単独のサービスではない）：行は残し、区分だけ明示する
update public.service_menus set category = '旧App会員メニュー'
where category is null
  and code in ('maintenance-teitei', 'maintenance-ginjiro', 'special-teitei', 'special-ginjiro',
               'premium-classics', 'premium-special-perm', 'premium-ginpara');

-- 旧・会計アシストのメニュー：名称と価格がどちらも同じものだけ正規サービスへつなぐ（違えば旧会計メニューのまま会計で選べる）
update public.accounting_items a set service_menu_id = m.id
from (values
        ('濡れパン',           'perm-nurepan',      8000),
        ('カールアイパー',     'perm-curl-iper',    8000),
        ('パンチパーマ',       'perm-punch',        8000),
        ('テイテイ刈り',       'store-teitei-gari', 8000),
        ('海軍御用達',         'store-kaigun',      5000),
        ('ライン入れ（一本）', 'opt-line',          300),
        ('ゴッソ',             'opt-gosso',         300),
        ('眉手入れ',           'opt-brow',          500),
        ('銀パラ',             'perm-ginpara-curly', 15000)
     ) as v(item_name, code, price)
join public.service_menus m on m.code = v.code
where a.name = v.item_name and a.price = v.price and a.price = m.price
  and a.category in ('menu', 'option') and a.service_menu_id is null;

-- ── 初期データ：オファー ───────────────────────────────────────────────────────
-- HOT PEPPER：依頼時点で確認できた条件付き価格
insert into public.service_offers (code, channel, external_id, name, offer_price, conditions, weekdays_only, time_from, time_to, first_visit_only, sort_order) values
  ('hp-senior',      'hotpepper', null, 'シニア割',         2000, '60歳以上・スキンフェード不可・バリカン刈上げ2mm以上', true, '08:00', '16:00', false, 10),
  ('hp-nurepan-new', 'hotpepper', null, '濡れパン（新規）', 7000, 'スキンフェードなし・顔剃りなし',                      true, '09:00', '16:00', true,  20)
on conflict (code) do nothing;
-- HOT PEPPER：App のスタイルから予約導線として使っているクーポン（src/data/reserveLinks.ts）。価格は未確認
insert into public.service_offers (code, channel, external_id, name, offer_price, conditions, sort_order) values
  ('hp-cp-11140746', 'hotpepper', 'CP00000011140746', '14日メンテナンス',                                 3000, '前回来店から14日以内・トップカット不可・顔剃り追加 ¥500', 100),
  ('hp-cp-8396672',  'hotpepper', 'CP00000008396672', 'クーポン（俺は濡れパン／濡れパン）',               null, null, 110),
  ('hp-cp-8738705',  'hotpepper', 'CP00000008738705', 'クーポン（カールアイパー）',                       null, null, 120),
  ('hp-cp-8396509',  'hotpepper', 'CP00000008396509', 'クーポン（バチバチパンチパーマ／パンチパーマ／ヤンキーパンチ）', null, null, 130),
  ('hp-cp-9409138',  'hotpepper', 'CP00000009409138', 'クーポン（銀パラ）',                               null, null, 140),
  ('hp-cp-9719294',  'hotpepper', 'CP00000009719294', 'クーポン（夏ニグロ）',                             null, null, 150),
  ('hp-cp-8738713',  'hotpepper', 'CP00000008738713', 'クーポン（テイテイ刈り）',                         null, null, 160),
  ('hp-cp-8396582',  'hotpepper', 'CP00000008396582', 'クーポン（ジャマイカンアフロ／ニグロパーマ）',     null, null, 170),
  ('hp-cp-9719263',  'hotpepper', 'CP00000009719263', 'クーポン（海の男専用／海軍御用達／シンサイ刈り）', null, null, 180),
  ('hp-cp-8875458',  'hotpepper', 'CP00000008875458', 'クーポン（昭和のアイパー／サイドバックアイパー）', null, null, 190),
  ('hp-cp-8914837',  'hotpepper', 'CP00000008914837', 'クーポン（リーゼントパンチ／シンサイパンチ）',     null, null, 200),
  ('hp-cp-8914867',  'hotpepper', 'CP00000008914867', 'クーポン（スペインパーマ）',                       null, null, 210),
  ('hp-cp-8761373',  'hotpepper', 'CP00000008761373', 'クーポン（トラック野郎御用達）',                   null, null, 220),
  ('hp-cp-10603641', 'hotpepper', 'CP00000010603641', 'クーポン（覚醒の色）',                             null, null, 230),
  ('hp-cp-9996260',  'hotpepper', 'CP00000009996260', 'クーポン（サラリーマン専用 ギリギリパーマ）',      null, null, 240),
  ('hp-cp-8738693',  'hotpepper', 'CP00000008738693', 'クーポン（ちょい悪オヤジ専用 昭和ヘアスタイル）',  null, null, 250)
on conflict (code) do nothing;
-- App 会員価格（src/data/wallet.ts。電話予約限定）
insert into public.service_offers (code, channel, external_id, name, offer_price, conditions, sort_order) values
  ('app-maintenance-teitei',  'app', null, 'テイテイメンテナンス', 3000,  'App 会員・前回来店から14日以内', 300),
  ('app-maintenance-ginjiro', 'app', null, '銀二郎メンテナンス',   2500,  'App 会員・前回来店から14日以内', 310),
  ('app-classics',            'app', null, 'GINJIRO CLASSICS',     8000,  'App 会員・電話予約限定・土日祝は17:00〜19:00受付', 320),
  ('app-special-perm',        'app', null, 'SPECIAL PERM',         10000, 'App 会員・電話予約限定・土日祝は17:00〜19:00受付', 330),
  ('app-ginpara',             'app', null, 'GINPARA',              15000, 'App 会員・電話予約限定・土日祝は17:00〜19:00受付', 340)
on conflict (code) do nothing;

-- オファー → 正規サービス：対象が名称どおりに確認できるものだけ（それ以外は未対応のまま。照合表の「要確認」）
insert into public.service_offer_menus (offer_id, menu_id)
select o.id, m.id
from (values
        ('hp-nurepan-new', 'perm-nurepan'),
        ('hp-cp-8396672',  'perm-nurepan'),
        ('hp-cp-8738705',  'perm-curl-iper'),
        ('hp-cp-8396509',  'perm-punch'),
        ('hp-cp-8738713',  'store-teitei-gari'),
        ('hp-cp-8914867',  'perm-spain'),
        ('hp-cp-9409138',  'perm-ginpara-curly'),
        ('app-ginpara',    'perm-ginpara-curly'),
        ('app-classics',   'perm-iper'),
        ('app-classics',   'perm-punch'),
        ('app-classics',   'perm-negro'),
        ('app-classics',   'perm-nurepan')
     ) as v(offer_code, menu_code)
join public.service_offers o on o.code = v.offer_code
join public.service_menus m on m.code = v.menu_code
on conflict do nothing;

-- オファーの担当条件（公開情報で確定したもの）
insert into public.service_offer_staff (offer_id, staff_id)
select o.id, st.id
from (values
        ('hp-cp-11140746', '銀二郎'),
        ('hp-cp-11140746', 'テイテイ'),
        ('hp-nurepan-new', '銀二郎')
     ) as v(offer_code, staff_name)
join public.service_offers o on o.code = v.offer_code
join public.staff_members st on st.display_name = v.staff_name
on conflict do nothing;

-- ── 所要時間・担当・予約可否 ────────────────────────────────────────────────────
-- 参考所要時間（公式サイトの記載。価格が古い項目を含むため参考のみ。予約可にはしない）。既に入っていれば変えない
update public.service_menus m set reference_duration_min = v.min, reference_duration_note = v.note
from (values
        ('perm-normal',    120, '公式サイト記載（参考）'),
        ('perm-twist',     120, '公式サイト記載（ツイスト/ピン・参考）'),
        ('perm-curly',     120, '公式サイト記載（参考）'),
        ('perm-afro',      120, '公式サイト記載（全頭は180分以上・参考）'),
        ('perm-punch',     70,  '公式サイト記載（参考）'),
        ('perm-nurepan',   70,  '公式サイト記載（参考）'),
        ('perm-curl-iper', 70,  '公式サイト記載（参考）'),
        ('perm-negro',     80,  '公式サイト記載（参考）'),
        ('perm-iper',      80,  '公式サイト記載（参考）')
     ) as v(code, min, note)
where m.code = v.code and m.reference_duration_min is null;

-- ギンパラカーリー：HOT PEPPER 記載の所要時間（約180分）と担当（銀二郎・テイテイ）が確定 → 予約可。
-- 本部で既に所要時間を設定済みなら変えない（初回だけ）
insert into public.staff_menu_capabilities (staff_id, menu_id)
select st.id, m.id
from public.service_menus m
join public.staff_members st on st.display_name in ('銀二郎', 'テイテイ')
where m.code = 'perm-ginpara-curly' and m.duration_min is null
on conflict do nothing;
update public.service_menus set duration_min = 180, booking_enabled = true, updated_at = now()
where code = 'perm-ginpara-curly' and duration_min is null and is_active
  and exists (select 1 from public.staff_menu_capabilities c where c.menu_id = service_menus.id);

-- ============================================================================
-- 予約：予約できるのは booking_enabled のサービスだけ（会計のみのサービスは予約に出ない）
-- ============================================================================

create or replace function app_private.booking_plan(p_staff_id uuid, p_menu_codes text[])
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_items jsonb := '[]'::jsonb; v_duration int := 0; v_buffer int := 0; v_price int := 0; v_price_known boolean := true;
        v_count int := 0; r record;
begin
  if p_menu_codes is null or cardinality(p_menu_codes) = 0 or cardinality(p_menu_codes) > 5 then return null; end if;
  if (select count(distinct c) from unnest(p_menu_codes) c) <> cardinality(p_menu_codes) then return null; end if;
  for r in
    select m.id, m.code, m.name, coalesce(c.duration_override_min, m.duration_min) as duration, m.buffer_after_min, m.price,
           array_position(p_menu_codes, m.code) as pos
    from public.service_menus m
    join public.staff_menu_capabilities c on c.menu_id = m.id and c.staff_id = p_staff_id
    join public.staff_members s on s.id = p_staff_id and s.is_active and s.is_bookable
    where m.code = any(p_menu_codes) and m.is_active and m.booking_enabled and m.duration_min is not null
    order by array_position(p_menu_codes, m.code)
  loop
    v_count := v_count + 1;
    v_duration := v_duration + r.duration;
    v_buffer := greatest(v_buffer, r.buffer_after_min);
    if r.price is null then v_price_known := false; else v_price := v_price + r.price; end if;
    v_items := v_items || jsonb_build_object('menu_id', r.id, 'menu_code', r.code, 'name', r.name,
      'duration_min', r.duration, 'buffer_after_min', r.buffer_after_min, 'price', r.price, 'sort_order', r.pos);
  end loop;
  if v_count <> cardinality(p_menu_codes) then return null; end if;
  return jsonb_build_object('duration_min', v_duration, 'buffer_min', v_buffer,
    'total_price', case when v_price_known then v_price else null end, 'items', v_items);
end;
$$;

create or replace function public.customer_booking_options(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  return json_build_object(
    'settings', (select json_build_object('slot_minutes', slot_minutes, 'booking_window_days', booking_window_days,
                   'min_lead_minutes', min_lead_minutes, 'hold_minutes', hold_minutes) from public.booking_settings where id = 1),
    'menus', coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'duration_min', m.duration_min,
                         'price', m.price, 'normal_price', m.normal_price, 'price_from', m.price_from) order by m.sort_order)
                       from public.service_menus m
                       where m.is_active and m.booking_enabled and m.duration_min is not null
                         and exists (select 1 from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id
                                     where c.menu_id = m.id and s.is_active and s.is_bookable)), '[]'::json),
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json));
end;
$$;

/** 予約登録に使うメニュー（担当できるスタッフ付き）とスタッフ */
create or replace function app_private.booking_options_json()
returns json language sql stable
set search_path = public, extensions, pg_temp
as $$
  select json_build_object(
    'settings', (select json_build_object('slot_minutes', slot_minutes, 'booking_window_days', booking_window_days, 'min_lead_minutes', min_lead_minutes)
                 from public.booking_settings where id = 1),
    'menus', coalesce((select json_agg(json_build_object('code', m.code, 'name', m.name, 'duration_min', m.duration_min, 'price', m.price,
                         'staff_ids', (select coalesce(json_agg(c.staff_id), '[]'::json) from public.staff_menu_capabilities c where c.menu_id = m.id))
                         order by m.sort_order)
                       from public.service_menus m where m.is_active and m.booking_enabled and m.duration_min is not null), '[]'::json),
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json))
$$;

-- ============================================================================
-- 本部：メニュー・価格マスター
-- ============================================================================

create or replace function public.hq_booking_masters(p_hq text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return json_build_object(
    'settings', (select row_to_json(b) from public.booking_settings b where id = 1),
    'staff', coalesce((select json_agg(row_to_json(s) order by s.sort_order, s.display_name) from public.staff_members s), '[]'::json),
    'business_hours', coalesce((select json_agg(json_build_object('weekday', b.weekday, 'is_closed', b.is_closed,
                         'open_time', to_char(b.open_time, 'HH24:MI'), 'close_time', to_char(b.close_time, 'HH24:MI')) order by b.weekday)
                       from public.business_hours b), '[]'::json),
    'templates', coalesce((select json_agg(json_build_object('staff_id', t.staff_id, 'weekday', t.weekday,
                    'start_time', to_char(t.start_time, 'HH24:MI'), 'end_time', to_char(t.end_time, 'HH24:MI')) order by t.staff_id, t.weekday)
                  from public.staff_shift_templates t), '[]'::json),
    'menus', coalesce((select json_agg(json_build_object('id', m.id, 'code', m.code, 'name', m.name, 'kind', m.kind, 'category', m.category,
                         'duration_min', m.duration_min, 'buffer_after_min', m.buffer_after_min, 'price', m.price, 'normal_price', m.normal_price,
                         'price_from', m.price_from, 'price_tax_included', m.price_tax_included,
                         'reference_duration_min', m.reference_duration_min, 'reference_duration_note', m.reference_duration_note,
                         'is_active', m.is_active, 'booking_enabled', m.booking_enabled, 'checkout_enabled', m.checkout_enabled, 'sort_order', m.sort_order,
                         'staff', (select coalesce(json_agg(json_build_object('staff_id', c.staff_id, 'duration_override_min', c.duration_override_min)), '[]'::json)
                                   from public.staff_menu_capabilities c where c.menu_id = m.id))
                         order by m.sort_order, m.name) from public.service_menus m), '[]'::json),
    'offers', coalesce((select json_agg(json_build_object('id', o.id, 'code', o.code, 'channel', o.channel, 'external_id', o.external_id,
                         'name', o.name, 'offer_price', o.offer_price, 'conditions', o.conditions, 'is_active', o.is_active,
                         'weekdays_only', o.weekdays_only, 'time_from', to_char(o.time_from, 'HH24:MI'), 'time_to', to_char(o.time_to, 'HH24:MI'),
                         'first_visit_only', o.first_visit_only,
                         'staff_ids', (select coalesce(json_agg(os.staff_id), '[]'::json) from public.service_offer_staff os where os.offer_id = o.id),
                         'menu_ids', (select coalesce(json_agg(om.menu_id), '[]'::json) from public.service_offer_menus om where om.offer_id = o.id))
                         order by o.sort_order, o.name) from public.service_offers o), '[]'::json));
end;
$$;

/** p：id（更新時）, code（新規のみ）, name, kind(service|option|set), category, duration_min, buffer_after_min, price, normal_price,
 *    price_from, is_active（マスターで有効）, booking_enabled（予約できる）, checkout_enabled（会計で選べる）, sort_order,
 *    staff：[{staff_id, duration_override_min}]（指定時は担当を置き換え）
 *   booking_enabled を指定しない古い呼び出しでは、is_active を「予約できる」として扱う（互換）。
 *   予約できるのは、有効・所要時間あり・担当できる（受付中の）スタッフが1人以上のときだけ。 */
create or replace function public.hq_upsert_menu(p_hq text, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.service_menus; v_s jsonb; v_constraint text;
        v_booking boolean := case when p ? 'booking_enabled' then (p->>'booking_enabled')::boolean
                                  when p ? 'is_active' then (p->>'is_active')::boolean end;
begin
  perform app_private.assert_hq(p_hq);
  if p->>'id' is null then
    insert into public.service_menus (code, name, kind, category, duration_min, buffer_after_min, price, normal_price, price_from,
                                      is_active, booking_enabled, checkout_enabled, sort_order)
    values (p->>'code', btrim(p->>'name'), coalesce(p->>'kind', 'service'), nullif(btrim(coalesce(p->>'category', '')), ''),
            (p->>'duration_min')::int, coalesce((p->>'buffer_after_min')::int, 0),
            (p->>'price')::int, (p->>'normal_price')::int, coalesce((p->>'price_from')::boolean, false),
            coalesce((p->>'is_active')::boolean, false), coalesce(v_booking, false), coalesce((p->>'checkout_enabled')::boolean, true),
            coalesce((p->>'sort_order')::int, 100))
    returning * into v;
  else
    update public.service_menus set
      name = coalesce(btrim(p->>'name'), name),
      kind = coalesce(p->>'kind', kind),
      category = case when p ? 'category' then nullif(btrim(coalesce(p->>'category', '')), '') else category end,
      duration_min = case when p ? 'duration_min' then (p->>'duration_min')::int else duration_min end,
      buffer_after_min = coalesce((p->>'buffer_after_min')::int, buffer_after_min),
      price = case when p ? 'price' then (p->>'price')::int else price end,
      normal_price = case when p ? 'normal_price' then (p->>'normal_price')::int else normal_price end,
      price_from = coalesce((p->>'price_from')::boolean, price_from),
      is_active = coalesce((p->>'is_active')::boolean, is_active),
      booking_enabled = coalesce(v_booking, booking_enabled),
      checkout_enabled = coalesce((p->>'checkout_enabled')::boolean, checkout_enabled),
      sort_order = coalesce((p->>'sort_order')::int, sort_order),
      updated_at = now()
    where id = (p->>'id')::uuid
    returning * into v;
    if v.id is null then return json_build_object('error', 'not_found'); end if;
  end if;
  if v.booking_enabled and (not v.is_active or v.duration_min is null) then raise exception 'duration_required'; end if;
  if p ? 'staff' then
    delete from public.staff_menu_capabilities where menu_id = v.id;
    for v_s in select * from jsonb_array_elements(p->'staff') loop
      insert into public.staff_menu_capabilities (staff_id, menu_id, duration_override_min)
      values ((v_s->>'staff_id')::uuid, v.id, (v_s->>'duration_override_min')::int);
    end loop;
  end if;
  if v.booking_enabled and not exists (select 1 from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id
                                       where c.menu_id = v.id and s.is_active and s.is_bookable) then
    raise exception 'staff_required';
  end if;
  return row_to_json(v);
exception
  when unique_violation then return json_build_object('error', 'duplicate_code');
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    return json_build_object('error', case when v_constraint = 'service_menus_booking_check' then 'duration_required' else 'invalid_value' end);
  when raise_exception then
    if sqlerrm in ('duration_required', 'staff_required') then return json_build_object('error', sqlerrm); end if;
    raise;
end;
$$;

-- ============================================================================
-- 会計：選べるのは正規サービス（checkout_enabled）と、正規サービスにつながっていない旧会計メニュー、店販商品
-- ============================================================================

create or replace function app_private.checkout_catalog_json()
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'service_menus', (select coalesce(jsonb_agg(jsonb_build_object('id', m.code, 'name', m.name,
                         'category', case m.kind when 'option' then 'option' else 'menu' end, 'kind', m.kind, 'group', m.category,
                         'price', m.price, 'price_from', m.price_from) order by m.sort_order, m.name), '[]'::jsonb)
                      from public.service_menus m where m.is_active and m.checkout_enabled and m.price is not null),
    'menus', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'category', a.category, 'price', a.price) order by a.category, a.sort_order), '[]'::jsonb)
              from public.accounting_items a where a.is_active and a.category in ('menu', 'option') and a.service_menu_id is null),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'category', 'retail', 'price', p.price) order by p.name), '[]'::jsonb)
                 from public.products p where p.is_active and p.category = '店販' and p.price > 0)
  )
$$;
