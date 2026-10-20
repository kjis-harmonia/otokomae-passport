// 音声の入出力。使えない端末では文字入力だけで動く。読み上げ中はマイクを止める（自分の声を聞き取らないように）。
//   聞き取り：録音して、話し終わり（約 0.9 秒の無音）で区切り、録音をサーバーに渡す（onAudio）。文字にするのはサーバー。
//     iPhone の音声認識は遅く、途中で止まって戻らないことがあるため、録音できる端末は録音を使う。
//   録音できない端末・デモ（server: false）だけ、ブラウザの音声認識（onFinal に文字が来る）。
//   読み上げ：AI の声（aiVoice.ts）。鳴らせないときだけ端末の読み上げ。
import { useCallback, useEffect, useRef, useState } from 'react'
import { playAiVoice } from './aiVoice'
import { toSpeech } from './speechText'

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

function canRecord(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/** 録音の形式（iPhone は mp4、Chrome・Android は webm） */
function pickMime(): string {
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported?.(m)) return m
  return ''
}

/** 音の大きさを測るための AudioContext（iPhone は画面に触れたときに動かす必要があるので、使い回す） */
let sharedCtx: AudioContext | null = null
function audioCtx(): AudioContext | null {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctor()
  return sharedCtx
}
// iPhone は画面に触れたときでないと音を鳴らせない：アプリのどこかに触れたら AudioContext を動かしておく
//（JOHNNY を開くボタンを押したときに動けば、最初の「いつのご来店を…」から AI の声で話せる）
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => { void audioCtx()?.resume().catch(() => {}) }, true)

export interface VoiceOptions {
  /** 録音してサーバーで文字にする（false ならブラウザの音声認識） */
  server: boolean
  /** 録音が終わったとき（server のとき） */
  onAudio?: (audio: Blob) => void
  /** AI の声で読み上げる（false なら端末の読み上げ） */
  aiVoice?: boolean
}

export function useVoice(onFinal: (text: string) => void, options: VoiceOptions = { server: false }) {
  const recordMode = options.server && canRecord()
  const [listen, setListen] = useState<ListenState>(() => (recordMode || recognitionCtor() ? 'idle' : 'unsupported'))
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
  const onAudioRef = useRef(options.onAudio)
  useEffect(() => { onAudioRef.current = options.onAudio }, [options.onAudio])
  /** 録音中のものを止める（cancel なら送らない） */
  const recStopRef = useRef<((cancel: boolean) => void) | null>(null)

  const aiVoiceRef = useRef(!!options.aiVoice)
  useEffect(() => { aiVoiceRef.current = !!options.aiVoice }, [options.aiVoice])
  /** AI の声を止める */
  const speakAbortRef = useRef<AbortController | null>(null)

  /** 録音して、話し終わりで区切る */
  const startRecording = useCallback(async () => {
    recStopRef.current?.(true)
    speakAbortRef.current?.abort()
    window.speechSynthesis?.cancel()
    setSpeaking(false)
    setNotice(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') setListen('denied')
      else setNotice('マイクを使えませんでした。もう一度マイクを押してください。')
      return
    }
    const mime = pickMime()
    let recorder: MediaRecorder
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch {
      stream.getTracks().forEach(t => t.stop())
      setNotice('このスマホでは録音できませんでした。キーボードで入力してください。')
      setListen('unsupported')
      return
    }
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    // 音の大きさ：最初の 0.3 秒でまわりの音を測り、それより大きい音を「話している」とみなす
    const ctx = audioCtx()
    let analyser: AnalyserNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    if (ctx) {
      try { await ctx.resume() } catch { /* 動かなければ時間で区切る */ }
      if (ctx.state === 'running') {
        source = ctx.createMediaStreamSource(stream)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
      }
    }
    const buf = new Float32Array(1024)
    const started = Date.now()
    let floor = 1, floorN = 0, voiced = false, lastVoice = 0, cancelled = false
    const finish = (cancel: boolean) => {
      if (recStopRef.current !== finish) return
      recStopRef.current = null
      cancelled = cancel
      window.clearInterval(timer)
      try { source?.disconnect() } catch { /* ignore */ }
      if (recorder.state !== 'inactive') recorder.stop()
    }
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      setListen(s => (s === 'listening' ? 'idle' : s))
      setInterim('')
      if (cancelled) return
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })
      // 話し声が無かった（大きさを測れたとき）・短すぎる
      if ((analyser && !voiced) || blob.size < 2000) { setNotice('聞き取れませんでした。マイクを押して、もう一度話してください。'); return }
      onAudioRef.current?.(blob)
    }
    const timer = window.setInterval(() => {
      const now = Date.now()
      if (analyser) {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        if (now - started < 300) { floor = floorN ? Math.min(floor, rms) : rms; floorN++; return }
        // まわりの音：すぐ話し始めた人の声を「まわりの音」と取り違えないよう、最初 0.3 秒の一番静かな所を使い上限も付ける
        const base = Math.min(floor, 0.02)
        // 話し始めは大きめの音、話している途中は語尾など小さい音も「まだ話している」とみなす
        if (rms > (voiced ? Math.max(0.01, base * 1.6) : Math.max(0.018, base * 2.5))) { voiced = true; lastVoice = now; setInterim('聞いています…') }
        // 話し終わり：「えーと」「明日の…3時」の間で切らないよう 1.3 秒静か（話し始めて 2 秒までは 1.6 秒待つ）
        if (voiced && now - lastVoice > (lastVoice - started < 2000 ? 1600 : 1300)) { finish(false); return }
        // 何も話さないまま 8 秒
        if (!voiced && now - started > 8000) { finish(false); return }
      } else if (now - started > 7000) { finish(false); return } // 大きさを測れない端末は 7 秒で区切る（マイクを押せばすぐ区切れる）
      if (now - started > 15000) finish(false)
    }, 100)
    recStopRef.current = finish
    recorder.start(250)
    setListen('listening')
  }, [])

  const stopListening = useCallback(() => {
    recStopRef.current?.(true)
    recRef.current?.abort()
    recRef.current = null
    setInterim('')
    setListen(s => (s === 'listening' ? 'idle' : s))
  }, [])

  /** 録音中にマイクを押した：ここまでで区切って送る */
  const finishListening = useCallback(() => { recStopRef.current?.(false) }, [])

  const startListening = useCallback(() => {
    if (recordMode) { void startRecording(); return }
    speakAbortRef.current?.abort()
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
      // 途中まで聞き取れていれば、その文で進める
      if (latest.trim()) { if (!finalRef.current) finalRef.current = latest; return }
      // service-not-allowed（iPhone の音声入力がオフ・ホーム画面のアプリ）は使えない。network などはもう一度試せる
      if (e.error === 'service-not-allowed') { setNotice('このスマホでは音声入力が使えませんでした。キーボードで入力してください。'); setListen('unsupported'); return }
      setNotice('うまく聞き取れませんでした。マイクを押して、もう一度話してください。')
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
  }, [recordMode, startRecording])

  /** 読み上げ。終わったら then を呼ぶ（消音・非対応ならすぐ呼ぶ） */
  const speak = useCallback((shown: string, then?: () => void) => {
    // 読み上げは日付の読みをひらがなにして（14日→じゅうよっか）
    const text = toSpeech(shown)
    const synth = window.speechSynthesis
    speakAbortRef.current?.abort()
    speakAbortRef.current = null
    if (muted) { then?.(); return }
    recStopRef.current?.(true)
    recRef.current?.abort()
    synth?.cancel()
    let done = false
    const finish = () => { if (done) return; done = true; setSpeaking(false); then?.() }
    // 端末の読み上げ（AI の声が使えないとき）
    const viaDevice = () => {
      if (!synth || typeof SpeechSynthesisUtterance === 'undefined') { finish(); return }
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ja-JP'
      u.rate = 1.04
      const voice = pickJapaneseVoice()
      if (voice) u.voice = voice
      u.onend = finish
      u.onerror = finish
      setSpeaking(true)
      synth.speak(u)
      // 読み上げの終わりが通知されない端末があるので、長さから見積もった時間で打ち切る
      window.setTimeout(finish, 1500 + text.length * 220)
    }
    const ctx = aiVoiceRef.current ? audioCtx() : null
    if (ctx && ctx.state === 'running') {
      const ac = new AbortController()
      speakAbortRef.current = ac
      setSpeaking(true)
      void playAiVoice(text, ctx, ac.signal).then(r => {
        if (r === 'aborted') { setSpeaking(false); return }
        if (speakAbortRef.current === ac) speakAbortRef.current = null
        if (r === 'failed') viaDevice(); else finish()
      })
      return
    }
    viaDevice()
  }, [muted])

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m)
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0') } catch { /* ignore */ }
    if (m) { speakAbortRef.current?.abort(); window.speechSynthesis?.cancel(); setSpeaking(false) }
  }, [])

  useEffect(() => () => { recStopRef.current?.(true); speakAbortRef.current?.abort(); recRef.current?.abort(); window.speechSynthesis?.cancel() }, [])

  return { listen, interim, notice, speaking, muted, setMuted, startListening, stopListening, finishListening, speak, recordMode }
}
