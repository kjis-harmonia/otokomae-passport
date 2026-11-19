// 銀ちゃんの「メニューを選ぶ」（11/17 慶一郎さん「ユーザーに寄り添った親切設計で」）
//   ・いつものメニューを一番上に（常連さんは探さなくていい）
//   ・検索と、カット／パーマ／セット／カラー／シェービングのタブで、すぐ見つかる
//   ・料金は折り返さない。所要時間も小さく添える。Black Monday の対象には「月曜 −¥2,000」
import { useMemo, useState } from 'react'
import { ChevronRight, RotateCw, Search, X } from 'lucide-react'

export type PickMenu = { code: string; name: string; duration_min: number; price: number | null }

const TABS = [
  { id: 'all', label: 'すべて' },
  { id: 'cut', label: 'カット' },
  { id: 'perm', label: 'パーマ' },
  { id: 'set', label: 'セット' },
  { id: 'color', label: 'カラー' },
  { id: 'shave', label: 'シェービング' },
] as const
type Tab = typeof TABS[number]['id']

/** メニューの記号の頭で分ける（cut-・maintenance・store-＝カット、perm-、set-、color-、shave-） */
function menuTab(code: string): Exclude<Tab, 'all'> | 'other' {
  if (/^(cut|maintenance|store)(-|$)/.test(code)) return 'cut'
  if (code.startsWith('perm-')) return 'perm'
  if (code.startsWith('set-')) return 'set'
  if (code.startsWith('color-')) return 'color'
  if (code.startsWith('shave-')) return 'shave'
  return 'other'
}

const yen = (n: number | null) => (n == null ? '料金はご来店時' : `¥${n.toLocaleString('ja-JP')}`)
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`)
/** ひらがな・カタカナ・大文字小文字・空白の違いをならして比べる */
const norm = (t: string) => t.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))

export function MenuPickerSheet({ menus, usualCode, bm, failed = false, onRetry, onPick, onClose }: {
  menus: PickMenu[]
  /** いつものメニュー（無ければ null） */
  usualCode: string | null
  /** Black Monday の対象（codes が空なら出さない） */
  bm: { codes: string[]; amount: number }
  /** 通信でメニューを読めなかった（0件とは分ける・SR-07） */
  failed?: boolean
  onRetry?: () => Promise<void>
  onPick: (m: PickMenu) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('all')
  const [q, setQ] = useState('')
  const [retrying, setRetrying] = useState(false)
  const usual = usualCode ? menus.find(m => m.code === usualCode) ?? null : null
  const tabs = TABS.filter(t => t.id === 'all' || menus.some(m => menuTab(m.code) === t.id))
  const list = useMemo(() => {
    const k = norm(q)
    return menus.filter(m => (k ? norm(m.name).includes(k) : tab === 'all' || menuTab(m.code) === tab))
  }, [menus, tab, q])
  const searching = q.trim() !== ''

  const row = (m: PickMenu) => (
    <button key={m.code} type="button" className="mp-row" onClick={() => onPick(m)}>
      <span className="mp-main">
        <span className="mp-name">{m.name}</span>
        <span className="mp-sub">
          {mins(m.duration_min)}
          {bm.amount > 0 && bm.codes.includes(m.code) && <em className="mp-bm">月曜のご来店で −{bm.amount.toLocaleString('ja-JP')}円</em>}
        </span>
      </span>
      <span className="mp-price">{yen(m.price)}</span>
      <ChevronRight size={16} aria-hidden="true" className="mp-chev" />
    </button>
  )

  if (failed && !menus.length) {
    return (
      <div className="mp">
        <div className="mp-head">
          <p className="mp-title">メニューを選ぶ</p>
          <button type="button" className="mp-x" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="mp-empty" role="alert">
          <p className="mp-empty-text">メニューを読み込めませんでした。<br />電波のよい所で、もう一度お試しください。</p>
          {onRetry && (
            <button type="button" className="mp-retry" disabled={retrying}
              onClick={() => { setRetrying(true); void onRetry().finally(() => setRetrying(false)) }}>
              <RotateCw size={15} aria-hidden="true" />{retrying ? '読み込んでいます…' : '読み込み直す'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mp">
      <div className="mp-head">
        <p className="mp-title">メニューを選ぶ</p>
        <button type="button" className="mp-x" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
      </div>
      <label className="mp-search">
        <Search size={17} aria-hidden="true" />
        <input type="search" inputMode="search" placeholder="メニュー名で探す" value={q} onChange={e => setQ(e.target.value)} aria-label="メニュー名で探す" />
        {searching && <button type="button" className="mp-clear" aria-label="消す" onClick={() => setQ('')}><X size={15} /></button>}
      </label>
      {!searching && (
        <div className="mp-tabs" role="tablist" aria-label="種類">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : undefined} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
      )}
      {usual && !searching && tab === 'all' && (
        <>
          <p className="mp-label">いつものメニュー</p>
          <div className="mp-list mp-usual">{row(usual)}</div>
        </>
      )}
      <p className="mp-label">{searching ? `「${q.trim()}」の検索結果` : tab === 'all' ? 'すべてのメニュー' : TABS.find(t => t.id === tab)?.label}</p>
      {list.length
        ? <div className="mp-list">{list.filter(m => !(usual && !searching && tab === 'all' && m.code === usual.code)).map(row)}</div>
        : <p className="mp-empty">見つかりませんでした。言い方を変えるか、銀ちゃんにお話しください。</p>}
    </div>
  )
}
