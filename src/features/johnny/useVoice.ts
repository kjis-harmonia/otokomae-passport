// 音声の入出力（ブラウザの音声認識・読み上げ）。使えない端末では文字入力だけで動く。
// 読み上げ中はマイクを止める（自分の声を聞き取らないように）。
import { useCallback, useEffect, useRef, useState } from 'react'

interface RecognitionResultLike { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEventLike { resultIndex: number; results: ArrayLike<RecognitionResultLike> }
interface RecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  onresult: ((e: RecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => RecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type ListenState = 'idle' | 'listening' | 'unsupported' | 'denied'

const MUTE_KEY = 'ginjiro_johnny_muted'

function pickJapaneseVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? []
  const ja = voices.filter(v => v.lang.replace('_', '-').toLowerCase().startsWith('ja'))
  // 端末に入っている自然な声を優先（iOS: Kyoko / O-ren、Android・Chrome: Google 日本語）
  return ja.find(v => /kyoko|o-ren|google/i.test(v.name)) ?? ja[0] ?? null
}

export function useVoice(onFinal: (text: string) => void) {
  const [listen, setListen] = useState<ListenState>(() => (recognitionCtor() ? 'idle' : 'unsupported'))
  const [interim, setInterim] = useState('')
  /** 聞き取れなかった・音声認識が使えなかったときの一言（次に話し始めたら消える） */
  const [notice, setNotice] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [muted, setMutedState] = useState<boolean>(() => {
    try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
  })
  const recRef = useRef<RecognitionLike | null>(null)
  const finalRef = useRef('')
  const onFinalRef = useRef(onFinal)
  useEffect(() => { onFinalRef.current = onFinal }, [onFinal])

  const stopListening = useCallback(() => {
    recRef.current?.abort()
    recRef.current = null
    setInterim('')
    setListen(s => (s === 'listening' ? 'idle' : s))
  }, [])

  const startListening = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) { setListen('unsupported'); return }
    window.speechSynthesis?.cancel()
    setSpeaking(false)
    recRef.current?.abort()
    const rec = new Ctor()
    rec.lang = 'ja-JP'
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1
    finalRef.current = ''
    let heardAnything = false
    let failed = false
    let latest = ''
    let silence: number | undefined
    setNotice(null)
    // iPhone は話し終わっても「確定」の合図がなかなか来ない。話が 1.2 秒止まったら、聞き取れた文で区切る
    const settle = () => {
      window.clearTimeout(silence)
      silence = window.setTimeout(() => {
        if (recRef.current !== rec || !latest.trim()) return
        if (!finalRef.current) finalRef.current = latest
        stopAndFinish()
      }, 1200)
    }
    // 何も話さないままでも 10 秒で止める
    const giveUp = window.setTimeout(() => { if (recRef.current === rec) stopAndFinish() }, 10000)
    rec.onresult = e => {
      heardAnything = true
      let text = ''
      let final = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else text += r[0].transcript
      }
      if (final) finalRef.current = final
      latest = final || text
      setInterim(latest)
      settle()
    }
    rec.onerror = e => {
      failed = true
      if (e.error === 'not-allowed') { setListen('denied'); return }
      if (e.error === 'aborted') return
      if (e.error === 'no-speech') { setNotice('聞き取れませんでした。マイクを押して、もう一度話してください。'); return }
      // service-not-allowed（iPhone の音声入力がオフ・ホーム画面のアプリ）・audio-capture・network など
      setNotice('このスマホでは音声入力が使えませんでした。キーボードで入力してください。')
      setListen('unsupported')
    }
    // 止めたあとの終わりの合図が来ない端末もあるので、来なくても区切る
    const stopAndFinish = () => { rec.stop(); window.setTimeout(() => rec.onend?.(), 800) }
    rec.onend = () => {
      window.clearTimeout(silence)
      window.clearTimeout(giveUp)
      if (recRef.current !== rec) return
      recRef.current = null
      setListen(s => (s === 'listening' ? 'idle' : s))
      const text = finalRef.current.trim()
      setInterim('')
      if (text) onFinalRef.current(text)
      else if (!heardAnything && !failed) setNotice('聞き取れませんでした。マイクを押して、もう一度話してください。')
    }
    recRef.current = rec
    try {
      rec.start()
      setListen('listening')
    } catch {
      recRef.current = null
      setListen('idle')
    }
  }, [])

  /** 読み上げ。終わったら then を呼ぶ（消音・非対応ならすぐ呼ぶ） */
  const speak = useCallback((text: string, then?: () => void) => {
    const synth = window.speechSynthesis
    if (muted || !synth || typeof SpeechSynthesisUtterance === 'undefined') { then?.(); return }
    recRef.current?.abort()
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ja-JP'
    u.rate = 1.04
    const voice = pickJapaneseVoice()
    if (voice) u.voice = voice
    let done = false
    const finish = () => { if (done) return; done = true; setSpeaking(false); then?.() }
    u.onend = finish
    u.onerror = finish
    setSpeaking(true)
    synth.speak(u)
    // 読み上げの終わりが通知されない端末があるので、長さから見積もった時間で打ち切る
    window.setTimeout(finish, 1500 + text.length * 220)
  }, [muted])

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m)
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0') } catch { /* ignore */ }
    if (m) { window.speechSynthesis?.cancel(); setSpeaking(false) }
  }, [])

  useEffect(() => () => { recRef.current?.abort(); window.speechSynthesis?.cancel() }, [])

  return { listen, interim, notice, speaking, muted, setMuted, startListening, stopListening, speak }
}
