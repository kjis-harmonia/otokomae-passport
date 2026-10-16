// 相談の重複送信を抑える。保存先はこのページのメモリだけ（顧客セッションごとに分離）。
// 通信中の同じ相談は共有し、成功した返事だけを5分・最大10件覚える。
import type { MenuOption } from './menuMatcher.ts'

export interface ConsultReply { reply: string; menuCodes: string[] }
export interface ConsultRequest { session: string; message: string; menus: readonly MenuOption[] }
type Send = (request: ConsultRequest) => Promise<ConsultReply | null>

export function createConsultCache(send: Send, now: () => number = Date.now): Send {
  const replies = new Map<string, { until: number; reply: ConsultReply }>()
  const pending = new Map<string, Promise<ConsultReply | null>>()
  return async request => {
    const message = request.message.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 300)
    if (!message) return null
    const menus = [...request.menus].sort((a, b) => a.code.localeCompare(b.code))
    const key = JSON.stringify([request.session, message, menus.map(m => [m.code, m.name, m.duration_min, m.price, m.price_from ?? false])])
    for (const [k, entry] of replies) if (entry.until <= now()) replies.delete(k)
    const cached = replies.get(key)
    if (cached) return structuredClone(cached.reply)
    const running = pending.get(key)
    if (running) return running.then(reply => reply && structuredClone(reply))
    const task = Promise.resolve().then(() => send({ ...request, message, menus }))
      .then(reply => {
        if (reply) {
          replies.set(key, { until: now() + 5 * 60_000, reply: structuredClone(reply) })
          if (replies.size > 10) replies.delete(replies.keys().next().value!)
        }
        return reply
      })
      .catch(() => null)
      .finally(() => { pending.delete(key) })
    pending.set(key, task)
    return task
  }
}
