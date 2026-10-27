// 銀二郎SB の「話して予約」の声を文字にする（Edge Function johnny-agent の店舗端末用・スタッフのログインで）。
//   iPad のホーム画面のアプリでは端末の音声認識が使えないため、お客様の AI予約と同じく録音してサーバーで文字にする（10/27）
import { supabase } from '../lib/supabase'
import { getStaffToken } from './sbRpc'

const TIMEOUT_MS = 20000

const blobToBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(blob)
})

/** 録音を文字にする。聞き取れなければ ''、通信できない・ログインが切れたなどは null */
export async function transcribeSb(audio: Blob): Promise<string | null> {
  const staff = getStaffToken()
  if (!staff || audio.size === 0) return null
  try {
    const call = supabase.functions.invoke<{ heard?: unknown }>('johnny-agent', { body: { staff, audio: await blobToBase64(audio), mime: audio.type } })
    const res = await Promise.race([call, new Promise<null>(resolve => setTimeout(() => resolve(null), TIMEOUT_MS))])
    if (!res || res.error || !res.data) return null
    return typeof res.data.heard === 'string' ? res.data.heard.trim() : ''
  } catch {
    return null
  }
}
