// 「ホーム画面に追加」の案内（下から出るシート）。ホーム画面から開くと全画面になり、すぐ開け、通知も受け取れる。
//   iPhone の Safari：右下の「…」→「共有」→「ホーム画面に追加」→「追加」
//   LINE・Instagram などのアプリ内ブラウザ：そのままでは追加できないので Safari で開いてもらう（LINE は外部ブラウザで開くリンク）
//   Android の Chrome：ボタン1つで追加（beforeinstallprompt）
// 自動で出すのはホーム画面で1回。「あとで」のあとは7日あけ、3回まで。マイページからはいつでも出せる（SHOW_INSTALL_GUIDE_EVENT）。
// ホーム画面から開いているとき（standalone）は出さない。
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Ellipsis, ExternalLink, Share, SquarePlus } from 'lucide-react'
import { detect, externalBrowserName, externalBrowserUrl, externalLinkWorks, installPrompt, INSTALL_GUIDE_KEY as KEY, MAX_AUTO, SHOW_INSTALL_GUIDE_EVENT, WAIT_DAYS, type InstallKind as Kind } from '../utils/installGuide'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const GOLD = '#C9A24A'
const CREAM = '#F2E6C8'

function readState(): { count: number; last: number } {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { count: Number(v.count) || 0, last: Number(v.last) || 0 } } catch { return { count: 0, last: 0 } }
}

export function InstallGuide({ autoAllowed }: { autoAllowed: boolean }) {
  const [open, setOpen] = useState(false)
  const [kind] = useState<Kind>(() => detect())

  // 自動で出す：ホーム画面で、ほかの案内が無いとき
  useEffect(() => {
    if (!autoAllowed || !kind) return
    const s = readState()
    if (s.count >= MAX_AUTO || Date.now() - s.last < WAIT_DAYS * 86400000) return
    const t = window.setTimeout(() => setOpen(true), 1200)
    return () => window.clearTimeout(t)
  }, [autoAllowed, kind])

  // マイページから
  useEffect(() => {
    const show = () => { if (kind) setOpen(true) }
    window.addEventListener(SHOW_INSTALL_GUIDE_EVENT, show)
    return () => window.removeEventListener(SHOW_INSTALL_GUIDE_EVENT, show)
  }, [kind])

  const close = useCallback(() => {
    const s = readState()
    try { localStorage.setItem(KEY, JSON.stringify({ count: s.count + 1, last: Date.now() })) } catch { /* 次も出るだけ */ }
    setOpen(false)
  }, [])

  const installAndroid = async () => {
    if (!installPrompt.get()) return
    await installPrompt.get()!.prompt()
    const r = await installPrompt.get()!.userChoice.catch(() => ({ outcome: 'dismissed' }))
    installPrompt.clear()
    if (r.outcome === 'accepted') { try { localStorage.setItem(KEY, JSON.stringify({ count: MAX_AUTO, last: Date.now() })) } catch { /* ignore */ } }
    setOpen(false)
  }

  // アプリ内ブラウザ → ふつうのブラウザ（LINE・Instagram・Android それぞれのやり方。utils/installGuide）
  const externalUrl = externalBrowserUrl()

  return (
    <AnimatePresence>
      {open && kind && (
        <motion.div
          key="install-guide"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onClick={close}
          style={{ position: 'fixed', inset: 0, zIndex: 10020, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <motion.div
            className="customer-install-sheet" role="dialog" aria-modal="true" aria-label="ホーム画面に追加"
            initial={{ y: 40 }} animate={{ y: 0 }} exit={{ y: 40 }} transition={{ duration: 0.25, ease: 'easeOut' }}
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 480, boxSizing: 'border-box',
              padding: '28px 24px calc(20px + env(safe-area-inset-bottom, 0px))',
              background: '#0E0D0B', borderTop: '1px solid rgba(201,162,74,0.35)', borderRadius: '20px 20px 0 0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <img src="/assets/app-icon.png" alt="" width={52} height={52} style={{ borderRadius: 12, border: '1px solid rgba(201,162,74,0.35)' }} />
              <div>
                <p style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, color: CREAM, letterSpacing: '0.06em' }}>ホーム画面に追加</p>
                <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.55)', marginTop: 4 }}>アプリのように、ワンタップで開けます</p>
              </div>
            </div>

            <div style={{ height: 1, background: 'rgba(201,162,74,0.18)', margin: '22px 0 18px' }} />

            {kind === 'ios' && (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Step n={1} icon={<Ellipsis size={18} />}>画面右下の <b style={{ color: CREAM }}>「…」</b> をタップ</Step>
                <Step n={2} icon={<Share size={17} />}><b style={{ color: CREAM }}>「共有」</b> をタップ</Step>
                <Step n={3} icon={<SquarePlus size={17} />}><b style={{ color: CREAM }}>「ホーム画面に追加」</b> → 右上の <b style={{ color: CREAM }}>「追加」</b></Step>
              </ol>
            )}
            {kind === 'ios' && (
              <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.4)', marginTop: 14, lineHeight: 1.6 }}>
                「…」が無いときは、画面の下にある共有ボタンから進めます。
              </p>
            )}

            {(kind === 'inapp' || kind === 'ios-other') && (
              <p style={{ fontFamily: SERIF, fontSize: 15, lineHeight: 1.9, color: CREAM }}>
                このままでは追加できません。<br />
                <b>{externalBrowserName()}</b> で開いてから、ホーム画面に追加してください。
              </p>
            )}
            {(kind === 'inapp' || kind === 'ios-other') && !externalLinkWorks() && (
              <ol style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Step n={1} icon={<Ellipsis size={18} />}>画面右上の <b style={{ color: CREAM }}>「…」</b> をタップ</Step>
                <Step n={2} icon={<ExternalLink size={17} />}><b style={{ color: CREAM }}>「外部ブラウザーで開く」</b> をタップ</Step>
              </ol>
            )}

            {kind === 'android' && (
              <p style={{ fontFamily: SERIF, fontSize: 15, lineHeight: 1.9, color: CREAM }}>
                {installPrompt.get() ? '下のボタンから追加できます。' : 'ブラウザのメニュー（︙）から「ホーム画面に追加」を選んでください。'}
              </p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
              {kind === 'inapp' && externalLinkWorks() && (
                <a href={externalUrl} style={{ ...primary, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <ExternalLink size={17} /> {externalBrowserName()} で開く
                </a>
              )}
              {kind === 'android' && installPrompt.get() && <button type="button" onClick={installAndroid} style={primary}>ホーム画面に追加</button>}
              <button type="button" onClick={close} style={kind === 'ios' || kind === 'ios-other' ? primary : secondary}>
                {kind === 'ios' ? 'わかりました' : 'あとで'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const primary: CSSProperties = {
  height: 50, borderRadius: 12, border: 'none', background: CREAM, color: '#0E0D0B',
  fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.1em', cursor: 'pointer',
}
const secondary: CSSProperties = {
  height: 46, borderRadius: 12, border: '1px solid rgba(201,162,74,0.3)', background: 'transparent', color: 'rgba(242,230,200,0.7)',
  fontFamily: SERIF, fontSize: 15, letterSpacing: '0.1em', cursor: 'pointer',
}

function Step({ n, icon, children }: { n: number; icon: ReactNode; children: ReactNode }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ flexShrink: 0, width: 26, fontFamily: SERIF, fontSize: 15, color: GOLD, textAlign: 'center' }}>{n}</span>
      <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 10, border: '1px solid rgba(242,230,200,0.18)', color: CREAM, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <span style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(242,230,200,0.8)' }}>{children}</span>
    </li>
  )
}

/** 登録の前に出す全画面の案内。ホーム画面に追加して、アイコンから開いたときだけ登録できる（ここから先へは進めない。10/24 慶一郎さん決定） */
export function InstallGate() {
  const [kind] = useState<Kind>(() => detect())
  const externalUrl = externalBrowserUrl()
  // Android の Chrome：追加できるようになった合図・追加が済んだ合図
  const [canPrompt, setCanPrompt] = useState(() => !!installPrompt.get())
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    const ready = () => window.setTimeout(() => setCanPrompt(!!installPrompt.get()), 0)
    const done = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', ready)
    window.addEventListener('appinstalled', done)
    return () => { window.removeEventListener('beforeinstallprompt', ready); window.removeEventListener('appinstalled', done) }
  }, [])
  const installAndroid = async () => {
    const p = installPrompt.get()
    if (!p) return
    await p.prompt()
    const r = await p.userChoice.catch(() => ({ outcome: 'dismissed' }))
    installPrompt.clear(); setCanPrompt(false)
    if (r.outcome === 'accepted') setInstalled(true)
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10030, background: '#0B0908', overflowY: 'auto', display: 'flex', justifyContent: 'center' }}>
      <div style={{
        width: '100%', maxWidth: 480, minHeight: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
        padding: 'calc(56px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px))',
      }}>
        <img src="/assets/app-icon.png" alt="" width={72} height={72} style={{ borderRadius: 16, border: '1px solid rgba(201,162,74,0.35)' }} />
        <h1 style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, color: CREAM, letterSpacing: '0.02em', lineHeight: 1.6, margin: '24px 0 0' }}>
          はじめに、<br />ホーム画面に追加してください
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.8, color: 'rgba(242,230,200,0.62)', margin: '12px 0 0' }}>
          会員登録は、ホーム画面のアイコンから開いて行います。
        </p>

        <div style={{ height: 1, background: 'rgba(201,162,74,0.18)', margin: '28px 0 22px' }} />

        {kind === 'ios' && (
          <>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <Step n={1} icon={<Ellipsis size={18} />}>画面右下の <b style={{ color: CREAM }}>「…」</b> をタップ</Step>
              <Step n={2} icon={<Share size={17} />}><b style={{ color: CREAM }}>「共有」</b> をタップ</Step>
              <Step n={3} icon={<SquarePlus size={17} />}><b style={{ color: CREAM }}>「ホーム画面に追加」</b> → 右上の <b style={{ color: CREAM }}>「追加」</b></Step>
              <Step n={4} icon={<img src="/assets/app-icon.png" alt="" width={22} height={22} style={{ borderRadius: 5 }} />}>ホーム画面の <b style={{ color: CREAM }}>「銀二郎」</b> から開く</Step>
            </ol>
            <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.4)', marginTop: 16, lineHeight: 1.6 }}>
              「…」が無いときは、画面の下にある共有ボタンから進めます。
            </p>
          </>
        )}
        {(kind === 'inapp' || kind === 'ios-other') && (
          <>
            <p style={{ fontFamily: SERIF, fontSize: 15, lineHeight: 1.9, color: CREAM, margin: 0 }}>
              このままではホーム画面に追加できません。<br /><b>{externalBrowserName()}</b> で開き直してください。
            </p>
            {externalLinkWorks() ? (
              <>
                <a href={externalUrl} style={{ ...primary, marginTop: 20, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <ExternalLink size={17} /> {externalBrowserName()} で開く
                </a>
                <p style={{ fontSize: 13, lineHeight: 1.8, color: 'rgba(242,230,200,0.55)', margin: '14px 0 0' }}>
                  開かないときは、画面右上の <b style={{ color: CREAM }}>「…」</b> から <b style={{ color: CREAM }}>「外部ブラウザーで開く」</b>を選んでください（アプリによっては「ブラウザで開く」）。
                </p>
              </>
            ) : (
              // Instagram・Facebook など：リンクでは Safari に移れないので、アプリのメニューの手順を大きく出す
              <ol style={{ listStyle: 'none', margin: '22px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
                <Step n={1} icon={<Ellipsis size={18} />}>画面右上の <b style={{ color: CREAM }}>「…」</b> をタップ</Step>
                <Step n={2} icon={<ExternalLink size={17} />}><b style={{ color: CREAM }}>「外部ブラウザーで開く」</b> をタップ</Step>
                <Step n={3} icon={<Share size={17} />}><b style={{ color: CREAM }}>Safari</b> で開いたら、出てくる手順でホーム画面に追加</Step>
              </ol>
            )}
          </>
        )}

        {kind === 'android' && (
          installed ? (
            <p style={{ fontFamily: SERIF, fontSize: 15, lineHeight: 1.9, color: CREAM, margin: 0 }}>
              追加しました。<br />ホーム画面の <b>「銀二郎」</b> から開いて、会員登録へお進みください。
            </p>
          ) : (
            <>
              {canPrompt && <button type="button" onClick={() => void installAndroid()} style={primary}>ホーム画面に追加</button>}
              <p style={{ fontSize: 14, lineHeight: 1.8, color: 'rgba(242,230,200,0.7)', margin: canPrompt ? '14px 0 0' : 0 }}>
                {canPrompt ? 'ボタンが使えないときは、' : ''}ブラウザ右上のメニュー <b style={{ color: CREAM }}>「︙」</b> から <b style={{ color: CREAM }}>「ホーム画面に追加」</b>（または「アプリをインストール」）を選び、ホーム画面の <b style={{ color: CREAM }}>「銀二郎」</b> から開いてください。
              </p>
            </>
          )
        )}

        <div style={{ flex: 1, minHeight: 32 }} />
      </div>
    </div>
  )
}
