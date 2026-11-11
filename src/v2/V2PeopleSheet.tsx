// 「いつものでAI予約する」を押したら：どなたのご予約ですか？（11/8 慶一郎さん）
//   ・ご本人と、登録したお連れ様（3名まで）を、それぞれのいつものメニューと並べる。選んだ方のいつもので AI予約へ
//   ・メンテナンスカットは、その方が対象メニューの施術を終えてから14日以内のときだけ出す（ご本人の記録で、お連れ様は出さない）
//   ・同じ画面の「お連れ様を追加・編集」で、追加・メニューの変更・削除
//   ・☰ の「いつもの・お連れ様」からは、編集の画面から開く（ご本人のいつものも変えられる・11/8）
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { bookingAssistantApi } from '../features/johnny/bookingAssistantApi'
import { canBeUsual, setUsualMenu, usualMenuOrder } from '../features/johnny/usualMenu'
import { callCustomerRpc } from '../utils/customerSession'
import { fetchPeople, MAX_COMPANIONS, removeCompanion, saveCompanion, type People, type Person } from '../features/johnny/usualMembers'
import { RpcError } from '../utils/staffSession'
import { loadUsual } from './usualPicks'

type Menu = { code: string; name: string; duration_min: number; price: number | null }
// 最初に出すメニュー（最初の案内と同じ順）。ほかは「ほかのメニューを見る」で
const FEATURED = ['cut-regular', 'cut-skin-fade', 'perm-nurepan', 'perm-iper', 'perm-punch', 'perm-negro', 'store-teitei-gari']

/** onBook：person が null ならご本人。menuCode が null ならメニューを AI が聞く（ご本人のいつものが無いとき） */
export function V2PeopleSheet({ open, onClose, ownerMenu, onBook, manage = false }: {
  open: boolean
  onClose: () => void
  ownerMenu: { code: string; name: string } | null
  /** 無いとき（☰ から開いた）は予約の画面を出さず、編集だけ */
  onBook?: (person: { id: string; name: string } | null, menuCode: string | null, label: string) => void
  /** ☰ から：最初から編集の画面 */
  manage?: boolean
}) {
  const [people, setPeople] = useState<People | null>(null)
  const [failed, setFailed] = useState(false)
  const [mode, setMode] = useState<'pick' | 'edit' | 'form'>('pick')
  // form：追加（id なし）・変更（id あり）
  const [form, setForm] = useState<{ id: string | null; name: string; menu: string | null }>({ id: null, name: '', menu: null })
  const [menus, setMenus] = useState<Menu[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [lastMenu, setLastMenu] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setMode(manage ? 'edit' : 'pick'); setError(null); setArmed(null); setFailed(false) // eslint-disable-line react-hooks/set-state-in-effect -- 開くたびに最初から
    void fetchPeople().then(p => { if (live) setPeople(p) }, () => { if (live) setFailed(true) })
    // ホーム・銀ちゃんと同じ「いつもの」（登録が無ければ前回のご来店）。ここだけ「まだ決まっていません」と食い違わないように（11/10 夜の点検）
    void loadUsual().then(u => { if (live) setLastMenu(u?.menu?.name ?? null) }, () => { if (live) setLastMenu(null) })
    return () => { live = false }
  }, [open, manage])
  useEffect(() => {
    if (mode !== 'form' || menus) return
    let live = true
    void bookingAssistantApi().options().then(o => {
      if (!live) return
      const all = usualMenuOrder(o.menus.filter(m => canBeUsual(m.code)))
      setMenus([...FEATURED.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m), ...all.filter(m => !FEATURED.includes(m.code))])
    }, () => { if (live) setMenus([]) })
    return () => { live = false }
  }, [mode, menus])
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t) }, [armed])

  const owner = people?.owner ?? null
  const companions = people?.companions ?? []
  const ownerMenuCode = ownerMenu?.code ?? owner?.menu_code ?? null
  const ownerMenuName = ownerMenu?.name ?? owner?.menu_name ?? null

  const errorText = (err: unknown) => {
    const code = err instanceof RpcError ? err.code : ''
    return code === 'name_exists' ? '同じお名前の方がいます。別のお名前にしてください。'
      : code === 'too_many' ? `お連れ様は${MAX_COMPANIONS}名まで登録できます。`
      : code === 'bad_name' ? 'お名前は20文字までで入れてください。'
      : 'うまく保存できませんでした。通信を確かめて、もう一度お試しください。'
  }
  const submit = async (menuCode: string) => {
    // ご本人のいつもの（form.id = 'me'）
    if (form.id === 'me') {
      setBusy(true); setError(null)
      try {
        const m = menus?.find(x => x.code === menuCode)
        if (m) setUsualMenu({ code: m.code, name: m.name })
        await callCustomerRpc('customer_set_usual_menu', { p_code: menuCode })
        setPeople(await fetchPeople()); setMode('edit'); setShowAll(false)
      } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
      return
    }
    const name = form.name.trim()
    if (!name) { setError('お名前を入れてください。'); return }
    setBusy(true); setError(null)
    try { setPeople(await saveCompanion(form.id, name, menuCode)); setMode('edit'); setShowAll(false) }
    catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  const remove = async (p: Person) => {
    if (!p.id) return
    if (armed !== p.id) { setArmed(p.id); return }
    setBusy(true); setError(null); setArmed(null)
    try { setPeople(await removeCompanion(p.id)) } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  /** 1人分：いつものメニュー。メンテナンスカットが使える方は2つから選ぶ */
  const personRow = (p: Person | null, name: string, sub: string | null, menuCode: string | null, menuName: string | null) => {
    const who = p?.id ? { id: p.id, name } : null
    const maint = !!p?.maintenance_ok && menuCode != null
    if (p?.id && !menuCode) {
      return (
        <button key={p.id} type="button" className="v2-row" onClick={() => { setForm({ id: p.id, name: p.name, menu: null }); setMode('form') }}>
          <span style={{ flex: 1 }}>{name}<small>いつものメニューを決める</small></span><ChevronRight size={18} />
        </button>
      )
    }
    if (!maint) {
      return (
        <button key={p?.id ?? 'owner'} type="button" className="v2-row" onClick={() => onBook?.(who, menuCode, menuName ?? '')}>
          <span style={{ flex: 1 }}>{name}{sub && <small>{sub}</small>}</span>
          <span className="v2-person-menu">{menuName ?? 'メニューを AI と決める'}</span><ChevronRight size={18} />
        </button>
      )
    }
    return (
      <div key={p?.id ?? 'owner'} className="v2-row v2-person" role="group" aria-label={`${name}のメニュー`}>
        <span>{name}{sub && <small>{sub}</small>}</span>
        <div className="v2-person-choices">
          <button type="button" className="v2-choice" onClick={() => onBook?.(who, menuCode, menuName ?? '')}>{menuName}</button>
          <button type="button" className="v2-choice" onClick={() => onBook?.(who, 'maintenance', 'メンテナンスカット')}>
            メンテナンスカット<small>{p!.days_left === 0 ? '今日まで' : `あと${p!.days_left}日`}</small>
          </button>
        </div>
      </div>
    )
  }

  // 決めたメニューが1つも無い環境（料金表が違う）では全部出す
  const featured = menus?.filter(m => FEATURED.includes(m.code)) ?? []
  const visibleMenus = menus ? (showAll || featured.length === 0 ? menus : featured) : null
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="back" className="v2-sheet-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div key="sheet" className="v2-sheet" role="dialog" aria-modal="true" aria-label="どなたのご予約ですか"
            initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}>
            <div className="v2-grab" data-guide="people-sheet" />
            {mode === 'pick' && <>
              <h2 className="v2-people-title">どなたのご予約ですか？</h2>
              <div className="v2-panel v2-glass" style={{ padding: '4px 14px' }}>
                {personRow(owner, owner?.name ?? 'ご本人', 'ご本人', ownerMenuCode, ownerMenuName)}
                {companions.map(c => personRow(c, c.name, null, c.menu_code, c.menu_name))}
              </div>
              {failed && <p className="v2-people-note" role="status">お連れ様を読み込めませんでした。ご本人の予約はできます。</p>}
              <button type="button" className="v2-btn v2-btn-quiet" style={{ marginTop: 4, background: 'none' }} disabled={!people} onClick={() => setMode('edit')}>お連れ様を追加・編集</button>
            </>}

            {mode === 'edit' && <>
              {!manage && <button type="button" className="v2-people-back" onClick={() => { setMode('pick'); setError(null) }}><ChevronLeft size={18} />戻る</button>}
              <h2 className="v2-people-title">{manage ? 'いつもの・お連れ様' : 'お連れ様'}</h2>
              {manage && (
                <>
                  <p className="v2-people-label">ご本人</p>
                  <div className="v2-panel v2-glass" style={{ padding: '4px 14px' }} data-guide="people-owner">
                    <div className="v2-row">
                      <span style={{ flex: 1 }}>{owner?.name ?? 'ご本人'}<small>{owner?.menu_name ? `いつもの：${owner.menu_name}` : lastMenu ? `いつもの：${lastMenu}` : 'いつものは、まだ決まっていません'}</small></span>
                      <button type="button" className="v2-text-btn" data-guide="people-owner-edit" disabled={busy || !people} onClick={() => { setForm({ id: 'me', name: owner?.name ?? '', menu: owner?.menu_code ?? null }); setError(null); setMode('form') }}>変更</button>
                    </div>
                  </div>
                  <p className="v2-people-label">お連れ様</p>
                </>
              )}
              {companions.length > 0 && (
                <div className="v2-panel v2-glass" style={{ padding: '4px 14px' }} data-guide="people-list">
                  {companions.map(c => (
                    <div key={c.id} className="v2-row">
                      <span style={{ flex: 1 }}>{c.name}<small>{c.menu_name ?? 'メニュー未登録'}</small></span>
                      <button type="button" className="v2-text-btn" data-guide="people-edit" disabled={busy} onClick={() => { setForm({ id: c.id, name: c.name, menu: c.menu_code }); setError(null); setMode('form') }}>変更</button>
                      <button type="button" className="v2-text-btn" data-guide="people-remove" data-danger={armed === c.id || undefined} disabled={busy} onClick={() => void remove(c)}>{armed === c.id ? 'もう一度で削除' : '削除'}</button>
                    </div>
                  ))}
                </div>
              )}
              {companions.length === 0 && <p className="v2-people-note">まだ登録されていません。ご家族やご友人など、一緒に来られる方を登録すると、次から押すだけで予約できます。</p>}
              {error && <p className="v2-people-error" role="alert">{error}</p>}
              {companions.length < MAX_COMPANIONS
                ? <button type="button" className="v2-btn v2-btn-gold" data-guide="people-add" style={{ marginTop: 14 }} onClick={() => { setForm({ id: null, name: '', menu: null }); setError(null); setMode('form') }}><Plus size={18} />お連れ様を追加</button>
                : <p className="v2-people-note">お連れ様は{MAX_COMPANIONS}名まで登録できます。</p>}
              <p className="v2-people-note">削除しても、すでに取ったご予約はそのまま残ります。</p>
            </>}

            {mode === 'form' && <>
              <button type="button" className="v2-people-back" onClick={() => { setMode('edit'); setError(null); setShowAll(false) }}><ChevronLeft size={18} />戻る</button>
              <h2 className="v2-people-title">{form.id === 'me' ? 'いつものメニューを変更' : form.id ? 'お連れ様を変更' : 'お連れ様を追加'}</h2>
              {form.id !== 'me' && <>
                <label className="v2-people-label" htmlFor="v2-mate-name">お名前（お店で呼ぶお名前）</label>
                <input id="v2-mate-name" className="v2-people-input" data-guide="people-name" value={form.name} maxLength={20} placeholder="例：父、たろう" autoComplete="off"
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </>}
              <p className="v2-people-label">いつものメニュー</p>
              <div className="v2-panel v2-glass" style={{ padding: '4px 14px' }} data-guide="people-menus">
                {!visibleMenus && <p className="v2-people-note" role="status">メニューを読み込んでいます…</p>}
                {visibleMenus?.map(m => (
                  <button key={m.code} type="button" className="v2-row" disabled={busy} aria-pressed={form.menu === m.code} onClick={() => void submit(m.code)}>
                    <span style={{ flex: 1 }}>{m.name}</span>
                    {m.price != null && <span className="v2-person-menu">¥{m.price.toLocaleString()}</span>}
                    {form.menu === m.code && <span className="v2-person-menu">いつもの</span>}
                  </button>
                ))}
              </div>
              {menus && visibleMenus && visibleMenus.length < menus.length && <button type="button" className="v2-btn v2-btn-quiet" style={{ background: 'none' }} onClick={() => setShowAll(true)}>ほかのメニューを見る</button>}
              {error && <p className="v2-people-error" role="alert">{error}</p>}
              <p className="v2-people-note">メニューを押すと保存します。</p>
            </>}

            <button type="button" className="v2-btn v2-btn-quiet" style={{ marginTop: 8, background: 'none' }} onClick={onClose} data-guide="people-close">閉じる</button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
