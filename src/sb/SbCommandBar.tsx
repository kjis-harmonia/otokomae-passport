// 「話して予約登録」：1文を言う・打つと、入力済みの新規予約フォームが開く。
// 例：「明日15時 田中さん パンチ 銀二郎で」。「今日15時から16時半 クローズ」なら時間を閉める画面。読み取りは決まった規則（sbCommand）、確定はスタッフが行う。
// 声は録音してサーバーで文字にする（sbVoice）。録音できない端末だけ端末の音声認識。うまくいかなかったときは一言出す（10/27：黙って何も起きなかった）
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Mic } from 'lucide-react'
import { useVoice } from '../features/johnny/useVoice'
import { parseSbCommand, type SbDraft } from './sbCommand'
import { transcribeSb } from './sbVoice'
import type { SbOptions } from './sbTypes'

export function SbCommandBar({ options, disabled, onDraft }: {
  options: SbOptions | null; disabled: boolean; onDraft: (draft: SbDraft) => void
}) {
  const [text, setText] = useState('')
  const [converting, setConverting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const submit = (value: string) => {
    const v = value.trim()
    if (!v || !options || disabled) return
    onDraft(parseSbCommand(v, options.staff, options.menus))
    setText('')
  }
  // 録音の結果はあとから戻るので、そのときの options で読む
  const submitRef = useRef(submit)
  useEffect(() => { submitRef.current = submit })
  const onAudio = useCallback((audio: Blob) => {
    setConverting(true); setNote(null)
    void transcribeSb(audio).then(heard => {
      setConverting(false)
      if (heard === null) { setNote('声を文字にできませんでした。もう一度マイクを押すか、文字で入力してください。'); return }
      if (!heard) { setNote('聞き取れませんでした。マイクを押して、もう一度話してください。'); return }
      setText(heard)
      submitRef.current(heard)
    })
  }, [])
  const voice = useVoice(heard => { setText(heard); submit(heard) }, { server: true, onAudio })
  const listening = voice.listen === 'listening'
  const canTalk = voice.listen !== 'unsupported' && voice.listen !== 'denied'
  const message = converting ? null
    : note ?? voice.notice ?? (voice.listen === 'denied' ? 'マイクが許可されていません。端末の設定でマイクを許可するか、文字で入力してください。' : null)

  return (
    <>
      <form className="sb-command" onSubmit={e => { e.preventDefault(); submit(text) }}>
        {canTalk && (
          <button type="button" className="sb-command-mic" aria-label={listening ? '話し終わった' : '話して予約'} aria-pressed={listening}
            disabled={disabled || !options || converting} onClick={() => { setNote(null); if (listening) voice.finishListening(); else voice.startListening() }}>
            <Mic size={21} />
          </button>
        )}
        {listening && <span className="sb-wave" aria-hidden="true"><i /><i /><i /><i /></span>}
        <input
          value={listening ? voice.interim : converting ? '' : text}
          onChange={e => setText(e.target.value)}
          placeholder={listening ? '聞いています…（話し終わったらマイクを押す）' : converting ? '文字にしています…' : '例：今日15時から16時半 クローズ／明日15時 田中さん パンチ'}
          aria-label="予約内容を話す・入力する"
          enterKeyHint="go"
          disabled={disabled || !options}
          readOnly={listening || converting}
        />
        <button type="submit" className="sb-command-go" aria-label="予約フォームを開く" disabled={disabled || !options || !text.trim()}>
          <ArrowUp size={21} />
        </button>
      </form>
      {message && <p className="sb-command-note" role="status">{message}</p>}
    </>
  )
}
