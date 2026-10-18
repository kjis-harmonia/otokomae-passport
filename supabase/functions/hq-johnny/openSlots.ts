// 空き枠うめ：空いている時間を見つける・送る相手を数える・お知らせを送る（本部 JOHNNY の道具）。
//   空き：hq_available_slots（本部セッション）を、いちばん予約の多いカットのメニューで日ごとに調べ、続いている時間をまとめる。
//   送る：Web Push（VAPID は johnny-notify と同じ Secrets）。相手は hq_open_slot_targets（DB が決める）。
import webpush from 'npm:web-push@3.6.7'

type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<T>

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'https://otokomae-passport.vercel.app'
const SLOT_MENU = Deno.env.get('HQ_SLOT_MENU') ?? 'cut-regular'
const WD = '日月火水木金土'

const jstDate = (offsetDays: number) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10)
const hm = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16)
const label = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）` }

/** 15分おきの開始時刻を「10:00〜12:00」のようにまとめる（終わりは最後の開始＋1時間＝カットが終わる目安） */
function ranges(starts: string[]): { from: string; to: string; minutes: number }[] {
  const mins = [...new Set(starts.map(hm))].map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))).sort((a, b) => a - b)
  const out: { from: number; to: number }[] = []
  for (const m of mins) {
    const last = out[out.length - 1]
    if (last && m - last.to <= 15) last.to = m
    else out.push({ from: m, to: m })
  }
  const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return out.map(r => ({ from: f(r.from), to: f(r.to + 60), minutes: r.to + 60 - r.from }))
}

export async function findOpenSlots(rpc: Rpc, hq: string, days: number) {
  const n = Math.min(Math.max(Math.round(days) || 3, 1), 7)
  const result: { date: string; label: string; open: { from: string; to: string; minutes: number }[] }[] = []
  for (let i = 0; i < n; i++) {
    const date = jstDate(i)
    const slots = await rpc<{ starts_at: string }[]>('hq_available_slots', { p_hq: hq, p_date: date, p_menu_codes: [SLOT_MENU], p_staff_id: null, p_exclude_reservation: null }).catch(() => [])
    // 今日はもう過ぎた時間を除く
    const now = Date.now()
    const future = (slots ?? []).filter(s => Date.parse(s.starts_at) > now + 30 * 60_000).map(s => s.starts_at)
    result.push({ date, label: label(date), open: ranges(future) })
  }
  return { menu: SLOT_MENU, days: result }
}

export async function openSlotTargets(rpc: Rpc, hq: string) {
  const r = await rpc<{ maintenance: number; lapsed: number; targets: unknown[] }>('hq_open_slot_targets', { p_hq: hq, p_limit: 20 })
  return { maintenance: r.maintenance, lapsed: r.lapsed, total: r.targets.length }
}

/** お知らせを送る。date は YYYY-MM-DD、times は「15:00〜17:00」のような文 */
export async function sendOpenSlotPush(rpc: Rpc, hq: string, date: string, times: string) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { error: 'push_not_configured' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !times.trim()) return { error: 'invalid_value' }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)
  const day = date === jstDate(0) ? '本日' : date === jstDate(1) ? '明日' : label(date)
  const r = await rpc<{ targets: { user_id: string; reason: string; subs: { endpoint: string; p256dh: string; auth: string }[] | null }[] }>('hq_open_slot_targets', { p_hq: hq, p_limit: 20 })
  let sent = 0
  for (const t of r.targets) {
    const body = `${day}${times.trim().slice(0, 40)}が空いています。${t.reason === 'maintenance' ? 'メンテナンスカットの期限も近いので、この機会にいかがですか？' : 'ご都合が合えば、JOHNNY からご予約ください。'}`
    const payload = JSON.stringify({ title: '銀二郎 JOHNNY', body, url: '/?tab=reserve&johnny=1', tag: `johnny-open-${date}` })
    let delivered = 0
    const gone: string[] = []
    for (const s of t.subs ?? []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 6 }); delivered++ }
      catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) gone.push(s.endpoint) }
    }
    await rpc('hq_open_slot_record', { p_hq: hq, p_user_id: t.user_id, p_title: '銀二郎 JOHNNY', p_body: body, p_delivered: delivered, p_gone: gone }).catch(() => {})
    if (delivered) sent++
  }
  return { sent, targets: r.targets.length }
}
