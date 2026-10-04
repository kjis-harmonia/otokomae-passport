#!/usr/bin/env node
// Staging 昇格前の Preflight。ローカルの使い捨て DB（と、本番バックアップを復元したローカル DB）だけに接続する。
// 本番・Staging の URL は拒否する（PREFLIGHT_ALLOW_REMOTE=1 を明示しない限り）。

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(root, 'supabase', 'migrations')
const testsDir = join(root, 'supabase', 'tests')
const rollbackDir = join(root, 'supabase', 'rollback')

// 適用順（Supabase CLI 互換：14桁の version が一意で、ファイル名の並び＝適用順）。
// base_schema は旧 supabase/schema.sql（本番には最初から存在する土台）。切り戻し用は supabase/rollback/ に分けてある。
const BASE_MIGRATION = '20261001000000_base_schema.sql'
const MIGRATION_ORDER = [
  BASE_MIGRATION,
  '20261001000100_welcome_coupon_onboarding.sql',
  '20261001000200_prod_schema_catchup.sql',
  '20261001000300_security_hardening_a_functions.sql',
  '20261001000400_security_hardening_b_lockdown.sql',
  '20261002000000_booking_phase1.sql',
  '20261003000000_customer_ledger.sql',
  '20261004000000_ginpay_ledger.sql',
  '20261005000000_checkout.sql',
  '20261006000000_service_master.sql',
  '20261007000000_client_visit_model.sql',
]
// 以前の名前（改名済み）。docs・テスト・スクリプトに参照が残っていないこと（migration 本文のコメントは内容を変えないため対象外）
const STALE_MIGRATION_NAMES = [
  'supabase/schema.sql', '20261001_welcome_coupon_onboarding', '20261001_prod_schema_catchup', '20261001_security_hardening_a_functions',
  '20261001_security_hardening_b_lockdown', '20261002_booking_phase1', '20261003_customer_ledger', '20261004_ginpay_ledger',
  '20261005_checkout', '20261006_service_master', '20261003_ginpay_ledger', '20261004_checkout',
]

const args = parseArgs(process.argv.slice(2))
const dbUrl = args.databaseUrl ?? process.env.PREFLIGHT_DATABASE_URL ?? process.env.DATABASE_URL ?? null
const baselineDbUrl = args.baselineDatabaseUrl ?? process.env.PREFLIGHT_BASELINE_DATABASE_URL ?? null
const skipDb = args.skipDb || !dbUrl
const skipBuild = args.skipBuild
const keepGoing = args.keepGoing
const results = []

async function main() {
  let baselineBefore = null

  await stage('migration', async () => {
    const migrations = migrationStaticCheck()
    if (skipDb) return `static ok (${migrations.length} migrations in order); DB apply skipped (${dbUrl ? '--skip-db' : 'no DATABASE_URL'})`
    assertSafeDatabaseUrl(dbUrl, 'DATABASE_URL')
    if (baselineDbUrl) assertSafeDatabaseUrl(baselineDbUrl, 'PREFLIGHT_BASELINE_DATABASE_URL')
    requireCommand('psql')
    assertSupabaseLike(dbUrl, 'DATABASE_URL')
    if (baselineDbUrl) assertSupabaseLike(baselineDbUrl, 'PREFLIGHT_BASELINE_DATABASE_URL')

    // 各 migration は Supabase CLI と同じく1トランザクションで適用する。
    // base_schema は土台の一括作成で再実行を想定していないため、再適用（冪等性の確認）は base 以外だけ
    const later = migrations.filter((file) => !file.endsWith(BASE_MIGRATION))
    for (const file of migrations) runPsqlMigration(dbUrl, file, `migration ${relative(root, file)}`)
    for (const file of later) runPsqlMigration(dbUrl, file, `migration replay ${relative(root, file)}`)
    if (baselineDbUrl) {
      // 本番相当のコピー：本番には base_schema が最初からある。適用前のデータの指紋を取り、base 以外を適用してから比較する
      baselineBefore = snapshot(baselineDbUrl)
      for (const file of later) runPsqlMigration(baselineDbUrl, file, `baseline migration ${relative(root, file)}`)
    }
    return baselineDbUrl
      ? `clean apply + replay + baseline apply ok (${migrations.length} migrations)`
      : `clean apply + replay ok (${migrations.length} migrations); baseline skipped`
  })

  await stage('baseline-data', async () => {
    if (skipDb || !baselineDbUrl) return 'skipped (no baseline DB)'
    const after = snapshot(baselineDbUrl)
    const changed = Object.keys(baselineBefore).filter((k) => JSON.stringify(baselineBefore[k]) !== JSON.stringify(after[k]))
    if (changed.length) throw new Error(`existing data changed by migrations: ${changed.join(', ')}`)
    const b = baselineBefore
    return `unchanged: customers ${b.customers.n}, accounting sessions ${b.accounting_sessions.n} (completed total ¥${b.accounting_sessions.completed_total}), `
      + `items ${b.accounting_session_items.n}, tickets ${b.tickets.n}, maintenance visits ${b.maintenance_visits.n}, user aliases ${b.customer_user_aliases.n}, recovery logs ${b.customer_recovery_logs.n}`
  })

  await stage('security', async () => {
    const secretSummary = scanSecrets()
    if (skipDb) return `${secretSummary}; DB security skipped`
    runPsqlFile(dbUrl, join(testsDir, 'preflight_security.sql'), 'RLS/grants/RPC security')
    if (baselineDbUrl) runPsqlFile(baselineDbUrl, join(testsDir, 'preflight_security.sql'), 'baseline RLS/grants/RPC security')
    return `${secretSummary}; DB security ok${baselineDbUrl ? ' (clean + baseline)' : ''}`
  })

  await stage('service-master', async () => {
    if (skipDb) return 'skipped'
    runPsqlFile(dbUrl, join(testsDir, 'preflight_service_master.sql'), 'service master expectations')
    if (baselineDbUrl) runPsqlFile(baselineDbUrl, join(testsDir, 'preflight_service_master.sql'), 'baseline service master expectations')
    return `43 services / 23 offers / 1 bookable (ギンパラカーリー ¥15,000・180分・銀二郎/テイテイ)${baselineDbUrl ? ' (clean + baseline)' : ''}`
  })

  await stage('booking', async () => {
    if (skipDb) return 'skipped'
    runPsqlFile(dbUrl, join(testsDir, 'preflight_booking_clients.sql'), 'booking/client smoke')
    return 'booking smoke ok'
  })

  await stage('clients', async () => {
    if (skipDb) return 'skipped'
    // 来店モデル：予約に紐づく会計は予約日の1来店、予約なしは店頭来店、同日の未会計の完了予約1件だけに突き合わせ
    runPsqlFile(dbUrl, join(testsDir, 'preflight_visit_model.sql'), 'client visit model')
    return 'client search + merge/unmerge (booking/client smoke) + visit model ok'
  })

  await stage('checkout', async () => {
    if (skipDb) return 'skipped'
    runPsqlFile(dbUrl, join(testsDir, 'preflight_checkout_coupon.sql'), 'checkout/coupon smoke')
    return 'checkout + coupon + void smoke ok'
  })

  await stage('ginpay', async () => {
    if (skipDb) return 'skipped'
    runPsqlFile(dbUrl, join(testsDir, 'ginpay_ledger.sql'), 'GINPay ledger suite')
    return 'GINPay ledger suite ok (charge, sale payment, sale void reversal, Stripe, merge, reconciliation)'
  })

  await stage('concurrency', async () => {
    if (skipDb) return 'skipped'
    requireCommand('pgbench')
    runPsqlFile(dbUrl, join(testsDir, 'preflight_booking_concurrency_setup.sql'), 'booking concurrency setup')
    runPgbench(dbUrl, join(testsDir, 'preflight_booking_concurrency_worker.sql'), 'booking concurrency')
    runPsqlFile(dbUrl, join(testsDir, 'preflight_booking_concurrency_verify.sql'), 'booking concurrency verify')
    runPsqlFile(dbUrl, join(testsDir, 'preflight_checkout_concurrency_setup.sql'), 'checkout concurrency setup')
    runPgbench(dbUrl, join(testsDir, 'preflight_checkout_concurrency_worker.sql'), 'checkout concurrency')
    runPsqlFile(dbUrl, join(testsDir, 'preflight_checkout_concurrency_verify.sql'), 'checkout concurrency verify')
    runPsqlFile(dbUrl, join(testsDir, 'ginpay_concurrency_setup.sql'), 'GINPay concurrency setup')
    runPgbench(dbUrl, join(testsDir, 'ginpay_concurrency_worker.sql'), 'GINPay concurrency')
    runPsqlFile(dbUrl, join(testsDir, 'ginpay_concurrency_verify.sql'), 'GINPay concurrency verify')
    return 'booking + checkout + GINPay concurrency ok'
  })

  await stage('frontend', async () => {
    if (skipBuild) return 'skipped'
    runCommand('npm', ['run', 'build'], 'frontend build/typecheck')
    return 'build/typecheck ok'
  })

  printSummary()
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
}

async function stage(name, fn) {
  process.stdout.write(`\n[${name}] START\n`)
  try {
    const detail = await fn()
    results.push({ name, status: 'PASS', detail })
    process.stdout.write(`[${name}] PASS ${detail ?? ''}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, status: 'FAIL', detail: message })
    process.stdout.write(`[${name}] FAIL ${message}\n`)
    if (!keepGoing) {
      printSummary()
      process.exit(1)
    }
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--database-url') out.databaseUrl = argv[++i]
    else if (arg === '--baseline-database-url') out.baselineDatabaseUrl = argv[++i]
    else if (arg === '--skip-db') out.skipDb = true
    else if (arg === '--skip-build') out.skipBuild = true
    else if (arg === '--keep-going') out.keepGoing = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  npm run preflight:staging -- --database-url "$DATABASE_URL" [--baseline-database-url "$BASELINE_URL"]

Options:
  --database-url URL             Disposable clean local PostgreSQL database (Supabase base roles anon /
                                 authenticated / service_role, pgcrypto in schema "extensions" and publication
                                 supabase_realtime must exist, as on Supabase).
  --baseline-database-url URL    Local copy restored from a production backup. Migrations are applied to it
                                 and existing data (customers, sales, tickets, maintenance, user aliases)
                                 must stay unchanged.
  --skip-db                      Run static checks and frontend only.
  --skip-build                   Skip npm run build.
  --keep-going                   Continue after a failed stage.

Safety:
  Remote database URLs are rejected unless PREFLIGHT_ALLOW_REMOTE=1 is set.
  Do not point this at Production or Staging.`)
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

/** 適用順の静的検査：ディレクトリ＝適用順、14桁 version の一意・昇順（ファイル名の並び＝適用順）、切り戻しの分離、旧ファイル名の参照 */
function migrationStaticCheck() {
  if (!existsSync(migrationsDir)) throw new Error('supabase/migrations not found')
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
  for (const file of files) {
    if (!/^\d{14}_[a-z0-9][a-z0-9_]*\.sql$/.test(file)) throw new Error(`migration filename is not a Supabase CLI version (14 digits): ${file}`)
    if (/rollback/i.test(file)) throw new Error(`rollback migration must not be in supabase/migrations: ${file}`)
  }
  if (JSON.stringify(files) !== JSON.stringify(MIGRATION_ORDER)) {
    throw new Error(`supabase/migrations does not match the apply order (found: ${files.join(', ')})`)
  }
  const versions = MIGRATION_ORDER.map((f) => f.slice(0, 14))
  for (let i = 0; i < versions.length; i += 1) {
    if (versions.indexOf(versions[i]) !== i) throw new Error(`duplicate migration version: ${versions[i]}`)
    if (i > 0 && versions[i] <= versions[i - 1]) throw new Error(`migration order reversed at ${versions[i]}`)
  }
  if (!existsSync(join(rollbackDir, '20261001_security_hardening_rollback.sql'))) throw new Error('rollback script missing from supabase/rollback')
  const stale = findInRepo(STALE_MIGRATION_NAMES)
  if (stale.length) throw new Error(`references to old migration names: ${stale.join(', ')}`)
  return MIGRATION_ORDER.map((file) => join(migrationsDir, file))
}

function assertSafeDatabaseUrl(value, label) {
  if (process.env.PREFLIGHT_ALLOW_REMOTE === '1') return
  let url
  try {
    url = new URL(value)
  } catch {
    if (/^postgres(?:ql)?:[^/]/.test(value)) return
    throw new Error(`${label} is not a valid PostgreSQL URL`)
  }
  const host = url.hostname.toLowerCase()
  const safeHosts = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]'])
  if (!safeHosts.has(host) && !host.endsWith('.local')) throw new Error(`${label} points to remote host ${host}; refusing Production/Staging connection`)
}

/**
 * Supabase と同じ前提か（基本ロール・extensions スキーマの pgcrypto・publication）。
 * migration の `create extension if not exists pgcrypto` は Supabase では何もしないが、素の PostgreSQL では public に入り、
 * 拡張の関数が anon から実行できる状態になる（Staging とは違う環境で誤検知する）ため、先に確認する。
 */
function assertSupabaseLike(url, label) {
  const out = runPsqlQuery(url, `select concat_ws(',',
    (select string_agg(r, ',') from unnest(array['anon', 'authenticated', 'service_role']) r where not exists (select 1 from pg_roles where rolname = r)),
    case when not exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto' and n.nspname = 'extensions')
         then 'pgcrypto in schema extensions' end,
    case when not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then 'publication supabase_realtime' end)`,
  `${label} prerequisites`).trim()
  if (out) throw new Error(`${label} is not Supabase-like (missing: ${out}). Create them before running (see --help).`)
}

function walkRepo(visit) {
  const allowedExt = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.md', '.json', '.toml', '.yml', '.yaml', '.env', '.example'])
  const skipDirs = new Set(['.git', 'node_modules', 'dist', '.vite'])
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) { walk(full); continue }
      const ext = extname(entry) || (entry.startsWith('.env') ? '.env' : '')
      if (!allowedExt.has(ext) && !entry.endsWith('.example')) continue
      visit(full, readFileSync(full, 'utf8'))
    }
  }
  walk(root)
}

function findInRepo(needles) {
  const self = fileURLToPath(import.meta.url)
  const hits = []
  walkRepo((full, text) => {
    if (full === self || full.startsWith(migrationsDir) || full.startsWith(rollbackDir)) return
    for (const n of needles) if (text.includes(n)) hits.push(`${n} in ${relative(root, full)}`)
  })
  return hits
}

function scanSecrets() {
  const findings = []
  const patterns = [
    { name: 'Stripe secret key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { name: 'Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
    { name: 'JWT-like token', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
    { name: 'Supabase service-role value', re: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*(?!\s*(?:$|your|example|placeholder|<|"))\S{12,}/gi },
    { name: 'PostgreSQL URL with password', re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@(?!localhost|127\.0\.0\.1)[^\s'"]+/g },
  ]
  walkRepo((full, text) => {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0
      if (pattern.re.test(text)) findings.push(`${pattern.name}: ${relative(root, full)}`)
    }
  })
  if (findings.length > 0) throw new Error(`secret scan found ${findings.length} issue(s): ${findings.join(', ')}`)
  return 'secret scan ok'
}

/** 既存データの指紋（件数・合計・内容の md5）。値そのものは出力しない */
function snapshot(url) {
  const out = runPsqlQuery(url, readFileSync(join(testsDir, 'preflight_baseline_snapshot.sql'), 'utf8'), 'baseline snapshot')
  const line = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (!line) throw new Error('baseline snapshot returned nothing')
  return JSON.parse(line)
}

function requireCommand(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error || result.status !== 0) throw new Error(`${command} is required but was not found`)
}

function runPsqlFile(url, file, label) {
  if (!existsSync(file)) throw new Error(`missing SQL file for ${label}: ${relative(root, file)}`)
  runCommand('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', url, '-f', file], label)
}

/** migration は1トランザクション（-1）で適用する（Supabase CLI と同じ。途中で失敗すればその migration は丸ごと戻る） */
function runPsqlMigration(url, file, label) {
  if (!existsSync(file)) throw new Error(`missing migration for ${label}: ${relative(root, file)}`)
  runCommand('psql', ['-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1', url, '-f', file], label)
}

function runPsqlQuery(url, sql, label) {
  const result = spawnSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', url], { cwd: root, input: sql, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: exited with ${result.status}: ${(result.stderr ?? '').slice(0, 500)}`)
  return result.stdout
}

function runPgbench(url, file, label) {
  if (!existsSync(file)) throw new Error(`missing pgbench file for ${label}: ${relative(root, file)}`)
  runCommand('pgbench', [url, '-n', '-c', '10', '-j', '10', '-t', '1', '-f', file], label)
}

function runCommand(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: exited with ${result.status}`)
}

function printSummary() {
  process.stdout.write('\nStaging Preflight Summary\n')
  for (const result of results) process.stdout.write(`- ${result.name}: ${result.status}${result.detail ? ` - ${result.detail}` : ''}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
