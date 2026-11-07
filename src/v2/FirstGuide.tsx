// 登録直後の最初の案内（11/6 慶一郎さん：AI が髪型をすすめるのはやめて「髪型に迷ったらお電話ください」でいい）
//   ・初めての方：メニューを一覧から選ぶだけ → それが「いつもの」になり、次からホームで押すだけで予約できる
//   ・来店したことがある方：前回（お店で登録した・来店の記録）のメニューがあれば「いつものに登録しますか？」、無ければ一覧から
//     前のアプリの会員さんには、チケットはご来店時にお店で引き継ぐことも添える
//   ・1回だけ。「あとで」で閉じても、いつものはあとから AI予約・ホームで登録できる
import { useEffect, useState } from 'react'
import { Phone } from 'lucide-react'
import { bookingAssistantApi } from '../features/johnny/bookingAssistantApi'
import { canBeUsual, setUsualMenu, usualMenuOrder } from '../features/johnny/usualMenu'
import { requestJohnny } from '../features/johnny/bookingIntent'
import { loadUsual } from './usualPicks'
import { addUsualMember, getUsualMembers, type UsualMember } from '../features/johnny/usualMembers'
import { SHOP_PHONE_TEL } from '../data/wallet'

type Menu = { code: string; name: string; duration_min: number; price: number | null }
// 最初に出すメニュー（11/6 慶一郎さんの指定の順）。ほかは「ほかのメニューを見る」で
const FEATURED = ['cut-regular', 'cut-skin-fade', 'perm-nurepan', 'perm-iper', 'perm-punch', 'perm-negro', 'store-teitei-gari']
const yen = (n: number | null) => (n == null ? '' : `¥${n.toLocaleString('ja-JP')}`)

export function FirstGuide({ visited, onClose }: { visited: boolean; onClose: () => void }) {
  const [menus, setMenus] = useState<Menu[] | null>(null)
  const [last, setLast] = useState<{ code: string; name: string } | null>(null)
  const [picking, setPicking] = useState(!visited)
  const [saved, setSaved] = useState<Menu | null>(null)
  // 並びすぎないように、決めた7つだけ。ほかは「ほかのメニューを見る」で（11/6 慶一郎さん「メニュー並び過ぎて、たいぎい」）
  const [showAll, setShowAll] = useState(false)
  // いつものを決めたあと：ご一緒に来られる方（いつものメンバー）を登録して、終わったらホームへ（11/7 慶一郎さん：最初にメニューとお連れ様を決めてからホーム）
  //   ask＝いますか？・name＝お名前・menu＝その方のメニュー・done＝準備ができました。2名まで（3名の予約に合わせる）
  const [mates, setMates] = useState<UsualMember[]>([])
  const [mateStep, setMateStep] = useState<'ask' | 'name' | 'menu' | 'done'>('ask')
  const [mateName, setMateName] = useState('')
  const [mateAll, setMateAll] = useState(false)

  useEffect(() => {
    let live = true
    void bookingAssistantApi().options().then(o => { if (!live) return; const all = usualMenuOrder(o.menus.filter(m => canBeUsual(m.code))); setMenus([...FEATURED.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m), ...all.filter(m => !FEATURED.includes(m.code))]) }).catch(() => { if (live) setMenus([]) })
    if (visited) void loadUsual().then(u => { if (!live) return; if (u?.menu) setLast({ code: u.menu.code, name: u.menu.name }); else setPicking(true) }).catch(() => { if (live) setPicking(true) })
    return () => { live = false }
  }, [visited])

  const save = (m: Menu) => { setUsualMenu({ code: m.code, name: m.name }); setSaved(m); setMates(getUsualMembers().slice(0, 2)); setMateStep('ask') }
  const addMate = (m: Menu) => {
    const name = mateName.trim()
    if (!name) return
    addUsualMember({ name, menuCode: m.code })
    setMates(prev => [...prev.filter(x => x.name !== name), { name, menuCode: m.code }])
    setMateName(''); setMateAll(false); setMateStep('done')
  }
  const menuName = (code: string) => menus?.find(m => m.code === code)?.name ?? ''
  const input: React.CSSProperties = { width: '100%', minHeight: 52, marginTop: 16, padding: '0 16px', boxSizing: 'border-box', borderRadius: 14, border: '1px solid var(--v2-line, rgba(70,55,34,.1))', background: '#fff', color: 'inherit', fontSize: 17 }
  const featuredCount = menus ? menus.filter(m => FEATURED.includes(m.code)).length : 0
  const lastMenu = last ? menus?.find(m => m.code === last.code) ?? null : null

  const sheet: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 80, background: 'var(--v2-bg, #f4f1eb)', color: 'var(--v2-ink, #28231e)', overflowY: 'auto', fontFamily: 'var(--v2-sans)',
    padding: 'calc(env(safe-area-inset-top, 0px) + 28px) 20px calc(env(safe-area-inset-bottom, 0px) + 24px)', boxSizing: 'border-box' }
  const card: React.CSSProperties = { marginTop: 16, borderRadius: 16, background: '#fff', border: '1px solid var(--v2-line, rgba(70,55,34,.1))', overflow: 'hidden' }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%', minHeight: 54, padding: '0 16px', boxSizing: 'border-box',
    border: 'none', borderTop: '1px solid var(--v2-line, rgba(70,55,34,.1))', marginTop: -1, background: 'transparent', color: 'inherit', fontSize: 16, textAlign: 'left', cursor: 'pointer' }
  const primary: React.CSSProperties = { width: '100%', minHeight: 52, borderRadius: 14, border: 'none', background: 'var(--v2-ink, #28231e)', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer' }
  const quiet: React.CSSProperties = { display: 'block', margin: '10px auto 0', minHeight: 44, border: 'none', background: 'none', color: 'var(--v2-sub, #62594e)', fontSize: 14, cursor: 'pointer' }

  return (
    <div role="dialog" aria-modal="true" aria-label="はじめに" className="v2" style={sheet}>
      <div style={{ maxWidth: 440, margin: '0 auto' }}>
        {saved && mateStep === 'ask' ? (
          <>
            <h2 style={{ margin: 0, font: '700 22px/1.5 var(--v2-serif)' }}>ご一緒に来られる方はいますか？</h2>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.7, color: 'var(--v2-sub)' }}>ご家族やお友だちのお名前とメニューを登録しておくと、2名以上の予約もお名前を押すだけでできます。</p>
            <div style={{ marginTop: 24, display: 'grid', gap: 10 }}>
              <button type="button" style={primary} onClick={() => setMateStep('name')}>登録する</button>
              <button type="button" style={quiet} onClick={() => setMateStep('done')}>いない</button>
            </div>
          </>
        ) : saved && mateStep === 'name' ? (
          <>
            <h2 style={{ margin: 0, font: '700 22px/1.5 var(--v2-serif)' }}>ご一緒の方のお名前</h2>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.7, color: 'var(--v2-sub)' }}>お店でお呼びするお名前です。下のお名前だけでも大丈夫です。</p>
            <input style={input} value={mateName} onChange={e => setMateName(e.target.value)} maxLength={20} autoComplete="off" enterKeyHint="next" aria-label="ご一緒の方のお名前"
              onKeyDown={e => { if (e.key === 'Enter' && mateName.trim()) setMateStep('menu') }} />
            <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
              <button type="button" style={primary} disabled={!mateName.trim()} onClick={() => setMateStep('menu')}>次へ</button>
              <button type="button" style={quiet} onClick={() => { setMateName(''); setMateStep(mates.length ? 'done' : 'ask') }}>戻る</button>
            </div>
          </>
        ) : saved && mateStep === 'menu' ? (
          <>
            <h2 style={{ margin: 0, font: '700 22px/1.5 var(--v2-serif)' }}>{mateName.trim()}さんのいつものメニュー</h2>
            <div style={card}>
              {(mateAll ? menus : menus?.slice(0, featuredCount))?.map(m => (
                <button key={m.code} type="button" style={row} onClick={() => addMate(m)}>
                  <span>{m.name}</span><span style={{ fontSize: 14, color: 'var(--v2-sub)' }}>{yen(m.price)}</span>
                </button>
              ))}
              {!mateAll && (menus?.length ?? 0) > featuredCount && (
                <button type="button" style={{ ...row, justifyContent: 'center', color: 'var(--v2-sub)', fontSize: 15 }} onClick={() => setMateAll(true)}>ほかのメニューを見る（{(menus?.length ?? 0) - featuredCount}）</button>
              )}
            </div>
            <button type="button" style={quiet} onClick={() => setMateStep('name')}>戻る</button>
          </>
        ) : saved ? (
          <>
            <h2 style={{ margin: 0, font: '700 22px/1.5 var(--v2-serif)' }}>準備ができました</h2>
            <div style={card}>
              <div style={{ ...row, cursor: 'default' }}><span>いつもの</span><span style={{ fontSize: 15 }}>{saved.name}</span></div>
              {mates.map(m => <div key={m.name} style={{ ...row, cursor: 'default' }}><span>{m.name}さん</span><span style={{ fontSize: 15 }}>{menuName(m.menuCode)}</span></div>)}
            </div>
            <p style={{ margin: '12px 2px 0', fontSize: 14, lineHeight: 1.7, color: 'var(--v2-sub)' }}>次からはホームの「いつもの」を押すだけで予約できます。{mates.length ? 'ご一緒の予約は「2名以上で予約する」からどうぞ。' : ''}あとから変えられます。</p>
            {mates.length < 2 && <button type="button" style={{ ...quiet, marginTop: 4 }} onClick={() => setMateStep('name')}>{mates.length ? 'もう1人登録する' : 'ご一緒の方を登録する'}</button>}
            <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
              <button type="button" style={primary} onClick={() => { onClose(); requestJohnny({ menuCode: saved.code, label: saved.name, usual: true }) }}>いつものでAI予約する</button>
              <button type="button" style={quiet} onClick={onClose}>ホームへ</button>
            </div>
          </>
        ) : !picking && last ? (
          <>
            <h2 style={{ margin: 0, font: '700 22px/1.5 var(--v2-serif)' }}>前回は「{last.name}」でした</h2>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.7, color: 'var(--v2-sub)' }}>いつものメニューに登録しますか？ 次からホームで押すだけで予約できます。</p>
            <div style={{ marginTop: 24, display: 'grid', gap: 10 }}>
              <button type="button" style={primary} disabled={!lastMenu} onClick={() => lastMenu && save(lastMenu)}>登録する</button>
              <button type="button" style={quiet} onClick={() => setPicking(true)}>ほかのメニューにする</button>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ margin: 0, font: '700 22px/1.5 var(--v2-serif)' }}>いつものメニューを決めましょう</h2>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.7, color: 'var(--v2-sub)' }}>決めておくと、次からホームの「いつもの」を押すだけで予約できます。あとから変えられます。</p>
            <a href={SHOP_PHONE_TEL} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, minHeight: 48, borderRadius: 14, border: '1px solid var(--v2-line, rgba(70,55,34,.1))', background: '#fff', color: 'inherit', fontSize: 15, textDecoration: 'none' }}>
              <Phone size={18} aria-hidden="true" />髪型に迷ったらお電話ください
            </a>
            <div style={card}>
              {menus === null && <p style={{ margin: 0, padding: 16, fontSize: 14, color: 'var(--v2-sub)' }}>読み込んでいます…</p>}
              {(showAll ? menus : menus?.slice(0, featuredCount))?.map(m => (
                <button key={m.code} type="button" style={row} onClick={() => save(m)}>
                  <span>{m.name}</span><span style={{ fontSize: 14, color: 'var(--v2-sub)' }}>{yen(m.price)}</span>
                </button>
              ))}
              {!showAll && (menus?.length ?? 0) > featuredCount && (
                <button type="button" style={{ ...row, justifyContent: 'center', color: 'var(--v2-sub)', fontSize: 15 }} onClick={() => setShowAll(true)}>ほかのメニューを見る（{(menus?.length ?? 0) - featuredCount}）</button>
              )}
            </div>
          </>
        )}
        {!saved && (
          <>
            {!picking && (
              <a href={SHOP_PHONE_TEL} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20, minHeight: 48, borderRadius: 14, border: '1px solid var(--v2-line, rgba(70,55,34,.1))', background: '#fff', color: 'inherit', fontSize: 15, textDecoration: 'none' }}>
                <Phone size={18} aria-hidden="true" />髪型に迷ったらお電話ください
              </a>
            )}
            {visited &&<p style={{ margin: '14px 2px 0', fontSize: 13, lineHeight: 1.7, color: 'var(--v2-sub)' }}>前のアプリをお使いだった方：お持ちのチケットは、ご来店時にお店で引き継ぎます。会員QRをお見せください。</p>}
            <button type="button" style={quiet} onClick={onClose}>あとで</button>
          </>
        )}
      </div>
    </div>
  )
}
