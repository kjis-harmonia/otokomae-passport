// 「話して予約登録」：1文を言う・打つと、入力済みの新規予約フォームが開く。
// 例：「明日15時 田中さん パンチ 銀二郎で」。読み取りは決まった規則（sbCommand）、確定はフォームでスタッフが行う。
import { useState } from 'react'
import { ArrowUp, Mic } from 'lucide-react'
import { useVoice } from '../features/johnny/useVoice'
import { parseSbCommand, type SbDraft } from './sbCommand'
import type { SbOptions } from './sbTypes'

export function SbCommandBar({ options, disabled, onDraft }: {
  options: SbOptions | null; disabled: boolean; onDraft: (draft: SbDraft) => void
}) {
  const [text, setText] = useState('')
  const submit = (value: string) => {
    const v = value.trim()
    if (!v || !options || disabled) return
    onDraft(parseSbCommand(v, options.staff, options.menus))
    setText('')
  }
  const voice = useVoice(heard => { setText(heard); submit(heard) })
  const listening = voice.listen === 'listening'
  const canTalk = voice.listen !== 'unsupported' && voice.listen !== 'denied'

  return (
    <form className="sb-command" onSubmit={e => { e.preventDefault(); submit(text) }}>
      {canTalk && (
        <button type="button" className="sb-command-mic" aria-label={listening ? '聞き取りを止める' : '話して予約'} aria-pressed={listening}
          disabled={disabled || !options} onClick={() => (listening ? voice.stopListening() : voice.startListening())}>
          <Mic size={19} />
        </button>
      )}
      <input
        value={listening ? voice.interim : text}
        onChange={e => setText(e.target.value)}
        placeholder={listening ? '聞いています…' : '例：明日15時 田中さん パンチ 銀二郎で'}
        aria-label="予約内容を話す・入力する"
        enterKeyHint="go"
        disabled={disabled || !options}
        readOnly={listening}
      />
      <button type="submit" className="sb-command-go" aria-label="予約フォームを開く" disabled={disabled || !options || !text.trim()}>
        <ArrowUp size={19} />
      </button>
    </form>
  )
}
