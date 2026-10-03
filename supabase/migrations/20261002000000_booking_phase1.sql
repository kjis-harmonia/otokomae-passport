-- ============================================================================
-- GINJIRO OS 予約システム Phase 1（additive migration）
-- ----------------------------------------------------------------------------
-- 前提：20261001_security_hardening_a_functions.sql（app_private の認証ヘルパー）が適用済み。
-- 既存テーブル・既存 RPC は変更しない。新規テーブルは最初から RLS 有効・anon/authenticated から直接アクセス不可。
-- アクセスは customer（p_session）/ staff（p_staff）/ HQ（p_hq）セッション付き RPC のみ。
--
-- 予約はすべて reservations に統一（source: app / hotpepper / phone / staff）。
-- time_blocks は予約ではない占有時間（休憩・研修・店内予定・個人的な予定・受付不可）専用。
-- 二重予約は (1) スタッフ単位のロックで同じスタッフへの書き込みを直列化 (2) DB の排他制約（EXCLUDE USING gist）の二重で防ぐ。
-- 片付け（buffer）時間もスタッフの拘束時間として扱い、シフト・営業時間の終了を超える予約は受け付けない。
-- シフト：通常週（staff_shift_templates）＋ 日付ごとの上書き（staff_shifts = その日の出勤時間 / staff_day_offs = その日は休み）。
-- 時刻は timestamptz で保存し、日付・シフトの解釈は Asia/Tokyo。
-- 何度実行しても同じ状態になる（冪等）。
-- ============================================================================

create extension if not exists btree_gist with schema extensions;

-- ── 設定（1行のみ） ─────────────────────────────────────────────────────────
create table if not exists public.booking_settings (
  id                                smallint primary key default 1 check (id = 1),
  slot_minutes                      integer not null default 15 check (slot_minutes in (5, 10, 15, 20, 30, 60)),
  booking_window_days               integer not null default 60 check (booking_window_days between 1 and 365),
  min_lead_minutes                  integer not null default 30 check (min_lead_minutes between 0 and 1440),
  hold_minutes                      integer not null default 2  check (hold_minutes between 1 and 30),
  -- お客様アプリからのキャンセル受付期限（開始の何分前まで）。店舗方針の確定まで暫定値
  customer_cancel_deadline_minutes  integer not null default 30 check (customer_cancel_deadline_minutes between 0 and 10080),
  -- お客様アプリからの予約受付（Feature Flag）。Phase 1 は OFF。切替は SQL Editor のみ
  app_booking_enabled               boolean not null default false,
  updated_at                        timestamptz not null default now()
);
insert into public.booking_settings (id) values (1) on conflict (id) do nothing;

-- ── スタッフ ────────────────────────────────────────────────────────────────
create table if not exists public.staff_members (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null unique check (btrim(display_name) <> '' and length(display_name) <= 40),
  is_bookable   boolean not null default true,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── メニュー ────────────────────────────────────────────────────────────────
-- duration_min が未設定（null）のメニューは予約できない（値は HQ で確定させる）
create table if not exists public.service_menus (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name               text not null check (btrim(name) <> '' and length(name) <= 80),
  duration_min       integer check (duration_min between 5 and 600),
  buffer_after_min   integer not null default 0 check (buffer_after_min between 0 and 120),
  price              integer check (price between 0 and 1000000),
  normal_price       integer check (normal_price between 0 and 1000000),
  is_active          boolean not null default false,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.staff_menu_capabilities (
  staff_id              uuid not null references public.staff_members(id) on delete cascade,
  menu_id               uuid not null references public.service_menus(id) on delete cascade,
  duration_override_min integer check (duration_override_min between 5 and 600),
  primary key (staff_id, menu_id)
);

-- ── 店休日・シフト・占有時間 ────────────────────────────────────────────────
create table if not exists public.business_closures (
  closure_date  date primary key,
  reason        text,
  created_at    timestamptz not null default now()
);

-- 営業時間（曜日ごと。行がない曜日は制限なし＝シフトだけで判断）。is_closed = 定休日
create table if not exists public.business_hours (
  weekday     smallint primary key check (weekday between 0 and 6),   -- 0=日 … 6=土
  is_closed   boolean not null default false,
  open_time   time,
  close_time  time,
  updated_at  timestamptz not null default now(),
  check (is_closed or (open_time is not null and close_time is not null and close_time > open_time))
);

-- 通常週のシフト（スタッフ × 曜日に1つ）。日付ごとの上書きが無い日はこれが使われる
create table if not exists public.staff_shift_templates (
  staff_id    uuid not null references public.staff_members(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  time not null,
  end_time    time not null,
  updated_at  timestamptz not null default now(),
  primary key (staff_id, weekday),
  check (end_time > start_time)
);

-- 日付ごとの休み（通常週で出勤の日を休みにする）
create table if not exists public.staff_day_offs (
  staff_id    uuid not null references public.staff_members(id) on delete cascade,
  off_date    date not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  primary key (staff_id, off_date)
);

-- 日付ごとの出勤時間（通常週の代わりにその日だけ使う）
create table if not exists public.staff_shifts (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff_members(id) on delete cascade,
  work_date   date not null,
  start_time  time not null,
  end_time    time not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  check (end_time > start_time),
  -- 同じスタッフの同じ日のシフトは重ならない
  constraint staff_shifts_no_overlap exclude using gist (
    staff_id with =, tsrange(work_date + start_time, work_date + end_time) with &&
  )
);
create index if not exists staff_shifts_date_idx on public.staff_shifts (work_date);

create table if not exists public.time_blocks (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references public.staff_members(id) on delete cascade, -- null = 全スタッフ
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  kind        text not null check (kind in ('break', 'training', 'store_event', 'personal', 'unavailable')),
  note        text,
  created_by  text,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists time_blocks_range_idx on public.time_blocks using gist (tstzrange(starts_at, ends_at));

-- ── 顧客マスター（GINJIRO OS の顧客＝銀二郎を利用する一人の人物） ─────────────────
--   clients            ：顧客。App 会員でなくても（HOT PEPPER・電話・店舗予約）持てる。名前は識別に使わない（同姓同名は別人のまま）
--   client_identifiers ：顧客を識別するための別 ID。App 会員（customers.id）・電話番号・HOT PEPPER 予約番号
--                        App 会員と HOT PEPPER 予約番号は1人の顧客にだけ属する。電話番号は家族で共有されうるので重複可
--   client_events      ：作成・統合・統合解除の監査履歴（統合で移した行を記録し、解除で元に戻す）
--   既存の customers は「App 会員（アカウント）」のまま変えない。会員1人につき顧客1人を自動で作り、App 会員 ID で紐付ける。
--   統合（同じ人物の顧客を1つにする）は人が確認して行う。名前・電話番号だけでは自動で統合しない。
create table if not exists public.clients (
  id               uuid primary key default gen_random_uuid(),
  display_name     text not null check (btrim(display_name) <> '' and length(display_name) <= 60),
  normalized_name  text not null default '',
  kana             text check (kana is null or length(kana) <= 60),  -- フリガナ（任意。HOT PEPPER の予約などから）
  created_via      text not null check (created_via in ('app', 'hotpepper', 'phone', 'staff')),
  merged_into      uuid references public.clients(id),
  merged_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((merged_into is null) = (merged_at is null) and merged_into is distinct from id)
);
create index if not exists clients_normalized_name_idx on public.clients (normalized_name) where merged_into is null;
create index if not exists clients_merged_into_idx on public.clients (merged_into) where merged_into is not null;

create table if not exists public.client_identifiers (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  kind        text not null check (kind in ('app_member', 'phone', 'hotpepper_ref')),
  value       text not null check (btrim(value) <> ''),  -- 照合用（電話は数字のみ、App 会員は customers.id）
  label       text,                                        -- 表示用（電話番号の表記など）
  created_by  text,
  created_at  timestamptz not null default now(),
  removed_at  timestamptz                                  -- App 会員行の削除などで無効になった ID（履歴として残す）
);
create unique index if not exists client_identifiers_unique_idx on public.client_identifiers (kind, value)
  where removed_at is null and kind in ('app_member', 'hotpepper_ref');
create index if not exists client_identifiers_lookup_idx on public.client_identifiers (kind, value) where removed_at is null;
create index if not exists client_identifiers_client_idx on public.client_identifiers (client_id);

create table if not exists public.client_events (
  id               bigint generated always as identity primary key,
  client_id        uuid not null references public.clients(id) on delete cascade,
  event_type       text not null check (event_type in ('created', 'updated', 'merged', 'merged_into', 'unmerged', 'identifier_removed')),
  other_client_id  uuid references public.clients(id) on delete set null,
  actor_type       text not null check (actor_type in ('customer', 'staff', 'hq', 'system')),
  actor_name       text,
  detail           jsonb,
  undone_at        timestamptz,                              -- merged：統合を解除した日時
  created_at       timestamptz not null default now()
);
create index if not exists client_events_client_idx on public.client_events (client_id, created_at desc);

-- 既存テーブルへ追加（列の追加のみ。既存の読み書きはそのまま動く）
--   customer_notes：顧客（App 会員でない人を含む）のメモ。customer_id は App 会員のメモとして残す
--   accounting_sessions：App 会員でない人の会計を顧客に紐付けるための列（会計側の書き込みは今後の会計連携で行う）
alter table public.customer_notes add column if not exists client_id uuid references public.clients(id);
alter table public.customer_notes alter column customer_id drop not null;
create index if not exists customer_notes_client_idx on public.customer_notes (client_id, created_at desc);
alter table public.accounting_sessions add column if not exists client_id uuid references public.clients(id);
create index if not exists accounting_sessions_client_idx on public.accounting_sessions (client_id) where client_id is not null;

/** 照合用：名前（空白除去・小文字）／電話（数字のみ） */
create or replace function app_private.norm_name(p text)
returns text language sql immutable
set search_path = pg_catalog
as $$ select lower(regexp_replace(replace(coalesce(p, ''), '　', ''), '\s+', '', 'g')) $$;

create or replace function app_private.norm_phone(p text)
returns text language sql immutable
set search_path = pg_catalog
as $$ select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') $$;

/** 統合済みの顧客は統合先をたどる（統合先がなければそのまま） */
create or replace function app_private.client_root(p_id uuid)
returns uuid language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v uuid := p_id; v_next uuid; i int;
begin
  for i in 1..20 loop
    select merged_into into v_next from public.clients where id = v;
    if not found then return null; end if;
    exit when v_next is null;
    v := v_next;
  end loop;
  return v;
end;
$$;

/** 顧客の App 会員の電話下4桁（customers が正。顧客側には写しを持たない） */
create or replace function app_private.client_last4(p_ids uuid[])
returns text[] language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(distinct cu.phone_last4), '{}') from public.client_identifiers i
  join public.customers cu on cu.id::text = i.value
  where i.client_id = any(p_ids) and i.kind = 'app_member' and i.removed_at is null and cu.phone_last4 is not null
$$;

/** 顧客の作成（監査履歴つき） */
create or replace function app_private.create_client(p_name text, p_via text, p_actor_type text, p_actor_name text)
returns uuid language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_id uuid; v_name text := coalesce(nullif(btrim(coalesce(p_name, '')), ''), '名前未設定');
begin
  insert into public.clients (display_name, normalized_name, created_via)
  values (left(v_name, 60), app_private.norm_name(v_name), p_via)
  returning id into v_id;
  insert into public.client_events (client_id, event_type, actor_type, actor_name) values (v_id, 'created', p_actor_type, p_actor_name);
  return v_id;
end;
$$;

/** 顧客に識別 ID を追加（同じ ID がすでにあれば何もしない） */
create or replace function app_private.add_client_identifier(p_client_id uuid, p_kind text, p_value text, p_label text, p_by text)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if p_value is null or btrim(p_value) = '' then return; end if;
  if exists (select 1 from public.client_identifiers where client_id = p_client_id and kind = p_kind and value = p_value and removed_at is null) then return; end if;
  insert into public.client_identifiers (client_id, kind, value, label, created_by) values (p_client_id, p_kind, p_value, p_label, p_by);
end;
$$;

/** App 会員の顧客（会員1人につき顧客1人。なければ作る） */
create or replace function app_private.member_client(p_customer_id uuid)
returns uuid language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_id uuid; v_c public.customers;
begin
  select client_id into v_id from public.client_identifiers
  where kind = 'app_member' and value = p_customer_id::text and removed_at is null;
  if v_id is not null then return app_private.client_root(v_id); end if;
  select * into v_c from public.customers where id = p_customer_id;
  if v_c.id is null then return null; end if;
  v_id := app_private.create_client(v_c.name, 'app', 'system', null);
  insert into public.client_identifiers (client_id, kind, value, label, created_by)
  values (v_id, 'app_member', v_c.id::text, null, 'system');
  return v_id;
end;
$$;

-- App 会員が増えたら、その会員の顧客を作る（既存の会員登録の処理は変えない）
create or replace function app_private.on_customer_inserted()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_client uuid;
begin
  v_client := app_private.member_client(new.id);
  -- 会員登録より前にその user_id で記録された会計も、この会員の顧客へ
  update public.accounting_sessions set client_id = v_client where client_id is null and user_id = new.user_id;
  return new;
end;
$$;
drop trigger if exists customers_client_after_insert on public.customers;
create trigger customers_client_after_insert after insert on public.customers
  for each row execute function app_private.on_customer_inserted();

-- App 会員行が削除されたら（端末変更の復旧で新端末の仮会員行を消すとき）、その App 会員 ID を無効にする。
-- 顧客に履歴が何もなければ顧客も削除し、履歴があれば残す（人が確認して統合する）
create or replace function app_private.on_customer_deleted()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_client uuid;
begin
  update public.client_identifiers set removed_at = now()
  where kind = 'app_member' and value = old.id::text and removed_at is null
  returning client_id into v_client;
  if v_client is null then return old; end if;
  if not exists (select 1 from public.client_identifiers where client_id = v_client and removed_at is null)
     and not exists (select 1 from public.reservations where client_id = v_client)
     and not exists (select 1 from public.customer_notes where client_id = v_client)
     and not exists (select 1 from public.accounting_sessions where client_id = v_client)
     and not exists (select 1 from public.clients where merged_into = v_client) then
    delete from public.clients where id = v_client;
  else
    insert into public.client_events (client_id, event_type, actor_type, detail)
    values (v_client, 'identifier_removed', 'system', jsonb_build_object('kind', 'app_member', 'customer_id', old.id));
  end if;
  return old;
end;
$$;
drop trigger if exists customers_client_after_delete on public.customers;
create trigger customers_client_after_delete after delete on public.customers
  for each row execute function app_private.on_customer_deleted();

-- App 会員のメモ（既存の本部カルテから追加されたもの）も、その会員の顧客のメモとして見えるようにする
create or replace function app_private.on_customer_note_inserted()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if new.client_id is null and new.customer_id is not null then
    new.client_id := app_private.member_client(new.customer_id);
  end if;
  return new;
end;
$$;
drop trigger if exists customer_notes_client_before_insert on public.customer_notes;
create trigger customer_notes_client_before_insert before insert on public.customer_notes
  for each row execute function app_private.on_customer_note_inserted();

-- 既存データの移行：App 会員1人につき顧客1人（名前での統合はしない）。メモは会員の顧客へ。何度実行しても同じ結果
do $$
declare c record;
begin
  for c in select id from public.customers cu
           where not exists (select 1 from public.client_identifiers i where i.kind = 'app_member' and i.value = cu.id::text)
           order by created_at loop
    perform app_private.member_client(c.id);
  end loop;
end $$;
update public.customer_notes n set client_id = app_private.member_client(n.customer_id)
where n.client_id is null and n.customer_id is not null;

-- ── 予約 ────────────────────────────────────────────────────────────────────
create table if not exists public.reservations (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references public.staff_members(id),
  nominated       boolean not null default false,                  -- お客様の指名あり（false＝フリー）
  -- 担当の確定。フリー（指名なし）予約は予約エンジンが実在のスタッフに仮で割り当て（staff_id は常に実在のスタッフで、
  -- 同時に受けられる人数は増えない）、店舗が後で担当を確定・変更する。指名ありは常に確定
  staff_confirmed boolean not null default true,
  client_id       uuid not null references public.clients(id),     -- 顧客（必須）。App 会員でなくても必ず紐付く
  customer_id     uuid references public.customers(id) on delete set null, -- App からの予約の App 会員（予約元の記録）
  user_id         text,
  customer_name   text not null check (btrim(customer_name) <> '' and length(customer_name) <= 60),
  customer_phone  text check (customer_phone is null or length(customer_phone) <= 20),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,                            -- 施術の終了
  occupied_until  timestamptz not null,                            -- 片付け（buffer）込みの占有終了
  status          text not null default 'confirmed'
                  check (status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed', 'cancelled', 'no_show')),
  source          text not null check (source in ('app', 'hotpepper', 'phone', 'staff')),
  external_ref    text,                                            -- HOT PEPPER 予約番号など
  total_price     integer,
  note            text check (note is null or length(note) <= 500),
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancel_reason   text,
  check (ends_at > starts_at and occupied_until >= ends_at),
  -- 二重予約の DB 保証：同じスタッフの有効な予約は占有時間が重ならない
  constraint reservations_no_overlap exclude using gist (
    staff_id with =, tstzrange(starts_at, occupied_until) with &&
  ) where (status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'))
);
create index if not exists reservations_starts_idx on public.reservations (starts_at);
create index if not exists reservations_user_idx on public.reservations (user_id);
create unique index if not exists reservations_external_ref_uq
  on public.reservations (source, external_ref) where external_ref is not null;

create table if not exists public.reservation_items (
  id                uuid primary key default gen_random_uuid(),
  reservation_id    uuid not null references public.reservations(id) on delete cascade,
  menu_id           uuid references public.service_menus(id) on delete set null,
  menu_code         text not null,
  name              text not null,
  duration_min      integer not null,
  buffer_after_min  integer not null default 0,
  price             integer,
  sort_order        integer not null default 0
);
create index if not exists reservation_items_res_idx on public.reservation_items (reservation_id);

-- 変更履歴（追記のみ。更新・削除の経路は作らない）
create table if not exists public.reservation_events (
  id              bigint generated always as identity primary key,
  reservation_id  uuid not null references public.reservations(id) on delete cascade,
  event_type      text not null check (event_type in
                    ('created', 'rescheduled', 'staff_changed', 'staff_confirmed', 'cancelled', 'checked_in', 'in_service', 'awaiting_payment', 'completed', 'no_show')),
  actor_type      text not null check (actor_type in ('customer', 'staff', 'hq', 'system')),
  actor_name      text,
  before          jsonb,
  after           jsonb,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists reservation_events_res_idx on public.reservation_events (reservation_id, created_at);

-- 予約確定前の短時間仮確保（AI 予約・SALON BOARD 同期の準備）。期限切れは空き計算で自動的に無視される
create table if not exists public.booking_holds (
  id                         uuid primary key default gen_random_uuid(),
  staff_id                   uuid not null references public.staff_members(id) on delete cascade,
  nominated                  boolean not null default false,
  starts_at                  timestamptz not null,
  ends_at                    timestamptz not null,
  occupied_until             timestamptz not null,
  menu_codes                 text[] not null,
  source                     text not null check (source in ('app', 'staff', 'ai', 'salonboard')),
  holder_user_id             text,
  expires_at                 timestamptz not null,
  released_at                timestamptz,
  converted_reservation_id   uuid references public.reservations(id) on delete set null,
  created_at                 timestamptz not null default now(),
  check (ends_at > starts_at and occupied_until >= ends_at)
);
create index if not exists reservations_client_idx on public.reservations (client_id, starts_at desc);
create index if not exists booking_holds_active_idx on public.booking_holds (expires_at) where released_at is null and converted_reservation_id is null;

-- ── 閉鎖：RLS 有効・ポリシーなし・テーブル権限なし（RPC のみ） ──────────────
do $$
declare t text;
begin
  foreach t in array array[
    'booking_settings', 'staff_members', 'service_menus', 'staff_menu_capabilities', 'business_closures',
    'business_hours', 'staff_shift_templates', 'staff_day_offs',
    'staff_shifts', 'time_blocks', 'reservations', 'reservation_items', 'reservation_events', 'booking_holds',
    'clients', 'client_identifiers', 'client_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.reservation_events_id_seq from public, anon, authenticated;
revoke all on sequence public.client_events_id_seq from public, anon, authenticated;

-- ── 初期データ（既存コードから確定できるものだけ） ───────────────────────────
-- スタッフ：店舗端末の担当者リスト（AdminScreen STAFF_NAMES）の7名。予約を受けるのはテイテイ・銀二郎の2名だけ
-- （他のスタッフは削除せず、予約対象外として登録。本部の予約設定で変更できる）
insert into public.staff_members (display_name, sort_order, is_bookable) values
  ('テイテイ', 10, true), ('ヨンピル', 20, false), ('銀二郎', 30, true), ('シルビア', 40, false), ('リアン', 50, false),
  ('キャンディ', 60, false), ('ヒョウ', 70, false)
on conflict (display_name) do nothing;

-- メニュー：アプリ内で価格が確定しているもの。所要時間はコードに無いため未設定（=予約不可）で登録し、HQ で確定させる
insert into public.service_menus (code, name, price, normal_price, sort_order) values
  ('maintenance-teitei',  'テイテイメンテナンス',                         3000, null,  10),
  ('maintenance-ginjiro', '銀二郎メンテナンス',                           2500, 3000,  20),
  ('special-teitei',      'テイテイSpecial 天空の髪ピチュ FULL COURSE',   6800, null,  30),
  ('special-ginjiro',     '銀二郎Special スキンフェードカット',           4000, 4500,  40),
  ('premium-classics',    'GINJIRO CLASSICS（アイパー / パンチ / ニグロ / 濡れパン）', 8000, 9000, 50),
  ('premium-special-perm','SPECIAL PERM（ピンパーマ / ツイストパーマ）',  10000, 12000, 60),
  ('premium-ginpara',     'GINPARA 銀パラ',                               15000, 16000, 70)
on conflict (code) do nothing;

-- 担当：アプリ内表記で担当者が明示されているものだけ（テイテイ／銀二郎の各メンテナンス・Special）
insert into public.staff_menu_capabilities (staff_id, menu_id)
select s.id, m.id
from (values ('テイテイ', 'maintenance-teitei'), ('銀二郎', 'maintenance-ginjiro'),
             ('テイテイ', 'special-teitei'),     ('銀二郎', 'special-ginjiro')) as v(staff_name, code)
join public.staff_members s on s.display_name = v.staff_name
join public.service_menus m on m.code = v.code
on conflict do nothing;

-- ============================================================================
-- 内部関数（app_private：外部から実行不可）
-- ============================================================================

/** JST の日付＋時刻 → timestamptz */
create or replace function app_private.jst_ts(p_date date, p_time time)
returns timestamptz language sql stable
set search_path = pg_catalog
as $$ select (p_date + p_time) at time zone 'Asia/Tokyo' $$;

/**
 * スタッフ単位の書き込みロック（同じスタッフへの予約・仮確保・シフト変更を直列化）。
 * デッドロックを避けるため、必要なスタッフ分を1回の呼び出しで id 順に取得する。
 */
create or replace function app_private.lock_staff(p_ids uuid[])
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v uuid;
begin
  for v in select distinct x from unnest(p_ids) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtextextended('ginjiro_booking_staff:' || v::text, 0));
  end loop;
end;
$$;

/** 全スタッフ分のロック（指名なしの担当決め・店全体に関わる変更） */
create or replace function app_private.lock_all_staff()
returns void language sql
set search_path = public, extensions, pg_temp
as $$ select app_private.lock_staff(array(select id from public.staff_members)) $$;

/**
 * その日の実際の勤務時間（JST）。日付の休み → なし／日付の出勤時間 → それ／それ以外 → 通常週。
 * 営業時間（設定がある曜日）で切り取り、定休日・店休日は勤務なし。
 */
create or replace function app_private.effective_shifts(p_staff_id uuid, p_date date)
returns table (st timestamptz, en timestamptz)
language sql stable
set search_path = public, extensions, pg_temp
as $$
  with off as (
    select exists (select 1 from public.staff_day_offs o where o.staff_id = p_staff_id and o.off_date = p_date) v
  ), raw as (
    select x.start_time s, x.end_time e from public.staff_shifts x
    where x.staff_id = p_staff_id and x.work_date = p_date and not (select v from off)
    union all
    select t.start_time, t.end_time from public.staff_shift_templates t
    where t.staff_id = p_staff_id and t.weekday = extract(dow from p_date)::int and not (select v from off)
      and not exists (select 1 from public.staff_shifts x where x.staff_id = p_staff_id and x.work_date = p_date)
  ), bh as (
    select * from public.business_hours where weekday = extract(dow from p_date)::int
  ), clipped as (
    select greatest(raw.s, coalesce(bh.open_time, raw.s)) s, least(raw.e, coalesce(bh.close_time, raw.e)) e, coalesce(bh.is_closed, false) closed
    from raw left join bh on true
  )
  select app_private.jst_ts(p_date, c.s), app_private.jst_ts(p_date, c.e)
  from clipped c
  where not c.closed and c.e > c.s
    and not exists (select 1 from public.business_closures bc where bc.closure_date = p_date)
  order by 1
$$;

/**
 * スタッフ × メニュー群の所要時間・buffer・料金。担当できない・所要時間未設定・無効なメニューを含む場合は null。
 * buffer は含まれるメニューの最大値（片付けは最後に1回）。
 */
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
    where m.code = any(p_menu_codes) and m.is_active and m.duration_min is not null
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

/**
 * その時間にそのスタッフで予約できるか（空き計算・作成・変更で共通）。
 *   勤務時間内（片付けの終わりまで）・予約／占有時間／他の有効な仮確保と重ならない。
 */
create or replace function app_private.slot_is_free(
  p_staff_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_occupied_until timestamptz,
  p_exclude_reservation uuid default null, p_exclude_hold uuid default null
)
returns boolean language sql stable
set search_path = public, extensions, pg_temp
as $$
  select
    exists (select 1 from app_private.effective_shifts(p_staff_id, (p_starts_at at time zone 'Asia/Tokyo')::date) e
            where e.st <= p_starts_at and e.en >= p_occupied_until)
    and not exists (select 1 from public.reservations r
                    where r.staff_id = p_staff_id
                      and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed')
                      and (p_exclude_reservation is null or r.id <> p_exclude_reservation)
                      and tstzrange(r.starts_at, r.occupied_until) && tstzrange(p_starts_at, p_occupied_until))
    and not exists (select 1 from public.time_blocks b
                    where (b.staff_id = p_staff_id or b.staff_id is null)
                      and tstzrange(b.starts_at, b.ends_at) && tstzrange(p_starts_at, p_occupied_until))
    and not exists (select 1 from public.booking_holds h
                    where h.staff_id = p_staff_id
                      and h.released_at is null and h.converted_reservation_id is null and h.expires_at > now()
                      and (p_exclude_hold is null or h.id <> p_exclude_hold)
                      and tstzrange(h.starts_at, h.occupied_until) && tstzrange(p_starts_at, p_occupied_until))
$$;

/** 予約できる日か（今日〜予約可能期間内・店休日でない） */
create or replace function app_private.booking_date_open(p_date date)
returns boolean language sql stable
set search_path = public, extensions, pg_temp
as $$
  select p_date >= app_private.today_jst()
     and p_date <= app_private.today_jst() + (select booking_window_days from public.booking_settings where id = 1)
     and not exists (select 1 from public.business_closures where closure_date = p_date)
$$;

/** 開始時刻が予約枠（slot_minutes 刻み、JST 0:00 起点）に乗っているか */
create or replace function app_private.on_slot_grid(p_starts_at timestamptz)
returns boolean language sql stable
set search_path = public, extensions, pg_temp
as $$
  select (extract(epoch from (p_starts_at at time zone 'Asia/Tokyo')::time)::bigint
          % ((select slot_minutes from public.booking_settings where id = 1) * 60)) = 0
     and extract(second from p_starts_at) = 0
$$;

/**
 * 空き時間。p_staff_id が null なら担当できる全スタッフ（指名なし）。
 * p_min_lead_minutes：現在からの最短開始（お客様は設定値、店舗端末は 0）。
 */
create or replace function app_private.available_slots(
  p_date date, p_menu_codes text[], p_staff_id uuid, p_min_lead_minutes integer,
  p_exclude_reservation uuid default null, p_exclude_hold uuid default null
)
returns table (staff_id uuid, staff_name text, starts_at timestamptz, ends_at timestamptz, occupied_until timestamptz)
language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare v_slot int; v_plan jsonb; v_dur interval; v_occ interval; v_earliest timestamptz; s record; sh record;
        v_first timestamptz; v_day_start timestamptz; v_t timestamptz;
begin
  if not app_private.booking_date_open(p_date) then return; end if;
  select slot_minutes into v_slot from public.booking_settings where id = 1;
  v_earliest := now() + make_interval(mins => greatest(p_min_lead_minutes, 0));
  v_day_start := app_private.jst_ts(p_date, '00:00');
  for s in
    select m.id, m.display_name from public.staff_members m
    where m.is_active and m.is_bookable and (p_staff_id is null or m.id = p_staff_id)
    order by m.sort_order, m.display_name
  loop
    v_plan := app_private.booking_plan(s.id, p_menu_codes);
    continue when v_plan is null;
    v_dur := make_interval(mins => (v_plan->>'duration_min')::int);
    v_occ := make_interval(mins => (v_plan->>'duration_min')::int + (v_plan->>'buffer_min')::int);
    for sh in
      select e.st, e.en from app_private.effective_shifts(s.id, p_date) e
    loop
      v_first := greatest(sh.st, v_earliest);
      -- 枠（JST 0:00 起点の slot_minutes 刻み）に切り上げ
      v_first := v_day_start + make_interval(mins => (ceil(extract(epoch from (v_first - v_day_start)) / 60.0 / v_slot) * v_slot)::int);
      v_t := v_first;
      -- 片付け（buffer）も拘束時間：片付けの終わりまで勤務時間内に収まる開始時刻だけ
      while v_t + v_occ <= sh.en loop
        if app_private.slot_is_free(s.id, v_t, v_t + v_dur, v_t + v_occ, p_exclude_reservation, p_exclude_hold) then
          staff_id := s.id; staff_name := s.display_name; starts_at := v_t; ends_at := v_t + v_dur; occupied_until := v_t + v_occ;
          return next;
        end if;
        v_t := v_t + make_interval(mins => v_slot);
      end loop;
    end loop;
  end loop;
end;
$$;

/** その日の空き時間の断片数（p_extra を予約した場合）。勤務時間から予約・占有時間・有効な仮確保を引いた残りの区間数 */
create or replace function app_private.free_fragments(p_staff_id uuid, p_date date, p_extra tstzrange, p_exclude_hold uuid default null)
returns integer language sql stable
set search_path = public, extensions, pg_temp
as $$
  with work as (
    select coalesce(range_agg(tstzrange(e.st, e.en)), '{}'::tstzmultirange) m from app_private.effective_shifts(p_staff_id, p_date) e
  ), busy as (
    select coalesce(range_agg(x.r), '{}'::tstzmultirange) m from (
      select tstzrange(r.starts_at, r.occupied_until) r from public.reservations r
      where r.staff_id = p_staff_id and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed')
      union all
      select tstzrange(b.starts_at, b.ends_at) from public.time_blocks b where b.staff_id = p_staff_id or b.staff_id is null
      union all
      select tstzrange(h.starts_at, h.occupied_until) from public.booking_holds h
      where h.staff_id = p_staff_id and h.released_at is null and h.converted_reservation_id is null and h.expires_at > now()
        and (p_exclude_hold is null or h.id <> p_exclude_hold)
      union all
      select p_extra where p_extra is not null
    ) x
  )
  select count(*)::int from unnest((select w.m - b.m from work w, busy b)) u
$$;

/** その日の予約済み時間（分・片付け込み） */
create or replace function app_private.booked_minutes(p_staff_id uuid, p_date date)
returns integer language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(sum(extract(epoch from (r.occupied_until - r.starts_at)) / 60), 0)::int
  from public.reservations r
  where r.staff_id = p_staff_id and r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed')
    and (r.starts_at at time zone 'Asia/Tokyo')::date = p_date
$$;

/**
 * 指名なしの担当決め（決定論的）：
 *   1. 予約後の空き時間の断片が最も少ない（予約の前後に使えない細切れの時間を作らない）
 *   2. 同じなら、その日の予約済み時間が少ない
 *   3. 同じなら、並び順（sort_order）→ 名前 → id
 */
create or replace function app_private.pick_staff(p_starts_at timestamptz, p_menu_codes text[], p_exclude_hold uuid default null)
returns uuid language sql stable
set search_path = public, extensions, pg_temp
as $$
  select a.staff_id
  from app_private.available_slots((p_starts_at at time zone 'Asia/Tokyo')::date, p_menu_codes, null, 0, null, p_exclude_hold) a
  join public.staff_members m on m.id = a.staff_id
  where a.starts_at = p_starts_at
  order by app_private.free_fragments(a.staff_id, (p_starts_at at time zone 'Asia/Tokyo')::date, tstzrange(a.starts_at, a.occupied_until), p_exclude_hold),
           app_private.booked_minutes(a.staff_id, (p_starts_at at time zone 'Asia/Tokyo')::date),
           m.sort_order, m.display_name, m.id
  limit 1
$$;

create or replace function app_private.reservation_json(p_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'id', r.id, 'client_id', r.client_id, 'staff_id', r.staff_id, 'staff_name', s.display_name, 'nominated', r.nominated, 'staff_confirmed', r.staff_confirmed,
    'customer_id', r.customer_id, 'user_id', r.user_id, 'customer_name', r.customer_name, 'customer_phone', r.customer_phone,
    'starts_at', r.starts_at, 'ends_at', r.ends_at, 'occupied_until', r.occupied_until,
    'status', r.status, 'source', r.source, 'external_ref', r.external_ref, 'total_price', r.total_price,
    'note', r.note, 'created_by', r.created_by, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'items', coalesce((select jsonb_agg(jsonb_build_object('menu_code', i.menu_code, 'name', i.name,
                          'duration_min', i.duration_min, 'price', i.price) order by i.sort_order)
                       from public.reservation_items i where i.reservation_id = r.id), '[]'::jsonb))
  from public.reservations r join public.staff_members s on s.id = r.staff_id
  where r.id = p_id
$$;

/** お客様向け（電話番号・メモ・作成者は返さない） */
create or replace function app_private.reservation_json_customer(p_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select app_private.reservation_json(p_id) - 'customer_phone' - 'note' - 'created_by' - 'customer_id' - 'client_id' - 'external_ref' - 'occupied_until'
$$;

create or replace function app_private.log_reservation_event(
  p_reservation_id uuid, p_event text, p_actor_type text, p_actor_name text, p_before jsonb, p_after jsonb, p_note text default null
)
returns void language sql
set search_path = public, extensions, pg_temp
as $$
  insert into public.reservation_events (reservation_id, event_type, actor_type, actor_name, before, after, note)
  values (p_reservation_id, p_event, p_actor_type, p_actor_name, p_before, p_after, p_note)
$$;

/**
 * 予約の顧客を決める（予約の作成と同じ取り消し範囲の中で呼ぶ。予約が作れなければ顧客も残らない）
 *   1. 人が選んだ顧客（p.client_id。統合済みなら統合先）
 *   2. App からの予約は、その App 会員の顧客
 *   3. それ以外は新しい顧客を作る（名前・電話番号が同じ既存顧客があっても自動ではまとめない。統合は人が確認して行う）
 * 電話番号・HOT PEPPER 予約番号は、その顧客の識別 ID として追加する。
 */
create or replace function app_private.booking_client(
  p jsonb, p_customer_id uuid, p_name text, p_source text, p_actor_type text, p_actor_name text
)
returns uuid language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_id uuid; v_phone text := app_private.norm_phone(p->>'customer_phone'); v_ref text := nullif(btrim(coalesce(p->>'external_ref', '')), '');
begin
  if nullif(p->>'client_id', '') is not null then
    v_id := app_private.client_root((p->>'client_id')::uuid);
    if v_id is null then return null; end if;
  elsif p_customer_id is not null then
    v_id := app_private.member_client(p_customer_id);
  end if;
  if v_id is not null then
    -- 統合と同時の予約に備え、顧客行を共有ロックしてから統合済みでないか確かめる
    perform 1 from public.clients where id = v_id for share;
    if (select merged_into from public.clients where id = v_id) is not null then v_id := app_private.client_root(v_id); end if;
  else
    v_id := app_private.create_client(p_name, p_source, p_actor_type, p_actor_name);
  end if;
  if v_phone is not null and length(v_phone) >= 8 then
    perform app_private.add_client_identifier(v_id, 'phone', v_phone, btrim(p->>'customer_phone'), p_actor_name);
  end if;
  if p_source = 'hotpepper' and v_ref is not null then
    perform app_private.add_client_identifier(v_id, 'hotpepper_ref', v_ref, v_ref, p_actor_name);
  end if;
  return v_id;
end;
$$;

/**
 * 予約作成（共通）。ロックの中で空きを再確認し、排他制約違反も slot_taken として返す。
 *   p：starts_at, menu_codes[], staff_id(null=指名なし), customer_name, customer_phone, user_id, customer_id,
 *      client_id（店舗・本部が既存の顧客を選んだとき）, source, external_ref, note, hold_id
 */
create or replace function app_private.create_reservation(
  p jsonb, p_actor_type text, p_actor_name text, p_min_lead_minutes integer
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_start timestamptz; v_codes text[]; v_staff uuid; v_nominated boolean; v_plan jsonb; v_hold public.booking_holds;
        v_end timestamptz; v_occ timestamptz; v_id uuid; v_source text; v_name text; v_customer uuid; v_user text; v_item jsonb; v_client uuid;
begin
  begin
    v_start := (p->>'starts_at')::timestamptz;
  exception when others then
    return jsonb_build_object('error', 'invalid_starts_at');
  end;
  select array_agg(x) into v_codes from jsonb_array_elements_text(coalesce(p->'menu_codes', '[]'::jsonb)) x;
  v_source := p->>'source';
  if v_source is null or v_source not in ('app', 'hotpepper', 'phone', 'staff') then return jsonb_build_object('error', 'invalid_source'); end if;
  v_name := btrim(coalesce(p->>'customer_name', ''));
  if v_name = '' or length(v_name) > 60 then return jsonb_build_object('error', 'invalid_customer_name'); end if;
  if p->>'customer_phone' is not null and length(p->>'customer_phone') > 20 then return jsonb_build_object('error', 'invalid_phone'); end if;
  if p->>'note' is not null and length(p->>'note') > 500 then return jsonb_build_object('error', 'invalid_note'); end if;

  -- 仮確保からの確定
  if p->>'hold_id' is not null then
    -- 行ロックはスタッフ単位ロックの後（ロック順を固定してデッドロックを避ける）。有効性はロック後に再確認する
    select * into v_hold from public.booking_holds where id = (p->>'hold_id')::uuid;
    if v_hold.id is null or v_hold.released_at is not null or v_hold.converted_reservation_id is not null or v_hold.expires_at <= now() then
      return jsonb_build_object('error', 'hold_expired');
    end if;
    if p->>'holder_user_id' is distinct from v_hold.holder_user_id then return jsonb_build_object('error', 'hold_not_found'); end if;
    v_start := v_hold.starts_at; v_codes := v_hold.menu_codes; v_staff := v_hold.staff_id; v_nominated := v_hold.nominated;
  else
    v_staff := nullif(p->>'staff_id', '')::uuid;
    v_nominated := v_staff is not null;
  end if;
  -- 書き込みロック：担当が決まっていればそのスタッフ、指名なしは担当決めの前に全員分
  if v_staff is null then perform app_private.lock_all_staff(); else perform app_private.lock_staff(array[v_staff]); end if;

  if v_hold.id is not null and exists (select 1 from public.booking_holds h where h.id = v_hold.id
      and (h.released_at is not null or h.converted_reservation_id is not null or h.expires_at <= now())) then
    return jsonb_build_object('error', 'hold_expired');
  end if;
  if v_start is null then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  if v_codes is null then return jsonb_build_object('error', 'invalid_menu'); end if;
  if not app_private.booking_date_open((v_start at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error', 'date_not_open'); end if;
  if not app_private.on_slot_grid(v_start) then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  -- 仮確保からの確定は、仮確保した時点で最短開始を確認済み（確定時は開始前であればよい）
  if v_start < now() + make_interval(mins => case when v_hold.id is null then greatest(p_min_lead_minutes, 0) else 0 end) then
    return jsonb_build_object('error', 'too_late');
  end if;

  if v_staff is null then
    v_staff := app_private.pick_staff(v_start, v_codes, v_hold.id);
    if v_staff is null then return jsonb_build_object('error', 'slot_taken'); end if;
  end if;
  v_plan := app_private.booking_plan(v_staff, v_codes);
  if v_plan is null then return jsonb_build_object('error', 'menu_not_available'); end if;
  v_end := v_start + make_interval(mins => (v_plan->>'duration_min')::int);
  v_occ := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
  if not app_private.slot_is_free(v_staff, v_start, v_end, v_occ, null, v_hold.id) then
    return jsonb_build_object('error', 'slot_taken');
  end if;

  v_customer := nullif(p->>'customer_id', '')::uuid;
  v_user := nullif(p->>'user_id', '');
  if v_customer is null and v_user is not null then
    select id into v_customer from public.customers where user_id = v_user;
  end if;

  begin
    v_client := app_private.booking_client(p, v_customer, v_name, v_source, p_actor_type, p_actor_name);
    if v_client is null then return jsonb_build_object('error', 'client_not_found'); end if;
    insert into public.reservations (staff_id, nominated, staff_confirmed, client_id, customer_id, user_id, customer_name, customer_phone,
      starts_at, ends_at, occupied_until, source, external_ref, total_price, note, created_by)
    values (v_staff, v_nominated, v_nominated, v_client, v_customer, v_user, v_name, nullif(btrim(coalesce(p->>'customer_phone', '')), ''),
      v_start, v_end, v_occ, v_source, nullif(btrim(coalesce(p->>'external_ref', '')), ''),
      (v_plan->>'total_price')::int, nullif(btrim(coalesce(p->>'note', '')), ''), p_actor_name)
    returning id into v_id;
  exception
    when exclusion_violation then return jsonb_build_object('error', 'slot_taken');
    when unique_violation then return jsonb_build_object('error', 'duplicate_external_ref');
  end;
  for v_item in select * from jsonb_array_elements(v_plan->'items') loop
    insert into public.reservation_items (reservation_id, menu_id, menu_code, name, duration_min, buffer_after_min, price, sort_order)
    values (v_id, (v_item->>'menu_id')::uuid, v_item->>'menu_code', v_item->>'name', (v_item->>'duration_min')::int,
            (v_item->>'buffer_after_min')::int, (v_item->>'price')::int, (v_item->>'sort_order')::int);
  end loop;
  if v_hold.id is not null then
    update public.booking_holds set converted_reservation_id = v_id where id = v_hold.id;
  end if;
  perform app_private.log_reservation_event(v_id, 'created', p_actor_type, p_actor_name, null, app_private.reservation_json(v_id));
  return app_private.reservation_json(v_id);
end;
$$;

/** 仮確保（共通） */
create or replace function app_private.create_hold(
  p_starts_at timestamptz, p_menu_codes text[], p_staff_id uuid, p_source text, p_holder_user_id text, p_min_lead_minutes integer
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v_staff uuid := p_staff_id; v_plan jsonb; v_end timestamptz; v_occ timestamptz; v_id uuid; v_exp timestamptz;
begin
  if p_staff_id is null then perform app_private.lock_all_staff(); else perform app_private.lock_staff(array[p_staff_id]); end if;
  if p_starts_at is null or not app_private.on_slot_grid(p_starts_at) then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  if not app_private.booking_date_open((p_starts_at at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error', 'date_not_open'); end if;
  if p_starts_at < now() + make_interval(mins => greatest(p_min_lead_minutes, 0)) then return jsonb_build_object('error', 'too_late'); end if;
  -- 同じ人の未確定の仮確保は1件まで（新しい仮確保で古いものを解放）
  if p_holder_user_id is not null then
    update public.booking_holds set released_at = now()
    where holder_user_id = p_holder_user_id and released_at is null and converted_reservation_id is null;
  end if;
  if v_staff is null then
    v_staff := app_private.pick_staff(p_starts_at, p_menu_codes);
    if v_staff is null then return jsonb_build_object('error', 'slot_taken'); end if;
  end if;
  v_plan := app_private.booking_plan(v_staff, p_menu_codes);
  if v_plan is null then return jsonb_build_object('error', 'menu_not_available'); end if;
  v_end := p_starts_at + make_interval(mins => (v_plan->>'duration_min')::int);
  v_occ := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
  if not app_private.slot_is_free(v_staff, p_starts_at, v_end, v_occ) then return jsonb_build_object('error', 'slot_taken'); end if;
  v_exp := now() + make_interval(mins => (select hold_minutes from public.booking_settings where id = 1));
  insert into public.booking_holds (staff_id, nominated, starts_at, ends_at, occupied_until, menu_codes, source, holder_user_id, expires_at)
  values (v_staff, p_staff_id is not null, p_starts_at, v_end, v_occ, p_menu_codes, p_source, p_holder_user_id, v_exp)
  returning id into v_id;
  -- 古い仮確保の掃除
  delete from public.booking_holds where expires_at < now() - interval '1 day' and converted_reservation_id is null;
  return jsonb_build_object('hold_id', v_id, 'staff_id', v_staff, 'staff_name', (select display_name from public.staff_members where id = v_staff),
    'starts_at', p_starts_at, 'ends_at', v_end, 'expires_at', v_exp, 'total_price', v_plan->'total_price');
end;
$$;

/** 日時・担当の変更（共通） */
create or replace function app_private.reschedule_reservation(
  p_id uuid, p_starts_at timestamptz, p_staff_id uuid, p_actor_type text, p_actor_name text
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare r public.reservations; v_before jsonb; v_codes text[]; v_staff uuid; v_plan jsonb; v_end timestamptz; v_occ timestamptz; v_locked uuid;
begin
  select * into r from public.reservations where id = p_id;
  if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
  perform app_private.lock_staff(array[r.staff_id, p_staff_id]);
  v_locked := r.staff_id;
  select * into r from public.reservations where id = p_id for update;
  -- ロック前に他の操作で担当が変わっていたら、ロックしたスタッフと一致しないため取り直してもらう
  if r.staff_id <> v_locked then return jsonb_build_object('error', 'try_again'); end if;
  if r.status not in ('confirmed', 'checked_in') then return jsonb_build_object('error', 'invalid_status'); end if;
  if r.status = 'checked_in' and p_starts_at is distinct from r.starts_at then return jsonb_build_object('error', 'invalid_status'); end if;
  if p_starts_at is null or not app_private.on_slot_grid(p_starts_at) then return jsonb_build_object('error', 'invalid_starts_at'); end if;
  if not app_private.booking_date_open((p_starts_at at time zone 'Asia/Tokyo')::date) then return jsonb_build_object('error', 'date_not_open'); end if;
  if p_starts_at < now() and p_starts_at is distinct from r.starts_at then return jsonb_build_object('error', 'too_late'); end if;
  v_staff := coalesce(p_staff_id, r.staff_id);
  select array_agg(menu_code order by sort_order) into v_codes from public.reservation_items where reservation_id = p_id;
  v_plan := app_private.booking_plan(v_staff, v_codes);
  if v_plan is null then return jsonb_build_object('error', 'menu_not_available'); end if;
  v_end := p_starts_at + make_interval(mins => (v_plan->>'duration_min')::int);
  v_occ := v_end + make_interval(mins => (v_plan->>'buffer_min')::int);
  if not app_private.slot_is_free(v_staff, p_starts_at, v_end, v_occ, p_id) then return jsonb_build_object('error', 'slot_taken'); end if;
  v_before := app_private.reservation_json(p_id);
  begin
    update public.reservations
    set starts_at = p_starts_at, ends_at = v_end, occupied_until = v_occ, staff_id = v_staff,
        -- 担当を指定した変更＝店舗が担当を決めた（フリー予約の担当確定）。お客様の指名あり／フリーは変えない
        staff_confirmed = case when p_staff_id is not null then true else staff_confirmed end,
        updated_at = now()
    where id = p_id;
  exception when exclusion_violation then return jsonb_build_object('error', 'slot_taken');
  end;
  if p_starts_at <> r.starts_at then
    perform app_private.log_reservation_event(p_id, 'rescheduled', p_actor_type, p_actor_name,
      jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at), jsonb_build_object('starts_at', p_starts_at, 'ends_at', v_end));
  end if;
  if v_staff = r.staff_id and p_staff_id is not null and not r.staff_confirmed then
    perform app_private.log_reservation_event(p_id, 'staff_confirmed', p_actor_type, p_actor_name,
      null, jsonb_build_object('staff_id', v_staff, 'staff_name', v_before->>'staff_name'));
  end if;
  if v_staff <> r.staff_id then
    perform app_private.log_reservation_event(p_id, 'staff_changed', p_actor_type, p_actor_name,
      jsonb_build_object('staff_id', r.staff_id, 'staff_name', v_before->>'staff_name'),
      jsonb_build_object('staff_id', v_staff, 'staff_name', (select display_name from public.staff_members where id = v_staff)));
  end if;
  return app_private.reservation_json(p_id);
end;
$$;

/** ステータス変更（共通）：confirmed → checked_in / no_show / cancelled / completed、checked_in → completed */
create or replace function app_private.set_reservation_status(
  p_id uuid, p_status text, p_actor_type text, p_actor_name text, p_reason text default null
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare r public.reservations; v_ok boolean;
begin
  select * into r from public.reservations where id = p_id for update;
  if r.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_ok := (r.status = 'confirmed' and p_status in ('checked_in', 'no_show', 'cancelled', 'completed'))
       or (r.status = 'checked_in' and p_status in ('in_service', 'awaiting_payment', 'completed'))
       or (r.status = 'in_service' and p_status in ('awaiting_payment', 'completed'))
       or (r.status = 'awaiting_payment' and p_status = 'completed');
  if not v_ok then return jsonb_build_object('error', 'invalid_status'); end if;
  if p_status = 'no_show' and r.starts_at > now() then return jsonb_build_object('error', 'not_started'); end if;
  update public.reservations
  set status = p_status, updated_at = now(),
      -- 施術を始めた時点で担当は確定（フリー予約の仮の担当のまま完了させない）
      staff_confirmed = staff_confirmed or p_status in ('in_service', 'awaiting_payment', 'completed'),
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
      cancel_reason = case when p_status = 'cancelled' then nullif(btrim(coalesce(p_reason, '')), '') else cancel_reason end
  where id = p_id;
  perform app_private.log_reservation_event(p_id, p_status, p_actor_type, p_actor_name,
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status), nullif(btrim(coalesce(p_reason, '')), ''));
  return app_private.reservation_json(p_id);
end;
$$;

/** 将来の有効な予約のうち、勤務時間（通常週・日付の上書き・営業時間・店休日）に収まらなくなったもの */
create or replace function app_private.schedule_conflicts(p_staff_id uuid default null)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'starts_at', r.starts_at, 'customer_name', r.customer_name,
           'staff_name', s.display_name) order by r.starts_at), '[]'::jsonb)
  from public.reservations r join public.staff_members s on s.id = r.staff_id
  where r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment') and r.occupied_until > now()
    and (p_staff_id is null or r.staff_id = p_staff_id)
    and not exists (select 1 from app_private.effective_shifts(r.staff_id, (r.starts_at at time zone 'Asia/Tokyo')::date) e
                    where e.st <= r.starts_at and e.en >= r.occupied_until)
$$;

/** 予定変更の後に呼ぶ。収まらない予約があれば例外（呼び出し側のブロックごと取り消し） */
create or replace function app_private.assert_schedule_ok(p_staff_id uuid default null)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare v jsonb := app_private.schedule_conflicts(p_staff_id);
begin
  if jsonb_array_length(v) > 0 then
    raise exception 'has_reservations' using detail = v::text;
  end if;
end;
$$;

create or replace function app_private.require_actor(p_name text)
returns text language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if p_name is null or btrim(p_name) = '' or length(p_name) > 40 then raise exception 'staff_name_required'; end if;
  return btrim(p_name);
end;
$$;

/** お客様向けの利用可否（Feature Flag） */
create or replace function app_private.assert_app_booking()
returns boolean language sql stable
set search_path = public, extensions, pg_temp
as $$ select app_booking_enabled from public.booking_settings where id = 1 $$;

-- ============================================================================
-- お客様 RPC（顧客セッション必須・Feature Flag が OFF の間は booking_disabled）
-- ============================================================================

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
                         'price', m.price, 'normal_price', m.normal_price) order by m.sort_order)
                       from public.service_menus m
                       where m.is_active and m.duration_min is not null
                         and exists (select 1 from public.staff_menu_capabilities c join public.staff_members s on s.id = c.staff_id
                                     where c.menu_id = m.id and s.is_active and s.is_bookable)), '[]'::json),
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json));
end;
$$;

create or replace function public.customer_available_slots(p_session text, p_date date, p_menu_codes text[], p_staff_id uuid default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.session_user_id(p_session);
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  if p_staff_id is null then
    -- 指名なし：時刻だけ（担当は確定時に決める）
    return coalesce((select json_agg(json_build_object('starts_at', t.starts_at) order by t.starts_at)
                     from (select distinct a.starts_at from app_private.available_slots(p_date, p_menu_codes, null,
                             (select min_lead_minutes from public.booking_settings where id = 1)) a) t), '[]'::json);
  end if;
  return coalesce((select json_agg(json_build_object('starts_at', a.starts_at, 'staff_id', a.staff_id, 'staff_name', a.staff_name) order by a.starts_at)
                   from app_private.available_slots(p_date, p_menu_codes, p_staff_id,
                     (select min_lead_minutes from public.booking_settings where id = 1)) a), '[]'::json);
end;
$$;

create or replace function public.customer_create_hold(p_session text, p_starts_at timestamptz, p_menu_codes text[], p_staff_id uuid default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  return app_private.create_hold(p_starts_at, p_menu_codes, p_staff_id, 'app', v_uid,
    (select min_lead_minutes from public.booking_settings where id = 1))::json;
end;
$$;

create or replace function public.customer_release_hold(p_session text, p_hold_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  update public.booking_holds set released_at = now()
  where id = p_hold_id and holder_user_id = v_uid and released_at is null and converted_reservation_id is null;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.customer_confirm_reservation(p_session text, p_hold_id uuid, p_note text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session); v_c public.customers; v_r jsonb;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select * into v_c from public.customers where user_id = v_uid;
  if v_c.id is null then return json_build_object('error', 'customer_not_found'); end if;
  v_r := app_private.create_reservation(
    jsonb_build_object('hold_id', p_hold_id, 'holder_user_id', v_uid, 'customer_name', v_c.name, 'customer_id', v_c.id,
                       'user_id', v_uid, 'source', 'app', 'note', p_note),
    'customer', v_c.name, (select min_lead_minutes from public.booking_settings where id = 1));
  if v_r ? 'error' then return v_r::json; end if;
  return app_private.reservation_json_customer((v_r->>'id')::uuid)::json;
end;
$$;

create or replace function public.customer_list_reservations(p_session text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session);
begin
  return coalesce((select json_agg(app_private.reservation_json_customer(r.id) order by r.starts_at)
                   from public.reservations r
                   where r.user_id = v_uid and r.starts_at > now() - interval '30 days'), '[]'::json);
end;
$$;

create or replace function public.customer_cancel_reservation(p_session text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid text := app_private.session_user_id(p_session); r public.reservations; v_c public.customers; v_res jsonb;
begin
  if not app_private.assert_app_booking() then return json_build_object('error', 'booking_disabled'); end if;
  select * into r from public.reservations where id = p_reservation_id and user_id = v_uid;
  if r.id is null then return json_build_object('error', 'not_found'); end if;
  if r.starts_at < now() + make_interval(mins => (select customer_cancel_deadline_minutes from public.booking_settings where id = 1)) then
    return json_build_object('error', 'cancel_deadline_passed');
  end if;
  select * into v_c from public.customers where user_id = v_uid;
  v_res := app_private.set_reservation_status(p_reservation_id, 'cancelled', 'customer', coalesce(v_c.name, v_uid), 'お客様アプリからキャンセル');
  if v_res ? 'error' then return v_res::json; end if;
  return app_private.reservation_json_customer(p_reservation_id)::json;
end;
$$;

-- ============================================================================
-- 店舗端末 RPC（スタッフセッション必須）
-- ============================================================================

-- ── 予約台帳・予約操作の共通処理（店舗端末と本部で同じものを使う） ──

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
                       from public.service_menus m where m.is_active and m.duration_min is not null), '[]'::json),
    'staff', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.display_name) order by s.sort_order)
                       from public.staff_members s where s.is_active and s.is_bookable), '[]'::json))
$$;

create or replace function app_private.available_slots_json(p_date date, p_menu_codes text[], p_staff_id uuid, p_exclude_reservation uuid)
returns json language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(json_agg(json_build_object('starts_at', a.starts_at, 'staff_id', a.staff_id, 'staff_name', a.staff_name)
                           order by a.starts_at, a.staff_name), '[]'::json)
  from app_private.available_slots(p_date, p_menu_codes, p_staff_id, 0, p_exclude_reservation) a
$$;

/** 店舗端末・本部からの予約登録（source は phone / hotpepper / staff。アプリ経由はお客様 RPC のみ） */
create or replace function app_private.create_reservation_by_store(p jsonb, p_actor_type text, p_actor_name text)
returns json language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if coalesce(p->>'source', '') not in ('phone', 'hotpepper', 'staff') then return json_build_object('error', 'invalid_source'); end if;
  return app_private.create_reservation(p - 'hold_id' - 'holder_user_id' - 'customer_id', p_actor_type, p_actor_name, 0)::json;
end;
$$;

create or replace function app_private.store_set_status(p_id uuid, p_status text, p_actor_type text, p_actor_name text, p_reason text)
returns json language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if p_status not in ('checked_in', 'in_service', 'awaiting_payment', 'completed', 'no_show', 'cancelled') then
    return json_build_object('error', 'invalid_status');
  end if;
  return app_private.set_reservation_status(p_id, p_status, p_actor_type, p_actor_name, p_reason)::json;
end;
$$;

create or replace function app_private.reservation_events_json(p_id uuid)
returns json language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(json_agg(json_build_object('event_type', e.event_type, 'actor_type', e.actor_type, 'actor_name', e.actor_name,
           'before', e.before, 'after', e.after, 'note', e.note, 'created_at', e.created_at) order by e.created_at, e.id), '[]'::json)
  from public.reservation_events e where e.reservation_id = p_id
$$;

/**
 * 担当変更の候補：同じ時間のまま担当できるスタッフ。日時・担当変更（reschedule_reservation）と同じ判定
 * （booking_plan：そのスタッフで受けられるメニューか ＋ slot_is_free：勤務時間内で、この予約以外と重ならないか）。
 * 来店後（開始時刻を過ぎた予約）でも使えるよう、新規予約用の空き時間（受付締切あり）とは別に求める。
 */
create or replace function app_private.reassign_candidates_json(p_id uuid)
returns json language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare r public.reservations; v_codes text[]; v_out json;
begin
  select * into r from public.reservations where id = p_id;
  if r.id is null or r.status not in ('confirmed', 'checked_in') then return '[]'::json; end if;
  select array_agg(menu_code order by sort_order) into v_codes from public.reservation_items where reservation_id = p_id;
  select coalesce(json_agg(json_build_object('staff_id', m.id, 'staff_name', m.display_name) order by m.sort_order, m.display_name), '[]'::json)
  into v_out
  from public.staff_members m
  cross join lateral (select app_private.booking_plan(m.id, v_codes) as plan) p
  where m.is_active and m.is_bookable and m.id <> r.staff_id and p.plan is not null
    and app_private.slot_is_free(m.id, r.starts_at,
          r.starts_at + make_interval(mins => (p.plan->>'duration_min')::int),
          r.starts_at + make_interval(mins => (p.plan->>'duration_min')::int + (p.plan->>'buffer_min')::int), p_id);
  return v_out;
end;
$$;

/**
 * 予約台帳（1日分）。表示する時間帯・スタッフ列・各スタッフの勤務時間・休憩・予約（全状態）。
 *   スタッフ列：予約を受ける在籍スタッフ（並び順）＋ その日に予約があるスタッフ
 *   勤務時間は空き計算と同じ effective_shifts（通常週・日付の上書き・営業時間・店休日）
 */
create or replace function app_private.day_ledger_json(p_date date)
returns json language sql stable
set search_path = public, extensions, pg_temp
as $$
  with cols as (
    select s.id, s.display_name, s.sort_order from public.staff_members s
    where (s.is_active and s.is_bookable)
       or exists (select 1 from public.reservations r where r.staff_id = s.id and (r.starts_at at time zone 'Asia/Tokyo')::date = p_date)
  )
  select json_build_object(
    'date', p_date,
    'slot_minutes', (select slot_minutes from public.booking_settings where id = 1),
    'closure', (select json_build_object('reason', c.reason) from public.business_closures c where c.closure_date = p_date),
    'business_hours', (select json_build_object('is_closed', b.is_closed, 'open_time', to_char(b.open_time, 'HH24:MI'), 'close_time', to_char(b.close_time, 'HH24:MI'))
                       from public.business_hours b where b.weekday = extract(dow from p_date)::int),
    'staff', coalesce((select json_agg(json_build_object('id', c.id, 'name', c.display_name,
                         'shifts', coalesce((select json_agg(json_build_object('start', e.st, 'end', e.en)) from app_private.effective_shifts(c.id, p_date) e), '[]'::json))
                         order by c.sort_order, c.display_name) from cols c), '[]'::json),
    'blocks', coalesce((select json_agg(json_build_object('id', b.id, 'staff_id', b.staff_id, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'kind', b.kind))
                        from public.time_blocks b
                        where tstzrange(b.starts_at, b.ends_at) && tstzrange(app_private.jst_ts(p_date, '00:00'), app_private.jst_ts(p_date + 1, '00:00'))), '[]'::json),
    'reservations', coalesce((select json_agg(app_private.reservation_json(r.id) order by r.starts_at)
                              from public.reservations r where (r.starts_at at time zone 'Asia/Tokyo')::date = p_date), '[]'::json))
$$;

-- ── 店舗端末（スタッフセッション） ──

create or replace function public.staff_booking_options(p_staff text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.booking_options_json();
end;
$$;

/** p_exclude_reservation：日時変更の対象予約（自分自身の時間を空きとして扱う） */
create or replace function public.staff_available_slots(p_staff text, p_date date, p_menu_codes text[], p_staff_id uuid default null, p_exclude_reservation uuid default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.available_slots_json(p_date, p_menu_codes, p_staff_id, p_exclude_reservation);
end;
$$;

/** p：starts_at, menu_codes[], staff_id(null=指名なし), customer_name, customer_phone, user_id, source(phone/hotpepper/staff), external_ref, note */
create or replace function public.staff_create_reservation(p_staff text, p jsonb, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.create_reservation_by_store(p, 'staff', app_private.require_actor(p_staff_name));
end;
$$;

create or replace function public.staff_day_ledger(p_staff text, p_date date)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.day_ledger_json(p_date);
end;
$$;

create or replace function public.staff_reschedule_reservation(p_staff text, p_reservation_id uuid, p_starts_at timestamptz, p_staff_id uuid, p_staff_name text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.reschedule_reservation(p_reservation_id, p_starts_at, p_staff_id, 'staff', app_private.require_actor(p_staff_name))::json;
end;
$$;

create or replace function public.staff_set_reservation_status(p_staff text, p_reservation_id uuid, p_status text, p_staff_name text, p_reason text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.store_set_status(p_reservation_id, p_status, 'staff', app_private.require_actor(p_staff_name), p_reason);
end;
$$;

create or replace function public.staff_reservation_events(p_staff text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.reservation_events_json(p_reservation_id);
end;
$$;

create or replace function public.staff_reassign_candidates(p_staff text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_staff(p_staff);
  return app_private.reassign_candidates_json(p_reservation_id);
end;
$$;

-- ── 本部（本部セッション）：店舗端末と同じ予約台帳・予約操作。記録上の操作者は「本部」 ──

create or replace function public.hq_day_ledger(p_hq text, p_date date)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.day_ledger_json(p_date);
end;
$$;

create or replace function public.hq_booking_options(p_hq text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.booking_options_json();
end;
$$;

create or replace function public.hq_available_slots(p_hq text, p_date date, p_menu_codes text[], p_staff_id uuid default null, p_exclude_reservation uuid default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.available_slots_json(p_date, p_menu_codes, p_staff_id, p_exclude_reservation);
end;
$$;

create or replace function public.hq_create_reservation(p_hq text, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.create_reservation_by_store(p, 'hq', '本部');
end;
$$;

create or replace function public.hq_reschedule_reservation(p_hq text, p_reservation_id uuid, p_starts_at timestamptz, p_staff_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.reschedule_reservation(p_reservation_id, p_starts_at, p_staff_id, 'hq', '本部')::json;
end;
$$;

create or replace function public.hq_set_reservation_status(p_hq text, p_reservation_id uuid, p_status text, p_reason text default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.store_set_status(p_reservation_id, p_status, 'hq', '本部', p_reason);
end;
$$;

create or replace function public.hq_reservation_events(p_hq text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.reservation_events_json(p_reservation_id);
end;
$$;

create or replace function public.hq_reassign_candidates(p_hq text, p_reservation_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  return app_private.reassign_candidates_json(p_reservation_id);
end;
$$;

-- ============================================================================
-- 本部 RPC（本部セッション必須）：設定・スタッフ・メニュー・シフト・休み
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
    'menus', coalesce((select json_agg(json_build_object('id', m.id, 'code', m.code, 'name', m.name, 'duration_min', m.duration_min,
                         'buffer_after_min', m.buffer_after_min, 'price', m.price, 'normal_price', m.normal_price,
                         'is_active', m.is_active, 'sort_order', m.sort_order,
                         'staff', (select coalesce(json_agg(json_build_object('staff_id', c.staff_id, 'duration_override_min', c.duration_override_min)), '[]'::json)
                                   from public.staff_menu_capabilities c where c.menu_id = m.id))
                         order by m.sort_order, m.name) from public.service_menus m), '[]'::json));
end;
$$;

/** p：slot_minutes, booking_window_days, min_lead_minutes, hold_minutes, customer_cancel_deadline_minutes（app_booking_enabled は変更不可） */
create or replace function public.hq_update_booking_settings(p_hq text, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  update public.booking_settings set
    slot_minutes = coalesce((p->>'slot_minutes')::int, slot_minutes),
    booking_window_days = coalesce((p->>'booking_window_days')::int, booking_window_days),
    min_lead_minutes = coalesce((p->>'min_lead_minutes')::int, min_lead_minutes),
    hold_minutes = coalesce((p->>'hold_minutes')::int, hold_minutes),
    customer_cancel_deadline_minutes = coalesce((p->>'customer_cancel_deadline_minutes')::int, customer_cancel_deadline_minutes),
    updated_at = now()
  where id = 1;
  return (select row_to_json(b) from public.booking_settings b where id = 1);
end;
$$;

/** p：id（更新時）, display_name, is_bookable, is_active, sort_order */
create or replace function public.hq_upsert_staff_member(p_hq text, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.staff_members;
begin
  perform app_private.assert_hq(p_hq);
  if p->>'id' is null then
    insert into public.staff_members (display_name, is_bookable, is_active, sort_order)
    values (btrim(p->>'display_name'), coalesce((p->>'is_bookable')::boolean, true), coalesce((p->>'is_active')::boolean, true),
            coalesce((p->>'sort_order')::int, 100))
    returning * into v;
  else
    update public.staff_members set
      display_name = coalesce(btrim(p->>'display_name'), display_name),
      is_bookable = coalesce((p->>'is_bookable')::boolean, is_bookable),
      is_active = coalesce((p->>'is_active')::boolean, is_active),
      sort_order = coalesce((p->>'sort_order')::int, sort_order),
      updated_at = now()
    where id = (p->>'id')::uuid
    returning * into v;
    if v.id is null then return json_build_object('error', 'not_found'); end if;
  end if;
  return row_to_json(v);
exception when unique_violation then return json_build_object('error', 'duplicate_name');
end;
$$;

/** p：id（更新時）, code（新規のみ）, name, duration_min, buffer_after_min, price, normal_price, is_active, sort_order,
 *    staff：[{staff_id, duration_override_min}]（指定時は担当を置き換え） */
create or replace function public.hq_upsert_menu(p_hq text, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.service_menus; v_s jsonb;
begin
  perform app_private.assert_hq(p_hq);
  if p->>'id' is null then
    insert into public.service_menus (code, name, duration_min, buffer_after_min, price, normal_price, is_active, sort_order)
    values (p->>'code', btrim(p->>'name'), (p->>'duration_min')::int, coalesce((p->>'buffer_after_min')::int, 0),
            (p->>'price')::int, (p->>'normal_price')::int, coalesce((p->>'is_active')::boolean, false), coalesce((p->>'sort_order')::int, 100))
    returning * into v;
  else
    update public.service_menus set
      name = coalesce(btrim(p->>'name'), name),
      duration_min = case when p ? 'duration_min' then (p->>'duration_min')::int else duration_min end,
      buffer_after_min = coalesce((p->>'buffer_after_min')::int, buffer_after_min),
      price = case when p ? 'price' then (p->>'price')::int else price end,
      normal_price = case when p ? 'normal_price' then (p->>'normal_price')::int else normal_price end,
      is_active = coalesce((p->>'is_active')::boolean, is_active),
      sort_order = coalesce((p->>'sort_order')::int, sort_order),
      updated_at = now()
    where id = (p->>'id')::uuid
    returning * into v;
    if v.id is null then return json_build_object('error', 'not_found'); end if;
  end if;
  if v.is_active and v.duration_min is null then raise exception 'duration_required'; end if;
  if p ? 'staff' then
    delete from public.staff_menu_capabilities where menu_id = v.id;
    for v_s in select * from jsonb_array_elements(p->'staff') loop
      insert into public.staff_menu_capabilities (staff_id, menu_id, duration_override_min)
      values ((v_s->>'staff_id')::uuid, v.id, (v_s->>'duration_override_min')::int);
    end loop;
  end if;
  return row_to_json(v);
exception
  when unique_violation then return json_build_object('error', 'duplicate_code');
  when check_violation then return json_build_object('error', 'invalid_value');
  when raise_exception then
    if sqlerrm = 'duration_required' then return json_build_object('error', 'duration_required'); end if;
    raise;
end;
$$;

/** 期間内の各日・各スタッフの勤務（source：template=通常週 / override=日付で変更 / off=日付で休み / none=勤務なし）と休憩・店休日・予約数 */
create or replace function public.hq_list_schedule(p_hq text, p_from date, p_to date)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  if p_to < p_from or p_to - p_from > 62 then return json_build_object('error', 'invalid_range'); end if;
  return json_build_object(
    'days', coalesce((select json_agg(json_build_object(
                'staff_id', s.id, 'date', d.d,
                'source', case when exists (select 1 from public.staff_day_offs o where o.staff_id = s.id and o.off_date = d.d) then 'off'
                               when exists (select 1 from public.staff_shifts x where x.staff_id = s.id and x.work_date = d.d) then 'override'
                               when exists (select 1 from public.staff_shift_templates t where t.staff_id = s.id and t.weekday = extract(dow from d.d)::int) then 'template'
                               else 'none' end,
                'ranges', coalesce((select json_agg(json_build_object('start', to_char(e.st at time zone 'Asia/Tokyo', 'HH24:MI'),
                                                                      'end', case when (e.en at time zone 'Asia/Tokyo')::date > d.d then '24:00'
                                                                                  else to_char(e.en at time zone 'Asia/Tokyo', 'HH24:MI') end))
                                    from app_private.effective_shifts(s.id, d.d) e), '[]'::json))
              order by d.d, s.sort_order)
             from generate_series(p_from, p_to, interval '1 day') g(x)
             cross join lateral (select g.x::date d) d
             cross join public.staff_members s
             where s.is_active), '[]'::json),
    'blocks', coalesce((select json_agg(json_build_object('id', b.id, 'staff_id', b.staff_id, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
                          'kind', b.kind, 'note', b.note) order by b.starts_at)
                        from public.time_blocks b
                        where tstzrange(b.starts_at, b.ends_at) && tstzrange(app_private.jst_ts(p_from, '00:00'), app_private.jst_ts(p_to + 1, '00:00'))), '[]'::json),
    'closures', coalesce((select json_agg(json_build_object('date', c.closure_date, 'reason', c.reason) order by c.closure_date)
                          from public.business_closures c where c.closure_date between p_from and p_to), '[]'::json),
    'reservations', coalesce((select json_agg(json_build_object('staff_id', r.staff_id, 'starts_at', r.starts_at, 'occupied_until', r.occupied_until))
                              from public.reservations r
                              where r.status in ('confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed')
                                and (r.starts_at at time zone 'Asia/Tokyo')::date between p_from and p_to), '[]'::json));
end;
$$;

/** 予定変更の共通エラー応答（has_reservations は該当予約の一覧つき） */
create or replace function app_private.schedule_error(p_message text, p_detail text)
returns json language sql immutable
set search_path = pg_catalog
as $$
  select case when p_message = 'has_reservations'
              then json_build_object('error', 'has_reservations', 'reservations', p_detail::json)
              else json_build_object('error', p_message) end
$$;

/**
 * 通常週のシフトを丸ごと置き換える。p_days：[{weekday(0=日…6=土), start_time, end_time}]（含まれない曜日は休み）。
 * 変更で将来の予約が勤務時間外になる場合は保存しない（has_reservations）。
 */
create or replace function public.hq_set_shift_template(p_hq text, p_staff_id uuid, p_days jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_detail text; v_d jsonb;
begin
  perform app_private.assert_hq(p_hq);
  if not exists (select 1 from public.staff_members where id = p_staff_id) then return json_build_object('error', 'not_found'); end if;
  perform app_private.lock_staff(array[p_staff_id]);
  begin
    delete from public.staff_shift_templates where staff_id = p_staff_id;
    for v_d in select * from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) loop
      insert into public.staff_shift_templates (staff_id, weekday, start_time, end_time)
      values (p_staff_id, (v_d->>'weekday')::smallint, (v_d->>'start_time')::time, (v_d->>'end_time')::time);
    end loop;
    perform app_private.assert_schedule_ok(p_staff_id);
  exception
    when raise_exception then
      get stacked diagnostics v_detail = pg_exception_detail;
      return app_private.schedule_error(sqlerrm, v_detail);
    when check_violation or unique_violation or invalid_datetime_format or invalid_text_representation or datetime_field_overflow then
      return json_build_object('error', 'invalid_time');
  end;
  return json_build_object('ok', true);
end;
$$;

/**
 * 日付ごとの上書き。p_mode：work（その日だけ p_start〜p_end で出勤）/ off（その日は休み）/ template（通常週に戻す）
 */
create or replace function public.hq_set_day_schedule(p_hq text, p_staff_id uuid, p_date date, p_mode text, p_start time default null, p_end time default null)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_detail text;
begin
  perform app_private.assert_hq(p_hq);
  if p_mode not in ('work', 'off', 'template') then return json_build_object('error', 'invalid_value'); end if;
  if not exists (select 1 from public.staff_members where id = p_staff_id) then return json_build_object('error', 'not_found'); end if;
  perform app_private.lock_staff(array[p_staff_id]);
  begin
    delete from public.staff_shifts where staff_id = p_staff_id and work_date = p_date;
    delete from public.staff_day_offs where staff_id = p_staff_id and off_date = p_date;
    if p_mode = 'work' then
      insert into public.staff_shifts (staff_id, work_date, start_time, end_time, created_by) values (p_staff_id, p_date, p_start, p_end, 'hq');
    elsif p_mode = 'off' then
      insert into public.staff_day_offs (staff_id, off_date, created_by) values (p_staff_id, p_date, 'hq');
    end if;
    perform app_private.assert_schedule_ok(p_staff_id);
  exception
    when raise_exception then
      get stacked diagnostics v_detail = pg_exception_detail;
      return app_private.schedule_error(sqlerrm, v_detail);
    when check_violation or not_null_violation or exclusion_violation or invalid_datetime_format or datetime_field_overflow then
      return json_build_object('error', 'invalid_time');
  end;
  return json_build_object('ok', true);
end;
$$;

/** 営業時間を丸ごと置き換える。p_days：[{weekday, is_closed, open_time, close_time}]（含まれない曜日は制限なし） */
create or replace function public.hq_set_business_hours(p_hq text, p_days jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_detail text; v_d jsonb;
begin
  perform app_private.assert_hq(p_hq);
  perform app_private.lock_all_staff();
  begin
    delete from public.business_hours;
    for v_d in select * from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) loop
      insert into public.business_hours (weekday, is_closed, open_time, close_time)
      values ((v_d->>'weekday')::smallint, coalesce((v_d->>'is_closed')::boolean, false),
              nullif(v_d->>'open_time', '')::time, nullif(v_d->>'close_time', '')::time);
    end loop;
    perform app_private.assert_schedule_ok(null);
  exception
    when raise_exception then
      get stacked diagnostics v_detail = pg_exception_detail;
      return app_private.schedule_error(sqlerrm, v_detail);
    when check_violation or unique_violation or invalid_datetime_format or invalid_text_representation or datetime_field_overflow then
      return json_build_object('error', 'invalid_time');
  end;
  return json_build_object('ok', true);
end;
$$;



/** p：staff_id（null=全員）, starts_at, ends_at, kind, note */
create or replace function public.hq_create_time_block(p_hq text, p jsonb)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.time_blocks;
begin
  perform app_private.assert_hq(p_hq);
  if nullif(p->>'staff_id', '') is null then perform app_private.lock_all_staff(); else perform app_private.lock_staff(array[(p->>'staff_id')::uuid]); end if;
  insert into public.time_blocks (staff_id, starts_at, ends_at, kind, note, created_by)
  values (nullif(p->>'staff_id', '')::uuid, (p->>'starts_at')::timestamptz, (p->>'ends_at')::timestamptz, p->>'kind',
          nullif(btrim(coalesce(p->>'note', '')), ''), 'hq')
  returning * into v;
  return row_to_json(v);
exception when check_violation then return json_build_object('error', 'invalid_value');
end;
$$;

create or replace function public.hq_delete_time_block(p_hq text, p_block_id uuid)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  delete from public.time_blocks where id = p_block_id;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.hq_set_closure(p_hq text, p_date date, p_reason text)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_detail text;
begin
  perform app_private.assert_hq(p_hq);
  perform app_private.lock_all_staff();
  begin
    insert into public.business_closures (closure_date, reason) values (p_date, nullif(btrim(coalesce(p_reason, '')), ''))
    on conflict (closure_date) do update set reason = excluded.reason;
    perform app_private.assert_schedule_ok(null);
  exception when raise_exception then
    get stacked diagnostics v_detail = pg_exception_detail;
    return app_private.schedule_error(sqlerrm, v_detail);
  end;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.hq_delete_closure(p_hq text, p_date date)
returns json language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform app_private.assert_hq(p_hq);
  delete from public.business_closures where closure_date = p_date;
  return json_build_object('ok', true);
end;
$$;

-- ── 実行権限：上の RPC だけを anon / authenticated に許可。内部関数は外部から実行不可 ──
do $$
declare f text;
begin
  foreach f in array array[
    'public.customer_booking_options(text)',
    'public.customer_available_slots(text, date, text[], uuid)',
    'public.customer_create_hold(text, timestamptz, text[], uuid)',
    'public.customer_release_hold(text, uuid)',
    'public.customer_confirm_reservation(text, uuid, text)',
    'public.customer_list_reservations(text)',
    'public.customer_cancel_reservation(text, uuid)',
    'public.staff_booking_options(text)',
    'public.staff_available_slots(text, date, text[], uuid, uuid)',
    'public.staff_create_reservation(text, jsonb, text)',
    'public.staff_day_ledger(text, date)',
    'public.staff_reschedule_reservation(text, uuid, timestamptz, uuid, text)',
    'public.staff_set_reservation_status(text, uuid, text, text, text)',
    'public.staff_reservation_events(text, uuid)',
    'public.staff_reassign_candidates(text, uuid)',
    'public.hq_day_ledger(text, date)',
    'public.hq_booking_options(text)',
    'public.hq_available_slots(text, date, text[], uuid, uuid)',
    'public.hq_create_reservation(text, jsonb)',
    'public.hq_reschedule_reservation(text, uuid, timestamptz, uuid)',
    'public.hq_set_reservation_status(text, uuid, text, text)',
    'public.hq_reservation_events(text, uuid)',
    'public.hq_reassign_candidates(text, uuid)',
    'public.hq_booking_masters(text)',
    'public.hq_update_booking_settings(text, jsonb)',
    'public.hq_upsert_staff_member(text, jsonb)',
    'public.hq_upsert_menu(text, jsonb)',
    'public.hq_list_schedule(text, date, date)',
    'public.hq_set_shift_template(text, uuid, jsonb)',
    'public.hq_set_day_schedule(text, uuid, date, text, time, time)',
    'public.hq_set_business_hours(text, jsonb)',
    'public.hq_create_time_block(text, jsonb)',
    'public.hq_delete_time_block(text, uuid)',
    'public.hq_set_closure(text, date, text)',
    'public.hq_delete_closure(text, date)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke all on all functions in schema app_private from public, anon, authenticated;
