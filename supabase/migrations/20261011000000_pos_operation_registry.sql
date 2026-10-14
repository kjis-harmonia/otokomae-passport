-- ============================================================================
-- GINJIRO POS B-2C-1: 操作レジストリ（サーバー側の操作台帳の土台・保存の部品だけ）
--
-- 端末をまたいだ二重処理を防ぐための「操作」の台帳を app_private に作る。この migration は部品だけで、
-- 既存の会計・GINPay・チケットの RPC、表、トリガー、権限は一切変えない（呼び出し元もまだ無い）。
--
--   pos_business_slots         業務の枠（予約・口座・会計・お客様など）。slot_epoch は「見た状態がまだ最新か」の版
--   pos_operations             操作。operation_id はサーバーが作る UUID。状態 prepared→claimed→completed/rejected/abandoned
--   pos_business_instructions  PREPARE で受けた依頼（受理・拒否とも）。書き換え不可
--   pos_operation_keys         既存の二重送信防止キー → 操作。キーの一意の範囲は既存の索引と同じ（D3 GINPay は全種類で1つ）。
--                              キーの文字列そのものは保存せず、範囲ごとの正規化の後の SHA-256（key_digest, bytea）だけを持つ
--   pos_operation_required_targets  CLAIM が宣言した資源の一式（追記のみ・書き換え不可）。claimed のあいだは有効な資源と完全に一致する
--   pos_operation_targets      未解決の操作が押さえている資源（同じ資源は未解決1件だけ）
--   pos_operation_effects      確定済みの効果（会計・GINPay 取引・チケット発行ログの行 ID）→ 操作。1効果は永久に1操作
--   pos_operation_events       履歴（追記のみ）
--
-- 保存する JSON（結果・効果のスナップショット・履歴）は種類ごとの許可リストと型だけ。PIN・承認トークン（APR1）・
-- 見積もりトークン（QTE1）・セッションの秘密は入る場所が無い。会計の quote_hash（QTE1）はそのまま保存せず、指紋（QFP1）にする。
--
-- 順序（C1 の中だけ。既存の書き込み RPC との統合は B-2C-2 以降の N4）:
--   キーの advisory lock（並べ替え）→ 効果の advisory lock（並べ替え）→ 依頼の advisory lock → 枠の行 → 操作の行 → 資源の行 → 履歴
-- advisory lock は2引数形式（名前空間 71000001 キー / 71000002 効果 / 71000003 依頼）。既存の1引数（bigint）の
-- 会計・返金用の lock とは別の空間になる。ハッシュの衝突は待ちが増えるだけで、正しさは表の一意制約で守る。
--
-- 状態の確認・照会・旧データの分類は SELECT だけ（STABLE）。旧データの取り込み（discovery）と fence は別の書き込み関数。
-- 公開 API は作らない（すべて app_private、実行権限はクライアントのロールから外す）。
-- ============================================================================

-- ── 1. 表 ───────────────────────────────────────────────────────────────────

create table if not exists app_private.pos_business_slots (
  slot_key              text primary key check (slot_key ~ '^[a-z_]+:[a-z_]+:\S{1,200}$'),
  slot_kind             text not null check (slot_kind in ('checkout_reservation', 'checkout_client', 'checkout_lane',
                                                           'ginpay_account', 'sale_void', 'ticket_issue_user', 'ginpay_open_family')),
  slot_epoch            bigint not null default 0 check (slot_epoch >= 0),
  active_instruction_id uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists app_private.pos_operations (
  operation_id           uuid primary key default gen_random_uuid(),
  kind                   text not null check (kind in (
                           'checkout_reservation', 'checkout_client', 'checkout_anonymous',
                           'ginpay_charge', 'ginpay_refund', 'hq_ginpay_refund', 'hq_ginpay_void', 'ginpay_adjustment',
                           'hq_sale_void', 'ticket_issue', 'ginpay_open',
                           'legacy_sale', 'legacy_sale_void', 'legacy_ginpay_charge', 'legacy_ginpay_refund',
                           'legacy_ginpay_void', 'legacy_ginpay_adjustment', 'legacy_ticket_issue',
                           'key_tombstone')),
  origin                 text not null check (origin in ('prepared', 'legacy_discovered', 'negative_tombstone',
                                                           'stale_prepare', 'busy_prepare', 'conflict_tombstone')),
  status                 text not null check (status in ('prepared', 'claimed', 'completed', 'rejected', 'abandoned')),
  slot_key               text references app_private.pos_business_slots (slot_key) on delete restrict,
  refused_instruction_id uuid,
  last_code              text check (last_code is null or last_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  result_snapshot        jsonb check (result_snapshot is null or jsonb_typeof(result_snapshot) = 'object'),
  result_snapshot_hash   text check (result_snapshot_hash is null or result_snapshot_hash ~ '^(LEG1|RES1)\.[0-9a-f]{64}$'),
  created_at             timestamptz not null default now(),
  status_changed_at      timestamptz not null default now(),
  terminal_at            timestamptz,
  check ((result_snapshot is null) = (result_snapshot_hash is null)),
  check ((status in ('completed', 'rejected', 'abandoned')) = (terminal_at is not null)),
  check ((origin = 'prepared') = (slot_key is not null)),
  check (origin <> 'prepared' or (kind not like 'legacy\_%' and kind <> 'key_tombstone')),
  check (origin <> 'legacy_discovered' or (status = 'completed' and result_snapshot is not null and kind like 'legacy\_%')),
  check (origin not in ('negative_tombstone', 'stale_prepare', 'busy_prepare', 'conflict_tombstone') or (status = 'abandoned' and result_snapshot is null)),
  check (origin <> 'negative_tombstone' or kind = 'key_tombstone'),
  check ((origin in ('stale_prepare', 'busy_prepare', 'conflict_tombstone')) = (refused_instruction_id is not null))
);
create index if not exists pos_operations_unresolved_idx on app_private.pos_operations (created_at) where status in ('prepared', 'claimed');
create index if not exists pos_operations_slot_idx on app_private.pos_operations (slot_key) where slot_key is not null;

create table if not exists app_private.pos_business_instructions (
  instruction_id   uuid primary key,
  operation_id     uuid not null unique references app_private.pos_operations (operation_id) on delete restrict,
  disposition      text not null check (disposition in ('accepted', 'refused')),
  refusal_code     text check (refusal_code is null or refusal_code in ('stale_epoch', 'slot_busy')),
  kind             text not null,
  slot_key         text not null references app_private.pos_business_slots (slot_key) on delete restrict,
  observed_epoch   bigint not null check (observed_epoch >= 0),
  installed_epoch  bigint,
  facts            jsonb not null check (jsonb_typeof(facts) = 'object'),
  facts_hash       text not null check (facts_hash ~ '^PREP1\.[0-9a-f]{64}$'),
  entry_key_domain text not null,
  entry_key_digest bytea not null check (octet_length(entry_key_digest) = 32),
  actor_type       text check (actor_type is null or actor_type in ('staff', 'hq', 'system', 'test')),
  actor_name       text check (actor_name is null or length(actor_name) <= 100),
  created_at       timestamptz not null default now(),
  check ((disposition = 'accepted') = (refusal_code is null)),
  check ((disposition = 'accepted') = (installed_epoch is not null)),
  check (installed_epoch is null or installed_epoch = observed_epoch + 1)
);
create unique index if not exists pos_business_instructions_slot_epoch_uidx
  on app_private.pos_business_instructions (slot_key, installed_epoch) where disposition = 'accepted';
create index if not exists pos_business_instructions_slot_idx on app_private.pos_business_instructions (slot_key, created_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'pos_business_slots_active_instruction_fkey'
                   and conrelid = 'app_private.pos_business_slots'::regclass) then
    alter table app_private.pos_business_slots
      add constraint pos_business_slots_active_instruction_fkey
      foreign key (active_instruction_id) references app_private.pos_business_instructions (instruction_id) on delete restrict;
  end if;
  -- 拒否・衝突の印が指す依頼は、必ず依頼の表にある行（消せない・付け替えられない）。
  -- stale / busy の拒否は「印の操作 → キー → 依頼」の順に1つのトランザクションで作る（依頼は操作を指す）ので、検査はコミット時。
  -- 衝突の印（conflict_tombstone）は保存済みの依頼を指す。どちらも RESTRICT（依頼の削除・ID の書き換えは即座に失敗）
  if not exists (select 1 from pg_constraint
                 where conname = 'pos_operations_refused_instruction_fkey'
                   and conrelid = 'app_private.pos_operations'::regclass) then
    alter table app_private.pos_operations
      add constraint pos_operations_refused_instruction_fkey
      foreign key (refused_instruction_id) references app_private.pos_business_instructions (instruction_id)
      on update restrict on delete restrict deferrable initially deferred;
  end if;
end $$;

-- 既存の二重送信防止キー。範囲ごとの正規化（D1/D3 は PostgreSQL の btrim、D2/D4 は送られたまま、仮想は送られたまま）の後の
-- キーを、範囲と版の区切りを付けて SHA-256 にした値（key_digest）だけを保存する（pos_op_key_digest）。キーの文字列は保存しない。
--   acct_sale = accounting_sessions.idempotency_key / acct_void = accounting_sessions.void_idempotency_key
--   ginpay_tx = ginpay_transactions.idempotency_key（全種類で1つ） / ticket_issue = ticket_issue_logs.idempotency_key
--   pos_virtual = 物理の列が無い新しい操作用（口座開設など）
-- 今の範囲で同じになるキーは同じ digest、違うキーは違う digest（衝突は SHA-256 として無視できる確率。一意性は (範囲, digest)）。
-- digest は台帳の中の識別子で、秘密でも資格情報でもない（何かを許可する用途に使わない）
create table if not exists app_private.pos_operation_keys (
  key_domain   text not null check (key_domain in ('acct_sale', 'acct_void', 'ginpay_tx', 'ticket_issue', 'pos_virtual')),
  key_digest   bytea not null check (octet_length(key_digest) = 32),
  operation_id uuid not null references app_private.pos_operations (operation_id) on delete restrict,
  key_role     text not null check (key_role in ('entry', 'derived', 'legacy_alias', 'fence')),
  created_at   timestamptz not null default now(),
  primary key (key_domain, key_digest)
);
create unique index if not exists pos_operation_keys_one_entry_uidx on app_private.pos_operation_keys (operation_id) where key_role = 'entry';
create index if not exists pos_operation_keys_operation_idx on app_private.pos_operation_keys (operation_id);

create table if not exists app_private.pos_operation_targets (
  operation_id uuid not null references app_private.pos_operations (operation_id) on delete restrict,
  target_key   text not null check (target_key ~ '^[a-z_]+:\S{1,200}$'),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  released_at  timestamptz,
  primary key (operation_id, target_key),
  check (active = (released_at is null))
);
create unique index if not exists pos_operation_targets_active_uidx on app_private.pos_operation_targets (target_key) where active;

-- CLAIM が宣言した資源の一式。prepared の操作に CLAIM の中でだけ書け、あとから足す・消すことはできない
create table if not exists app_private.pos_operation_required_targets (
  operation_id uuid not null references app_private.pos_operations (operation_id) on delete restrict,
  target_key   text not null check (target_key ~ '^[a-z_]+:\S{1,200}$'),
  created_at   timestamptz not null default now(),
  primary key (operation_id, target_key)
);

create table if not exists app_private.pos_operation_effects (
  effect_domain      text not null check (effect_domain in ('accounting_sale', 'accounting_sale_void', 'ginpay_transaction', 'ticket_issue')),
  effect_identity    uuid not null,
  operation_id       uuid not null references app_private.pos_operations (operation_id) on delete restrict,
  effect_kind        text not null check (effect_kind in ('sale', 'sale_void', 'ginpay_sale_payment', 'ginpay_sale_reversal',
                                                          'ginpay_charge', 'ginpay_refund', 'ginpay_void', 'ginpay_adjustment', 'ticket_issue')),
  parent_domain      text,
  parent_identity    uuid,
  snapshot           jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash      text not null check (snapshot_hash ~ '^LEG1\.[0-9a-f]{64}$'),
  classifier_version text not null check (classifier_version ~ '^[a-z0-9._-]{1,40}$'),
  registered_via     text not null check (registered_via in ('discovery_key', 'discovery_effect', 'writer')),
  registered_at      timestamptz not null default now(),
  primary key (effect_domain, effect_identity),
  -- 子（会計の GINPay 支払い・取消の戻し）は親の範囲と ID が必ずある。親を持たない種類は両方とも null。
  -- NULL との比較は CHECK を素通りするので、IS [NOT] NULL / IS NOT DISTINCT FROM だけで書き、全体も coalesce で false にする
  constraint pos_operation_effects_parent_shape check (coalesce(
    (effect_kind = 'ginpay_sale_payment' and effect_domain = 'ginpay_transaction'
       and parent_domain is not distinct from 'accounting_sale' and parent_identity is not null)
    or (effect_kind = 'ginpay_sale_reversal' and effect_domain = 'ginpay_transaction'
       and parent_domain is not distinct from 'accounting_sale_void' and parent_identity is not null)
    or (effect_kind = 'sale' and effect_domain = 'accounting_sale' and parent_domain is null and parent_identity is null)
    or (effect_kind = 'sale_void' and effect_domain = 'accounting_sale_void' and parent_domain is null and parent_identity is null)
    or (effect_kind = 'ticket_issue' and effect_domain = 'ticket_issue' and parent_domain is null and parent_identity is null)
    or (effect_kind in ('ginpay_charge', 'ginpay_refund', 'ginpay_void', 'ginpay_adjustment') and effect_domain = 'ginpay_transaction'
       and parent_domain is null and parent_identity is null),
    false))
);
create index if not exists pos_operation_effects_operation_idx on app_private.pos_operation_effects (operation_id);

create table if not exists app_private.pos_operation_events (
  event_id     bigint generated always as identity primary key,
  operation_id uuid references app_private.pos_operations (operation_id) on delete restrict,
  slot_key     text references app_private.pos_business_slots (slot_key) on delete restrict,
  event_type   text not null check (event_type in ('prepared', 'claimed', 'completed', 'rejected', 'abandoned', 'refused',
                                                    'tombstoned', 'slot_fenced', 'legacy_discovered', 'legacy_alias_added',
                                                    'legacy_effect_attached')),
  detail       jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at   timestamptz not null default now(),
  check (operation_id is not null or slot_key is not null)
);
create index if not exists pos_operation_events_operation_idx on app_private.pos_operation_events (operation_id, event_id);
-- 依頼の衝突の履歴は1つの操作に1件まで（pos_op_events_guard と pos_op_check_invariants と合わせて、衝突の印にちょうど1件）
create unique index if not exists pos_operation_events_conflict_uidx on app_private.pos_operation_events (operation_id)
  where detail ->> 'reason' = 'instruction_conflict';

-- ── 2. 小さな部品 ───────────────────────────────────────────────────────────

-- 時刻は UTC の固定形式で保存・比較する（セッションのタイムゾーンで値が変わらないように）
create or replace function app_private.pos_op_ts(p timestamptz)
returns text language sql stable
set search_path = public, extensions, pg_temp
as $$ select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $$;

create or replace function app_private.pos_op_hash(p_prefix text, p jsonb)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$ select p_prefix || '.' || app_private.sha256_hex(p::text) $$;

-- 秘密らしい値の形（保存するすべての文字列に共通の決まり。事実・結果・効果・履歴・コード・キー・資源・枠の名前で同じものを使う）：
--   承認トークン APR1. / 見積もりトークン QTE1. / 操作者のセッション OPS1. / Apache MD5 の $apr1$ / Bearer … / JWT（eyJ…）/
--   お客様の提示トークン GJC1.<32 バイトの乱数 base64url 43 文字>（20261009000100 の発行・検証と同じ形。持っていれば来店を名乗れる）/
--   このリポジトリのセッション・端末トークンの生の形（gen_random_bytes の 24〜32 バイトを hex にしたもの）＝ 48 文字以上続く 16 進。
--   文字列の途中（接頭辞の後など）に入っていても当たる
-- UUID（ハイフンあり）や業務の ID（u-…、U+32桁、c1-user-… など）、"GJC1" だけ・形の違う GJC1. は当たらない。
-- 依頼のハッシュ（REQ1./AUTH1.）と見積もりの指紋（QFP1.）は 16 進 64 文字を含むのでここでは当たる。
-- 保存してよいのは、許可リストで型が hash / fp と決まった欄だけ（pos_op_validate_shape が厳密な形で決める）
create or replace function app_private.pos_op_secret_like(p text)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p ~* '(^|[^a-z0-9])(apr1|qte1|ops1)[.$:]' or p ~* '\$apr1\$' or p ~* '^\s*bearer\s'
                  or p ~ '(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.'
                  or p ~* 'gjc1\.[a-z0-9_-]{43}'
                  or p ~* '[0-9a-f]{48}', false)
$$;

-- 秘密らしい項目名（許可リストの外は元々通らないが、名前でも二重に止める）
create or replace function app_private.pos_op_secret_name(p text)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(lower(p) ~ '(pin|apr1|qte1|ops1|gjc1|token|secret|password|passwd|bearer|credential|cookie|otp|session_key|api_?key|private)', false)
$$;

-- 保存する業務コード（last_code・終了／fence の理由・履歴のコード）の唯一の検査：
-- 形（小文字の英数字と _）に加えて、秘密らしい名前でも秘密らしい値の形（pos_op_secret_like）でもないこと。
-- 表の CHECK（pos_operations_last_code_safe）もこれを使う
create or replace function app_private.pos_op_code_ok(p text)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p ~ '^[a-z][a-z0-9_]{0,63}$' and not app_private.pos_op_secret_name(p) and not app_private.pos_op_secret_like(p), false)
$$;

-- 予約されたコード：決まった出どころ（origin）の決まった記録にだけ書ける。返すのはそのコードを持てる origin（null なら予約なし）
--   instruction_conflict = PREPARE が証明した依頼の衝突（conflict_tombstone の tombstoned 履歴の reason だけ）
--   stale_epoch / slot_busy = PREPARE の拒否（stale_prepare / busy_prepare の refused 履歴の code と、依頼の refusal_code だけ）
-- last_code・fence の理由・終了のコードには使えない（表の CHECK・履歴のガード・各関数の入口で止める）
create or replace function app_private.pos_op_reserved_code(p text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case p when 'instruction_conflict' then 'conflict_tombstone' when 'stale_epoch' then 'stale_prepare'
                when 'slot_busy' then 'busy_prepare' end
$$;

-- JSON 全体の検査（入れ子・配列の中も）：文字列の値は pos_op_secret_like、項目名は pos_op_secret_name に当たらないこと
create or replace function app_private.pos_op_json_safe(p jsonb)
returns boolean language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_key text;
  v_val jsonb;
begin
  if p is null then return true; end if;
  case jsonb_typeof(p)
    when 'string' then
      return not app_private.pos_op_secret_like(p #>> '{}');
    when 'array' then
      return not exists (select 1 from jsonb_array_elements(p) e where not app_private.pos_op_json_safe(e));
    when 'object' then
      for v_key, v_val in select key, value from jsonb_each(p) loop
        if app_private.pos_op_secret_name(v_key) or app_private.pos_op_secret_like(v_key) or not app_private.pos_op_json_safe(v_val) then
          return false;
        end if;
      end loop;
      return true;
    else
      return true;
  end case;
end;
$$;

-- 表の境界での検査（JSON 以外の保存する文字列）。直接の INSERT / UPDATE でも、あとで戻されるのを待たずにその場で失敗する
--   コード：pos_operations.last_code は pos_op_code_ok（refusal_code は stale_epoch / slot_busy だけの CHECK のまま）
--   名前：枠・資源・記録者名・分類の版は pos_op_secret_like に当たらないこと
--   二重送信防止キーは文字列として保存しないので、ここの対象ではない（digest だけ。pos_op_key_digest）
-- JSON（事実・結果・効果・履歴）は各表のトリガーが許可リストと pos_op_json_safe で検査する
do $$
declare
  v_c record;
begin
  for v_c in
    select * from (values
      ('pos_operations', 'pos_operations_last_code_safe', 'last_code is null or app_private.pos_op_code_ok(last_code)'),
      ('pos_operations', 'pos_operations_last_code_not_reserved', 'last_code is null or app_private.pos_op_reserved_code(last_code) is null'),
      ('pos_business_slots', 'pos_business_slots_key_safe', 'not app_private.pos_op_secret_like(slot_key)'),
      ('pos_operation_targets', 'pos_operation_targets_key_safe', 'not app_private.pos_op_secret_like(target_key)'),
      ('pos_operation_required_targets', 'pos_operation_required_targets_key_safe', 'not app_private.pos_op_secret_like(target_key)'),
      ('pos_business_instructions', 'pos_business_instructions_text_safe',
        'actor_name is null or not app_private.pos_op_secret_like(actor_name)'),
      ('pos_operation_effects', 'pos_operation_effects_classifier_safe', 'not app_private.pos_op_secret_like(classifier_version)')
    ) as t(tbl, con, expr)
  loop
    if not exists (select 1 from pg_constraint where conname = v_c.con and conrelid = ('app_private.' || v_c.tbl)::regclass) then
      execute format('alter table app_private.%I add constraint %I check (%s)', v_c.tbl, v_c.con, v_c.expr);
    end if;
  end loop;
end $$;

-- 各範囲が保存している形へ（D1/D3 は btrim、D2/D4/仮想は送られたまま）。空なら null
create or replace function app_private.pos_op_key_normalize(p_domain text, p_raw text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case
    when p_raw is null or btrim(p_raw) = '' then null
    when p_domain in ('acct_sale', 'ginpay_tx') then btrim(p_raw)
    when p_domain in ('acct_void', 'ticket_issue', 'pos_virtual') then p_raw
    else null end
$$;

-- キーの台帳上の識別子：SHA-256("ginjiro-pos-key-v1" \0 範囲 \0 正規化済みのキーの UTF-8 バイト列)。32 バイト。
-- 正規化は呼び出し元が先に済ませる（pos_op_key_ident）。範囲・キーは text なので \0 を含まず、区切りはあいまいにならない。
-- キーの形（16 進・トークンに見える文字列など）では何も決めない：どんなキーも digest にでき、文字列は保存しない
create or replace function app_private.pos_op_key_digest(p_domain text, p_canonical text)
returns bytea language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case when p_domain is null or p_canonical is null then null
              else sha256(convert_to('ginjiro-pos-key-v1', 'UTF8') || '\x00'::bytea || convert_to(p_domain, 'UTF8')
                          || '\x00'::bytea || convert_to(p_canonical, 'UTF8')) end
$$;

-- 送られたキー（生の値）→ 範囲の正規化 → digest。空・知らない範囲なら null。生の値は関数の中でだけ使う
create or replace function app_private.pos_op_key_ident(p_domain text, p_raw text)
returns bytea language sql immutable
set search_path = public, extensions, pg_temp
as $$ select app_private.pos_op_key_digest(p_domain, app_private.pos_op_key_normalize(p_domain, p_raw)) $$;

-- 関数の中だけで使うキーの要素 {d: 範囲, v: 正規化済みのキー（一時的。保存しない）, h: digest の 16 進（lock・照合用）, r: 役割}
create or replace function app_private.pos_op_key_elem(p_domain text, p_canonical text, p_role text default null)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object('d', p_domain, 'v', p_canonical,
    'h', encode(app_private.pos_op_key_digest(p_domain, p_canonical), 'hex'), 'r', p_role))
$$;

-- 種類ごとの決まり。min_targets は CLAIM で宣言しなければならない資源の最小数（今の種類はすべて 1。0 を許す種類を足すときはここで明示する）
create or replace function app_private.pos_op_kind_spec(p_kind text)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case p_kind
    when 'checkout_reservation' then '{"min_targets":1,"domain":"acct_sale","prefix":"checkout:","slot_kind":"checkout_reservation","allowed":["reservation_id","client_id","account_id","method","total","ticket_ids"],"required":["reservation_id"]}'
    when 'checkout_client' then '{"min_targets":1,"domain":"acct_sale","prefix":"checkout:","slot_kind":"checkout_client","allowed":["client_id","account_id","method","total","ticket_ids"],"required":["client_id"]}'
    when 'checkout_anonymous' then '{"min_targets":1,"domain":"acct_sale","prefix":"checkout:","slot_kind":"checkout_lane","allowed":["method","total"],"required":[]}'
    when 'ginpay_charge' then '{"min_targets":1,"domain":"ginpay_tx","prefix":"staff-store-charge:","slot_kind":"ginpay_account","allowed":["account_id","client_id","amount","method"],"required":["account_id","amount"]}'
    when 'ginpay_refund' then '{"min_targets":1,"domain":"ginpay_tx","prefix":"staff-refund:","slot_kind":"ginpay_account","allowed":["account_id","original_transaction_id","amount"],"required":["account_id","original_transaction_id","amount"]}'
    when 'hq_ginpay_refund' then '{"min_targets":1,"domain":"ginpay_tx","prefix":"hq-refund:","slot_kind":"ginpay_account","allowed":["account_id","original_transaction_id","amount"],"required":["account_id","original_transaction_id","amount"]}'
    when 'hq_ginpay_void' then '{"min_targets":1,"domain":"ginpay_tx","prefix":"hq-void:","slot_kind":"ginpay_account","allowed":["account_id","original_transaction_id"],"required":["account_id","original_transaction_id"]}'
    when 'ginpay_adjustment' then '{"min_targets":1,"domain":"ginpay_tx","prefix":"hq-adjustment:","slot_kind":"ginpay_account","allowed":["account_id","amount"],"required":["account_id","amount"]}'
    when 'hq_sale_void' then '{"min_targets":1,"domain":"acct_void","prefix":"hq-sale-void:","slot_kind":"sale_void","allowed":["sale_id"],"required":["sale_id"]}'
    when 'ticket_issue' then '{"min_targets":1,"domain":"ticket_issue","prefix":"ticket-issue:","slot_kind":"ticket_issue_user","allowed":["user_id","ticket_type","amount","quantity"],"required":["user_id","ticket_type","amount","quantity"]}'
    when 'ginpay_open' then '{"min_targets":1,"domain":"pos_virtual","prefix":"ginpay-open:","slot_kind":"ginpay_open_family","allowed":["client_id"],"required":["client_id"]}'
  end::jsonb
$$;

create or replace function app_private.pos_op_is_uuid_text(p text)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp
as $$ select coalesce(p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) $$;

-- 新しいキーは種類ごとの接頭辞 + 小文字の UUID だけ（前後の空白・制御文字・別の接頭辞・予約済みの sale:/sale-void:/stripe: は通らない）
create or replace function app_private.pos_op_key_admissible(p_kind text, p_key text)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    p_key ~ ('^' || (app_private.pos_op_kind_spec(p_kind) ->> 'prefix') || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    false)
$$;

create or replace function app_private.pos_op_fact_value_ok(p_key text, p jsonb)
returns boolean language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_items text[];
begin
  if p is null then return false; end if;
  case p_key
    when 'reservation_id', 'client_id', 'account_id', 'original_transaction_id', 'sale_id' then
      return jsonb_typeof(p) = 'string' and app_private.pos_op_is_uuid_text(p #>> '{}');
    when 'user_id' then
      -- 形が自由な唯一の文字列の事実。値の形でも秘密らしいものを止める（UUID や業務の ID は通る）
      return jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^\S{1,200}$' and not app_private.pos_op_secret_like(p #>> '{}');
    when 'method' then
      return jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^[a-z_]{1,20}$';
    when 'ticket_type' then
      return jsonb_typeof(p) = 'string' and (p #>> '{}') in ('coupon', 'discount', 'otoku', 'cut-ticket');
    when 'amount' then
      return jsonb_typeof(p) = 'number' and p::text ~ '^-?[0-9]{1,8}$' and p::text::bigint between -10000000 and 10000000 and p::text::bigint <> 0;
    when 'total' then
      return jsonb_typeof(p) = 'number' and p::text ~ '^[0-9]{1,8}$' and p::text::bigint <= 10000000;
    when 'quantity' then
      return jsonb_typeof(p) = 'number' and p::text ~ '^[0-9]{1,3}$' and p::text::integer between 1 and 100;
    when 'ticket_ids' then
      if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 50 then return false; end if;
      if exists (select 1 from jsonb_array_elements(p) e where jsonb_typeof(e) <> 'string' or not app_private.pos_op_is_uuid_text(e #>> '{}')) then
        return false;
      end if;
      select array_agg(e order by ord) into v_items from jsonb_array_elements_text(p) with ordinality as x(e, ord);
      -- 並び順を正規化しておく（重複なし・昇順）。同じ依頼が別の順で来て別の依頼に見えないように
      return v_items is null or v_items = (select array_agg(distinct x order by x) from unnest(v_items) x);
    else
      return false;
  end case;
end;
$$;

-- 事実は種類ごとの許可リストだけ（項目名・JSON の型・入れ子の形）。加えて、すべての文字列の値と項目名が
-- 結果・効果・履歴と同じ秘密の形の決まり（pos_op_json_safe）を通ること。PIN・APR1・QTE1・セッションの秘密は保存しない
create or replace function app_private.pos_op_validate_facts(p_kind text, p_facts jsonb)
returns text language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_spec jsonb := app_private.pos_op_kind_spec(p_kind);
  v_key text;
  v_val jsonb;
begin
  if v_spec is null then return 'invalid_kind'; end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' then return 'invalid_facts'; end if;
  if not app_private.pos_op_json_safe(p_facts) then return 'unsafe_fact_value'; end if;
  for v_key, v_val in select key, value from jsonb_each(p_facts) loop
    if not ((v_spec -> 'allowed') ? v_key) then return 'unknown_fact'; end if;
    if not app_private.pos_op_fact_value_ok(v_key, v_val) then return 'invalid_fact_value'; end if;
  end loop;
  for v_key in select jsonb_array_elements_text(v_spec -> 'required') loop
    if not (p_facts ? v_key) then return 'missing_fact'; end if;
  end loop;
  return null;
end;
$$;

-- 枠はサーバーが事実から決める（クライアントから枠の名前は受け取らない）。匿名の会計だけは端末のレーン ID
create or replace function app_private.pos_op_slot_key(p_kind text, p_facts jsonb, p_lane text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case p_kind
    when 'checkout_reservation' then 'checkout:reservation:' || (p_facts ->> 'reservation_id')
    when 'checkout_client' then 'checkout:client:' || (p_facts ->> 'client_id')
    when 'checkout_anonymous' then case when app_private.pos_op_is_uuid_text(p_lane) then 'checkout:lane:' || p_lane end
    when 'ginpay_charge' then 'ginpay:account:' || (p_facts ->> 'account_id')
    when 'ginpay_refund' then 'ginpay:account:' || (p_facts ->> 'account_id')
    when 'hq_ginpay_refund' then 'ginpay:account:' || (p_facts ->> 'account_id')
    when 'hq_ginpay_void' then 'ginpay:account:' || (p_facts ->> 'account_id')
    when 'ginpay_adjustment' then 'ginpay:account:' || (p_facts ->> 'account_id')
    when 'hq_sale_void' then 'sale_void:sale:' || (p_facts ->> 'sale_id')
    when 'ticket_issue' then 'ticket_issue:user:' || (p_facts ->> 'user_id')
    when 'ginpay_open' then 'ginpay_open:family:' || (p_facts ->> 'client_id')
  end
$$;

-- 依頼のキー一式：入口のキーと、会計の GINPay 支払いに使われる sale:<key>（同じ操作の派生キー）。
-- 派生キーは生のキーがある今ここで作り、両方の digest を保存する（あとで生のキーを組み立て直さない）
create or replace function app_private.pos_op_request_keys(p_kind text, p_key text)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_array(app_private.pos_op_key_elem(app_private.pos_op_kind_spec(p_kind) ->> 'domain', p_key, 'entry'))
    || case when p_kind in ('checkout_reservation', 'checkout_client', 'checkout_anonymous')
            then jsonb_build_array(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || p_key, 'derived'))
            else '[]'::jsonb end
$$;

-- {d, h} だけの配列 / {d, i} だけの配列（集合の比較用）
create or replace function app_private.pos_op_dh(p jsonb)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('d', e ->> 'd', 'h', e ->> 'h')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e
$$;

create or replace function app_private.pos_op_di(p jsonb)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('d', e ->> 'd', 'i', e ->> 'i')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e
$$;

-- ── 2b. 保存する JSON の許可リスト（結果・効果のスナップショット・履歴） ─────────────
-- 型の名前の最後の ? は null を許す。入れ子は決まった形（uuids / tickets / effects / headline）だけ
-- 二重送信防止キーはどのスナップショットにも入れない（効果は行 ID で特定し、キーは pos_operation_keys の digest で結ぶ）

create or replace function app_private.pos_op_snapshot_schema(p_surface text)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case p_surface
    -- 会計。quote_hash（QTE1）は保存せず、指紋（QFP1）だけにする
    when 'effect:sale' then '{"sale_id":"uuid","status_at_discovery":"code","completed_at":"ts","total":"int","subtotal":"int","discount_total":"int",
                              "payment_method":"code?","reservation_id":"uuid?","client_id":"uuid?","used_ticket_ids":"uuids",
                              "request_hash":"hash?","quote_fingerprint":"fp?"}'
    when 'effect:sale_void' then '{"sale_id":"uuid","voided_at":"ts","void_request_hash":"hash?",
                                   "reversal_transaction_ids":"uuids"}'
    when 'effect:ginpay' then '{"transaction_id":"uuid","account_id":"uuid","type":"code","amount":"int","status":"code",
                                "accounting_session_id":"uuid?","original_transaction_id":"uuid?","created_at":"ts"}'
    when 'effect:ticket_issue' then '{"log_id":"uuid","user_id":"userid","ticket_type":"code","amount":"int","quantity":"int","ticket_ids":"uuids",
                                      "tickets":"tickets","request_hash":"hash","status":"code","issued_at":"ts?"}'
    when 'result:legacy' then '{"representative_only":"true","kind":"code","classifier_version":"ver","initial_effects":"effects","headline":"headline"}'
    when 'result:checkout' then '{"sale_id":"uuid","total":"int","ginpay_transaction_id":"uuid?","balance_after":"int?"}'
    when 'result:ginpay' then '{"transaction_id":"uuid","amount":"int","balance_after":"int?"}'
    when 'result:sale_void' then '{"sale_id":"uuid","reversal_transaction_ids":"uuids"}'
    when 'result:ticket_issue' then '{"log_id":"uuid","ticket_ids":"uuids"}'
    when 'result:ginpay_open' then '{"account_id":"uuid"}'
    when 'headline' then '{"sale_id":"uuid","total":"int","payment_method":"code?","reversal_amount":"int?","transaction_id":"uuid","type":"code",
                           "amount":"int","log_id":"uuid","ticket_type":"code","quantity":"int"}'
    when 'event' then '{"reason":"code","keys":"int","code":"code?","observed_epoch":"int","slot_epoch":"int","installed_epoch":"int",
                        "targets":"int","targets_released":"int","effects":"int","via":"code","effect_domain":"code","effect_kind":"code",
                        "key_domain":"code"}'
  end::jsonb
$$;

-- 許可リストの検査：知らない項目・秘密らしい項目名・型の違い・（p_all_required なら）足りない項目は不可。理由のコードを返す（null なら OK）
create or replace function app_private.pos_op_validate_shape(p_schema jsonb, p jsonb, p_all_required boolean)
returns text language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_key text;
  v_val jsonb;
begin
  if p_schema is null then return 'unknown_surface'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then return 'not_object'; end if;
  -- 秘密の形の検査（pos_op_json_safe）が先。例外は、許可リストで型が hash（REQ1./AUTH1. + 64桁）・fp（QFP1. + 64桁）と
  -- 決まった欄の値だけで、それは pos_op_value_ok の厳密な形（接頭辞・長さ・16 進の小文字）で決める。
  -- 接頭辞の無い 64 桁の 16 進は生のセッショントークンと見分けられないので、型の付いた欄でも通さない
  for v_key, v_val in select key, value from jsonb_each(p) loop
    if app_private.pos_op_secret_name(v_key) or app_private.pos_op_secret_like(v_key)
       or (rtrim(p_schema ->> v_key, '?') is distinct from 'hash' and rtrim(p_schema ->> v_key, '?') is distinct from 'fp'
           and not app_private.pos_op_json_safe(v_val)) then
      return 'secret_like_value';
    end if;
  end loop;
  for v_key, v_val in select key, value from jsonb_each(p) loop
    if app_private.pos_op_secret_name(v_key) then return 'secret_like_key'; end if;
    if not (p_schema ? v_key) then return 'unknown_key'; end if;
    if not app_private.pos_op_value_ok(p_schema ->> v_key, v_val) then return 'invalid_value'; end if;
  end loop;
  if p_all_required then
    for v_key in select jsonb_object_keys(p_schema) loop
      if not (p ? v_key) then return 'missing_key'; end if;
    end loop;
  end if;
  return null;
end;
$$;

create or replace function app_private.pos_op_value_ok(p_type text, p jsonb)
returns boolean language plpgsql immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_t text := rtrim(p_type, '?');
  v_s text;
begin
  if p is null or p_type is null then return false; end if;
  if jsonb_typeof(p) = 'null' then return right(p_type, 1) = '?'; end if;
  if jsonb_typeof(p) = 'string' then v_s := p #>> '{}'; end if;
  case v_t
    when 'uuid' then return app_private.pos_op_is_uuid_text(v_s);
    when 'int' then return jsonb_typeof(p) = 'number' and p::text ~ '^-?[0-9]{1,12}$';
    when 'true' then return p = 'true'::jsonb;
    when 'ts' then return coalesce(v_s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$', false);
    when 'code' then return coalesce(v_s ~ '^[a-z][a-z0-9_-]{0,63}$' and not app_private.pos_op_secret_name(v_s)
                                     and not app_private.pos_op_secret_like(v_s), false);
    -- 業務の整合性のための決まった形のハッシュ（依頼の正規化した事実の SHA-256）。トークンではない。
    -- 今のコードが書くのは REQ1.（会計：pos_sale_request_hash / finalize_sale）と AUTH1.（pos_auth_hash ほか）だけ
    when 'hash' then return coalesce(v_s ~ '^(REQ1|AUTH1)\.[0-9a-f]{64}$', false);
    when 'fp' then return coalesce(v_s ~ '^QFP1\.[0-9a-f]{64}$', false);
    when 'userid' then return coalesce(v_s ~ '^\S{1,200}$' and not app_private.pos_op_secret_like(v_s), false);
    when 'ver' then return coalesce(v_s ~ '^[a-z0-9._-]{1,40}$', false);
    when 'uuids' then
      return jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 200
        and not exists (select 1 from jsonb_array_elements(p) x
                        where not app_private.pos_op_is_uuid_text(case when jsonb_typeof(x) = 'string' then x #>> '{}' end));
    when 'tickets' then
      return jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 200
        and not exists (select 1 from jsonb_array_elements(p) x
                        where jsonb_typeof(x) <> 'object'
                           or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['amount', 'id', 'type']
                           or not app_private.pos_op_value_ok('uuid', x -> 'id') or not app_private.pos_op_value_ok('code', x -> 'type')
                           or not app_private.pos_op_value_ok('int', x -> 'amount'));
    when 'effects' then
      return jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 50
        and not exists (select 1 from jsonb_array_elements(p) x
                        where jsonb_typeof(x) <> 'object'
                           or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['d', 'i', 'k']
                           or not app_private.pos_op_value_ok('code', x -> 'd') or not app_private.pos_op_value_ok('uuid', x -> 'i')
                           or not app_private.pos_op_value_ok('code', x -> 'k'));
    when 'headline' then
      return app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('headline'), p, false) is null;
    else
      return false;
  end case;
end;
$$;

create or replace function app_private.pos_op_validate_effect_snapshot(p_effect_kind text, p jsonb)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema(case
           when p_effect_kind in ('sale', 'sale_void', 'ticket_issue') then 'effect:' || p_effect_kind
           when p_effect_kind in ('ginpay_sale_payment', 'ginpay_sale_reversal', 'ginpay_charge', 'ginpay_refund', 'ginpay_void', 'ginpay_adjustment')
             then 'effect:ginpay' end), p, true)
$$;

-- 操作の結果：旧データの代表（全項目が必要）か、種類ごとの結果（項目は任意。空は不可）
create or replace function app_private.pos_op_validate_result(p_kind text, p_origin text, p jsonb)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case
    when p_origin = 'legacy_discovered' then app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('result:legacy'), p, true)
    when p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then 'not_object'
    else app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema(case
           when p_kind in ('checkout_reservation', 'checkout_client', 'checkout_anonymous') then 'result:checkout'
           when p_kind in ('ginpay_charge', 'ginpay_refund', 'hq_ginpay_refund', 'hq_ginpay_void', 'ginpay_adjustment') then 'result:ginpay'
           when p_kind = 'hq_sale_void' then 'result:sale_void'
           when p_kind = 'ticket_issue' then 'result:ticket_issue'
           when p_kind = 'ginpay_open' then 'result:ginpay_open' end), p, false) end
$$;

-- ── 3. advisory lock（キー → 効果 → 依頼。lock id で並べ替え、重複は1回だけ） ──
-- ここの lock はすべて pg_advisory_xact_lock（トランザクションの終わりで必ず外れる）。セッション単位の pg_advisory_lock は使わない。

/**
 * キーの lock の唯一の入口。キー一式（{d: 範囲, h: digest の 16 進}）を受け取り、lock id（hashtext(範囲 + digest)）で重複を除いて並べ替え、
 * 全部を pg_advisory_xact_lock で取ってから戻る（途中で戻らない・あとから別のキーを足さない）。
 * PREPARE・CLAIM・終了（pos_op_finish）・fence（キー）・旧データの取り込みは、すべてここを通ってキーを取る。
 * トランザクション単位であることは、この関数が pg_advisory_xact_lock を使うことで保証する（pg_locks からは分からない）
 * lock id は保存済みの digest から決まるので、操作のキー一式（pos_op_operation_keys）だけで計画でき、生のキーは要らない
 */
create or replace function app_private.pos_op_key_lock_id(p jsonb)
returns integer language sql immutable
set search_path = public, extensions, pg_temp
as $$ select hashtext((p ->> 'd') || chr(31) || (p ->> 'h')) $$;

create or replace function app_private.pos_op_lock_keys_xact(p_keys jsonb)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_h integer;
begin
  -- digest の無い要素は lock できない（null の lock id は何も取らずに通ってしまうので止める）
  if exists (select 1 from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) e
             where e ->> 'd' is null or coalesce(e ->> 'h', '') !~ '^[0-9a-f]{64}$') then
    raise exception 'pos_key_identity_missing';
  end if;
  for v_h in
    select distinct app_private.pos_op_key_lock_id(e)
    from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) e
    order by 1
  loop
    perform pg_advisory_xact_lock(71000001, v_h);
  end loop;
end;
$$;

create or replace function app_private.pos_op_lock_effects(p_effects jsonb)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_h integer;
begin
  for v_h in
    select distinct hashtext((e ->> 'd') || chr(31) || (e ->> 'i'))
    from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) e
    order by 1
  loop
    perform pg_advisory_xact_lock(71000002, v_h);
  end loop;
end;
$$;

create or replace function app_private.pos_op_lock_instruction(p_instruction_id uuid)
returns void language sql
set search_path = public, extensions, pg_temp
as $$ select pg_advisory_xact_lock(71000003, hashtext(p_instruction_id::text)) $$;

-- 操作のキー一式（lock の単位）。prepared の操作のキー（entry・derived）は PREPARE で一度に作られ、あとから増えない。
-- 保存済みの digest だけで作る（{d, h}）
create or replace function app_private.pos_op_operation_keys(p_operation_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('d', key_domain, 'h', encode(key_digest, 'hex')) order by key_domain, key_digest), '[]'::jsonb)
  from app_private.pos_operation_keys where operation_id = p_operation_id and key_role in ('entry', 'derived')
$$;

/**
 * 前提の確認（持っているかどうかだけ）：今のバックエンドが、渡したキー一式の advisory lock を
 * ExclusiveLock ですべて持っていること。ShareLock・ほかのバックエンド・待ち中（未取得）は不可。
 * これで分かるのは「今、排他で持っている」ことだけ。pg_locks からは pg_advisory_lock（セッション）か
 * pg_advisory_xact_lock（トランザクション）かは区別できないので、トランザクション単位であることの証明ではない。
 * トランザクション単位は、呼び出し元が pos_op_lock_keys_xact で取ることで保証する
 */
create or replace function app_private.pos_op_assert_keys_locked(p_keys jsonb)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) e
    where not exists (
      select 1 from pg_locks l
      where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.mode = 'ExclusiveLock' and l.objsubid = 2
        and l.database = (select oid from pg_database where datname = current_database())
        and l.classid::bigint = 71000001
        and l.objid::bigint = (app_private.pos_op_key_lock_id(e)::bigint & 4294967295))) then
    raise exception 'pos_lock_order_violation: operation keys must be locked before terminal transition';
  end if;
end;
$$;

-- 既存の会計・GINPay・チケットの表にそのキーがあるか（物理の照会はすべてここを通す。読むだけ：lock・書き込み・履歴なし）
-- D1/D3 は登録簿と同じ btrim の同値類をまるごと見る：btrim(既存の行のキー) = 正規化したキー（NULL の行はどのキーとも同じでない）
--   0 行                          → physical_key_absent（物理に無いと言えるのはこれだけ）
--   1 行・行のキーが正規化した形  → physical_key_canonical_single（id はその行）
--   1 行・行のキーが正規化した形でない（例：'  K  '）→ physical_key_noncanonical
--   2 行以上（K と '  K  '、' K' と 'K ' など）→ physical_key_ambiguous（どの行も選ばない）
-- D2/D4 は送られたままの文字列の一致だけ（btrim しない）。仮想の範囲は物理の列が無いので absent。
-- 既存の表の一意索引は生の値なので、btrim の照会は索引を使えないことがある（C1 では既存の表に索引を足さない）
create or replace function app_private.pos_op_physical_probe(p_domain text, p_key text)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm text := app_private.pos_op_key_normalize(p_domain, p_key);
  v_n bigint;
  v_exact bigint;
  v_ids uuid[];
begin
  if v_norm is null then return jsonb_build_object('state', 'invalid_key'); end if;
  case p_domain
    when 'acct_sale' then
      select count(*), count(*) filter (where idempotency_key = v_norm), array_agg(id) filter (where idempotency_key = v_norm)
      into v_n, v_exact, v_ids from public.accounting_sessions where btrim(idempotency_key) = v_norm;
    when 'ginpay_tx' then
      select count(*), count(*) filter (where idempotency_key = v_norm), array_agg(id) filter (where idempotency_key = v_norm)
      into v_n, v_exact, v_ids from public.ginpay_transactions where btrim(idempotency_key) = v_norm;
    when 'acct_void' then
      select count(*), count(*), array_agg(id) into v_n, v_exact, v_ids
      from public.accounting_sessions where void_idempotency_key = v_norm;
    when 'ticket_issue' then
      select count(*), count(*), array_agg(id) into v_n, v_exact, v_ids
      from public.ticket_issue_logs where idempotency_key = v_norm;
    when 'pos_virtual' then
      v_n := 0;
    else
      return jsonb_build_object('state', 'invalid_key');
  end case;
  if v_n = 0 then return jsonb_build_object('state', 'physical_key_absent'); end if;
  if v_n > 1 then return jsonb_build_object('state', 'physical_key_ambiguous'); end if;
  if v_exact = 1 then return jsonb_build_object('state', 'physical_key_canonical_single', 'id', v_ids[1]); end if;
  return jsonb_build_object('state', 'physical_key_noncanonical');
end;
$$;

-- そのキーの同値類に既存の行が1つでもあるか（正規・正規でない・あいまいのどれでも true）
create or replace function app_private.pos_op_key_present(p_domain text, p_value text)
returns boolean language sql stable
set search_path = public, extensions, pg_temp
as $$ select app_private.pos_op_physical_probe(p_domain, p_value) ->> 'state' <> 'physical_key_absent' $$;

-- 物理の状態 → 書かずに断るときのコード（absent・正規の1行なら null）
create or replace function app_private.pos_op_physical_refusal(p_state text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case p_state when 'physical_key_noncanonical' then 'legacy_key_noncanonical'
                      when 'physical_key_ambiguous' then 'legacy_key_ambiguous'
                      when 'invalid_key' then 'invalid_key' end
$$;

-- キーの要素 {d, v} の一覧のうち、物理の同値類が正規でない・あいまいなものがあればその状態（あいまいを先に）。無ければ null
create or replace function app_private.pos_op_probe_blocked_reason(p_keys jsonb)
returns text language sql stable
set search_path = public, extensions, pg_temp
as $$
  select case when bool_or(s = 'physical_key_ambiguous') then 'physical_key_ambiguous'
              when bool_or(s = 'physical_key_noncanonical') then 'physical_key_noncanonical' end
  from (select app_private.pos_op_physical_probe(e ->> 'd', e ->> 'v') ->> 'state' s
        from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) e) x
$$;

-- ── 4. 不変・遷移のトリガー ───────────────────────────────────────────────────

create or replace function app_private.pos_op_forbid_mutation()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  raise exception 'pos_registry_immutable: % on %.%', tg_op, tg_table_schema, tg_table_name;
end;
$$;

create or replace function app_private.pos_op_operations_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.status_changed_at := now();
    if new.origin = 'prepared' then
      -- 通常の操作は prepared でしか作れない
      if new.status <> 'prepared' or new.result_snapshot is not null or new.last_code is not null then
        raise exception 'pos_operation_invalid_construction';
      end if;
      new.terminal_at := null;
    elsif new.origin = 'legacy_discovered' then
      -- 旧データの確定済み効果だけ、最初から completed で作れる（代表の結果を固定）
      if new.status <> 'completed' or new.result_snapshot is null
         or new.result_snapshot_hash is distinct from app_private.pos_op_hash('LEG1', new.result_snapshot) then
        raise exception 'pos_operation_invalid_construction';
      end if;
      if app_private.pos_op_validate_result(new.kind, new.origin, new.result_snapshot) is not null then
        raise exception 'pos_operation_invalid_result: %', app_private.pos_op_validate_result(new.kind, new.origin, new.result_snapshot);
      end if;
      new.terminal_at := now();
    else
      -- 取り消し済みの印（tombstone）は最初から abandoned
      if new.status <> 'abandoned' or new.result_snapshot is not null then
        raise exception 'pos_operation_invalid_construction';
      end if;
      new.terminal_at := now();
    end if;
    return new;
  end if;

  if old.status in ('completed', 'rejected', 'abandoned') then
    raise exception 'pos_operation_terminal_immutable';
  end if;
  if (new.operation_id, new.kind, new.origin, new.slot_key, new.refused_instruction_id, new.created_at)
     is distinct from (old.operation_id, old.kind, old.origin, old.slot_key, old.refused_instruction_id, old.created_at) then
    raise exception 'pos_operation_identity_immutable';
  end if;
  if new.last_code is distinct from old.last_code and not app_private.pos_op_code_ok(new.last_code) then
    raise exception 'pos_operation_invalid_code';
  end if;
  if new.last_code is distinct from old.last_code and app_private.pos_op_reserved_code(new.last_code) is not null then
    raise exception 'pos_operation_reserved_code: %', new.last_code;
  end if;
  if new.status = old.status then
    -- 状態はそのまま、途中の業務コード（承認待ちなど）だけ書き換え
    if new.result_snapshot is distinct from old.result_snapshot or new.terminal_at is distinct from old.terminal_at then
      raise exception 'pos_operation_invalid_transition';
    end if;
    new.status_changed_at := old.status_changed_at;
    return new;
  end if;
  if not ((old.status = 'prepared' and new.status in ('claimed', 'abandoned'))
       or (old.status = 'claimed' and new.status in ('completed', 'rejected', 'abandoned'))) then
    raise exception 'pos_operation_invalid_transition: % -> %', old.status, new.status;
  end if;
  if new.result_snapshot is distinct from old.result_snapshot then
    if old.result_snapshot is not null or new.status <> 'completed'
       or new.result_snapshot_hash is distinct from app_private.pos_op_hash('RES1', new.result_snapshot)
       or app_private.pos_op_validate_result(new.kind, new.origin, new.result_snapshot) is not null then
      raise exception 'pos_operation_invalid_result';
    end if;
  end if;
  new.status_changed_at := now();
  new.terminal_at := case when new.status in ('completed', 'rejected', 'abandoned') then now() end;
  return new;
end;
$$;

create or replace function app_private.pos_op_keys_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_op app_private.pos_operations;
begin
  select * into v_op from app_private.pos_operations where operation_id = new.operation_id;
  if v_op.operation_id is null then raise exception 'pos_key_operation_missing'; end if;
  if new.key_role in ('entry', 'derived') and not (v_op.origin = 'prepared' and v_op.status = 'prepared') then
    raise exception 'pos_key_role_mismatch: %', new.key_role;
  end if;
  if new.key_role = 'legacy_alias' and v_op.status <> 'completed' then
    raise exception 'pos_key_role_mismatch: legacy_alias';
  end if;
  if new.key_role = 'fence' and v_op.origin not in ('negative_tombstone', 'stale_prepare', 'busy_prepare', 'conflict_tombstone') then
    raise exception 'pos_key_role_mismatch: fence';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create or replace function app_private.pos_op_slots_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.slot_epoch <> 0 or new.active_instruction_id is not null then
      raise exception 'pos_slot_invalid_construction';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if (new.slot_key, new.slot_kind, new.created_at) is distinct from (old.slot_key, old.slot_kind, old.created_at) then
    raise exception 'pos_slot_identity_immutable';
  end if;
  -- 版は1つずつだけ進む（戻らない・飛ばない・変えずに書き換えない）
  if new.slot_epoch <> old.slot_epoch + 1 then
    raise exception 'pos_slot_epoch_must_advance_by_one';
  end if;
  if old.active_instruction_id is null and new.active_instruction_id is not null then
    -- 空 → I：受理された依頼で、この枠の、この版のもの
    if not exists (select 1 from app_private.pos_business_instructions i
                   join app_private.pos_operations o on o.operation_id = i.operation_id
                   where i.instruction_id = new.active_instruction_id and i.slot_key = new.slot_key
                     and i.disposition = 'accepted' and i.installed_epoch = new.slot_epoch
                     and o.origin = 'prepared' and o.status = 'prepared') then
      raise exception 'pos_slot_invalid_pointer_install';
    end if;
  elsif old.active_instruction_id is not null and new.active_instruction_id is null then
    -- I → 空：I の操作が終わったときだけ
    if not exists (select 1 from app_private.pos_business_instructions i
                   join app_private.pos_operations o on o.operation_id = i.operation_id
                   where i.instruction_id = old.active_instruction_id and o.status in ('completed', 'rejected', 'abandoned')) then
      raise exception 'pos_slot_pointer_clear_requires_terminal';
    end if;
  elsif old.active_instruction_id is not null and new.active_instruction_id is not null then
    -- I → J（I → I も）は不可
    raise exception 'pos_slot_invalid_pointer_transition';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function app_private.pos_op_instructions_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_op app_private.pos_operations;
  v_spec jsonb := app_private.pos_op_kind_spec(new.kind);
  v_epoch bigint;
begin
  -- 事実の検査を最初に（どの経路の直接の INSERT でも、秘密らしい値は保存の前に止まる）
  if v_spec is null or app_private.pos_op_validate_facts(new.kind, new.facts) is not null then
    raise exception 'pos_instruction_invalid_facts: %', coalesce(app_private.pos_op_validate_facts(new.kind, new.facts), 'invalid_kind');
  end if;
  select * into v_op from app_private.pos_operations where operation_id = new.operation_id;
  if v_op.operation_id is null or v_op.kind <> new.kind then raise exception 'pos_instruction_operation_mismatch'; end if;
  if new.disposition = 'accepted' then
    if not (v_op.origin = 'prepared' and v_op.status = 'prepared' and v_op.slot_key = new.slot_key) then
      raise exception 'pos_instruction_operation_mismatch';
    end if;
    select slot_epoch into v_epoch from app_private.pos_business_slots where slot_key = new.slot_key;
    if v_epoch is distinct from new.observed_epoch then raise exception 'pos_instruction_epoch_mismatch'; end if;
  else
    if not (v_op.origin = case new.refusal_code when 'stale_epoch' then 'stale_prepare' else 'busy_prepare' end
            and v_op.refused_instruction_id = new.instruction_id) then
      raise exception 'pos_instruction_operation_mismatch';
    end if;
  end if;
  if new.slot_key is distinct from app_private.pos_op_slot_key(new.kind, new.facts,
       case when new.kind = 'checkout_anonymous' then split_part(new.slot_key, ':', 3) end) then
    raise exception 'pos_instruction_slot_mismatch';
  end if;
  if new.facts_hash <> app_private.pos_op_hash('PREP1', jsonb_build_object('kind', new.kind, 'slot', new.slot_key, 'facts', new.facts)) then
    raise exception 'pos_instruction_hash_mismatch';
  end if;
  -- 入口のキー（digest）は、この操作に先に結ばれた入口のキー（受理：entry、拒否：fence）と同じであること。
  -- キーの形（種類ごとの接頭辞 + UUID）は PREPARE が digest にする前に確かめる
  if new.entry_key_domain <> (v_spec ->> 'domain')
     or not exists (select 1 from app_private.pos_operation_keys k
                    where k.key_domain = new.entry_key_domain and k.key_digest = new.entry_key_digest
                      and k.operation_id = new.operation_id
                      and k.key_role = case new.disposition when 'accepted' then 'entry' else 'fence' end) then
    raise exception 'pos_instruction_invalid_key';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create or replace function app_private.pos_op_targets_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status from app_private.pos_operations where operation_id = new.operation_id;
  if tg_op = 'INSERT' then
    if not new.active or new.released_at is not null or v_status is distinct from 'claimed' then
      raise exception 'pos_target_invalid_construction';
    end if;
    -- 有効な資源は CLAIM が宣言した一式の中だけ
    if not exists (select 1 from app_private.pos_operation_required_targets r
                   where r.operation_id = new.operation_id and r.target_key = new.target_key) then
      raise exception 'pos_target_not_required';
    end if;
    new.created_at := now();
    return new;
  end if;
  -- 書き換えは「解放」（active true → false）だけ。操作が終わってから
  if (new.operation_id, new.target_key, new.created_at) is distinct from (old.operation_id, old.target_key, old.created_at)
     or not (old.active and not new.active)
     or v_status not in ('completed', 'rejected', 'abandoned') then
    raise exception 'pos_target_invalid_update';
  end if;
  new.released_at := now();
  return new;
end;
$$;

create or replace function app_private.pos_op_effects_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (select 1 from app_private.pos_operations where operation_id = new.operation_id and status = 'completed') then
    raise exception 'pos_effect_requires_completed_operation';
  end if;
  if new.snapshot_hash <> app_private.pos_op_hash('LEG1', new.snapshot) then
    raise exception 'pos_effect_snapshot_hash_mismatch';
  end if;
  if app_private.pos_op_validate_effect_snapshot(new.effect_kind, new.snapshot) is not null then
    raise exception 'pos_effect_invalid_snapshot: %', app_private.pos_op_validate_effect_snapshot(new.effect_kind, new.snapshot);
  end if;
  -- スナップショットの行 ID は効果の ID と同じ
  if (new.snapshot ->> case when new.effect_kind in ('sale', 'sale_void') then 'sale_id'
                            when new.effect_kind = 'ticket_issue' then 'log_id' else 'transaction_id' end)
     is distinct from new.effect_identity::text then
    raise exception 'pos_effect_identity_mismatch';
  end if;
  if new.effect_kind in ('ginpay_sale_payment', 'ginpay_sale_reversal') then
    -- 子の効果（会計の GINPay 支払い・取消の戻し）：親が必ずあり、同じ操作に、決まった種類で登録済み、取引の会計 ID が親と同じ
    if new.parent_domain is null or new.parent_identity is null then
      raise exception 'pos_effect_parent_required';
    end if;
    if not exists (
         select 1 from app_private.pos_operation_effects p
         where p.effect_domain = new.parent_domain and p.effect_identity = new.parent_identity and p.operation_id = new.operation_id
           and p.effect_kind = case new.effect_kind when 'ginpay_sale_payment' then 'sale' else 'sale_void' end
           and p.effect_domain = case new.effect_kind when 'ginpay_sale_payment' then 'accounting_sale' else 'accounting_sale_void' end) then
      raise exception 'pos_effect_parent_unproven';
    end if;
    if (new.snapshot ->> 'accounting_session_id') is distinct from new.parent_identity::text then
      raise exception 'pos_effect_parent_mismatch';
    end if;
  elsif new.parent_domain is not null or new.parent_identity is not null then
    raise exception 'pos_effect_parent_forbidden';
  end if;
  new.registered_at := now();
  return new;
end;
$$;

-- CLAIM が宣言する資源：prepared の通常の操作にだけ書ける（宣言のあとは claimed になり、もう足せない）
create or replace function app_private.pos_op_required_targets_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (select 1 from app_private.pos_operations
                 where operation_id = new.operation_id and origin = 'prepared' and status = 'prepared') then
    raise exception 'pos_required_target_invalid_construction';
  end if;
  new.created_at := now();
  return new;
end;
$$;

-- 履歴の detail も許可リストだけ。
-- 予約されたコード（pos_op_reserved_code）は、そのコードを持てる origin の操作の、決まった種類・項目にだけ書ける：
--   instruction_conflict → conflict_tombstone の tombstoned の reason / stale_epoch・slot_busy → stale_prepare・busy_prepare の refused の code。
-- 逆向き：tombstoned は取り消しの印（negative / conflict）にだけ、refused は拒否の印（stale / busy）にだけ、その origin のコードで。
-- 衝突の印の履歴は instruction_conflict の tombstoned 1件だけ（ほかの履歴は足せない。1件はコミット時の不変条件と一意の索引）
create or replace function app_private.pos_op_events_guard()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_origin text;
  v_key text;
  v_val text;
  v_owner text;
begin
  if app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('event'), new.detail, false) is not null then
    raise exception 'pos_event_invalid_detail: %', app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('event'), new.detail, false);
  end if;
  select origin into v_origin from app_private.pos_operations where operation_id = new.operation_id;
  for v_key, v_val in select key, value from jsonb_each_text(new.detail) loop
    v_owner := app_private.pos_op_reserved_code(v_val);
    if v_owner is not null and not (v_origin is not distinct from v_owner
         and ((v_owner = 'conflict_tombstone' and v_key = 'reason' and new.event_type = 'tombstoned')
           or (v_owner <> 'conflict_tombstone' and v_key = 'code' and new.event_type = 'refused'))) then
      raise exception 'pos_event_reserved_code: % on %', v_val, coalesce(v_origin, 'no_operation');
    end if;
  end loop;
  if new.event_type = 'tombstoned' and v_origin is distinct from 'negative_tombstone'
     and not (v_origin is not distinct from 'conflict_tombstone' and new.detail ->> 'reason' is not distinct from 'instruction_conflict') then
    raise exception 'pos_event_origin_mismatch: tombstoned on %', coalesce(v_origin, 'no_operation');
  end if;
  if new.event_type = 'refused' and app_private.pos_op_reserved_code(new.detail ->> 'code') is distinct from v_origin then
    raise exception 'pos_event_origin_mismatch: refused on %', coalesce(v_origin, 'no_operation');
  end if;
  if v_origin = 'conflict_tombstone' and new.event_type <> 'tombstoned' then
    raise exception 'pos_event_origin_mismatch: % on conflict_tombstone', new.event_type;
  end if;
  new.created_at := now();
  return new;
end;
$$;

-- コミット時の不変条件（遅延制約トリガー）：
--   通常の操作：prepared/claimed のあいだは枠の active がその依頼、終わったら枠は指さない
--   資源：claimed は宣言した一式（1件以上）と有効な資源が集合として完全に一致。prepared・旧データ・取り消しの印は宣言も資源も無し。
--         終了した操作は有効な資源なし（宣言と解放済みの資源は履歴として残る）
create or replace function app_private.pos_op_check_invariants(p_operation_id uuid)
returns void language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_op app_private.pos_operations;
  v_inst uuid;
  v_active uuid;
  v_required integer;
begin
  select * into v_op from app_private.pos_operations where operation_id = p_operation_id;
  if v_op.operation_id is null then return; end if;
  if v_op.origin = 'prepared' then
    select instruction_id into v_inst from app_private.pos_business_instructions
    where operation_id = p_operation_id and disposition = 'accepted';
    if v_inst is null then raise exception 'pos_invariant_instruction_missing'; end if;
    select active_instruction_id into v_active from app_private.pos_business_slots where slot_key = v_op.slot_key;
    if v_op.status in ('prepared', 'claimed') and v_active is distinct from v_inst then
      raise exception 'pos_invariant_slot_pointer';
    end if;
    if v_op.status not in ('prepared', 'claimed') and v_active is not distinct from v_inst then
      raise exception 'pos_invariant_slot_pointer';
    end if;
  elsif v_op.origin in ('stale_prepare', 'busy_prepare') then
    if not exists (select 1 from app_private.pos_business_instructions
                   where instruction_id = v_op.refused_instruction_id and operation_id = p_operation_id and disposition = 'refused') then
      raise exception 'pos_invariant_refused_instruction_missing';
    end if;
  elsif v_op.origin = 'conflict_tombstone' then
    -- 衝突の印：依頼は外部キー（コミット時）で必ずある。履歴は instruction_conflict の tombstoned ちょうど1件だけ
    if (select count(*) from app_private.pos_operation_events where operation_id = p_operation_id) <> 1
       or not exists (select 1 from app_private.pos_operation_events
                      where operation_id = p_operation_id and event_type = 'tombstoned' and detail ->> 'reason' = 'instruction_conflict') then
      raise exception 'pos_invariant_conflict_event';
    end if;
  end if;
  -- 資源：宣言した一式（required）と有効な資源（active）
  if v_op.status = 'claimed' then
    -- 宣言は種類の最小数以上（0 件の claimed は作れない）
    select count(*) into v_required from app_private.pos_operation_required_targets where operation_id = p_operation_id;
    if v_required = 0 or v_required < coalesce((app_private.pos_op_kind_spec(v_op.kind) ->> 'min_targets')::int, 1) then
      raise exception 'pos_invariant_required_targets_missing';
    end if;
    -- 集合として完全に一致：宣言 − 有効 = 空、かつ 有効 − 宣言 = 空（解放済みの行も無い）
    if exists (select 1 from app_private.pos_operation_required_targets r
               where r.operation_id = p_operation_id
                 and not exists (select 1 from app_private.pos_operation_targets t
                                 where t.operation_id = p_operation_id and t.target_key = r.target_key and t.active))
       or exists (select 1 from app_private.pos_operation_targets t
                  where t.operation_id = p_operation_id
                    and (not t.active or not exists (select 1 from app_private.pos_operation_required_targets r
                                                     where r.operation_id = p_operation_id and r.target_key = t.target_key))) then
      raise exception 'pos_invariant_claimed_targets';
    end if;
  else
    if exists (select 1 from app_private.pos_operation_targets where operation_id = p_operation_id and active) then
      raise exception 'pos_invariant_targets_not_released';
    end if;
    -- prepared・旧データ・取り消しの印は宣言も資源も持たない（終了した操作は宣言の履歴だけ残る）
    if (v_op.status = 'prepared' or v_op.origin <> 'prepared')
       and (exists (select 1 from app_private.pos_operation_required_targets where operation_id = p_operation_id)
            or exists (select 1 from app_private.pos_operation_targets where operation_id = p_operation_id)) then
      raise exception 'pos_invariant_unclaimed_targets';
    end if;
    -- 終了した操作の資源の履歴も宣言の中だけ
    if exists (select 1 from app_private.pos_operation_targets t
               where t.operation_id = p_operation_id
                 and not exists (select 1 from app_private.pos_operation_required_targets r
                                 where r.operation_id = p_operation_id and r.target_key = t.target_key)) then
      raise exception 'pos_invariant_targets_outside_required';
    end if;
  end if;
end;
$$;

create or replace function app_private.pos_op_invariant_trigger()
returns trigger language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_table_name = 'pos_business_slots' then
    perform app_private.pos_op_check_invariants(i.operation_id)
    from app_private.pos_business_instructions i
    where i.instruction_id in (old.active_instruction_id, new.active_instruction_id);
  else
    perform app_private.pos_op_check_invariants(new.operation_id);
  end if;
  return null;
end;
$$;

-- トリガーの付け直し（新しい表だけ。再適用しても同じ形になる）
do $$
declare
  t text;
begin
  foreach t in array array['pos_operations', 'pos_operation_keys', 'pos_business_instructions', 'pos_business_slots',
                           'pos_operation_targets', 'pos_operation_required_targets', 'pos_operation_effects', 'pos_operation_events'] loop
    execute format('drop trigger if exists %I on app_private.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on app_private.%I for each statement execute function app_private.pos_op_forbid_mutation()',
                   t || '_no_truncate', t);
  end loop;
  -- 書き換え・削除が一切できない表
  foreach t in array array['pos_operation_keys', 'pos_business_instructions', 'pos_operation_required_targets',
                           'pos_operation_effects', 'pos_operation_events'] loop
    execute format('drop trigger if exists %I on app_private.%I', t || '_no_update_delete', t);
    execute format('create trigger %I before update or delete on app_private.%I for each row execute function app_private.pos_op_forbid_mutation()',
                   t || '_no_update_delete', t);
  end loop;
  -- 削除だけできない表（書き換えは各ガードが決まった遷移だけ許す）
  foreach t in array array['pos_operations', 'pos_business_slots', 'pos_operation_targets'] loop
    execute format('drop trigger if exists %I on app_private.%I', t || '_no_delete', t);
    execute format('create trigger %I before delete on app_private.%I for each row execute function app_private.pos_op_forbid_mutation()',
                   t || '_no_delete', t);
  end loop;
end $$;

drop trigger if exists pos_operations_guard on app_private.pos_operations;
create trigger pos_operations_guard before insert or update on app_private.pos_operations
  for each row execute function app_private.pos_op_operations_guard();
drop trigger if exists pos_operation_keys_guard on app_private.pos_operation_keys;
create trigger pos_operation_keys_guard before insert on app_private.pos_operation_keys
  for each row execute function app_private.pos_op_keys_guard();
drop trigger if exists pos_business_slots_guard on app_private.pos_business_slots;
create trigger pos_business_slots_guard before insert or update on app_private.pos_business_slots
  for each row execute function app_private.pos_op_slots_guard();
drop trigger if exists pos_business_instructions_guard on app_private.pos_business_instructions;
create trigger pos_business_instructions_guard before insert on app_private.pos_business_instructions
  for each row execute function app_private.pos_op_instructions_guard();
drop trigger if exists pos_operation_targets_guard on app_private.pos_operation_targets;
create trigger pos_operation_targets_guard before insert or update on app_private.pos_operation_targets
  for each row execute function app_private.pos_op_targets_guard();
drop trigger if exists pos_operation_effects_guard on app_private.pos_operation_effects;
create trigger pos_operation_effects_guard before insert on app_private.pos_operation_effects
  for each row execute function app_private.pos_op_effects_guard();
drop trigger if exists pos_operation_required_targets_guard on app_private.pos_operation_required_targets;
create trigger pos_operation_required_targets_guard before insert on app_private.pos_operation_required_targets
  for each row execute function app_private.pos_op_required_targets_guard();
drop trigger if exists pos_operation_events_guard on app_private.pos_operation_events;
create trigger pos_operation_events_guard before insert on app_private.pos_operation_events
  for each row execute function app_private.pos_op_events_guard();

drop trigger if exists pos_operations_invariant on app_private.pos_operations;
create constraint trigger pos_operations_invariant after insert or update on app_private.pos_operations
  deferrable initially deferred for each row execute function app_private.pos_op_invariant_trigger();
drop trigger if exists pos_operation_targets_invariant on app_private.pos_operation_targets;
create constraint trigger pos_operation_targets_invariant after insert or update on app_private.pos_operation_targets
  deferrable initially deferred for each row execute function app_private.pos_op_invariant_trigger();
drop trigger if exists pos_operation_required_targets_invariant on app_private.pos_operation_required_targets;
create constraint trigger pos_operation_required_targets_invariant after insert on app_private.pos_operation_required_targets
  deferrable initially deferred for each row execute function app_private.pos_op_invariant_trigger();
drop trigger if exists pos_business_slots_invariant on app_private.pos_business_slots;
create constraint trigger pos_business_slots_invariant after update on app_private.pos_business_slots
  deferrable initially deferred for each row execute function app_private.pos_op_invariant_trigger();

-- ── 5. PREPARE / CLAIM / 終了 / fence（内部の書き込み関数） ─────────────────────

-- 負けた依頼のキー一式（PREPARE が作って lock 済みのもの）について、取り消しの印を作ってはいけない理由を返す（読むだけ。書かない）。
-- null のときだけ印を作ってよい：入口のキーが未登録で、どのキーも物理に無い（正規の1行・正規でない・あいまいのどれでもない）。
-- 書き込みは PREPARE の instruction_conflict の分岐の中だけにある（この関数は印を作れない）
create or replace function app_private.pos_op_conflict_losing_status(p_keys jsonb)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_entry jsonb;
  v_refusal text;
  v_present jsonb;
  v_class jsonb;
begin
  -- キーはすべて lock 済みであること（あとから lock を取りに行かない）。digest は範囲と値から計算したものと同じであること
  perform app_private.pos_op_assert_keys_locked(p_keys);
  if exists (select 1 from jsonb_array_elements(p_keys) e
             where e ->> 'h' is distinct from encode(app_private.pos_op_key_ident(e ->> 'd', e ->> 'v'), 'hex')) then
    raise exception 'pos_key_plan_invalid: request key digest does not match its domain and canonical value';
  end if;
  select e into v_entry from jsonb_array_elements(p_keys) e where e ->> 'r' = 'entry';
  if exists (select 1 from app_private.pos_operation_keys where key_domain = v_entry ->> 'd' and key_digest = decode(v_entry ->> 'h', 'hex')) then
    return jsonb_build_object('losing_key', 'already_bound');
  end if;
  -- 同値類が正規でない・あいまいなキーが1つでもあれば（あいまいを先に）
  v_refusal := app_private.pos_op_physical_refusal(app_private.pos_op_probe_blocked_reason(p_keys));
  if v_refusal is not null then
    return jsonb_build_object('losing_key', v_refusal);
  end if;
  -- 正規の1行として物理にあるキー（入口の K でも、対の sale:K でも）：行 ID で分類して返す
  select e into v_present from jsonb_array_elements(p_keys) e
  where app_private.pos_op_physical_probe(e ->> 'd', e ->> 'v') ->> 'state' = 'physical_key_canonical_single'
  order by e ->> 'r' desc, e ->> 'd' limit 1;
  if v_present is not null then
    v_class := app_private.pos_op_classify_legacy_effect(
      case v_present ->> 'd' when 'acct_sale' then 'accounting_sale' when 'ginpay_tx' then 'ginpay_transaction'
                             when 'acct_void' then 'accounting_sale_void' else 'ticket_issue' end,
      (app_private.pos_op_physical_probe(v_present ->> 'd', v_present ->> 'v') ->> 'id')::uuid);
    return jsonb_build_object('losing_key', 'legacy_key_present', 'losing_key_domain', v_present ->> 'd',
      'losing_key_verdict', v_class ->> 'verdict', 'losing_key_reason', v_class ->> 'reason');
  end if;
  return null;
end;
$$;

/**
 * PREPARE：業務の依頼を、お金を動かす前にサーバーへ記録する（内部用。B-2C-1 では呼び出し元なし）
 * 順序：検証 → キーの lock（並べ替え）→ 依頼の lock → 同じ依頼 ID の有無
 *   ある：全く同じ依頼なら保存済みの結果を返す（枠の版は見ない）。違えば instruction_conflict（負けたキーは取り消しの印）
 *         負けたキーの印は、この「同じ依頼 ID・違う依頼」と決まった分岐の中でだけ作る（独立した書き込み関数は無い）
 *   ない：キーが登録済みなら key_conflict、既存の表にあれば legacy_key_present（どちらも書かない）
 *         既存の表は pos_op_physical_probe で見る：同値類が正規でない行だけなら legacy_key_noncanonical、2行以上なら legacy_key_ambiguous
 *         枠の lock → 版が違えば stale_epoch、ほかの依頼が進行中なら slot_busy（依頼は拒否として記録、キーは取り消しの印）
 *         受理：操作（prepared）・依頼・キーを作り、枠の版を +1 して active に入れる
 */
create or replace function app_private.pos_op_prepare(
  p_instruction_id uuid,
  p_kind text,
  p_facts jsonb,
  p_entry_key text,
  p_expected_epoch bigint,
  p_lane text default null,
  p_actor_type text default null,
  p_actor_name text default null
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_spec jsonb := app_private.pos_op_kind_spec(p_kind);
  v_err text;
  v_slot text;
  v_hash text;
  v_keys jsonb;
  v_k jsonb;
  v_inst app_private.pos_business_instructions;
  v_slot_row app_private.pos_business_slots;
  v_bound app_private.pos_operation_keys;
  v_op uuid;
  v_status text;
  v_code text;
  v_losing jsonb;
  v_pstate text;
  v_entry jsonb;
  v_present jsonb;
  v_class jsonb;
  v_n int := 0;
begin
  -- 1. 形式の検証（DB を読まない）
  if p_instruction_id is null or p_expected_epoch is null or p_expected_epoch < 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  if v_spec is null then return jsonb_build_object('ok', false, 'error', 'invalid_kind'); end if;
  v_err := app_private.pos_op_validate_facts(p_kind, p_facts);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', 'invalid_facts', 'detail', v_err); end if;
  if not app_private.pos_op_key_admissible(p_kind, p_entry_key) then
    return jsonb_build_object('ok', false, 'error', 'invalid_key');
  end if;
  if (p_kind = 'checkout_anonymous') <> (p_lane is not null) then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  if p_actor_type is not null and p_actor_type not in ('staff', 'hq', 'system', 'test')
     or p_actor_name is not null and (length(p_actor_name) > 100 or app_private.pos_op_secret_like(p_actor_name)) then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  v_slot := app_private.pos_op_slot_key(p_kind, p_facts, p_lane);
  if v_slot is null then return jsonb_build_object('ok', false, 'error', 'invalid_request'); end if;
  v_hash := app_private.pos_op_hash('PREP1', jsonb_build_object('kind', p_kind, 'slot', v_slot, 'facts', p_facts));
  v_keys := app_private.pos_op_request_keys(p_kind, p_entry_key);

  -- 2-3. キー → 依頼の順に lock
  perform app_private.pos_op_lock_keys_xact(v_keys);
  perform app_private.pos_op_lock_instruction(p_instruction_id);

  -- 4. 同じ依頼 ID があれば、全く同じかどうかだけで決める（版は見ない）
  select * into v_inst from app_private.pos_business_instructions where instruction_id = p_instruction_id;
  if v_inst.instruction_id is not null then
    if v_inst.kind = p_kind and v_inst.slot_key = v_slot and v_inst.facts_hash = v_hash
       and v_inst.entry_key_domain = (v_spec ->> 'domain')
       and v_inst.entry_key_digest = app_private.pos_op_key_ident(v_spec ->> 'domain', p_entry_key)
       and v_inst.observed_epoch = p_expected_epoch then
      if v_inst.disposition = 'accepted' then
        select status into v_status from app_private.pos_operations where operation_id = v_inst.operation_id;
        return jsonb_build_object('ok', true, 'result', 'existing', 'instruction_id', v_inst.instruction_id,
          'operation_id', v_inst.operation_id, 'status', v_status, 'slot_key', v_inst.slot_key, 'installed_epoch', v_inst.installed_epoch);
      end if;
      return jsonb_build_object('ok', false, 'error', v_inst.refusal_code, 'replay', true,
        'instruction_id', v_inst.instruction_id, 'operation_id', v_inst.operation_id);
    end if;
    -- ここで instruction_conflict が決まる（同じ依頼 ID・保存済みの依頼と、種類・枠・事実・入口のキー・観察した版のどれかが違う）。
    -- 負けた依頼のキー一式 v_keys は、この依頼の入口のキーから pos_op_request_keys で作ったもの（入口の K と、会計なら sale:K）で、
    -- 手順 2 で lock 済み。印は、どのキーも未登録かつ物理に無い（正規の1行・正規でない・あいまいのどれでもない）ときだけ作る
    v_losing := app_private.pos_op_conflict_losing_status(v_keys);
    if v_losing is null then
      insert into app_private.pos_operations (kind, origin, status, refused_instruction_id, terminal_at)
      values (p_kind, 'conflict_tombstone', 'abandoned', p_instruction_id, now())
      returning operation_id into v_op;
      for v_k in select e from jsonb_array_elements(v_keys) e loop
        if not exists (select 1 from app_private.pos_operation_keys where key_domain = v_k ->> 'd' and key_digest = decode(v_k ->> 'h', 'hex')) then
          insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role)
          values (v_k ->> 'd', decode(v_k ->> 'h', 'hex'), v_op, 'fence');
          v_n := v_n + 1;
        end if;
      end loop;
      insert into app_private.pos_operation_events (operation_id, event_type, detail)
      values (v_op, 'tombstoned', jsonb_build_object('reason', 'instruction_conflict', 'keys', v_n));
      v_losing := jsonb_build_object('losing_key', 'tombstoned', 'tombstone_operation_id', v_op);
    end if;
    return jsonb_build_object('ok', false, 'error', 'instruction_conflict', 'instruction_id', p_instruction_id,
      'existing_operation_id', v_inst.operation_id) || v_losing;
  end if;

  -- 5. 新しい依頼：キーが登録済み・既存の表にあるなら何も書かない
  for v_k in select e from jsonb_array_elements(v_keys) e loop
    select * into v_bound from app_private.pos_operation_keys where key_domain = v_k ->> 'd' and key_digest = decode(v_k ->> 'h', 'hex');
    if v_bound.operation_id is not null then
      select status into v_status from app_private.pos_operations where operation_id = v_bound.operation_id;
      return jsonb_build_object('ok', false, 'error', 'key_conflict', 'key_domain', v_bound.key_domain,
        'operation_id', v_bound.operation_id, 'key_role', v_bound.key_role, 'status', v_status);
    end if;
  end loop;
  -- 物理に無いと言えるのは、キーの同値類（D1/D3 は btrim）に既存の行が0のときだけ。正規でない・あいまいなら断る（書かない）
  for v_k in select e from jsonb_array_elements(v_keys) e loop
    v_pstate := app_private.pos_op_physical_probe(v_k ->> 'd', v_k ->> 'v') ->> 'state';
    if v_pstate <> 'physical_key_absent' then
      return jsonb_build_object('ok', false, 'error', coalesce(app_private.pos_op_physical_refusal(v_pstate), 'legacy_key_present'),
        'key_domain', v_k ->> 'd');
    end if;
  end loop;

  -- 6. 枠の lock と版の確認
  insert into app_private.pos_business_slots (slot_key, slot_kind) values (v_slot, v_spec ->> 'slot_kind')
  on conflict (slot_key) do nothing;
  select * into v_slot_row from app_private.pos_business_slots where slot_key = v_slot for update;

  if v_slot_row.slot_epoch <> p_expected_epoch or v_slot_row.active_instruction_id is not null then
    v_code := case when v_slot_row.slot_epoch <> p_expected_epoch then 'stale_epoch' else 'slot_busy' end;
    insert into app_private.pos_operations (kind, origin, status, refused_instruction_id, terminal_at)
    values (p_kind, case v_code when 'stale_epoch' then 'stale_prepare' else 'busy_prepare' end, 'abandoned', p_instruction_id, now())
    returning operation_id into v_op;
    for v_k in select e from jsonb_array_elements(v_keys) e loop
      insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role)
      values (v_k ->> 'd', decode(v_k ->> 'h', 'hex'), v_op, 'fence');
    end loop;
    insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key,
      observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest, actor_type, actor_name)
    values (p_instruction_id, v_op, 'refused', v_code, p_kind, v_slot, p_expected_epoch, null, p_facts, v_hash,
      v_spec ->> 'domain', app_private.pos_op_key_ident(v_spec ->> 'domain', p_entry_key), p_actor_type, p_actor_name);
    insert into app_private.pos_operation_events (operation_id, slot_key, event_type, detail)
    values (v_op, v_slot, 'refused', jsonb_build_object('code', v_code, 'observed_epoch', p_expected_epoch, 'slot_epoch', v_slot_row.slot_epoch));
    return jsonb_build_object('ok', false, 'error', v_code, 'instruction_id', p_instruction_id, 'operation_id', v_op,
      'slot_key', v_slot, 'slot_epoch', v_slot_row.slot_epoch, 'active_instruction_id', v_slot_row.active_instruction_id);
  end if;

  -- 7. 受理
  insert into app_private.pos_operations (kind, origin, status, slot_key)
  values (p_kind, 'prepared', 'prepared', v_slot)
  returning operation_id into v_op;
  -- キー（digest）を先に結び、依頼はその入口のキーを指す
  for v_k in select e from jsonb_array_elements(v_keys) e loop
    insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role)
    values (v_k ->> 'd', decode(v_k ->> 'h', 'hex'), v_op, v_k ->> 'r');
  end loop;
  insert into app_private.pos_business_instructions (instruction_id, operation_id, disposition, refusal_code, kind, slot_key,
    observed_epoch, installed_epoch, facts, facts_hash, entry_key_domain, entry_key_digest, actor_type, actor_name)
  values (p_instruction_id, v_op, 'accepted', null, p_kind, v_slot, p_expected_epoch, p_expected_epoch + 1, p_facts, v_hash,
    v_spec ->> 'domain', app_private.pos_op_key_ident(v_spec ->> 'domain', p_entry_key), p_actor_type, p_actor_name);
  update app_private.pos_business_slots
  set slot_epoch = slot_epoch + 1, active_instruction_id = p_instruction_id
  where slot_key = v_slot;
  insert into app_private.pos_operation_events (operation_id, slot_key, event_type, detail)
  values (v_op, v_slot, 'prepared', jsonb_build_object('installed_epoch', p_expected_epoch + 1));
  return jsonb_build_object('ok', true, 'result', 'prepared', 'instruction_id', p_instruction_id, 'operation_id', v_op,
    'status', 'prepared', 'slot_key', v_slot, 'installed_epoch', p_expected_epoch + 1);
end;
$$;

/**
 * CLAIM：受理済みの依頼を参照して、必要な資源を一度に押さえる（キー・依頼・操作は作れない）
 * 順序：キー → 依頼 → 枠 → 操作 → 資源（target_key の順）。どれか1つでも押さえられなければ全体を戻す
 * 1つのトランザクションで：宣言した一式（required、書き換え不可）→ prepared → claimed → 有効な資源 → 履歴。
 * 資源が衝突したら、宣言・資源・状態の変更はどれも残らない（prepared のまま）
 */
create or replace function app_private.pos_op_claim(p_instruction_id uuid, p_target_keys text[])
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_inst app_private.pos_business_instructions;
  v_op app_private.pos_operations;
  v_targets text[];
  v_existing text[];
  v_current text;
  v_blocker uuid;
  v_keys jsonb;
begin
  if p_instruction_id is null or p_target_keys is null or cardinality(p_target_keys) > 32
     or exists (select 1 from unnest(p_target_keys) t where t is null or t !~ '^[a-z_]+:\S{1,200}$' or app_private.pos_op_secret_like(t)) then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  select array_agg(distinct t order by t) into v_targets from unnest(p_target_keys) t;
  v_targets := coalesce(v_targets, '{}');
  if cardinality(v_targets) <> cardinality(p_target_keys) then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select * into v_inst from app_private.pos_business_instructions where instruction_id = p_instruction_id;
  if v_inst.instruction_id is null then return jsonb_build_object('ok', false, 'error', 'instruction_not_found'); end if;
  if v_inst.disposition <> 'accepted' then
    return jsonb_build_object('ok', false, 'error', 'instruction_refused', 'refusal_code', v_inst.refusal_code);
  end if;

  v_keys := app_private.pos_op_operation_keys(v_inst.operation_id);
  perform app_private.pos_op_lock_keys_xact(v_keys);
  perform app_private.pos_op_lock_instruction(p_instruction_id);
  perform 1 from app_private.pos_business_slots where slot_key = v_inst.slot_key for update;
  select * into v_op from app_private.pos_operations where operation_id = v_inst.operation_id for update;

  if v_op.status = 'claimed' then
    -- 再送：宣言した一式と全く同じときだけ同じ結果
    select coalesce(array_agg(target_key order by target_key), '{}') into v_existing
    from app_private.pos_operation_required_targets where operation_id = v_op.operation_id;
    if v_existing = v_targets then
      return jsonb_build_object('ok', true, 'result', 'already_claimed', 'operation_id', v_op.operation_id);
    end if;
    return jsonb_build_object('ok', false, 'error', 'claim_conflict', 'operation_id', v_op.operation_id);
  end if;
  if v_op.status <> 'prepared' then
    return jsonb_build_object('ok', false, 'error', 'operation_terminal', 'operation_id', v_op.operation_id, 'status', v_op.status);
  end if;
  -- 宣言なし（0 件）の claim は種類で明示されていない限り受けない
  if cardinality(v_targets) < coalesce((app_private.pos_op_kind_spec(v_op.kind) ->> 'min_targets')::int, 1) or cardinality(v_targets) = 0 then
    return jsonb_build_object('ok', false, 'error', 'targets_required', 'operation_id', v_op.operation_id);
  end if;

  begin
    foreach v_current in array v_targets loop
      insert into app_private.pos_operation_required_targets (operation_id, target_key) values (v_op.operation_id, v_current);
    end loop;
    update app_private.pos_operations set status = 'claimed' where operation_id = v_op.operation_id;
    foreach v_current in array v_targets loop
      insert into app_private.pos_operation_targets (operation_id, target_key) values (v_op.operation_id, v_current);
    end loop;
  exception when unique_violation then
    -- 押さえられない資源があった：宣言・状態の変更・途中の資源はすべて戻る（成功とは扱わない）
    select operation_id into v_blocker from app_private.pos_operation_targets where target_key = v_current and active;
    return jsonb_build_object('ok', false, 'error', 'target_busy', 'operation_id', v_op.operation_id,
      'target_key', v_current, 'blocking_operation_id', v_blocker);
  end;
  insert into app_private.pos_operation_events (operation_id, event_type, detail)
  values (v_op.operation_id, 'claimed', jsonb_build_object('targets', cardinality(v_targets)));
  return jsonb_build_object('ok', true, 'result', 'claimed', 'operation_id', v_op.operation_id, 'targets', to_jsonb(v_targets));
end;
$$;

/**
 * 操作を終える（内部の中核。直接呼ばない。実行権限はどのロールにも無い）。正しい入口は pos_op_finish と pos_op_fence_key で、
 * どちらも pos_op_lock_keys_xact でキー一式をトランザクション単位で取ってからここへ来る。ここではキーの lock を新しく取らない
 * （派生キー → 操作 → あとから入口のキー、のような逆順を作らないため）。始めに pos_op_assert_keys_locked で
 * 「今のバックエンドがキー一式を ExclusiveLock で持っている」ことだけを確かめ、無ければ pos_lock_order_violation
 * （トランザクション単位かどうかは pg_locks では分からないので、それは入口が保証する）
 * 順序：（キー済み）→ 依頼 → 枠 → 操作 → 資源。終わった操作をもう一度終えても何も変えない（版も進めない）
 * 枠の active がこの依頼のときだけ、空にして版を +1（新しい依頼の active を消すことはない）
 */
create or replace function app_private.pos_op_finish_locked(
  p_operation_id uuid,
  p_status text,
  p_code text,
  p_result jsonb,
  p_nowait boolean
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_op app_private.pos_operations;
  v_inst app_private.pos_business_instructions;
  v_target text;
  v_released int := 0;
begin
  select * into v_op from app_private.pos_operations where operation_id = p_operation_id;
  if v_op.operation_id is null then return jsonb_build_object('ok', false, 'error', 'operation_not_found'); end if;
  if v_op.origin <> 'prepared' then
    return jsonb_build_object('ok', true, 'result', 'already_terminal', 'replay', true, 'operation_id', v_op.operation_id, 'status', v_op.status);
  end if;
  select * into v_inst from app_private.pos_business_instructions where operation_id = p_operation_id;
  perform app_private.pos_op_assert_keys_locked(app_private.pos_op_operation_keys(p_operation_id));
  perform app_private.pos_op_lock_instruction(v_inst.instruction_id);
  begin
    if p_nowait then
      perform 1 from app_private.pos_business_slots where slot_key = v_op.slot_key for update nowait;
      select * into v_op from app_private.pos_operations where operation_id = p_operation_id for update nowait;
    else
      perform 1 from app_private.pos_business_slots where slot_key = v_op.slot_key for update;
      select * into v_op from app_private.pos_operations where operation_id = p_operation_id for update;
    end if;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'error', 'operation_in_progress', 'operation_id', p_operation_id);
  end;

  if v_op.status in ('completed', 'rejected', 'abandoned') then
    return jsonb_build_object('ok', true, 'result', 'already_terminal', 'replay', true, 'operation_id', v_op.operation_id, 'status', v_op.status);
  end if;
  if p_status in ('completed', 'rejected') and v_op.status <> 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition', 'operation_id', v_op.operation_id, 'status', v_op.status);
  end if;

  update app_private.pos_operations
  set status = p_status, last_code = coalesce(p_code, last_code),
      result_snapshot = p_result,
      result_snapshot_hash = case when p_result is not null then app_private.pos_op_hash('RES1', p_result) end
  where operation_id = p_operation_id;
  for v_target in
    select target_key from app_private.pos_operation_targets where operation_id = p_operation_id and active order by target_key
  loop
    update app_private.pos_operation_targets set active = false where operation_id = p_operation_id and target_key = v_target;
    v_released := v_released + 1;
  end loop;
  update app_private.pos_business_slots
  set slot_epoch = slot_epoch + 1, active_instruction_id = null
  where slot_key = v_op.slot_key and active_instruction_id = v_inst.instruction_id;
  insert into app_private.pos_operation_events (operation_id, slot_key, event_type, detail)
  values (p_operation_id, v_op.slot_key, p_status, jsonb_build_object('code', p_code, 'targets_released', v_released));
  return jsonb_build_object('ok', true, 'result', p_status, 'operation_id', p_operation_id, 'targets_released', v_released);
end;
$$;

/**
 * 操作を終える（completed / rejected / abandoned）。B-2C-1 では内部とテストだけが使う
 * 結果は種類ごとの許可リストだけ（PIN・承認トークンなどは保存の前に止める）。
 * 操作のキー一式（PREPARE で決まり増えない）を最初に pos_op_lock_keys_xact でまとめて取ってから（トランザクション単位）、pos_op_finish_locked へ
 */
create or replace function app_private.pos_op_finish(
  p_operation_id uuid,
  p_status text,
  p_code text default null,
  p_result jsonb default null,
  p_nowait boolean default false
)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_op app_private.pos_operations;
begin
  if p_status is null or p_status not in ('completed', 'rejected', 'abandoned')
     or p_code is not null and not app_private.pos_op_code_ok(p_code)
     or app_private.pos_op_reserved_code(p_code) is not null
     or p_result is not null and p_status <> 'completed' then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  select * into v_op from app_private.pos_operations where operation_id = p_operation_id;
  if v_op.operation_id is null then return jsonb_build_object('ok', false, 'error', 'operation_not_found'); end if;
  if p_result is not null and app_private.pos_op_validate_result(v_op.kind, 'prepared', p_result) is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_result', 'detail', app_private.pos_op_validate_result(v_op.kind, 'prepared', p_result));
  end if;
  if v_op.origin <> 'prepared' then
    return jsonb_build_object('ok', true, 'result', 'already_terminal', 'replay', true, 'operation_id', v_op.operation_id, 'status', v_op.status);
  end if;
  perform app_private.pos_op_lock_keys_xact(app_private.pos_op_operation_keys(p_operation_id));
  return app_private.pos_op_finish_locked(p_operation_id, p_status, p_code, p_result, coalesce(p_nowait, false));
end;
$$;

-- fence の計画（1か所で決める）。C1 で範囲をまたぐキーの関係は、会計キー K と GINPay 支払いの派生キー sale:K の対だけ
--   bind  ：印として結ぶキー（指定のキー。会計キーなら sale:K も）
--   safety：印を作る前に、物理に無いことを lock の後で確かめるキー（bind ＋ sale:K の親の会計キー K。親は確認だけで結ばない）
--   親の K は D1 の正規化（btrim）で決める（呼び出し元の綴りではなく正規化した識別子から）
-- lock の範囲には safety を必ず全部入れる（pos_op_fence_key が書く前に確かめる）
create or replace function app_private.pos_op_fence_plan(p_domain text, p_norm text)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object('bind', b, 'safety', b || p)
  from (select
          jsonb_build_array(app_private.pos_op_key_elem(p_domain, p_norm))
            || case when p_domain = 'acct_sale' then jsonb_build_array(app_private.pos_op_key_elem('ginpay_tx', 'sale:' || p_norm))
                    else '[]'::jsonb end b,
          case when p_domain = 'ginpay_tx' and starts_with(p_norm, 'sale:')
                    and app_private.pos_op_key_normalize('acct_sale', substr(p_norm, 6)) is not null
               then jsonb_build_array(app_private.pos_op_key_elem('acct_sale', app_private.pos_op_key_normalize('acct_sale', substr(p_norm, 6))))
               else '[]'::jsonb end p) x
$$;

/**
 * fence（キー）：キーを使えなくする（内部用）
 *   登録済み：進行中の操作なら abandoned（実行中なら operation_in_progress）。終わっていればその状態を返す
 *   未登録で既存の表に行がある：取り消しの印は作らない（確定済みなら legacy_effect_present、あいまいなら legacy_state_blocked）
 *   未登録で行も無い：abandoned の印を作ってキー（と会計キーの sale:<key>）を永久に結びつける。枠は触らない
 * lock は「計画 → 一度に lock → 確認」：
 *   1. lock なしで、指定のキーの持ち主と、その操作のキー一式を読む（会計キーと sale:<key> は対で扱う）
 *   2. 一式をまとめて並べ替えて lock（あとから別のキーを取りに行かない）
 *   3. lock の後に読み直し、持ち主のキー一式が lock した範囲に無ければ retry_required（何も書かない）
 *   4. そのあと依頼 → 枠 → 操作 → 資源（pos_op_finish_locked はキーの lock を取らない）
 */
create or replace function app_private.pos_op_fence_key(p_domain text, p_raw text, p_reason text default null)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm text := app_private.pos_op_key_normalize(p_domain, p_raw);
  v_digest bytea := app_private.pos_op_key_ident(p_domain, p_raw);
  v_plan jsonb;
  v_keys jsonb;
  v_lock jsonb;
  v_bound app_private.pos_operation_keys;
  v_op app_private.pos_operations;
  v_class jsonb;
  v_tomb uuid;
  v_k jsonb;
  v_n int := 0;
  v_reason text;
begin
  -- キーは型の決まった「二重送信防止キー」の引数：形（16 進・トークンに見える文字列など）では断らない。
  -- 範囲の正規化 → digest にして、台帳には digest だけを保存する（生のキーは既存の表の照会にだけ使う）
  if v_norm is null or v_digest is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_key');
  end if;
  if p_reason is not null and not app_private.pos_op_code_ok(p_reason) then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  -- 予約されたコード（instruction_conflict など）は fence の理由にできない（書き換えずに断る）
  if app_private.pos_op_reserved_code(p_reason) is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request', 'reason', 'reserved_code');
  end if;
  -- 印を付けるキーと、物理で確かめるキー（生のキーがある今ここで digest を作る）
  v_plan := app_private.pos_op_fence_plan(p_domain, v_norm);
  v_keys := v_plan -> 'bind';

  -- 1. 計画（lock なし）：safety（sale:<key> なら親の会計キーも）、登録済みならその操作のキー一式も lock の範囲に入れる
  v_lock := v_plan -> 'safety';
  select * into v_bound from app_private.pos_operation_keys where key_domain = p_domain and key_digest = v_digest;
  if v_bound.operation_id is not null then
    v_lock := v_lock || app_private.pos_op_operation_keys(v_bound.operation_id);
  end if;

  -- 2. 一度に lock（並べ替え・重複は1回）
  perform app_private.pos_op_lock_keys_xact(v_lock);

  -- 3. 読み直し：持ち主のキー一式が lock の範囲を超えたら、何も書かずにやり直し
  select * into v_bound from app_private.pos_operation_keys where key_domain = p_domain and key_digest = v_digest;
  if v_bound.operation_id is not null
     and not (app_private.pos_op_operation_keys(v_bound.operation_id) <@ app_private.pos_op_dh(v_lock)) then
    return jsonb_build_object('ok', false, 'error', 'retry_required', 'reason', 'key_set_changed');
  end if;

  if v_bound.operation_id is not null then
    select * into v_op from app_private.pos_operations where operation_id = v_bound.operation_id;
    if v_op.origin = 'prepared' and v_op.status in ('prepared', 'claimed') then
      return app_private.pos_op_finish_locked(v_op.operation_id, 'abandoned', 'fenced', null, true);
    end if;
    return jsonb_build_object('ok', true, 'result', 'already_terminal', 'operation_id', v_op.operation_id,
      'status', v_op.status, 'key_role', v_bound.key_role);
  end if;

  -- 4. 物理の確認（lock の後）。確かめるキー（safety）はすべて lock の範囲に入っていること
  if not (app_private.pos_op_dh(v_plan -> 'safety') <@ app_private.pos_op_dh(v_lock)) then
    raise exception 'pos_fence_plan_violation: physical safety keys must be locked before probing';
  end if;
  -- safety のどれか1つでも同値類が正規でない・あいまいなら何も書かない（あいまいを先に。どのキーを先に見たかで変わらない）
  v_reason := app_private.pos_op_probe_blocked_reason(v_plan -> 'safety');
  if v_reason is not null then
    return jsonb_build_object('ok', false, 'error', 'legacy_state_blocked', 'verdict', 'blocked', 'reason', v_reason);
  end if;
  -- 物理の同値類（D1/D3 は btrim）に既存の行が1つでもあれば、取り消しの印（物理に無いという証拠）は作らない
  if app_private.pos_op_key_present(p_domain, v_norm) then
    v_class := app_private.pos_op_classify_legacy_key(p_domain, v_norm);
    return jsonb_build_object('ok', false,
      'error', case when v_class ->> 'verdict' = 'proven' then 'legacy_effect_present' else 'legacy_state_blocked' end,
      'verdict', v_class ->> 'verdict', 'reason', v_class ->> 'reason');
  end if;
  -- 対のキー（会計キー K の sale:K、sale:K の親の K）が物理にある（正規の1行）：「無い」という印は作らない。
  -- 対の行はその行 ID で分類する（sale:K はキーからは分類できないため）。結ぶキー（bind）でも確かめるだけのキーでも同じ
  select k into v_k from jsonb_array_elements(v_plan -> 'safety') k
  where not (k ->> 'd' = p_domain and k ->> 'v' = v_norm)
    and app_private.pos_op_physical_probe(k ->> 'd', k ->> 'v') ->> 'state' = 'physical_key_canonical_single'
  order by k ->> 'd' limit 1;
  if v_k is not null then
    v_class := app_private.pos_op_classify_legacy_effect(
      case v_k ->> 'd' when 'acct_sale' then 'accounting_sale' else 'ginpay_transaction' end,
      (app_private.pos_op_physical_probe(v_k ->> 'd', v_k ->> 'v') ->> 'id')::uuid);
    return jsonb_build_object('ok', false,
      'error', case when v_class ->> 'verdict' = 'proven' then 'legacy_effect_present' else 'legacy_state_blocked' end,
      'verdict', v_class ->> 'verdict', 'reason', coalesce(v_class ->> 'reason', 'parent_key_present'), 'key_domain', v_k ->> 'd');
  end if;

  insert into app_private.pos_operations (kind, origin, status, terminal_at)
  values ('key_tombstone', 'negative_tombstone', 'abandoned', now())
  returning operation_id into v_tomb;
  for v_k in select e from jsonb_array_elements(v_keys) e loop
    if not exists (select 1 from app_private.pos_operation_keys where key_domain = v_k ->> 'd' and key_digest = decode(v_k ->> 'h', 'hex'))
       and not app_private.pos_op_key_present(v_k ->> 'd', v_k ->> 'v') then
      insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role)
      values (v_k ->> 'd', decode(v_k ->> 'h', 'hex'), v_tomb, 'fence');
      v_n := v_n + 1;
    end if;
  end loop;
  insert into app_private.pos_operation_events (operation_id, event_type, detail)
  values (v_tomb, 'tombstoned', jsonb_build_object('reason', coalesce(p_reason, 'fence'), 'keys', v_n));
  return jsonb_build_object('ok', true, 'result', 'tombstoned', 'operation_id', v_tomb, 'keys', v_n);
end;
$$;

/**
 * fence（枠・レーン）：枠を明示的に進める（内部用）
 *   進行中の依頼があれば abandoned にする（終了の処理で枠は空になり版が +1）
 *   空なら版だけ +1（空 → 空）。古い観察から作られた PREPARE はこれで stale になる
 */
create or replace function app_private.pos_op_fence_slot(p_slot_key text, p_reason text default null)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_slot app_private.pos_business_slots;
  v_op uuid;
begin
  if p_reason is not null and not app_private.pos_op_code_ok(p_reason) then return jsonb_build_object('ok', false, 'error', 'invalid_request'); end if;
  if app_private.pos_op_reserved_code(p_reason) is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request', 'reason', 'reserved_code');
  end if;
  select * into v_slot from app_private.pos_business_slots where slot_key = p_slot_key;
  if v_slot.slot_key is null then return jsonb_build_object('ok', false, 'error', 'slot_not_found'); end if;
  if v_slot.active_instruction_id is not null then
    select operation_id into v_op from app_private.pos_business_instructions where instruction_id = v_slot.active_instruction_id;
    return app_private.pos_op_finish(v_op, 'abandoned', 'slot_fenced', null, true);
  end if;
  select * into v_slot from app_private.pos_business_slots where slot_key = p_slot_key for update;
  if v_slot.active_instruction_id is not null then
    return jsonb_build_object('ok', false, 'error', 'retry_required');
  end if;
  update app_private.pos_business_slots set slot_epoch = slot_epoch + 1 where slot_key = p_slot_key;
  insert into app_private.pos_operation_events (slot_key, event_type, detail)
  values (p_slot_key, 'slot_fenced', jsonb_build_object('reason', coalesce(p_reason, 'fence'), 'slot_epoch', v_slot.slot_epoch + 1));
  return jsonb_build_object('ok', true, 'result', 'slot_fenced', 'slot_key', p_slot_key, 'slot_epoch', v_slot.slot_epoch + 1);
end;
$$;

-- ── 6. 旧データの分類（SELECT だけ） ──────────────────────────────────────────
-- 結果は {verdict: proven | blocked | no_physical_record | derived_key_requires_parent | foreign_domain_key | invalid_key, ...}
-- proven のときは kind・effects（親が先）・keys・headline を返す。効果の ID は各表の行 ID だけ（キーの文字列・名前・金額では結ばない）

create or replace function app_private.pos_op_blocked(p_reason text, p_ref jsonb default '{}'::jsonb)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$ select jsonb_build_object('verdict', 'blocked', 'reason', p_reason, 'ref', p_ref) $$;

create or replace function app_private.pos_op_ginpay_snapshot(t public.ginpay_transactions)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object('transaction_id', t.id, 'account_id', t.account_id, 'type', t.type, 'amount', t.amount,
    'status', t.status, 'accounting_session_id', t.accounting_session_id, 'original_transaction_id', t.original_transaction_id,
    'created_at', app_private.pos_op_ts(t.created_at))
$$;

-- 見積もりの指紋。会計の quote_hash は QTE1 形式の値（見積もりトークンとして端末とやり取りされる）なので、そのものは保存せず、
-- 一方向の指紋（QFP1）だけを残す。証拠が変わっていないかの比較には十分で、元の QTE1 には戻せない
create or replace function app_private.pos_op_quote_fingerprint(p_quote_hash text)
returns text language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case when p_quote_hash is null then null
              else 'QFP1.' || app_private.sha256_hex('pos_op_quote_fingerprint' || chr(31) || p_quote_hash) end
$$;

-- D1 会計：completed か voided（取消の前に確定していた）で、GINPay 払いなら sale:<key> の支払い1件と金額が一致すること
create or replace function app_private.pos_op_classify_sale(p_sale_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  s public.accounting_sessions;
  t public.ginpay_transactions;
  v_n integer;
  v_snap jsonb;
  v_effects jsonb;
  v_keys jsonb := '[]'::jsonb;
  v_ref jsonb := jsonb_build_object('sale_id', p_sale_id);
  v_state text;
begin
  select * into s from public.accounting_sessions where id = p_sale_id;
  if s.id is null then return jsonb_build_object('verdict', 'no_physical_record'); end if;
  if s.status is null or s.status not in ('completed', 'voided') then return app_private.pos_op_blocked('sale_status_' || coalesce(s.status, 'null'), v_ref); end if;
  if s.completed_at is null then return app_private.pos_op_blocked('sale_completed_at_missing', v_ref); end if;
  if s.status = 'voided' and s.voided_at is null then return app_private.pos_op_blocked('sale_voided_at_missing', v_ref); end if;
  if s.idempotency_key is not null and btrim(s.idempotency_key) = '' then
    return app_private.pos_op_blocked('sale_key_noncanonical', v_ref);
  end if;
  -- キーの同値類（btrim）がこの行だけで、行のキーが正規化した形であること（正規でない・あいまいなら登録しない）
  if s.idempotency_key is not null then
    v_state := app_private.pos_op_physical_probe('acct_sale', s.idempotency_key) ->> 'state';
    if v_state <> 'physical_key_canonical_single' or s.idempotency_key <> btrim(s.idempotency_key) then
      return app_private.pos_op_blocked(case when v_state = 'physical_key_ambiguous' then v_state else 'physical_key_noncanonical' end, v_ref);
    end if;
  end if;
  select count(*) into v_n from public.ginpay_transactions
  where accounting_session_id = s.id and type = 'payment' and status = 'posted';
  if s.payment_method = 'ginpay' then
    if s.idempotency_key is null then return app_private.pos_op_blocked('ginpay_sale_without_key', v_ref); end if;
    if v_n <> 1 then return app_private.pos_op_blocked('ginpay_payment_missing', v_ref); end if;
    select * into t from public.ginpay_transactions
    where accounting_session_id = s.id and type = 'payment' and status = 'posted';
    if t.idempotency_key <> 'sale:' || s.idempotency_key or t.amount <> -s.total then
      return app_private.pos_op_blocked('ginpay_payment_mismatch', v_ref);
    end if;
  elsif v_n > 0 then
    return app_private.pos_op_blocked('unexpected_ginpay_payment', v_ref);
  end if;

  v_snap := jsonb_build_object('sale_id', s.id, 'status_at_discovery', s.status, 'completed_at', app_private.pos_op_ts(s.completed_at),
    'total', s.total, 'subtotal', s.subtotal, 'discount_total', s.discount_total, 'payment_method', s.payment_method,
    'reservation_id', s.reservation_id, 'client_id', s.client_id,
    'used_ticket_ids', coalesce((select jsonb_agg(x order by x) from unnest(s.used_ticket_ids) x), '[]'::jsonb),
    'request_hash', s.request_hash, 'quote_fingerprint', app_private.pos_op_quote_fingerprint(s.quote_hash));
  v_effects := jsonb_build_array(jsonb_build_object('d', 'accounting_sale', 'i', s.id, 'k', 'sale', 's', v_snap));
  if s.idempotency_key is not null then
    v_keys := v_keys || jsonb_build_array(jsonb_build_object('d', 'acct_sale', 'v', s.idempotency_key));
  end if;
  if t.id is not null then
    v_effects := v_effects || jsonb_build_array(jsonb_build_object('d', 'ginpay_transaction', 'i', t.id, 'k', 'ginpay_sale_payment',
      'pd', 'accounting_sale', 'pi', s.id, 's', app_private.pos_op_ginpay_snapshot(t)));
    v_keys := v_keys || jsonb_build_array(jsonb_build_object('d', 'ginpay_tx', 'v', t.idempotency_key));
  end if;
  return jsonb_build_object('verdict', 'proven', 'kind', 'legacy_sale', 'effects', v_effects, 'keys', v_keys,
    'headline', jsonb_build_object('sale_id', s.id, 'total', s.total, 'payment_method', s.payment_method));
end;
$$;

-- D2 取消：キーがあるだけでは証明にならない。voided（確定と取消の日時あり）で、GINPay 払いなら sale-void:<会計ID> の戻しが
-- 元の支払いを指し、同じ口座・同じ会計で、今の取消の決まりどおりの金額（元の支払いの全額）であること。言い切れなければ blocked
create or replace function app_private.pos_op_classify_sale_void(p_sale_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  s public.accounting_sessions;
  t public.ginpay_transactions;
  v public.ginpay_transactions;
  v_n integer;
  v_snap jsonb;
  v_effects jsonb;
  v_keys jsonb := '[]'::jsonb;
  v_ref jsonb := jsonb_build_object('sale_id', p_sale_id);
  v_probe jsonb;
begin
  select * into s from public.accounting_sessions where id = p_sale_id;
  if s.id is null then return jsonb_build_object('verdict', 'no_physical_record'); end if;
  if s.status is distinct from 'voided' then return app_private.pos_op_blocked('sale_not_voided', v_ref); end if;
  if s.completed_at is null or s.voided_at is null then return app_private.pos_op_blocked('sale_void_times_missing', v_ref); end if;
  if s.void_idempotency_key is not null and (btrim(s.void_idempotency_key) = '' or s.void_request_hash is null) then
    return app_private.pos_op_blocked('void_key_without_request_hash', v_ref);
  end if;
  -- 戻しのキー sale-void:<会計ID> も D3：btrim の同値類をまるごと見る（正規でない・あいまいなら「戻しが無い」とは言わない）
  v_probe := app_private.pos_op_physical_probe('ginpay_tx', 'sale-void:' || s.id::text);
  if v_probe ->> 'state' in ('physical_key_noncanonical', 'physical_key_ambiguous') then
    return app_private.pos_op_blocked(v_probe ->> 'state', v_ref);
  end if;
  if v_probe ->> 'state' = 'physical_key_canonical_single' then
    select * into v from public.ginpay_transactions where id = (v_probe ->> 'id')::uuid;
  end if;
  select count(*) into v_n from public.ginpay_transactions
  where accounting_session_id = s.id and type = 'payment' and status = 'posted';
  if s.payment_method = 'ginpay' then
    -- 元の支払い T：この会計の posted の payment がちょうど1件、sale:<会計キー>、金額 = -合計
    if v_n <> 1 or s.idempotency_key is null then return app_private.pos_op_blocked('ginpay_payment_missing', v_ref); end if;
    select * into t from public.ginpay_transactions
    where accounting_session_id = s.id and type = 'payment' and status = 'posted';
    if t.idempotency_key is distinct from 'sale:' || s.idempotency_key or t.amount is distinct from -s.total
       or t.amount >= 0 or t.account_id is null then
      return app_private.pos_op_blocked('ginpay_payment_mismatch', v_ref);
    end if;
    -- 戻し V：sale-void:<会計ID>、void・posted、T を指し、同じ口座、同じ会計
    if v.id is null or v.type is distinct from 'void' or v.status is distinct from 'posted'
       or v.original_transaction_id is distinct from t.id then
      return app_private.pos_op_blocked('sale_void_reversal_unproven', v_ref);
    end if;
    if v.account_id is distinct from t.account_id then
      return app_private.pos_op_blocked('sale_void_reversal_account_mismatch', v_ref);
    end if;
    if v.accounting_session_id is distinct from s.id then
      return app_private.pos_op_blocked('sale_void_reversal_session_mismatch', v_ref);
    end if;
    -- 金額：今の取消（ginpay_reverse_transaction の void）は -(T + それまでの T への返金・取消) を戻す。
    -- T を指す返金・取消が V 以外に1件でもあると、取消の時点で残っていた額をこの台帳だけでは一意に言えないので止める
    if exists (select 1 from public.ginpay_transactions x where x.original_transaction_id = t.id and x.id <> v.id) then
      return app_private.pos_op_blocked('sale_void_reversal_ambiguous', v_ref);
    end if;
    if v.amount is distinct from -t.amount then
      return app_private.pos_op_blocked('sale_void_reversal_amount_mismatch', v_ref);
    end if;
    -- この会計に結びつく GINPay の行は T と V だけ
    if exists (select 1 from public.ginpay_transactions x where x.accounting_session_id = s.id and x.id not in (t.id, v.id)) then
      return app_private.pos_op_blocked('unexpected_sale_ginpay_rows', v_ref);
    end if;
  elsif v.id is not null then
    return app_private.pos_op_blocked('unexpected_ginpay_reversal', v_ref);
  elsif v_n > 0 then
    return app_private.pos_op_blocked('unexpected_ginpay_payment', v_ref);
  end if;

  v_snap := jsonb_build_object('sale_id', s.id, 'voided_at', app_private.pos_op_ts(s.voided_at),
    'void_request_hash', s.void_request_hash,
    'reversal_transaction_ids', case when v.id is not null then jsonb_build_array(v.id) else '[]'::jsonb end);
  v_effects := jsonb_build_array(jsonb_build_object('d', 'accounting_sale_void', 'i', s.id, 'k', 'sale_void', 's', v_snap));
  if s.void_idempotency_key is not null then
    v_keys := v_keys || jsonb_build_array(jsonb_build_object('d', 'acct_void', 'v', s.void_idempotency_key));
  end if;
  if v.id is not null then
    v_effects := v_effects || jsonb_build_array(jsonb_build_object('d', 'ginpay_transaction', 'i', v.id, 'k', 'ginpay_sale_reversal',
      'pd', 'accounting_sale_void', 'pi', s.id, 's', app_private.pos_op_ginpay_snapshot(v)));
    v_keys := v_keys || jsonb_build_array(jsonb_build_object('d', 'ginpay_tx', 'v', v.idempotency_key));
  end if;
  return jsonb_build_object('verdict', 'proven', 'kind', 'legacy_sale_void', 'effects', v_effects, 'keys', v_keys,
    'headline', jsonb_build_object('sale_id', s.id, 'reversal_amount', v.amount));
end;
$$;

-- D3 GINPay：posted で、キーの接頭辞と種類が一致するものだけ。会計の支払い・取消の戻しは親（会計）から証明する。Stripe は対象外
create or replace function app_private.pos_op_classify_ginpay(p_tx_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  t public.ginpay_transactions;
  v_plan jsonb;
  v_expected text;
  v_ref jsonb := jsonb_build_object('transaction_id', p_tx_id);
  v_state text;
begin
  select * into t from public.ginpay_transactions where id = p_tx_id;
  if t.id is null then return jsonb_build_object('verdict', 'no_physical_record'); end if;
  -- D3 は種類をまたいで1つの範囲：キーの同値類（btrim）がこの行だけで、行のキーが正規化した形であること
  v_state := app_private.pos_op_physical_probe('ginpay_tx', t.idempotency_key) ->> 'state';
  if v_state is distinct from 'physical_key_canonical_single' or t.idempotency_key <> btrim(t.idempotency_key) then
    return app_private.pos_op_blocked(case when v_state = 'physical_key_ambiguous' then v_state else 'physical_key_noncanonical' end, v_ref);
  end if;
  if t.type = 'charge_stripe' or t.operator_type = 'stripe' or starts_with(t.idempotency_key, 'stripe:') then
    return jsonb_build_object('verdict', 'foreign_domain_key');
  end if;
  if t.type = 'payment' or starts_with(t.idempotency_key, 'sale:') then
    if t.type <> 'payment' or t.accounting_session_id is null then return app_private.pos_op_blocked('derived_namespace_misuse', v_ref); end if;
    v_plan := app_private.pos_op_classify_sale(t.accounting_session_id);
    if v_plan ->> 'verdict' = 'no_physical_record' then return app_private.pos_op_blocked('payment_parent_missing', v_ref); end if;
    if v_plan ->> 'verdict' = 'proven' and not exists (select 1 from jsonb_array_elements(v_plan -> 'effects') e where e ->> 'i' = t.id::text) then
      return app_private.pos_op_blocked('payment_not_owned_by_sale', v_ref);
    end if;
    return v_plan;
  end if;
  if starts_with(t.idempotency_key, 'sale-void:') then
    if t.accounting_session_id is null then return app_private.pos_op_blocked('derived_namespace_misuse', v_ref); end if;
    v_plan := app_private.pos_op_classify_sale_void(t.accounting_session_id);
    if v_plan ->> 'verdict' = 'no_physical_record' then return app_private.pos_op_blocked('reversal_parent_missing', v_ref); end if;
    if v_plan ->> 'verdict' = 'proven' and not exists (select 1 from jsonb_array_elements(v_plan -> 'effects') e where e ->> 'i' = t.id::text) then
      return app_private.pos_op_blocked('reversal_not_owned_by_void', v_ref);
    end if;
    return v_plan;
  end if;
  if t.status <> 'posted' then return app_private.pos_op_blocked('ginpay_status_' || t.status, v_ref); end if;
  v_expected := case
    when starts_with(t.idempotency_key, 'staff-store-charge:') then 'charge_store'
    when starts_with(t.idempotency_key, 'staff-refund:') or starts_with(t.idempotency_key, 'hq-refund:') then 'refund'
    when starts_with(t.idempotency_key, 'hq-void:') then 'void'
    when starts_with(t.idempotency_key, 'hq-adjustment:') then 'adjustment'
  end;
  if v_expected is null then return app_private.pos_op_blocked('unknown_key_prefix', v_ref); end if;
  if v_expected <> t.type then return app_private.pos_op_blocked('type_prefix_mismatch', v_ref); end if;
  return jsonb_build_object('verdict', 'proven',
    'kind', case t.type when 'charge_store' then 'legacy_ginpay_charge' when 'refund' then 'legacy_ginpay_refund'
                        when 'void' then 'legacy_ginpay_void' else 'legacy_ginpay_adjustment' end,
    'effects', jsonb_build_array(jsonb_build_object('d', 'ginpay_transaction', 'i', t.id,
      'k', case t.type when 'charge_store' then 'ginpay_charge' when 'refund' then 'ginpay_refund'
                       when 'void' then 'ginpay_void' else 'ginpay_adjustment' end,
      's', app_private.pos_op_ginpay_snapshot(t))),
    'keys', jsonb_build_array(jsonb_build_object('d', 'ginpay_tx', 'v', t.idempotency_key)),
    'headline', jsonb_build_object('transaction_id', t.id, 'type', t.type, 'amount', t.amount));
end;
$$;

-- D4 チケット発行：issued で、承認ハッシュ・枚数・チケット ID がそろい、チケットの行が種類・金額とも一致すること
create or replace function app_private.pos_op_classify_ticket_issue(p_log_id uuid)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  l public.ticket_issue_logs;
  v_n integer;
  v_tickets jsonb;
  v_keys jsonb := '[]'::jsonb;
  v_ref jsonb := jsonb_build_object('log_id', p_log_id);
begin
  select * into l from public.ticket_issue_logs where id = p_log_id;
  if l.id is null then return jsonb_build_object('verdict', 'no_physical_record'); end if;
  if l.status is distinct from 'issued' then return app_private.pos_op_blocked('ticket_issue_status', v_ref); end if;
  if l.request_hash is null or l.request_hash !~ '^AUTH1\.[a-f0-9]{64}$' then
    return app_private.pos_op_blocked('ticket_issue_request_hash_missing', v_ref);
  end if;
  if l.ticket_ids is null or l.quantity is null or l.quantity < 1 or cardinality(l.ticket_ids) <> l.quantity
     or (select count(distinct x) from unnest(l.ticket_ids) x) <> l.quantity then
    return app_private.pos_op_blocked('ticket_issue_ids_inconsistent', v_ref);
  end if;
  select count(*), jsonb_agg(jsonb_build_object('id', t.id, 'type', t.type, 'amount', t.amount) order by t.id)
  into v_n, v_tickets
  from public.tickets t where t.id = any (l.ticket_ids);
  if v_n <> l.quantity then return app_private.pos_op_blocked('ticket_issue_tickets_missing', v_ref); end if;
  if exists (select 1 from public.tickets t where t.id = any (l.ticket_ids) and (t.type <> l.ticket_type or t.amount <> l.amount)) then
    return app_private.pos_op_blocked('ticket_issue_tickets_mismatch', v_ref);
  end if;
  if l.idempotency_key is not null and btrim(l.idempotency_key) <> '' then
    v_keys := jsonb_build_array(jsonb_build_object('d', 'ticket_issue', 'v', l.idempotency_key));
  end if;
  return jsonb_build_object('verdict', 'proven', 'kind', 'legacy_ticket_issue',
    'effects', jsonb_build_array(jsonb_build_object('d', 'ticket_issue', 'i', l.id, 'k', 'ticket_issue',
      's', jsonb_build_object('log_id', l.id, 'user_id', l.user_id, 'ticket_type', l.ticket_type, 'amount', l.amount,
        'quantity', l.quantity, 'ticket_ids', (select jsonb_agg(x order by x) from unnest(l.ticket_ids) x),
        'tickets', v_tickets, 'request_hash', l.request_hash, 'status', l.status,
        'issued_at', app_private.pos_op_ts(l.issued_at)))),
    'keys', v_keys,
    'headline', jsonb_build_object('log_id', l.id, 'ticket_type', l.ticket_type, 'amount', l.amount, 'quantity', l.quantity));
end;
$$;

-- proven の計画のキーのうち D1/D3 のもの：既存の表の同値類（btrim）がちょうど1行で、行のキーが正規化した形であること。
-- 支払い sale:<key>・戻し sale-void:<id> のように、元の行の分類では見ていない派生キーもここで確かめる。満たさなければ blocked
create or replace function app_private.pos_op_plan_physical_check(p_plan jsonb)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select case
    when p_plan ->> 'verdict' is distinct from 'proven' then p_plan
    when r.reason is not null then app_private.pos_op_blocked(r.reason, jsonb_build_object('effect_identity', p_plan #>> '{effects,0,i}'))
    else p_plan end
  from (select case when bool_or(s = 'physical_key_ambiguous') then 'physical_key_ambiguous'
                    when bool_or(s <> 'physical_key_canonical_single' or not canon) then 'physical_key_noncanonical' end reason
        from (select app_private.pos_op_physical_probe(k ->> 'd', k ->> 'v') ->> 'state' s,
                     coalesce(k ->> 'v' = app_private.pos_op_key_normalize(k ->> 'd', k ->> 'v'), false) canon
              from jsonb_array_elements(coalesce(p_plan -> 'keys', '[]'::jsonb)) k
              where k ->> 'd' in ('acct_sale', 'ginpay_tx')) x) r
$$;

-- キーからの分類。既存の行は pos_op_physical_probe で探す（D1/D3 は btrim の同値類をまるごと。1行を勝手に選ばない）
create or replace function app_private.pos_op_classify_legacy_key(p_domain text, p_raw text)
returns jsonb language plpgsql stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm text := app_private.pos_op_key_normalize(p_domain, p_raw);
  v_probe jsonb;
  v_id uuid;
begin
  if v_norm is null or p_domain not in ('acct_sale', 'acct_void', 'ginpay_tx', 'ticket_issue', 'pos_virtual') then
    return jsonb_build_object('verdict', 'invalid_key');
  end if;
  if p_domain = 'pos_virtual' then return jsonb_build_object('verdict', 'no_physical_record'); end if;
  if p_domain = 'ginpay_tx' then
    if starts_with(v_norm, 'sale:') or starts_with(v_norm, 'sale-void:') then
      return jsonb_build_object('verdict', 'derived_key_requires_parent');
    end if;
    if starts_with(v_norm, 'stripe:') then return jsonb_build_object('verdict', 'foreign_domain_key'); end if;
  end if;
  v_probe := app_private.pos_op_physical_probe(p_domain, v_norm);
  case v_probe ->> 'state'
    when 'physical_key_absent' then return jsonb_build_object('verdict', 'no_physical_record');
    when 'physical_key_noncanonical' then return app_private.pos_op_blocked('physical_key_noncanonical');
    when 'physical_key_ambiguous' then return app_private.pos_op_blocked('physical_key_ambiguous');
    when 'physical_key_canonical_single' then v_id := (v_probe ->> 'id')::uuid;
    else return jsonb_build_object('verdict', 'invalid_key');
  end case;
  return app_private.pos_op_plan_physical_check(case p_domain
    when 'acct_sale' then app_private.pos_op_classify_sale(v_id)
    when 'acct_void' then app_private.pos_op_classify_sale_void(v_id)
    when 'ginpay_tx' then app_private.pos_op_classify_ginpay(v_id)
    else app_private.pos_op_classify_ticket_issue(v_id) end);
end;
$$;

create or replace function app_private.pos_op_classify_legacy_effect(p_domain text, p_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select app_private.pos_op_plan_physical_check(case p_domain
    when 'accounting_sale' then app_private.pos_op_classify_sale(p_id)
    when 'accounting_sale_void' then app_private.pos_op_classify_sale_void(p_id)
    when 'ginpay_transaction' then app_private.pos_op_classify_ginpay(p_id)
    when 'ticket_issue' then app_private.pos_op_classify_ticket_issue(p_id)
    else jsonb_build_object('verdict', 'invalid_effect') end)
$$;

-- 登録済みの効果と今の証拠が、お金・本人に関わる項目で同じか（表示だけの項目・キーの文字列・会計の取消後の状態は見ない）
create or replace function app_private.pos_op_effect_compatible(p_kind text, p_stored jsonb, p_current jsonb)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(bool_and((p_stored -> k) is not distinct from (p_current -> k)), false)
  from unnest(case p_kind
    when 'sale' then array['sale_id', 'completed_at', 'total', 'subtotal', 'discount_total', 'payment_method',
                           'reservation_id', 'used_ticket_ids', 'request_hash', 'quote_fingerprint']
    when 'sale_void' then array['sale_id', 'voided_at', 'void_request_hash', 'reversal_transaction_ids']
    when 'ticket_issue' then array['log_id', 'user_id', 'ticket_type', 'amount', 'quantity', 'ticket_ids', 'tickets',
                                   'request_hash', 'issued_at']
    else array['transaction_id', 'account_id', 'type', 'amount', 'status', 'accounting_session_id',
               'original_transaction_id', 'created_at'] end) k
$$;

-- ── 7. 旧データの取り込み（discovery。内部の書き込み関数） ─────────────────────

-- 分類の結果のキー（既存の行の値、{d, v}）に digest（h）を付ける。v は関数の中だけで使い、台帳には h だけを書く
create or replace function app_private.pos_op_plan_with_digests(p_plan jsonb)
returns jsonb language sql immutable
set search_path = public, extensions, pg_temp
as $$
  select case when p_plan ? 'keys'
              then jsonb_set(p_plan, '{keys}', coalesce((select jsonb_agg(app_private.pos_op_key_elem(k ->> 'd', k ->> 'v') order by ord)
                                                          from jsonb_array_elements(p_plan -> 'keys') with ordinality as x(k, ord)), '[]'::jsonb))
              else p_plan end
$$;

/**
 * 旧データの確定済み効果を、1つの操作（legacy_discovered・completed）として登録する。キーか効果 ID のどちらからでも同じ操作に収束する
 *   A. 読むだけで計画（分類・キー一式 Y・効果一式 X）
 *   B. キーの lock（並べ替え）→ 効果の lock（並べ替え）
 *   C. lock の後に分類し直し、Y/X が lock した範囲を超えたら discovery_retry_required（何も書かない）
 *   X が未登録 → 操作を1つ作り、効果・キー（legacy_alias）・履歴を1回で登録
 *   X がすべて O → 証拠が同じなら、足りないキーを legacy_alias として O に足す
 *   X の一部が O、残りが O の効果の子 → 子を O に足す（状態・結果・時刻は変えない）
 *   X が複数の操作に分かれる → legacy_effect_conflict / 証拠が違う → legacy_evidence_changed / あいまい → legacy_state_blocked（どれも書かない）
 * 一意制約の違反は成功とは扱わない（例外のまま全体を戻す）
 */
create or replace function app_private.pos_op_discover_legacy(p_mode text, p_domain text, p_value text)
returns jsonb language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm text;
  v_eff uuid;
  v_plan jsonb;
  v_lock_keys jsonb;
  v_lock_effects jsonb;
  v_req_bind app_private.pos_operation_keys;
  v_req_op app_private.pos_operations;
  v_owners uuid[];
  v_op app_private.pos_operations;
  v_existing app_private.pos_operation_effects;
  v_e jsonb;
  v_k jsonb;
  v_via text;
  v_attached integer := 0;
  v_aliases integer := 0;
  v_registered uuid;
  v_new uuid;
begin
  if p_mode = 'key' then
    v_norm := app_private.pos_op_key_normalize(p_domain, p_value);
    if v_norm is null or p_domain not in ('acct_sale', 'acct_void', 'ginpay_tx', 'ticket_issue', 'pos_virtual') then
      return jsonb_build_object('ok', false, 'error', 'invalid_key');
    end if;
    v_via := 'discovery_key';
  elsif p_mode = 'effect' then
    if p_domain not in ('accounting_sale', 'accounting_sale_void', 'ginpay_transaction', 'ticket_issue')
       or not app_private.pos_op_is_uuid_text(lower(coalesce(p_value, ''))) then
      return jsonb_build_object('ok', false, 'error', 'invalid_effect');
    end if;
    v_eff := p_value::uuid;
    v_via := 'discovery_effect';
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  -- A. 計画（読むだけ）。生のキーは既存の表の照会と digest を作るためだけに使い、保存しない
  v_plan := app_private.pos_op_plan_with_digests(case when p_mode = 'key' then app_private.pos_op_classify_legacy_key(p_domain, v_norm)
                                                      else app_private.pos_op_classify_legacy_effect(p_domain, v_eff) end);
  v_lock_keys := app_private.pos_op_dh(v_plan -> 'keys')
    || case when p_mode = 'key' then app_private.pos_op_dh(jsonb_build_array(app_private.pos_op_key_elem(p_domain, v_norm))) else '[]'::jsonb end;
  v_lock_effects := app_private.pos_op_di(v_plan -> 'effects')
    || case when p_mode = 'effect' then jsonb_build_array(jsonb_build_object('d', p_domain, 'i', v_eff::text)) else '[]'::jsonb end;

  -- B. キー → 効果の順に lock
  perform app_private.pos_op_lock_keys_xact(v_lock_keys);
  perform app_private.pos_op_lock_effects(v_lock_effects);

  -- C. lock の後に分類し直す
  v_plan := app_private.pos_op_plan_with_digests(case when p_mode = 'key' then app_private.pos_op_classify_legacy_key(p_domain, v_norm)
                                                      else app_private.pos_op_classify_legacy_effect(p_domain, v_eff) end);
  if not (app_private.pos_op_dh(v_plan -> 'keys') <@ v_lock_keys and app_private.pos_op_di(v_plan -> 'effects') <@ v_lock_effects) then
    return jsonb_build_object('ok', false, 'error', 'discovery_retry_required');
  end if;

  -- 指定のキーがすでに登録済みなら、台帳を正とする（元の行のキーが消えても同じ操作を返す）
  if p_mode = 'key' then
    select * into v_req_bind from app_private.pos_operation_keys
    where key_domain = p_domain and key_digest = app_private.pos_op_key_digest(p_domain, v_norm);
    if v_req_bind.operation_id is not null then
      select * into v_req_op from app_private.pos_operations where operation_id = v_req_bind.operation_id;
      if v_plan ->> 'verdict' = 'no_physical_record' then
        return jsonb_build_object('ok', true, 'result', 'bound', 'operation_id', v_req_op.operation_id, 'status', v_req_op.status,
          'key_role', v_req_bind.key_role, 'note', 'source_key_absent');
      end if;
      if v_req_op.status <> 'completed' then
        return jsonb_build_object('ok', false, 'error', 'bound_key_has_legacy_effect', 'operation_id', v_req_op.operation_id,
          'status', v_req_op.status, 'verdict', v_plan ->> 'verdict');
      end if;
      if v_plan ->> 'verdict' <> 'proven' then
        return jsonb_build_object('ok', false, 'error', 'legacy_evidence_changed', 'operation_id', v_req_op.operation_id,
          'verdict', v_plan ->> 'verdict', 'reason', v_plan ->> 'reason');
      end if;
    end if;
  end if;

  if v_plan ->> 'verdict' <> 'proven' then
    if p_mode = 'effect' then
      select operation_id into v_registered from app_private.pos_operation_effects where effect_domain = p_domain and effect_identity = v_eff;
      if v_registered is not null then
        return jsonb_build_object('ok', false, 'error', 'legacy_evidence_changed', 'operation_id', v_registered,
          'verdict', v_plan ->> 'verdict', 'reason', v_plan ->> 'reason');
      end if;
    end if;
    return jsonb_build_object('ok', false,
      'error', case v_plan ->> 'verdict' when 'blocked' then 'legacy_state_blocked' else v_plan ->> 'verdict' end,
      'reason', v_plan ->> 'reason');
  end if;

  -- 保存できない証拠（許可リストの外・秘密らしい値）は登録しない（何も書かない）
  if exists (select 1 from jsonb_array_elements(v_plan -> 'effects') e
             where app_private.pos_op_validate_effect_snapshot(e ->> 'k', e -> 's') is not null)
     or app_private.pos_op_validate_shape(app_private.pos_op_snapshot_schema('headline'), v_plan -> 'headline', false) is not null then
    return jsonb_build_object('ok', false, 'error', 'legacy_state_blocked', 'reason', 'snapshot_not_representable');
  end if;
  -- 既存の行のキーが、その範囲の正規化した形でないなら（例：D3 で前後に空白）、別のキーと同じ digest になりうるので登録しない
  if exists (select 1 from jsonb_array_elements(v_plan -> 'keys') k
             where app_private.pos_op_key_normalize(k ->> 'd', k ->> 'v') is distinct from k ->> 'v') then
    return jsonb_build_object('ok', false, 'error', 'legacy_state_blocked', 'reason', 'key_noncanonical');
  end if;

  -- 効果・キーの持ち主
  select array_agg(distinct x.operation_id) into v_owners
  from (
    select f.operation_id from app_private.pos_operation_effects f
    join jsonb_array_elements(v_plan -> 'effects') e on f.effect_domain = e ->> 'd' and f.effect_identity = (e ->> 'i')::uuid
    union all
    select b.operation_id from app_private.pos_operation_keys b
    join jsonb_array_elements(v_plan -> 'keys') k on b.key_domain = k ->> 'd' and b.key_digest = decode(k ->> 'h', 'hex')
    union all
    select v_req_bind.operation_id where v_req_bind.operation_id is not null
  ) x;

  if coalesce(cardinality(v_owners), 0) > 1 then
    return jsonb_build_object('ok', false, 'error', 'legacy_effect_conflict', 'operation_ids', to_jsonb(v_owners));
  end if;

  if coalesce(cardinality(v_owners), 0) = 1 then
    select * into v_op from app_private.pos_operations where operation_id = v_owners[1] for update;
    if v_op.status <> 'completed' then
      return jsonb_build_object('ok', false, 'error', 'bound_key_has_legacy_effect', 'operation_id', v_op.operation_id, 'status', v_op.status);
    end if;
    -- 先に全部を確かめてから書く
    for v_e in select e from jsonb_array_elements(v_plan -> 'effects') e loop
      select * into v_existing from app_private.pos_operation_effects
      where effect_domain = v_e ->> 'd' and effect_identity = (v_e ->> 'i')::uuid;
      if v_existing.operation_id is not null then
        if v_existing.effect_kind <> v_e ->> 'k' or not app_private.pos_op_effect_compatible(v_existing.effect_kind, v_existing.snapshot, v_e -> 's') then
          return jsonb_build_object('ok', false, 'error', 'legacy_evidence_changed', 'operation_id', v_op.operation_id,
            'effect_domain', v_existing.effect_domain, 'effect_identity', v_existing.effect_identity);
        end if;
      elsif v_e ->> 'pd' is null or not (
              exists (select 1 from app_private.pos_operation_effects p
                      where p.effect_domain = v_e ->> 'pd' and p.effect_identity = (v_e ->> 'pi')::uuid and p.operation_id = v_op.operation_id)) then
        -- 親子の関係が証明できない新しい効果は、既存の操作に足さない
        return jsonb_build_object('ok', false, 'error', 'legacy_evidence_changed', 'operation_id', v_op.operation_id,
          'effect_domain', v_e ->> 'd', 'effect_identity', v_e ->> 'i');
      end if;
    end loop;
    for v_e in select e from jsonb_array_elements(v_plan -> 'effects') e loop
      if not exists (select 1 from app_private.pos_operation_effects where effect_domain = v_e ->> 'd' and effect_identity = (v_e ->> 'i')::uuid) then
        insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, parent_domain, parent_identity,
          snapshot, snapshot_hash, classifier_version, registered_via)
        values (v_e ->> 'd', (v_e ->> 'i')::uuid, v_op.operation_id, v_e ->> 'k', v_e ->> 'pd', (v_e ->> 'pi')::uuid,
          v_e -> 's', app_private.pos_op_hash('LEG1', v_e -> 's'), 'c1-legacy-v1', v_via);
        insert into app_private.pos_operation_events (operation_id, event_type, detail)
        values (v_op.operation_id, 'legacy_effect_attached', jsonb_build_object('effect_domain', v_e ->> 'd', 'effect_kind', v_e ->> 'k'));
        v_attached := v_attached + 1;
      end if;
    end loop;
    for v_k in select e from jsonb_array_elements(v_plan -> 'keys') e loop
      if not exists (select 1 from app_private.pos_operation_keys where key_domain = v_k ->> 'd' and key_digest = decode(v_k ->> 'h', 'hex')) then
        insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role)
        values (v_k ->> 'd', decode(v_k ->> 'h', 'hex'), v_op.operation_id, 'legacy_alias');
        insert into app_private.pos_operation_events (operation_id, event_type, detail)
        values (v_op.operation_id, 'legacy_alias_added', jsonb_build_object('key_domain', v_k ->> 'd'));
        v_aliases := v_aliases + 1;
      end if;
    end loop;
    return jsonb_build_object('ok', true, 'result', case when v_attached + v_aliases > 0 then 'enriched' else 'existing' end,
      'operation_id', v_op.operation_id, 'effects_attached', v_attached, 'aliases_added', v_aliases);
  end if;

  -- 未登録：操作を1つ作って、効果（親が先）とキーを登録
  insert into app_private.pos_operations (kind, origin, status, result_snapshot, result_snapshot_hash, terminal_at)
  select v_plan ->> 'kind', 'legacy_discovered', 'completed', r, app_private.pos_op_hash('LEG1', r), now()
  from (select jsonb_build_object(
          'representative_only', true,
          'kind', v_plan ->> 'kind',
          'classifier_version', 'c1-legacy-v1',
          'initial_effects', (select jsonb_agg(jsonb_build_object('d', e ->> 'd', 'i', e ->> 'i', 'k', e ->> 'k'))
                              from jsonb_array_elements(v_plan -> 'effects') e),
          'headline', v_plan -> 'headline') r) x
  returning operation_id into v_new;
  for v_e in select e from jsonb_array_elements(v_plan -> 'effects') e loop
    insert into app_private.pos_operation_effects (effect_domain, effect_identity, operation_id, effect_kind, parent_domain, parent_identity,
      snapshot, snapshot_hash, classifier_version, registered_via)
    values (v_e ->> 'd', (v_e ->> 'i')::uuid, v_new, v_e ->> 'k', v_e ->> 'pd', (v_e ->> 'pi')::uuid,
      v_e -> 's', app_private.pos_op_hash('LEG1', v_e -> 's'), 'c1-legacy-v1', v_via);
  end loop;
  for v_k in select e from jsonb_array_elements(v_plan -> 'keys') e loop
    insert into app_private.pos_operation_keys (key_domain, key_digest, operation_id, key_role)
    values (v_k ->> 'd', decode(v_k ->> 'h', 'hex'), v_new, 'legacy_alias');
  end loop;
  insert into app_private.pos_operation_events (operation_id, event_type, detail)
  values (v_new, 'legacy_discovered', jsonb_build_object('effects', jsonb_array_length(v_plan -> 'effects'),
    'keys', jsonb_array_length(v_plan -> 'keys'), 'via', v_via));
  return jsonb_build_object('ok', true, 'result', 'discovered', 'operation_id', v_new,
    'effects', jsonb_array_length(v_plan -> 'effects'), 'keys', jsonb_array_length(v_plan -> 'keys'));
end;
$$;

-- ── 8. 状態の確認・照会（SELECT だけ。discovery も旧データの分類も呼ばない） ─────────

create or replace function app_private.pos_op_operation_summary(p_operation_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'operation_id', o.operation_id, 'kind', o.kind, 'origin', o.origin, 'status', o.status, 'last_code', o.last_code,
    'slot_key', o.slot_key, 'created_at', app_private.pos_op_ts(o.created_at), 'terminal_at', app_private.pos_op_ts(o.terminal_at),
    'instruction_id', (select i.instruction_id from app_private.pos_business_instructions i where i.operation_id = o.operation_id),
    'refused_instruction_id', o.refused_instruction_id,
    -- キーは範囲と役割だけ（台帳はキーの文字列を持たない）
    'keys', coalesce((select jsonb_agg(jsonb_build_object('domain', k.key_domain, 'role', k.key_role)
                                      order by k.key_domain, k.key_role, k.key_digest)
                      from app_private.pos_operation_keys k where k.operation_id = o.operation_id), '[]'::jsonb),
    'effects', coalesce((select jsonb_agg(jsonb_build_object('domain', f.effect_domain, 'identity', f.effect_identity, 'kind', f.effect_kind)
                                         order by f.registered_at, f.effect_domain, f.effect_identity)
                         from app_private.pos_operation_effects f where f.operation_id = o.operation_id), '[]'::jsonb),
    'required_targets', coalesce((select jsonb_agg(r.target_key order by r.target_key)
                                  from app_private.pos_operation_required_targets r where r.operation_id = o.operation_id), '[]'::jsonb),
    'active_targets', coalesce((select jsonb_agg(t.target_key order by t.target_key)
                                from app_private.pos_operation_targets t where t.operation_id = o.operation_id and t.active), '[]'::jsonb),
    'result_snapshot', o.result_snapshot)
  from app_private.pos_operations o where o.operation_id = p_operation_id
$$;

create or replace function app_private.pos_op_status_by_operation(p_operation_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$ select coalesce(app_private.pos_op_operation_summary(p_operation_id), jsonb_build_object('found', false)) $$;

create or replace function app_private.pos_op_status_by_key(p_domain text, p_raw text)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object('key_domain', p_domain, 'bound', k.operation_id is not null, 'key_role', k.key_role,
    'operation', app_private.pos_op_operation_summary(k.operation_id))
  from (select app_private.pos_op_key_ident(p_domain, p_raw) as h) n
  left join app_private.pos_operation_keys k on k.key_domain = p_domain and k.key_digest = n.h
$$;

-- 将来の書き込み RPC が使う判定：実行してよいのは、登録済みの entry キーで、操作が prepared/claimed のときだけ
create or replace function app_private.pos_op_key_executable(p_domain text, p_raw text)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select case
    when k.operation_id is null then jsonb_build_object('executable', false, 'reason', 'unbound')
    when k.key_role <> 'entry' then jsonb_build_object('executable', false, 'reason', 'role_' || k.key_role, 'operation_id', k.operation_id)
    when o.status not in ('prepared', 'claimed') then jsonb_build_object('executable', false, 'reason', 'status_' || o.status, 'operation_id', k.operation_id)
    else jsonb_build_object('executable', true, 'operation_id', k.operation_id, 'status', o.status) end
  from (select app_private.pos_op_key_ident(p_domain, p_raw) as h) n
  left join app_private.pos_operation_keys k on k.key_domain = p_domain and k.key_digest = n.h
  left join app_private.pos_operations o on o.operation_id = k.operation_id
$$;

create or replace function app_private.pos_op_status_by_instruction(p_instruction_id uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce((
    select jsonb_build_object('instruction_id', i.instruction_id, 'disposition', i.disposition, 'refusal_code', i.refusal_code,
      'kind', i.kind, 'slot_key', i.slot_key, 'observed_epoch', i.observed_epoch, 'installed_epoch', i.installed_epoch,
      'entry_key_domain', i.entry_key_domain, 'facts', i.facts,
      'actor_type', i.actor_type, 'actor_name', i.actor_name, 'created_at', app_private.pos_op_ts(i.created_at),
      'operation', app_private.pos_op_operation_summary(i.operation_id))
    from app_private.pos_business_instructions i where i.instruction_id = p_instruction_id),
    jsonb_build_object('found', false))
$$;

-- 枠から照会（キーを失った端末でも、業務の文脈から依頼・操作・キーが分かる）
create or replace function app_private.pos_op_status_by_slot(p_slot_key text)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce((
    select jsonb_build_object('slot_key', s.slot_key, 'slot_kind', s.slot_kind, 'slot_epoch', s.slot_epoch,
      'active_instruction_id', s.active_instruction_id,
      'instructions', coalesce((select jsonb_agg(app_private.pos_op_status_by_instruction(i.instruction_id) order by i.created_at desc, i.instruction_id)
                                from (select instruction_id, created_at from app_private.pos_business_instructions
                                      where slot_key = s.slot_key order by created_at desc, instruction_id limit 50) i), '[]'::jsonb))
    from app_private.pos_business_slots s where s.slot_key = p_slot_key),
    jsonb_build_object('slot_key', p_slot_key, 'found', false, 'slot_epoch', 0, 'instructions', '[]'::jsonb))
$$;

create or replace function app_private.pos_op_status_by_context(p_kind text, p_facts jsonb, p_lane text default null)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select case
    when app_private.pos_op_validate_facts(p_kind, p_facts) is not null then jsonb_build_object('found', false, 'error', 'invalid_facts')
    when app_private.pos_op_slot_key(p_kind, p_facts, p_lane) is null then jsonb_build_object('found', false, 'error', 'invalid_request')
    else app_private.pos_op_status_by_slot(app_private.pos_op_slot_key(p_kind, p_facts, p_lane)) end
$$;

create or replace function app_private.pos_op_status_by_target(p_target_key text)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object('target_key', p_target_key,
    'active_operation', (select app_private.pos_op_operation_summary(t.operation_id)
                         from app_private.pos_operation_targets t where t.target_key = p_target_key and t.active),
    'history', coalesce((select jsonb_agg(jsonb_build_object('operation_id', t.operation_id, 'active', t.active,
                                                             'released_at', app_private.pos_op_ts(t.released_at)) order by t.created_at, t.operation_id)
                         from app_private.pos_operation_targets t where t.target_key = p_target_key), '[]'::jsonb))
$$;

create or replace function app_private.pos_op_status_by_effect(p_domain text, p_identity uuid)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce((
    select jsonb_build_object('effect_domain', f.effect_domain, 'effect_identity', f.effect_identity, 'effect_kind', f.effect_kind,
      'snapshot', f.snapshot, 'snapshot_hash', f.snapshot_hash, 'classifier_version', f.classifier_version,
      'operation', app_private.pos_op_operation_summary(f.operation_id))
    from app_private.pos_operation_effects f where f.effect_domain = p_domain and f.effect_identity = p_identity),
    jsonb_build_object('found', false))
$$;

create or replace function app_private.pos_op_unresolved(p_limit integer default 100)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(app_private.pos_op_operation_summary(o.operation_id) order by o.created_at, o.operation_id), '[]'::jsonb)
  from (select operation_id, created_at from app_private.pos_operations
        where status in ('prepared', 'claimed') order by created_at, operation_id
        limit least(greatest(coalesce(p_limit, 100), 1), 500)) o
$$;

-- ── 9. 権限（すべて内部用。クライアントのロールからは見えない） ──────────────────

alter table app_private.pos_business_slots enable row level security;
alter table app_private.pos_operations enable row level security;
alter table app_private.pos_business_instructions enable row level security;
alter table app_private.pos_operation_keys enable row level security;
alter table app_private.pos_operation_targets enable row level security;
alter table app_private.pos_operation_required_targets enable row level security;
alter table app_private.pos_operation_effects enable row level security;
alter table app_private.pos_operation_events enable row level security;

revoke all on table app_private.pos_business_slots, app_private.pos_operations, app_private.pos_business_instructions,
  app_private.pos_operation_keys, app_private.pos_operation_targets, app_private.pos_operation_required_targets, app_private.pos_operation_effects,
  app_private.pos_operation_events
  from public, anon, authenticated, service_role;
revoke all on sequence app_private.pos_operation_events_event_id_seq from public, anon, authenticated, service_role;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'pos\_op\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
