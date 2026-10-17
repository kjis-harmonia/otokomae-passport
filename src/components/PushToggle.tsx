// 「JOHNNY のお知らせ」を受け取る・止めるボタン（マイページ・予約完了の画面）。
//   iPhone の Safari のままでは受け取れないので、ホーム画面に追加の案内を出す。通知を拒否していたら設定の案内。
import { useEffect, useState } from 'react'
import { pushState, turnOffPush, turnOnPush, type PushState } from '../utils/webPush'
import { SHOW_INSTALL_GUIDE_EVENT } from '../utils/installGuide'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

/** tone：gold＝マイページ（黒と金）、mono＝JOHNNY の画面（白黒） */
export function PushToggle({ tone }: { tone: 'gold' | 'mono' }) {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 調べるのに失敗しても（古い端末など）、ボタンは出す
  useEffect(() => { pushState().then(setState, () => setState('off')) }, [])
  if (!state || state === 'unsupported') return null
  if (tone === 'mono' && state === 'on') return null

  const act = async () => {
    setBusy(true); setError(null)
    try {
      if (state === 'needs-install') { window.dispatchEvent(new Event(SHOW_INSTALL_GUIDE_EVENT)); return }
      setState(state === 'on' ? await turnOffPush() : await turnOnPush())
    } catch {
      setError('うまく設定できませんでした。もう一度お試しください。')
    } finally { setBusy(false) }
  }

  const title = state === 'on' ? 'JOHNNY のお知らせ：受け取り中' : 'JOHNNY のお知らせを受け取る'
  const sub = state === 'on' ? 'メンテナンスカットの期限が近づいたらお知らせします（押すと止めます）'
    : state === 'denied' ? '通知が許可されていません。設定アプリの「通知」から許可してください'
    : state === 'needs-install' ? 'ホーム画面に追加すると、お知らせを受け取れます'
    : 'メンテナンスカットの期限が近づいたら、JOHNNY がお知らせします'

  const gold = tone === 'gold'
  return (
    <div style={{ width: '100%', marginTop: gold ? 0 : 16 }}>
      <button type="button" onClick={() => void act()} disabled={busy || state === 'denied'} style={{
        width: '100%', padding: '15px 18px', borderRadius: 14, textAlign: 'left', cursor: state === 'denied' ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        background: gold ? 'rgba(0,0,0,0.3)' : '#1C1C1E', border: gold ? '1px solid rgba(201,162,74,0.28)' : 'none', color: gold ? '#F2E6C8' : '#FFFFFF',
      }}>
        <span>
          <span style={{ display: 'block', fontFamily: gold ? SERIF : undefined, fontSize: 15, fontWeight: 700, letterSpacing: gold ? '0.04em' : undefined }}>{busy ? '設定しています…' : title}</span>
          <span style={{ display: 'block', fontSize: 12, marginTop: 4, color: gold ? 'rgba(242,230,200,0.5)' : 'rgba(235,235,245,0.6)', lineHeight: 1.5 }}>{sub}</span>
        </span>
        {state !== 'denied' && <span aria-hidden="true" style={{ color: gold ? '#C9A24A' : 'rgba(235,235,245,0.6)', fontSize: 18 }}>{state === 'on' ? '✓' : '›'}</span>}
      </button>
      {error && <p role="alert" style={{ margin: '8px 4px 0', fontSize: 12, color: '#E06060' }}>{error}</p>}
    </div>
  )
}
