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

  // キャンセル待ち（毎分）：{ "waitlist": true } のときは、空いた枠を押さえた人へ「確定して」のお知らせ
  if ((body as { waitlist?: unknown }).waitlist === true) {
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
    return new Response(JSON.stringify({ waitlist: true, offers: sent.length, sent }), { headers: { 'Content-Type': 'application/json' } })
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
