-- JOHNNY Phase 1: auditable operator facade (20261007000000_client_visit_model.sql の後に適用。何度実行しても同じ結果)
--
-- Principles:
--   * Facts come from DB/RPC. The Edge Function never runs arbitrary SQL.
--   * Deterministic systems stay deterministic: booking, arrival/visit flow,
--     GINPay, checkout, void and maintenance start are not AI decisions.
--     JOHNNY does not describe the arrival/visit flow at all in Phase 1
--     (the TARGET flow in docs/JOHNNY_ARCHITECTURE.md is not implemented in the DB).
--   * STYLE is not a second source of truth: the style catalog holds only
--     style identity, image and tags. Price, duration and availability come
--     only from the service master / booking RPCs. A style maps to a booking
--     service only through a confirmed link; otherwise the menu is "unconfirmed".
--   * Customer-facing modes require an App/customer session in v1.
--   * Production keeps JOHNNY_ENABLED=false (Edge) and VITE_JOHNNY_ENABLED unset (UI).
--   * Write intents follow proposed → approved → executed with expiry and
--     fact re-validation enforced here; Phase 1 never executes business writes.

-- ── Style catalog (identity, image, tags only) ───────────────────────────────
-- Mirrors the published Style Library / TryOn assets. No price / duration / service codes.
create table if not exists public.johnny_style_catalog (
  slug                 text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  title                text not null unique check (btrim(title) <> '' and length(title) <= 80),
  category             text not null check (btrim(category) <> '' and length(category) <= 40),
  catch_copy           text,
  description          text,
  image_url            text,
  tags                 text[] not null default '{}',
  tryon_style_id       text,
  is_published         boolean not null default true,
  sort_order           integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

insert into public.johnny_style_catalog
  (slug, title, category, catch_copy, description, image_url, tags, tryon_style_id, sort_order)
values
  ('truck-yaro', 'トラック野郎御用達', 'classic', '仕事終わりでもピシャッと決まる。漢のための実用主義スタイル。', '無駄を排した硬派なショートスタイル。整髪料も最小限で済み、走り込んでも乱れない耐久性が魅力。', '/assets/truck-yaro.png', array['硬派','威圧','クラシック','短髪','メンテフリー'], 'truck', 0),
  ('nurepan', '俺は濡れパン', 'modern', '滴る色気。水面が揺れるような艶が男を語る。', '濡れたような光沢感がクセになるモダンウェットスタイル。強い整髪料で毛流れを作り、光を操ることで圧倒的な色気を演出する。', '/assets/hero-nurepan.jpg', array['ウェット','艶','モテ','色気','モダン'], 'nurepan', 1),
  ('bachibachi-punch', 'バチバチパンチパーマ', 'premium', '頂点を極めた渦。これをまとえる男に、世界が道を空ける。', '銀二郎最高峰の技が生み出す究極のパンチパーマ。', '/assets/hero-punch-perm.jpg', array['パンチパーマ','個性','威圧','プレミアム','覚悟'], 'punch', 2),
  ('showa-iper', '昭和のアイパー', 'classic', '昭和の猛者が選んだ不滅のカール。威圧感は時代を超える。', 'アイロンパーマで作り上げた昭和男の美学。', '/assets/styles/showa-aipar.png', array['クラシック','昭和','アイパー','威圧','硬派'], 'showa', 3),
  ('curl-iper', 'カールアイパー', 'classic', 'カールが語る男の矜持。時代を超える不滅の艶。', 'アイロンパーマで生み出した均一なカールが、男の色気を最大限に引き出す。', '/assets/hero-curl-iper.jpg', array['アイパー','クラシック','カール','色気','職人技'], 'curl', 4),
  ('jamaican-afro', 'ジャマイカンアフロ', 'casual', '自然の膨らみを愛せ。飾らない男の自由がここにある。', '天然のうねりを最大限に活かし、自由奔放な存在感を発揮するアフロスタイル。', '/assets/jamaican-afro.png', array['アフロ','ナチュラル','個性','カジュアル','メンテフリー'], 'afro', 5),
  ('natsu-nigro', '夏ニグロ', 'seasonal', '夏の熱気に負けない。潔さが男を際立たせる。', '夏に映える短めスタイルを銀二郎流に昇華。', '/assets/hero-natsu-niguro.jpg', array['夏','シーズナル','さっぱり','モテ','刈り上げ'], 'natsu', 7),
  ('ginpara', '銀パラ', 'premium', '銀の艶が宿る。それが本物の男の顔だ。', '銀二郎が誇る特製パーマ。艶感と自然な動きのバランスが絶妙。', '/assets/styles/ginpara-showcase.jpg', array['パーマ','艶','色気','プレミアム','経営者'], 'ginpara', 8),
  ('teitei-gari', 'テイテイ刈り', 'classic', 'ギリギリまで刈り込む。その線が男の矜持だ。', 'サイドを極限まで刈り上げ、トップとのコントラストで輪郭を際立たせる硬派な刈り込みスタイル。', '/assets/teitei-gari.png', array['刈り上げ','威圧','硬派','夜職','清潔感'], 'teitei', 9),
  ('sea-man', '海の男専用', 'casual', '潮風に負けん、漢の髪型。', '港で映える、漁師の貫禄を宿した硬派な短髪スタイル。', '/assets/styles/library-uminotoko.jpg', array['海','漁師','シンプル','短髪','男前'], 'gokudo', 10),
  ('rejent-punch', 'リーゼントパンチ', 'classic', 'リーゼントの型にパンチの魂。昭和の凄みが宿る二刀流。', '前髪を高く立ち上げたリーゼントにパンチパーマの渦を組み合わせたスタイル。', '/assets/styles/rejent-punch2.png', array['リーゼント','パンチパーマ','昭和','威圧','二刀流'], 'rejent', 11),
  ('spain-perm', 'スペインパーマ', 'modern', '艶と動きで女を落とす。舶来の波が男を変える。', 'スペイン系のウェーブパターンを取り入れた色気系パーマ。', '/assets/spain-parm.jpeg', array['パーマ','ウェーブ','色気','モテ','舶来'], 'spain', 12),
  ('shinsai-punch', 'シンサイパンチ', 'premium', 'バチッと決めて、気分も上々。', '難波の夜を支配する現代版パンチパーマ。', '/assets/styles/shinsai-punch.png', array['パンチパーマ','威圧','個性','漢','難波'], 'punch', 13),
  ('kakusei-color', '覚醒の色', 'modern', '常識を、ぶっ壊せ。', '銀二郎が提案する大胆なカラーリング。', '/assets/styles/kakusei.png', array['カラー','個性','覚醒','モテ','大胆'], null, 14),
  ('salaryman-girigiri-perm', 'サラリーマン専用 ギリギリパーマ', 'modern', '会社でも怒られない。でも、男は上がる。', '会社のルールの隙間を突く、男のギリギリ戦略。', '/assets/styles/ri-man-parm.png', array['パーマ','ビジネス','モテ','清潔感','ギリギリ'], null, 15),
  ('choiwaru-showa', 'ちょい悪オヤジ専用 昭和ヘアスタイル', 'classic', '渋く、粋に、そしてカッコよく。', '年を重ねたからこそ出せる、本物の色気。', '/assets/styles/showa-hair.png', array['昭和','渋い','ちょい悪','クラシック','大人'], null, 16),
  ('sideback-iper', 'サイドバックアイパー', 'classic', 'サイドを制する男が、時代を制する。', 'サイドとバックをアイロンパーマで締め上げた昭和硬派の完成形。', '/assets/styles/sidebuck.png', array['アイパー','昭和','硬派','威圧','クラシック'], null, 17),
  ('yanki-punch', 'ヤンキーパンチ', 'classic', '街を睨みつける。それがヤンキーの流儀。', '昭和のストリートを生きた男たちが誇るパンチパーマ。', '/assets/styles/yanki-punch.png', array['パンチパーマ','ヤンキー','昭和','威圧','硬派'], null, 18),
  ('nigro-perm', 'ニグロパーマ', 'modern', '渦の密度が、男の格を語る。', '細かく均一に刻まれたカールが生み出す圧倒的な存在感。', '/assets/styles/nigro.png', array['パーマ','王道','威圧','密度','職人技'], null, 19),
  ('kaigun', '海軍御用達', 'premium', '規律が生む、究極の男前。', '清潔感と威圧感の極致。海軍が認めた硬派なショートスタイル。', '/assets/styles/kaigun-showcase.jpg', array['ショート','威圧','清潔感','硬派','軍隊'], null, 21),
  ('shinsaigari', 'シンサイ刈り', 'premium', '難波の本気を、頭で語れ。', '心斎橋の夜を支配する男たちが愛する刈り込みスタイル。', '/assets/styles/shinsaigari.png', array['刈り上げ','威圧','難波','心斎橋','清潔感'], null, 22)
on conflict (slug) do nothing;

-- ── Confirmed style → booking service links ─────────────────────────────────
-- Only links confirmed in docs/service-master-reconciliation.md (HOT PEPPER coupon → offer → service,
-- or confirmed by the owner). Every other style has no link: its booking menu is "unconfirmed".
create table if not exists public.johnny_style_service_links (
  style_slug        text primary key references public.johnny_style_catalog(slug) on delete cascade,
  menu_code         text not null references public.service_menus(code) on delete restrict,
  confirmed_source  text not null check (btrim(confirmed_source) <> ''),
  created_at        timestamptz not null default now()
);

insert into public.johnny_style_service_links (style_slug, menu_code, confirmed_source)
select v.slug, v.code, v.src
from (values
        ('nurepan',          'perm-nurepan',       'service-master reconciliation: HOT PEPPER coupon CP00000008396672 → 濡れパン'),
        ('curl-iper',        'perm-curl-iper',     'service-master reconciliation: HOT PEPPER coupon CP00000008738705 → カールアイパー'),
        ('bachibachi-punch', 'perm-punch',         'service-master reconciliation: HOT PEPPER coupon CP00000008396509 → パンチパーマ'),
        ('spain-perm',       'perm-spain',         'service-master reconciliation: HOT PEPPER coupon CP00000008914867 → スペインパーマ'),
        ('teitei-gari',      'store-teitei-gari',  'service-master reconciliation: HOT PEPPER coupon CP00000008738713 → テイテイ刈り'),
        ('ginpara',          'perm-ginpara-curly', 'owner confirmed 2026-10-03: 銀パラ / GINPARA = ギンパラカーリー')
     ) as v(slug, code, src)
join public.johnny_style_catalog c on c.slug = v.slug
join public.service_menus m on m.code = v.code
on conflict (style_slug) do nothing;

-- ── Audit tables ─────────────────────────────────────────────────────────────
create table if not exists public.johnny_sessions (
  id                   uuid primary key default gen_random_uuid(),
  mode                 text not null check (mode in ('style', 'booking', 'hq')),
  actor_type           text not null check (actor_type in ('customer', 'hq', 'service')),
  customer_user_id     text,
  client_id            uuid references public.clients(id) on delete set null,
  request_id           uuid not null,
  correlation_id       uuid not null,
  source_fact_at       timestamptz not null,
  source_fact_version  text not null,
  status               text not null default 'open' check (status in ('open', 'completed', 'failed')),
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists johnny_sessions_request_uidx on public.johnny_sessions (request_id);
create index if not exists johnny_sessions_correlation_idx on public.johnny_sessions (correlation_id, created_at desc);
create index if not exists johnny_sessions_mode_idx on public.johnny_sessions (mode, created_at desc);
create index if not exists johnny_sessions_client_idx on public.johnny_sessions (client_id, created_at desc) where client_id is not null;

create table if not exists public.johnny_messages (
  id                   bigint generated always as identity primary key,
  session_id           uuid not null references public.johnny_sessions(id) on delete cascade,
  role                 text not null check (role in ('customer', 'hq', 'operator', 'tool', 'system')),
  content              text not null check (length(content) <= 12000),
  provider             text,
  model                text,
  request_id           uuid not null,
  correlation_id       uuid not null,
  source_fact_at       timestamptz not null,
  source_fact_version  text not null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);
create index if not exists johnny_messages_session_idx on public.johnny_messages (session_id, id);
create index if not exists johnny_messages_created_idx on public.johnny_messages (created_at);

create table if not exists public.johnny_tool_calls (
  id                   bigint generated always as identity primary key,
  session_id           uuid not null references public.johnny_sessions(id) on delete cascade,
  mode                 text not null check (mode in ('style', 'booking', 'hq')),
  tool_name            text not null check (tool_name ~ '^[a-z_][a-z0-9_]{1,80}$'),
  arguments            jsonb not null default '{}'::jsonb,
  result_summary       jsonb not null default '{}'::jsonb,
  status               text not null check (status in ('ok', 'error', 'skipped')),
  request_id           uuid not null,
  correlation_id       uuid not null,
  source_fact_at       timestamptz not null,
  source_fact_version  text not null,
  created_at           timestamptz not null default now()
);
create index if not exists johnny_tool_calls_session_idx on public.johnny_tool_calls (session_id, id);
create index if not exists johnny_tool_calls_tool_idx on public.johnny_tool_calls (tool_name, created_at desc);

create table if not exists public.johnny_action_intents (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid references public.johnny_sessions(id) on delete set null,
  mode                   text not null check (mode in ('style', 'booking', 'hq')),
  intent_type            text not null check (intent_type in ('tryon_handoff', 'booking_handoff', 'reservation_create', 'price_change', 'coupon_issue', 'shift_change', 'client_update', 'ginpay_review')),
  payload                jsonb not null default '{}'::jsonb,
  status                 text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executed', 'expired', 'failed')),
  idempotency_key        text not null check (btrim(idempotency_key) <> ''),
  expires_at             timestamptz not null,
  approved_by            text,
  approved_at            timestamptz,
  approved_fact_version  text,
  executed_at            timestamptz,
  execution_result       jsonb,
  rejected_reason        text,
  request_id             uuid not null,
  correlation_id         uuid not null,
  source_fact_at         timestamptz not null,
  source_fact_version    text not null,
  created_at             timestamptz not null default now(),
  -- 承認・実行の状態と記録の整合（承認なしの実行、承認者なしの承認を DB で禁止）
  constraint johnny_action_intents_lifecycle_check check (
    (status <> 'approved' or (approved_by is not null and approved_at is not null and approved_fact_version is not null))
    and (status not in ('executed', 'failed') or (approved_at is not null and executed_at is not null))
    and (status <> 'rejected' or rejected_reason is not null)
  )
);
alter table public.johnny_action_intents add column if not exists approved_fact_version text;
create unique index if not exists johnny_action_intents_idempotency_uidx on public.johnny_action_intents (idempotency_key);
create index if not exists johnny_action_intents_session_idx on public.johnny_action_intents (session_id, created_at desc);
create index if not exists johnny_action_intents_status_idx on public.johnny_action_intents (status, expires_at);

alter table public.johnny_style_catalog enable row level security;
alter table public.johnny_style_service_links enable row level security;
alter table public.johnny_sessions enable row level security;
alter table public.johnny_messages enable row level security;
alter table public.johnny_tool_calls enable row level security;
alter table public.johnny_action_intents enable row level security;

revoke all on public.johnny_style_catalog from public, anon, authenticated;
revoke all on public.johnny_style_service_links from public, anon, authenticated;
revoke all on public.johnny_sessions from public, anon, authenticated;
revoke all on public.johnny_messages from public, anon, authenticated;
revoke all on public.johnny_tool_calls from public, anon, authenticated;
revoke all on public.johnny_action_intents from public, anon, authenticated;
revoke all on sequence public.johnny_messages_id_seq from public, anon, authenticated;
revoke all on sequence public.johnny_tool_calls_id_seq from public, anon, authenticated;

-- Phase 1 の以前の案から外したもの（現在の DB の事実ではない到着・来店フローの記述、状態を自由に変えられる更新）
drop function if exists public.hq_johnny_visit_flow_contract(text);
drop function if exists public.johnny_update_action_intent(uuid, text, text, jsonb, text);
drop function if exists public.johnny_create_action_intent(uuid, text, text, jsonb, text, timestamptz, uuid, uuid, timestamptz, text);

-- ── Customer tool facade RPCs ────────────────────────────────────────────────
create or replace function public.customer_johnny_profile(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid text := app_private.session_user_id(p_session);
  v_client uuid := app_private.user_client(v_uid);
begin
  return json_build_object(
    'user_id', v_uid,
    'client_id', v_client,
    'app_session_required', true,
    'guest_mode', false,
    'pii_policy', json_build_object('customer_notes_default', false)
  );
end;
$$;

/** スタイル（名前・画像・タグ）と、確認済みの予約メニューだけ。価格・所要時間は返さない */
create or replace function public.customer_johnny_style_catalog(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.session_user_id(p_session);
  return coalesce((
    select json_agg(json_build_object(
      'slug', s.slug,
      'title', s.title,
      'category', s.category,
      'catch_copy', s.catch_copy,
      'description', s.description,
      'image_url', s.image_url,
      'tags', s.tags,
      'tryon_style_id', s.tryon_style_id,
      'booking_menu', case when m.code is null then null else json_build_object('code', m.code, 'name', m.name) end
    ) order by s.sort_order, s.title)
    from public.johnny_style_catalog s
    left join public.johnny_style_service_links l on l.style_slug = s.slug
    left join public.service_menus m on m.code = l.menu_code and m.is_active
    where s.is_published
  ), '[]'::json);
end;
$$;

create or replace function public.customer_johnny_booking_options(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.session_user_id(p_session);
  return public.customer_booking_options(p_session);
end;
$$;

create or replace function public.customer_johnny_available_slots(
  p_session text,
  p_date date,
  p_menu_codes text[],
  p_staff_id uuid default null
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.session_user_id(p_session);
  return public.customer_available_slots(p_session, p_date, p_menu_codes, p_staff_id);
end;
$$;

-- ── HQ facts facade ──────────────────────────────────────────────────────────
-- 売上・予約はそれぞれ先に集計してからスタッフへ結合する（1件の会計を必ず1回だけ数える）。
-- source_fact_at は事実を読んだ時刻、source_fact_version は事実の内容のハッシュ（同じ内容なら同じ値）。
create or replace function public.hq_johnny_snapshot(p_hq text, p_from date default null, p_to date default null)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_from date := coalesce(p_from, (now() at time zone 'Asia/Tokyo')::date - 30);
  v_to date := coalesce(p_to, (now() at time zone 'Asia/Tokyo')::date + 1);
  v_from_ts timestamptz := v_from::timestamp at time zone 'Asia/Tokyo';
  v_to_ts timestamptz := v_to::timestamp at time zone 'Asia/Tokyo';
  v_facts jsonb;
  v_ginpay jsonb;
begin
  perform app_private.assert_hq(p_hq);
  v_ginpay := app_private.ginpay_reconcile_json();
  v_facts := jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'sales', (
      select jsonb_build_object(
        'completed_count', count(*) filter (where s.status = 'completed'),
        'voided_count', count(*) filter (where s.status = 'voided'),
        'gross_sales', coalesce(sum(s.total) filter (where s.status = 'completed'), 0),
        'average_ticket', case when count(*) filter (where s.status = 'completed') = 0 then 0
          else round(coalesce(sum(s.total) filter (where s.status = 'completed'), 0)::numeric / count(*) filter (where s.status = 'completed'))::int end,
        'ginpay_sales', coalesce(sum(s.total) filter (where s.status = 'completed' and s.payment_method = 'ginpay'), 0)
      )
      from public.accounting_sessions s
      where coalesce(s.completed_at, s.created_at) >= v_from_ts and coalesce(s.completed_at, s.created_at) < v_to_ts
    ),
    'booking', (
      select jsonb_build_object(
        'total', count(*),
        'completed', count(*) filter (where r.status = 'completed'),
        'cancelled', count(*) filter (where r.status = 'cancelled'),
        'no_show', count(*) filter (where r.status = 'no_show'),
        'future_confirmed', count(*) filter (where r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment') and r.starts_at >= now())
      )
      from public.reservations r
      where r.starts_at >= v_from_ts and r.starts_at < v_to_ts
    ),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'staff_id', st.id,
        'staff_name', st.display_name,
        'completed_sales', coalesce(sa.completed_sales, 0),
        'gross_sales', coalesce(sa.gross_sales, 0),
        'completed_reservations', coalesce(ra.completed_reservations, 0)
      ) order by coalesce(sa.gross_sales, 0) desc, st.display_name)
      from public.staff_members st
      left join (
        select s.stylist_id, count(*) filter (where s.status = 'completed') completed_sales,
               coalesce(sum(s.total) filter (where s.status = 'completed'), 0) gross_sales
        from public.accounting_sessions s
        where s.stylist_id is not null
          and coalesce(s.completed_at, s.created_at) >= v_from_ts and coalesce(s.completed_at, s.created_at) < v_to_ts
        group by s.stylist_id
      ) sa on sa.stylist_id = st.id
      left join (
        select r.staff_id, count(*) filter (where r.status = 'completed') completed_reservations
        from public.reservations r
        where r.starts_at >= v_from_ts and r.starts_at < v_to_ts
        group by r.staff_id
      ) ra on ra.staff_id = st.id
      where st.is_active
    ), '[]'::jsonb),
    'menu_mix', coalesce((
      select jsonb_agg(jsonb_build_object('name', y.item_name, 'count', y.count, 'sales', y.sales) order by y.sales desc, y.count desc)
      from (
        select i.item_name, sum(coalesce(i.quantity, 1))::int count, coalesce(sum(coalesce(i.line_total, i.price * coalesce(i.quantity, 1))), 0)::int sales
        from public.accounting_session_items i
        join public.accounting_sessions s on s.id = i.session_id
        where s.status = 'completed' and coalesce(s.completed_at, s.created_at) >= v_from_ts and coalesce(s.completed_at, s.created_at) < v_to_ts
        group by i.item_name
        order by sales desc, count desc
        limit 10
      ) y
    ), '[]'::jsonb),
    'clients', (
      select jsonb_build_object(
        'active_clients', count(*) filter (where c.merged_into is null),
        'app_linked_clients', count(*) filter (where c.merged_into is null and exists (
          select 1 from public.client_identifiers i where i.client_id = c.id and i.kind = 'app_member' and i.removed_at is null
        ))
      )
      from public.clients c
    ),
    -- GINPay は合計と整合だけ（口座ごとの内訳は渡さない）
    'ginpay', jsonb_build_object(
      'consistent', v_ginpay->'consistent',
      'total_cached_balance', v_ginpay->'total_cached_balance',
      'total_ledger_balance', v_ginpay->'total_ledger_balance',
      'inconsistent_accounts', jsonb_array_length(coalesce(v_ginpay->'accounts', '[]'::jsonb))
    )
  );
  return (v_facts || jsonb_build_object(
    'source_fact_at', now(),
    'source_fact_version', 'sha256:' || encode(extensions.digest(v_facts::text, 'sha256'), 'hex')
  ))::json;
end;
$$;

create or replace function public.hq_johnny_audit(
  p_hq text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_mode text default null,
  p_limit integer default 100
)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  perform app_private.assert_hq(p_hq);
  if p_mode is not null and p_mode not in ('style', 'booking', 'hq') then
    return json_build_object('error', 'invalid_mode');
  end if;
  return coalesce((
    select json_agg(json_build_object(
      'id', s.id,
      'mode', s.mode,
      'actor_type', s.actor_type,
      'client_id', s.client_id,
      'request_id', s.request_id,
      'correlation_id', s.correlation_id,
      'source_fact_at', s.source_fact_at,
      'source_fact_version', s.source_fact_version,
      'status', s.status,
      'created_at', s.created_at,
      'tool_calls', (select count(*) from public.johnny_tool_calls t where t.session_id = s.id),
      'messages', (select count(*) from public.johnny_messages m where m.session_id = s.id),
      'action_intents', (select count(*) from public.johnny_action_intents a where a.session_id = s.id)
    ) order by s.created_at desc)
    from (
      select *
      from public.johnny_sessions s
      where (p_from is null or s.created_at >= p_from)
        and (p_to is null or s.created_at < p_to)
        and (p_mode is null or s.mode = p_mode)
      order by s.created_at desc
      limit v_limit
    ) s
  ), '[]'::json);
end;
$$;

-- ── Edge audit write RPCs (service_role only) ────────────────────────────────
-- Edge Function は認証（お客様セッション・本部セッション）と事実の取得が終わってから呼ぶ。
create or replace function public.johnny_record_session(
  p_mode text,
  p_actor_type text,
  p_request_id uuid,
  p_correlation_id uuid,
  p_source_fact_at timestamptz,
  p_source_fact_version text,
  p_customer_user_id text default null,
  p_client_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.johnny_sessions;
begin
  insert into public.johnny_sessions
    (mode, actor_type, request_id, correlation_id, source_fact_at, source_fact_version, customer_user_id, client_id, metadata)
  values
    (p_mode, p_actor_type, p_request_id, coalesce(p_correlation_id, p_request_id), p_source_fact_at,
     coalesce(nullif(p_source_fact_version, ''), 'unknown'), p_customer_user_id, p_client_id, coalesce(p_metadata, '{}'::jsonb))
  on conflict (request_id) do nothing
  returning * into v;
  if v.id is null then
    -- 同じ request_id の再送：同じ相手・同じモードなら同じセッション。違えば別のセッションへは混ぜない
    select * into v from public.johnny_sessions where request_id = p_request_id;
    if v.mode is distinct from p_mode or v.actor_type is distinct from p_actor_type
       or v.customer_user_id is distinct from p_customer_user_id then
      raise exception 'request_id_conflict' using errcode = 'unique_violation';
    end if;
  end if;
  return v.id;
end;
$$;

create or replace function public.johnny_record_message(
  p_session_id uuid,
  p_role text,
  p_content text,
  p_request_id uuid,
  p_correlation_id uuid,
  p_source_fact_at timestamptz,
  p_source_fact_version text,
  p_provider text default null,
  p_model text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_id bigint;
begin
  insert into public.johnny_messages
    (session_id, role, content, provider, model, request_id, correlation_id, source_fact_at, source_fact_version, metadata)
  values
    (p_session_id, p_role, left(coalesce(p_content, ''), 12000), p_provider, p_model, p_request_id,
     coalesce(p_correlation_id, p_request_id), p_source_fact_at, coalesce(nullif(p_source_fact_version, ''), 'unknown'),
     coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.johnny_record_tool_call(
  p_session_id uuid,
  p_mode text,
  p_tool_name text,
  p_arguments jsonb,
  p_result_summary jsonb,
  p_status text,
  p_request_id uuid,
  p_correlation_id uuid,
  p_source_fact_at timestamptz,
  p_source_fact_version text
)
returns bigint language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_id bigint;
begin
  insert into public.johnny_tool_calls
    (session_id, mode, tool_name, arguments, result_summary, status, request_id, correlation_id, source_fact_at, source_fact_version)
  values
    (p_session_id, p_mode, p_tool_name, coalesce(p_arguments, '{}'::jsonb), coalesce(p_result_summary, '{}'::jsonb),
     p_status, p_request_id, coalesce(p_correlation_id, p_request_id), p_source_fact_at,
     coalesce(nullif(p_source_fact_version, ''), 'unknown'))
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * 書き込みの意図（提案）を作る。期限は今より後・7日以内。同じ idempotency_key の再送は、内容
 * （session・mode・種類・payload）が同じなら同じ意図を返し、違えば idempotency_conflict。
 */
create or replace function public.johnny_create_action_intent(
  p_session_id uuid,
  p_mode text,
  p_intent_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_expires_at timestamptz,
  p_request_id uuid,
  p_correlation_id uuid,
  p_source_fact_at timestamptz,
  p_source_fact_version text
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.johnny_action_intents;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then return json_build_object('error', 'idempotency_key_required'); end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '7 days' then
    return json_build_object('error', 'invalid_expiry');
  end if;
  if p_source_fact_version is null or btrim(p_source_fact_version) = '' or p_source_fact_at is null then
    return json_build_object('error', 'source_fact_required');
  end if;
  select * into v from public.johnny_action_intents where idempotency_key = btrim(p_idempotency_key);
  if v.id is not null then
    if v.session_id is distinct from p_session_id or v.mode <> p_mode or v.intent_type <> p_intent_type
       or v.payload <> coalesce(p_payload, '{}'::jsonb) then
      return json_build_object('error', 'idempotency_conflict');
    end if;
    return json_build_object('id', v.id, 'status', v.status, 'idempotent', true);
  end if;
  insert into public.johnny_action_intents
    (session_id, mode, intent_type, payload, idempotency_key, expires_at, request_id, correlation_id, source_fact_at, source_fact_version)
  values
    (p_session_id, p_mode, p_intent_type, coalesce(p_payload, '{}'::jsonb), btrim(p_idempotency_key), p_expires_at,
     p_request_id, coalesce(p_correlation_id, p_request_id), p_source_fact_at, btrim(p_source_fact_version))
  returning * into v;
  return json_build_object('id', v.id, 'status', v.status, 'idempotent', false);
exception
  when check_violation then return json_build_object('error', 'invalid_value');
  when unique_violation then return json_build_object('error', 'idempotency_conflict');
end;
$$;

/**
 * 意図の状態を進める（service_role だけ）。
 *   approve  ：proposed → approved。承認者と、承認時に見た事実の版（p_fact_version）が必要。
 *   reject   ：proposed / approved → rejected。理由が必要。
 *   execute / fail：approved → executed / failed。実行直前に取り直した事実の版が承認時と違えば実行せず、
 *              承認を外して proposed に戻す（再承認が必要）。
 *   expire   ：proposed / approved → expired。
 *   期限切れの意図は承認も実行もできない（その時点で expired にする）。proposed から直接 executed にはできない。
 */
create or replace function public.johnny_transition_action_intent(
  p_id uuid,
  p_action text,
  p_actor text default null,
  p_fact_version text default null,
  p_result jsonb default null,
  p_reason text default null
)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.johnny_action_intents;
begin
  select * into v from public.johnny_action_intents where id = p_id for update;
  if v.id is null then return json_build_object('error', 'not_found'); end if;
  if p_action not in ('approve', 'reject', 'execute', 'fail', 'expire') then return json_build_object('error', 'invalid_action'); end if;
  if v.status in ('rejected', 'executed', 'expired', 'failed') then return json_build_object('error', 'invalid_status', 'status', v.status); end if;

  if v.expires_at <= now() and p_action <> 'reject' then
    update public.johnny_action_intents set status = 'expired' where id = v.id;
    return json_build_object('error', 'expired', 'status', 'expired');
  end if;

  if p_action = 'approve' then
    if v.status <> 'proposed' then return json_build_object('error', 'invalid_status', 'status', v.status); end if;
    if nullif(btrim(coalesce(p_actor, '')), '') is null then return json_build_object('error', 'approver_required'); end if;
    if nullif(btrim(coalesce(p_fact_version, '')), '') is null then return json_build_object('error', 'fact_version_required'); end if;
    update public.johnny_action_intents
    set status = 'approved', approved_by = btrim(p_actor), approved_at = now(), approved_fact_version = btrim(p_fact_version)
    where id = v.id;
  elsif p_action = 'reject' then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then return json_build_object('error', 'reason_required'); end if;
    update public.johnny_action_intents set status = 'rejected', rejected_reason = btrim(p_reason) where id = v.id;
  elsif p_action in ('execute', 'fail') then
    if v.status <> 'approved' then return json_build_object('error', 'not_approved', 'status', v.status); end if;
    if p_fact_version is distinct from v.approved_fact_version then
      update public.johnny_action_intents
      set status = 'proposed', approved_by = null, approved_at = null, approved_fact_version = null
      where id = v.id;
      return json_build_object('error', 'facts_changed_reapproval_required', 'status', 'proposed');
    end if;
    update public.johnny_action_intents
    set status = case p_action when 'execute' then 'executed' else 'failed' end, executed_at = now(), execution_result = p_result
    where id = v.id;
  else
    update public.johnny_action_intents set status = 'expired' where id = v.id;
  end if;
  select * into v from public.johnny_action_intents where id = p_id;
  return json_build_object('id', v.id, 'status', v.status);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.customer_johnny_profile(text)',
    'public.customer_johnny_style_catalog(text)',
    'public.customer_johnny_booking_options(text)',
    'public.customer_johnny_available_slots(text, date, text[], uuid)',
    'public.hq_johnny_snapshot(text, date, date)',
    'public.hq_johnny_audit(text, timestamptz, timestamptz, text, integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.johnny_record_session(text, text, uuid, uuid, timestamptz, text, text, uuid, jsonb)',
    'public.johnny_record_message(uuid, text, text, uuid, uuid, timestamptz, text, text, text, jsonb)',
    'public.johnny_record_tool_call(uuid, text, text, jsonb, jsonb, text, uuid, uuid, timestamptz, text)',
    'public.johnny_create_action_intent(uuid, text, text, jsonb, text, timestamptz, uuid, uuid, timestamptz, text)',
    'public.johnny_transition_action_intent(uuid, text, text, text, jsonb, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

revoke all on all functions in schema app_private from public, anon, authenticated;
