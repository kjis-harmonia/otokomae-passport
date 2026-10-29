// JOHNNY の先回りのお知らせを送る（毎日11時、Supabase の pg_cron から呼ぶ）。
//   呼び出しの確かめ：ヘッダー x-notify-secret が Secrets の NOTIFY_SECRET と同じとき（DB 側も同じ合言葉で確かめる）
//   送る相手と文面の材料：DB の notify_due_for_sender（本部でオン・1日の上限・週1回・予約がある人は除く、は DB が決める）
//   送り方：Web Push（VAPID）。届かなくなった受け取り先（404・410）は DB で止める
// Secrets：NOTIFY_SECRET・VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECT（例 https://otokomae-passport.vercel.app）
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SECRET = Deno.env.get('NOTIFY_SECRET') ?? ''
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'https://otokomae-passport.vercel.app'

interface Due {
  user_id: string
  kind: 'maintenance'
  days_left: number
  usual: string | null
  subs: { endpoint: string; p256dh: string; auth: string }[] | null
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!r.ok) throw new Error(`${name} ${r.status} ${(await r.text()).slice(0, 200)}`)
  const text = await r.text()
  return (text ? JSON.parse(text) : null) as T
}

/** 文面：メンテナンスカットの期限（あと何日）と、いつものメニュー */
function message(d: Due): { title: string; body: string } {
  const left = d.days_left === 1 ? '明日まで' : `あと${d.days_left}日`
  const usual = d.usual ? `いつもの${d.usual}も、空きをお調べします。` : '空いている時間をお調べします。'
  return { title: '銀二郎 JOHNNY', body: `メンテナンスカットは${left}です。${usual}` }
}

interface WaitOffer {
  user_id: string
  hold_id: string
  date: string
  time: string
  menu_names: string | null
  subs: { endpoint: string; p256dh: string; auth: string }[] | null
}

/** 今日・明日・10/22（木） */
function dayLabel(ymd: string): string {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 33 * 3600_000).toISOString().slice(0, 10)
  if (ymd === today) return '本日'
  if (ymd === tomorrow) return '明日'
  const d = new Date(`${ymd}T00:00:00Z`)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${'日月火水木金土'[d.getUTCDay()]}）`
}

interface StaffNew { id: string; starts_at: string; customer_name: string; staff_name: string; menus?: string | null; kind?: 'new' | 'cancel'; rescheduled?: boolean }
type Sub = { endpoint: string; p256dh: string; auth: string }

/** SB へ：AI 予約が入った・お客様がアプリで取り消したら、SB を入れたすべての端末へ。担当は「テイテイ指名」「指名なし」。test なら試しの1通 */
async function sendStaffNew(test = false): Promise<{ reservations: number; cancels: number; devices: number; delivered: number }> {
  const p = await rpc<{ reservations: StaffNew[]; cancels?: StaffNew[]; overdue?: StaffNew[]; subs: Sub[] }>('staff_push_pending_for_sender', { p_secret: SECRET })
  // 試しのときも、待っている本物の予約は一緒に送る（受け取ったことにした予約を落とさない）
  const list: StaffNew[] = [...(test ? [{ id: `test-${Date.now()}`, starts_at: new Date(Date.now() + 3 * 3600_000).toISOString(), customer_name: 'テスト', staff_name: '銀二郎指名', menus: 'お知らせの確認' }] : []), ...(p.reservations ?? [])]
  const gone: string[] = []
  let delivered = 0
  const when = (r: StaffNew) => { const jst = new Date(Date.parse(r.starts_at) + 9 * 3600_000).toISOString(); return `${dayLabel(jst.slice(0, 10))} ${jst.slice(11, 16)}〜` }
  const send = async (payload: string) => {
    for (const s of p.subs ?? []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' }); delivered++ }
      catch (e) { const code = (e as { statusCode?: number }).statusCode; if ((code === 404 || code === 410) && !gone.includes(s.endpoint)) gone.push(s.endpoint) }
    }
  }
  for (const r of list) {
    await send(JSON.stringify({ title: '予約が入りました', body: `${when(r)} ${r.customer_name}様・${r.menus ?? 'メニュー未定'}（${r.staff_name}）。サロンボードに入れてください。`, url: '/sb', tag: `sb-new-${r.id}`, kind: 'sb-new-reservation' }))
  }
  // お客様がアプリで取り消した予約：サロンボードからも消してもらう（日時変更なら、新しい日時は「予約が入りました」で別に届く）
  for (const r of p.cancels ?? []) {
    await send(JSON.stringify({
      title: r.rescheduled ? '日時変更がありました' : 'キャンセルが入りました',
      body: `${when(r)} ${r.customer_name}様・${r.menus ?? ''}（${r.staff_name}）${r.rescheduled ? 'は元の予約です。' : 'がキャンセルされました。'}サロンボードから消してください。`,
      url: '/sb', tag: `sb-cancel-${r.id}`, kind: 'sb-cancel',
    }))
  }
  // 最終警告：5分たっても誰もサロンボードに反映していない予約・取り消し（1回だけ）
  for (const r of p.overdue ?? []) {
    const cancel = r.kind === 'cancel'
    await send(JSON.stringify({ title: 'まだ確認されていません', body: `${when(r)} ${r.customer_name}様（${r.staff_name}）${cancel ? 'のキャンセル' : ''}。サロンボードへの${cancel ? '取り消し' : '入力'}を確認してください。`, url: '/sb', tag: `sb-final-${r.id}`, kind: 'sb-final' }))
  }
  // 登録していない端末が PIN で入ろうとした（10/28）：SB を入れたすべての端末へ。仕組みが無い DB では何もしない
  // ロック中は約3分ごとに送り直す（remind）。iPad・iPhone は他のアプリの上に画面を出せないため、お知らせで気づいてもらう
  const sec = await rpc<{ alerts: { id: number }[]; remind?: boolean; subs: Sub[] }>('staff_device_alerts_for_sender', { p_secret: SECRET }).catch(() => null)
  const secPayloads = [
    ...(sec?.alerts ?? []).map(a => ({ title: '⚠ 登録していない端末がPINで入ろうとしました', body: '慶一郎まで急いで報告してください。店舗端末・SB を止めています。', url: '/sb', tag: `sb-intrusion-${a.id}`, kind: 'sb-intrusion' })),
    ...(sec?.remind ? [{ title: '⚠ ロック中：店舗端末・SB を止めています', body: '登録していない端末がPINで入ろうとしました。慶一郎まで急いで報告してください。', url: '/sb', tag: `sb-intrusion-remind-${Date.now()}`, kind: 'sb-intrusion' }] : []),
  ]
  for (const p of secPayloads) {
    const payload = JSON.stringify(p)
    for (const s of sec?.subs ?? []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' }); delivered++ }
      catch (e) { const code = (e as { statusCode?: number }).statusCode; if ((code === 404 || code === 410) && !gone.includes(s.endpoint)) gone.push(s.endpoint) }
    }
  }
  if (gone.length) await rpc('staff_push_gone_for_sender', { p_secret: SECRET, p_gone: gone }).catch(() => {})
  return { reservations: list.length, cancels: (p.cancels ?? []).length, devices: (p.subs ?? []).length, delivered }
}

/** 再来店パーマクーポン（10/29）：来店日の翌日 12:00 に配った券のお知らせ。配る・誰に送るかは DB が決める（12:00〜20:59 だけ） */
async function sendPermReturn(): Promise<{ sent: number; delivered: number }> {
  const list = await rpc<{ user_id: string; expires_at: string | null; subs: { endpoint: string; p256dh: string; auth: string }[] | null }[]>('perm_return_for_sender', { p_secret: SECRET })
  let delivered = 0
  for (const g of list ?? []) {
    const until = g.expires_at ? new Date(Date.parse(g.expires_at) - 1).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric' }) : null
    const title = '二代目 銀二郎'
    const body = `ご来店ありがとうございました。次回のパーマで使える500円引きのクーポンをお届けしました。${until ? `${until}まで、` : ''}平日にお使いいただけます。`
    const payload = JSON.stringify({ title, body, url: '/?tab=tickets', tag: `perm-return-${g.user_id}` })
    let n = 0
    const gone: string[] = []
    for (const s of g.subs ?? []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 6 }); n++ }
      catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) gone.push(s.endpoint) }
    }
    await rpc('perm_return_record_for_sender', { p_secret: SECRET, p_user_id: g.user_id, p_title: title, p_body: body, p_delivered: n, p_gone: gone }).catch(() => {})
    delivered += n
  }
  return { sent: (list ?? []).length, delivered }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })
  if (!SECRET || req.headers.get('x-notify-secret') !== SECRET) return new Response('forbidden', { status: 403 })
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return new Response('not_configured', { status: 503 })
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)

  // 試し送り：{ "test_user_id": "..." } のときは、その人だけに試しのお知らせ（決まり・記録は通さない）
  const body = await req.json().catch(() => ({})) as { test_user_id?: unknown; debug_sub?: { endpoint: string; keys: { p256dh: string; auth: string } } }
  // 暗号の確かめ：{ "debug_sub": ... } のときは送らずに、暗号にした中身を返す（手元で解いて確かめる）
  if (body.debug_sub) {
    const d = webpush.generateRequestDetails(body.debug_sub, JSON.stringify({ title: 't', body: 'デバッグ' }), { TTL: 60 })
    return new Response(JSON.stringify({ headers: d.headers, body: btoa(String.fromCharCode(...new Uint8Array(d.body as Uint8Array))) }), { headers: { 'Content-Type': 'application/json' } })
  }
  if (typeof body.test_user_id === 'string' && body.test_user_id) {
    const subs = await rpc<{ endpoint: string; p256dh: string; auth: string }[]>('notify_subs_for_sender', { p_secret: SECRET, p_user_id: body.test_user_id })
    const payload = JSON.stringify({ title: '銀二郎 JOHNNY', body: 'お知らせのテストです。押すと JOHNNY が開きます。', url: '/?tab=reserve&johnny=1', tag: `johnny-test-${Date.now()}` })
    const results = await Promise.all((subs ?? []).map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 600 })
      .then(() => 'ok', (e: unknown) => String((e as { statusCode?: number }).statusCode ?? 'error'))))
    return new Response(JSON.stringify({ test: true, subs: results.length, results }), { headers: { 'Content-Type': 'application/json' } })
  }

  // SB の試し送り：{ "staff_test": true }。SB だけの毎分の見回り（キャンセル待ちの無い本番）：{ "staff": true }
  if ((body as { staff_test?: unknown }).staff_test === true || (body as { staff?: unknown }).staff === true) {
    const test = (body as { staff_test?: unknown }).staff_test === true
    // 毎分の見回りのついでに、再来店パーマクーポンを配って知らせる（失敗しても SB のお知らせは止めない）
    const permReturn = test ? null : await sendPermReturn().catch((e: unknown) => ({ error: String(e).slice(0, 120) }))
    return new Response(JSON.stringify({ staff: true, test, ...(await sendStaffNew(test)), permReturn }), { headers: { 'Content-Type': 'application/json' } })
  }

  // キャンセル待ち（毎分）：{ "waitlist": true } のときは、空いた枠を押さえた人へ「確定して」のお知らせ。
  // ついでに SB へ「予約が入りました」（失敗してもキャンセル待ちは止めない）
  if ((body as { waitlist?: unknown }).waitlist === true) {
    const staff = await sendStaffNew().catch((e: unknown) => ({ error: String(e).slice(0, 120) }))
    const offers = await rpc<WaitOffer[]>('waitlist_offers_for_sender', { p_secret: SECRET })
    const sent: { user: string; delivered: number }[] = []
    for (const o of offers ?? []) {
      const title = '銀二郎 JOHNNY'
      const text = `キャンセルが出ました！${dayLabel(o.date)}${o.time}〜（${o.menu_names}）を10分間お取りしています。押して予約を確定してください。`
      const payload = JSON.stringify({ title, body: text, url: `/?tab=reserve&johnny=1&hold=${o.hold_id}`, tag: `johnny-waitlist-${o.hold_id}` })
      let delivered = 0
      const gone: string[] = []
      for (const s of o.subs ?? []) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 600, urgency: 'high' }); delivered++ }
        catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) gone.push(s.endpoint) }
      }
      await rpc('waitlist_record_for_sender', { p_secret: SECRET, p_user_id: o.user_id, p_title: title, p_body: text, p_delivered: delivered, p_gone: gone }).catch(() => {})
      sent.push({ user: o.user_id.slice(0, 8), delivered })
    }
    return new Response(JSON.stringify({ waitlist: true, offers: sent.length, sent, staff }), { headers: { 'Content-Type': 'application/json' } })
  }

  const due = await rpc<Due[]>('notify_due_for_sender', { p_secret: SECRET })
  const report: { user: string; delivered: number; gone: number }[] = []
  for (const d of due ?? []) {
    const { title, body } = message(d)
    const payload = JSON.stringify({ title, body, url: '/?tab=reserve&johnny=1', tag: `johnny-${d.kind}` })
    let delivered = 0
    const gone: string[] = []
    for (const s of d.subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 12 })
        delivered++
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) gone.push(s.endpoint)
        else console.error('[johnny-notify]', status, String((e as Error).message ?? e).slice(0, 200))
      }
    }
    await rpc('notify_record_for_sender', { p_secret: SECRET, p_user_id: d.user_id, p_kind: d.kind, p_title: title, p_body: body, p_delivered: delivered, p_gone: gone })
    report.push({ user: d.user_id.slice(0, 6), delivered, gone: gone.length })
  }
  return new Response(JSON.stringify({ sent: report.length, report }), { headers: { 'Content-Type': 'application/json' } })
})
