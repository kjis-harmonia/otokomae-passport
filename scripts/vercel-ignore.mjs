// Vercel の「この push で版を作るか」（vercel.json の ignoreCommand から呼ばれる）。
//   終了コード 0 ＝ 作らない、1 ＝ 作る。
//   本番用（otokomae-passport）は main だけ、Staging 用（otokomae-passport-staging）は staging だけ作る。
//   作業用のブランチや、もう片方のブランチでは作らない（版が増えて Vercel の保存の上限 10GB に近づいた・11/12）
const ref = process.env.VERCEL_GIT_COMMIT_REF ?? ''
const site = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? ''
const want = site.includes('staging') ? 'staging' : 'main'
// どちらのプロジェクトか分からないとき・ブランチが分からないときは、念のため作る（出したはずの版が出ない方が困る）
const build = !site || !ref || ref === want
console.log(`[vercel-ignore] site=${site || '?'} ref=${ref || '?'} want=${want} → ${build ? 'build' : 'skip'}`)
process.exit(build ? 1 : 0)
