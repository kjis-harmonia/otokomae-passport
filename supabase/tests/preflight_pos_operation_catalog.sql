-- ============================================================================
-- GINJIRO POS B-2C-1: 既存オブジェクトのカタログ指紋 (preflight_pos_operation_catalog.sql)
--
-- B-2C-1 の migration を当てる直前と直後に取り、完全一致することを確認する（staging-preflight.mjs）。
-- 対象は public / app_private の既存オブジェクトすべて（会計・GINPay・チケットの表、制約、索引、
-- トリガー、ポリシー、関数の本文・引数・戻り値・権限・search_path、スキーマ権限、既定の権限、拡張、publication）。
-- B-2C-1 で新しく作る app_private.pos_operation* / pos_business_* と app_private.pos_op_* 関数だけを除く。
-- 1行1オブジェクトで出力する（値そのものは含めず、定義の文字列か md5）。
-- ============================================================================

with new_tables(relname) as (
  values ('pos_operations'), ('pos_operation_keys'), ('pos_business_instructions'), ('pos_business_slots'),
         ('pos_operation_targets'), ('pos_operation_required_targets'), ('pos_operation_effects'), ('pos_operation_events')
),
rels as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relacl, c.relrowsecurity, c.relforcerowsecurity, c.reloptions
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'app_private')
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and not (n.nspname = 'app_private' and (c.relname in (select relname from new_tables) or c.relname like 'pos\_operation%' or c.relname like 'pos\_business%'))
),
lines as (
  select 'rel|' || nspname || '.' || relname || '|' || relkind::text || '|' || coalesce(relacl::text, '') || '|' || relrowsecurity || '|' || relforcerowsecurity || '|' || coalesce(reloptions::text, '') as line
  from rels
  union all
  select 'col|' || r.nspname || '.' || r.relname || '|' || a.attnum || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
         || '|' || a.attnotnull || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || '|' || a.attgenerated::text || '|' || coalesce(a.attacl::text, '')
  from rels r join pg_attribute a on a.attrelid = r.oid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped
  union all
  select 'con|' || r.nspname || '.' || r.relname || '|' || co.conname || '|' || pg_get_constraintdef(co.oid) || '|' || co.condeferrable || '|' || co.condeferred || '|' || co.convalidated
  from rels r join pg_constraint co on co.conrelid = r.oid
  union all
  select 'idx|' || r.nspname || '.' || r.relname || '|' || pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid
  from rels r join pg_index i on i.indrelid = r.oid
  union all
  select 'trg|' || r.nspname || '.' || r.relname || '|' || pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
  from rels r join pg_trigger t on t.tgrelid = r.oid
  where not t.tgisinternal
  union all
  select 'pol|' || r.nspname || '.' || r.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || p.polpermissive || '|' || p.polroles::text
         || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from rels r join pg_policy p on p.polrelid = r.oid
  union all
  select 'fn|' || p.oid::regprocedure::text || '|' || pg_get_function_result(p.oid) || '|' || p.prokind::text || '|' || md5(p.prosrc)
         || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '')
         || '|' || pg_get_userbyid(p.proowner) || '|' || l.lanname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  where n.nspname in ('public', 'app_private')
    and not (n.nspname = 'app_private' and p.proname like 'pos\_op\_%')
  union all
  select 'nsp|' || n.nspname || '|' || coalesce(n.nspacl::text, '') || '|' || pg_get_userbyid(n.nspowner)
  from pg_namespace n where n.nspname in ('public', 'app_private', 'extensions')
  union all
  select 'defacl|' || pg_get_userbyid(d.defaclrole) || '|' || coalesce(n.nspname, '') || '|' || d.defaclobjtype::text || '|' || d.defaclacl::text
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select 'ext|' || e.extname || '|' || n.nspname || '|' || e.extversion
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  union all
  select 'pub|' || pubname || '|' || schemaname || '.' || tablename
  from pg_publication_tables
)
select line from lines order by line;
