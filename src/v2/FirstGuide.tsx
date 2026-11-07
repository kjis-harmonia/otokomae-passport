// 登録直後の「いつものメニュー」決め：バイクの銀ちゃんが話しかけて、いっしょに決める（11/8 慶一郎さん「世界観忘れるなよ」）
//   ・来たことがある方：「いつもはどれにしよるん？」（前回のメニューが分かれば「これでええかのぉ？」）
//   ・はじめての方：「どれがええかのぉ？」＋ ホットペッパーのメニューも見られる
//   ・選んだら、正式なメニュー名と料金で必ず確かめてから登録する（勝手に決めない）
//   ・メンテナンスカットの対象メニューなら「14日以内のメンテナンスカットはご希望かのぉ？」
//   ・つぎに「お連れ様の登録もできるけど、どうするかのぉ？」（3名まで。お連れ様も対象メニューならメンテナンスを聞く）
//   ・終わったらホームへ。店頭で本人確認が済んだ方だけ「お店で決めてもらう」で飛ばせる
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, Phone } from 'lucide-react'
import { bookingAssistantApi } from '../features/johnny/bookingAssistantApi'
import { canBeUsual, setUsualMenu, usualMenuOrder } from '../features/johnny/usualMenu'
import { loadUsual } from './usualPicks'
import { MAX_COMPANIONS, saveCompanion, setOwnerMaintenance } from '../features/johnny/usualMembers'
import { JohnnyRider } from '../features/johnny/JohnnyRider'
import { callCustomerRpc } from '../utils/customerSession'
import { useStoreAccess } from '../features/customerAccess/storeAccess'
import { SHOP_PHONE_TEL } from '../data/wallet'

type Menu = { code: string; name: string; duration_min: number; price: number | null; maintenance?: boolean }
// 最初に出すメニュー（11/6 慶一郎さんの指定の順）。ほかは「ほかのメニューを見る」で
const FEATURED = ['cut-regular', 'cut-skin-fade', 'perm-nurepan', 'perm-iper', 'perm-punch', 'perm-negro', 'store-teitei-gari']
const HOTPEPPER_MENU_URL = 'https://beauty.hotpepper.jp/slnH000583749/coupon/'
/** お名前の呼び方：「お父さん」「花子ちゃん」はそのまま、「たろう」は「たろうさん」 */
const honor = (name: string) => (/(さん|様|ちゃん|くん|君)$/.test(name) ? name : `${name}さん`)
const yen = (n: number | null) => (n == null ? '' : `¥${n.toLocaleString('ja-JP')}`)

/** だれのいつものを決めているか（me＝ご本人・mate＝お連れ様） */
type Who = { kind: 'me' } | { kind: 'mate'; name: string }
type Step =
  | { k: 'last'; last: Menu }                       // 前回のメニューでええか
  | { k: 'pick'; who: Who }                         // メニューを選ぶ
  | { k: 'check'; who: Who; menu: Menu }            // 正式な名前と料金で確かめる
  | { k: 'maint'; who: Who; menu: Menu }            // メンテナンスカットのご希望
  | { k: 'mateAsk' }                                // お連れ様を登録するか
  | { k: 'mateName' }                               // お連れ様のお名前
  | { k: 'done' }

export function FirstGuide({ visited, onClose }: { visited: boolean; onClose: () => void }) {
  const access = useStoreAccess()
  const [menus, setMenus] = useState<Menu[] | null>(null)
  const [step, setStep] = useState<Step>({ k: 'pick', who: { kind: 'me' } })
  const [showAll, setShowAll] = useState(false)
  const [mine, setMine] = useState<{ menu: Menu; maint: boolean } | null>(null)
  const [mates, setMates] = useState<{ name: string; menu: Menu; maint: boolean }[]>([])
  const [mateName, setMateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void bookingAssistantApi().options().then(o => {
      if (!live) return
      const all = usualMenuOrder(o.menus.filter(m => canBeUsual(m.code))) as Menu[]
      const list = [...FEATURED.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m), ...all.filter(m => !FEATURED.includes(m.code))]
      setMenus(list)
      // 来たことがある方：前回（お店で登録した・来店の記録）のメニューが分かれば、まずそれを聞く
      if (visited) void loadUsual().then(u => { const m = u?.menu ? list.find(x => x.code === u.menu!.code) : undefined; if (live && m) setStep(s => (s.k === 'pick' && s.who.kind === 'me' ? { k: 'last', last: m } : s)) }).catch(() => {})
    }).catch(() => { if (live) setMenus([]) })
    return () => { live = false }
  }, [visited])

  const featured = menus?.filter(m => FEATURED.includes(m.code)) ?? []
  const shown = menus ? (showAll || featured.length === 0 ? menus : featured) : null

  /** 決めたメニュー（＋メンテナンス）を会員の記録に。ご本人はいつものメニュー、お連れ様はお連れ様として */
  const commit = async (who: Who, menu: Menu, maint: boolean) => {
    setBusy(true); setError(null)
    try {
      if (who.kind === 'me') {
        setUsualMenu({ code: menu.code, name: menu.name })
        await callCustomerRpc('customer_set_usual_menu', { p_code: menu.code })
        if (maint) await setOwnerMaintenance(true)
        setMine({ menu, maint })
        setStep({ k: 'mateAsk' })
      } else {
        await saveCompanion(null, who.name, menu.code, maint)
        setMates(x => [...x.filter(m => m.name !== who.name), { name: who.name, menu, maint }])
        setMateName('')
        setStep({ k: 'done' })
      }
    } catch {
      setError('うまく登録できんかったのぉ。電波を確かめて、もう一回押してみてくれる？')
    } finally { setBusy(false) }
  }
  const chooseMenu = (who: Who, menu: Menu) => { setShowAll(false); setStep({ k: 'check', who, menu }) }
  const confirmMenu = (who: Who, menu: Menu) => (menu.maintenance ? setStep({ k: 'maint', who, menu }) : void commit(who, menu, false))

  const whoName = (who: Who) => (who.kind === 'me' ? '' : `${honor(who.name)}の`)
  // 銀ちゃんのセリフ（広島ことば）
  const line = (() => {
    switch (step.k) {
      case 'last': return `よう来んさったのぉ！ほいじゃ、いつものメニュー決めていこうか！\n前は「${step.last.name}」じゃったね。いつものはこれでええかのぉ？`
      case 'pick':
        if (step.who.kind === 'mate') return `${honor(step.who.name)}は、いつもどれにしよるん？`
        return visited ? 'よう来んさったのぉ！ほいじゃ、いつものメニュー決めていこうか！\nいつもはどれにしよるん？'
          : 'よう来んさったのぉ！ほいじゃ、いつものメニュー決めていこうか！\nどれがええかのぉ？迷うたら、ホットペッパーのメニューも見てみんさい。'
      case 'check': return `${whoName(step.who)}いつものは「${step.menu.name}」${step.menu.price != null ? `（${yen(step.menu.price)}）` : ''}じゃね。これで登録してええかのぉ？`
      case 'maint': return `「${step.menu.name}」なら、14日以内のメンテナンスカットも使えるんよ。${step.who.kind === 'mate' ? `${honor(step.who.name)}も` : ''}ご希望かのぉ？`
      case 'mateAsk': return mates.length ? 'ほかにも一緒に来る人はおるかのぉ？' : 'ええね！お連れ様の登録もできるけど、どうするかのぉ？\n家族や友だちを入れとくと、次から押すだけで予約できるけぇ。'
      case 'mateName': return 'お連れ様のお名前を教えてくれる？お店で呼ぶ名前でええよ。'
      case 'done': return '準備できたけぇ！次からはホームの「いつもの」を押すだけで予約できるよ。'
    }
  })()

  const sheet: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 80, background: 'var(--v2-bg, #f4f1eb)', color: 'var(--v2-ink, #28231e)', overflowY: 'auto', fontFamily: 'var(--v2-sans)',
    padding: 'calc(env(safe-area-inset-top, 0px) + 8px) 20px calc(env(safe-area-inset-bottom, 0px) + 24px)', boxSizing: 'border-box' }
  const card: React.CSSProperties = { marginTop: 16, borderRadius: 16, background: '#fff', border: '1px solid var(--v2-line, rgba(70,55,34,.1))', overflow: 'hidden' }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%', minHeight: 54, padding: '0 16px', boxSizing: 'border-box',
    border: 'none', borderTop: '1px solid var(--v2-line, rgba(70,55,34,.1))', marginTop: -1, background: 'transparent', color: 'inherit', fontSize: 16, textAlign: 'left', cursor: 'pointer' }
  const primary: React.CSSProperties = { width: '100%', minHeight: 52, borderRadius: 14, border: 'none', background: 'var(--v2-ink, #28231e)', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer' }
  const secondary: React.CSSProperties = { ...primary, background: '#fff', color: 'var(--v2-ink, #28231e)', border: '1px solid var(--v2-line, rgba(70,55,34,.14))' }
  const quiet: React.CSSProperties = { display: 'block', margin: '6px auto 0', minHeight: 44, border: 'none', background: 'none', color: 'var(--v2-sub, #62594e)', fontSize: 14, cursor: 'pointer' }
  const linkBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, minHeight: 48, borderRadius: 14, border: '1px solid var(--v2-line, rgba(70,55,34,.1))', background: '#fff', color: 'inherit', fontSize: 15, textDecoration: 'none' }

  const menuList = (who: Who) => (
    <div style={card}>
      {menus === null && <p style={{ margin: 0, padding: 16, fontSize: 14, color: 'var(--v2-sub)' }}>読み込んどるけぇ、ちょっと待ってね…</p>}
      {shown?.map(m => (
        <button key={m.code} type="button" style={row} onClick={() => chooseMenu(who, m)}>
          <span>{m.name}</span><span style={{ fontSize: 14, color: 'var(--v2-sub)' }}>{yen(m.price)}</span>
        </button>
      ))}
      {menus && shown && shown.length < menus.length && (
        <button type="button" style={{ ...row, justifyContent: 'center', color: 'var(--v2-sub)', fontSize: 15 }} onClick={() => setShowAll(true)}>ほかのメニューを見る（{menus.length - shown.length}）</button>
      )}
    </div>
  )

  return (
    <div role="dialog" aria-modal="true" aria-label="いつものメニューを決める" className="v2" style={sheet}>
      <div style={{ maxWidth: 440, margin: '0 auto' }}>
        {/* 店頭で本人確認が済んだ方だけ：お店で決めてもらう（ここは飛ばしてホームへ） */}
        {access.mode === 'verified' && step.k !== 'done' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" style={{ ...quiet, margin: 0, fontSize: 13 }} onClick={onClose}>お店で決めてもらう</button>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: access.mode === 'verified' ? 0 : 20 }} aria-hidden="true">
          <JohnnyRider state="speaking" width={220} />
        </div>
        <AnimatePresence mode="wait">
          <motion.p key={line} role="status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            style={{ margin: '8px 0 0', padding: '16px 18px', borderRadius: 18, background: '#fff', border: '1px solid var(--v2-line, rgba(70,55,34,.1))', fontSize: 17, lineHeight: 1.75, whiteSpace: 'pre-line' }}>
            {line}
          </motion.p>
        </AnimatePresence>
        {error && <p role="alert" style={{ margin: '10px 4px 0', fontSize: 14, color: '#a33' }}>{error}</p>}

        {step.k === 'last' && (
          <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
            <button type="button" style={primary} onClick={() => chooseMenu({ kind: 'me' }, step.last)}>これでええ</button>
            <button type="button" style={secondary} onClick={() => setStep({ k: 'pick', who: { kind: 'me' } })}>ほかのメニューにする</button>
          </div>
        )}

        {step.k === 'pick' && <>
          {step.who.kind === 'me' && !visited && (
            <a href={HOTPEPPER_MENU_URL} target="_blank" rel="noopener noreferrer" style={linkBtn}><ExternalLink size={17} aria-hidden="true" />ホットペッパーのメニューを見る</a>
          )}
          {menuList(step.who)}
          <a href={SHOP_PHONE_TEL} style={linkBtn}><Phone size={17} aria-hidden="true" />髪型に迷ったらお電話ください</a>
          {step.who.kind === 'mate'
            ? <button type="button" style={quiet} onClick={() => setStep({ k: 'mateName' })}>戻る</button>
            : <button type="button" style={quiet} onClick={onClose}>あとで</button>}
        </>}

        {step.k === 'check' && (
          <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
            <button type="button" style={primary} disabled={busy} onClick={() => confirmMenu(step.who, step.menu)}>{busy ? '登録しよるよ…' : 'これで登録する'}</button>
            <button type="button" style={secondary} disabled={busy} onClick={() => setStep({ k: 'pick', who: step.who })}>選びなおす</button>
          </div>
        )}

        {step.k === 'maint' && (
          <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
            <button type="button" style={primary} disabled={busy} onClick={() => void commit(step.who, step.menu, true)}>はい</button>
            <button type="button" style={secondary} disabled={busy} onClick={() => void commit(step.who, step.menu, false)}>いいえ</button>
            <p style={{ margin: '2px 4px 0', fontSize: 13, lineHeight: 1.6, color: 'var(--v2-faint, #756b5f)' }}>メンテナンスカットは、このメニューの施術から14日以内に使えます。</p>
          </div>
        )}

        {step.k === 'mateAsk' && (
          <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
            <button type="button" style={primary} onClick={() => setStep({ k: 'mateName' })}>登録する</button>
            <button type="button" style={secondary} onClick={() => setStep({ k: 'done' })}>{mates.length ? 'もうおらん' : '今はいらん'}</button>
          </div>
        )}

        {step.k === 'mateName' && <>
          <input value={mateName} onChange={e => setMateName(e.target.value)} maxLength={20} autoComplete="off" enterKeyHint="next" aria-label="お連れ様のお名前" placeholder="例：父、たろう"
            onKeyDown={e => { if (e.key === 'Enter' && mateName.trim()) setStep({ k: 'pick', who: { kind: 'mate', name: mateName.trim() } }) }}
            style={{ width: '100%', minHeight: 52, marginTop: 16, padding: '0 16px', boxSizing: 'border-box', borderRadius: 14, border: '1px solid var(--v2-line, rgba(70,55,34,.1))', background: '#fff', color: 'inherit', fontSize: 17 }} />
          <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
            <button type="button" style={primary} disabled={!mateName.trim() || mates.some(m => m.name === mateName.trim())} onClick={() => setStep({ k: 'pick', who: { kind: 'mate', name: mateName.trim() } })}>次へ</button>
            <button type="button" style={quiet} onClick={() => { setMateName(''); setStep(mates.length ? { k: 'done' } : { k: 'mateAsk' }) }}>戻る</button>
          </div>
        </>}

        {step.k === 'done' && <>
          <div style={card}>
            {mine && <div style={{ ...row, cursor: 'default' }}><span>ご本人</span><span style={{ fontSize: 15 }}>{mine.menu.name}{mine.maint ? '・メンテナンス' : ''}</span></div>}
            {mates.map(m => <div key={m.name} style={{ ...row, cursor: 'default' }}><span>{honor(m.name)}</span><span style={{ fontSize: 15 }}>{m.menu.name}{m.maint ? '・メンテナンス' : ''}</span></div>)}
          </div>
          <p style={{ margin: '10px 4px 0', fontSize: 13, lineHeight: 1.6, color: 'var(--v2-faint, #756b5f)' }}>あとから、ホームの「いつもの」で変えられます。</p>
          {mates.length < MAX_COMPANIONS && <button type="button" style={quiet} onClick={() => setStep({ k: 'mateName' })}>{mates.length ? 'もう1人登録する' : 'お連れ様を登録する'}</button>}
          <div style={{ marginTop: 14 }}>
            <button type="button" style={primary} onClick={onClose}>ホームへ</button>
          </div>
        </>}
      </div>
    </div>
  )
}
