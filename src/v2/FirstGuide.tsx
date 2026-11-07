// 登録直後の「いつものメニュー」決め：銀ちゃんと話して決める（11/8 慶一郎さん「話すことを画面の主役に」「極限まで削ぎ落とし、極限まで美しく」）
//   ・最初は銀ちゃんとひとこと、ガラスの入力欄「銀ちゃんとAIで話して決める」だけ。一覧と HOT PEPPER は下に控えめに
//   ・話した言葉から、AI予約と同じメニューの読み取り（matchMenu）で探す。あいまいなら候補を出して聞き返す。勝手に決めない
//   ・決める前に、正式なメニュー名と料金で必ず確かめる
//   ・対象メニューならメンテナンスカットのご希望、つぎにお連れ様（3名まで。お連れ様も対象ならメンテナンスを聞く）
//   ・終わったらホームへ。店頭で本人確認が済んだ方だけ「お店で決めてもらう」で飛ばせる
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUp, ChevronRight, X } from 'lucide-react'
import { bookingAssistantApi } from '../features/johnny/bookingAssistantApi'
import { matchMenu } from '../features/johnny/menuMatcher'
import { askUsualAi } from '../features/johnny/usualAi'
import type { AgentTurn } from '../features/johnny/agentClient'
import { canBeUsual, setUsualMenu, usualMenuOrder } from '../features/johnny/usualMenu'
import { loadUsual } from './usualPicks'
import { MAX_COMPANIONS, saveCompanion, setOwnerMaintenance } from '../features/johnny/usualMembers'
import { JohnnyRider } from '../features/johnny/JohnnyRider'
import { callCustomerRpc } from '../utils/customerSession'
import { useStoreAccess } from '../features/customerAccess/storeAccess'
import { SHOP_PHONE_TEL } from '../data/wallet'

type Menu = { code: string; name: string; duration_min: number; price: number | null; maintenance?: boolean }
const FEATURED = ['cut-regular', 'cut-skin-fade', 'perm-nurepan', 'perm-iper', 'perm-punch', 'perm-negro', 'store-teitei-gari']
const HOTPEPPER_MENU_URL = 'https://beauty.hotpepper.jp/slnH000583749/coupon/'
const yen = (n: number | null) => (n == null ? '' : `¥${n.toLocaleString('ja-JP')}`)
/** お名前の呼び方：「お父さん」「花子ちゃん」はそのまま、「たろう」は「たろうさん」 */
const honor = (name: string) => (/(さん|様|ちゃん|くん|君)$/.test(name) ? name : `${name}さん`)

type Who = { kind: 'me' } | { kind: 'mate'; name: string }
/** 銀ちゃんの返しに付けるボタン */
type Chip = { label: string; sub?: string; act: () => void; strong?: boolean }
type Msg = { id: number; from: 'gin' | 'you'; text: string }
/** いま何を聞いているか（入力欄に打った言葉の行き先） */
type Ask = { k: 'menu'; who: Who } | { k: 'mateName' } | { k: 'none' }

/** あいまいな言葉から候補（例：「パーマ」→ パーマのメニュー）。多すぎるときは代表から4つ */
function candidates(text: string, menus: readonly Menu[]): Menu[] {
  const t = text.normalize('NFKC')
  const rules: [RegExp, (m: Menu) => boolean][] = [
    [/子供|子ども|こども|キッズ|小学生|息子|娘/, m => /小学生|子供|キッズ|ジュニア/.test(m.name)],
    [/パンチ|ぱんち|アイパー|あいぱー/, m => /パンチ|アイパー/.test(m.name)],
    [/カラー|からー|白髪|しらが|グレー|染め/, m => /カラー|グレー/.test(m.name)],
    [/剃|そり|シェービング|顔/, m => /シェービング|顔剃/.test(m.name)],
    [/パーマ|ぱーま|くせ|クセ|ちりちり|チリチリ|ウェーブ/, m => m.code.startsWith('perm-') || /パーマ|パン|アイパー|カーリー/.test(m.name)],
    [/フェード|刈り上げ|かりあげ|短|みじか|さっぱり|坊主|ぼうず/, m => /フェード|刈|丸刈/.test(m.name)],
    [/カット|かっと|切|整え/, m => m.code.startsWith('cut-') || /カット|刈/.test(m.name)],
  ]
  for (const [re, pick] of rules) {
    if (!re.test(t)) continue
    const hit = menus.filter(pick)
    if (hit.length) return [...hit.filter(m => FEATURED.includes(m.code)), ...hit.filter(m => !FEATURED.includes(m.code))].slice(0, 4)
  }
  return []
}

export function FirstGuide({ visited, onClose }: { visited: boolean; onClose: () => void }) {
  const access = useStoreAccess()
  const reduce = useReducedMotion()
  const [menus, setMenus] = useState<Menu[] | null>(null)
  const [last, setLast] = useState<Menu | null>(null)
  const [mode, setMode] = useState<'intro' | 'chat'>('intro')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [chips, setChips] = useState<Chip[]>([])
  const [ask, setAsk] = useState<Ask>({ k: 'none' })
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [list, setList] = useState<{ who: Who } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [mine, setMine] = useState<{ menu: Menu; maint: boolean } | null>(null)
  const [mates, setMates] = useState<{ name: string; menu: Menu; maint: boolean }[]>([])
  const [done, setDone] = useState(false)
  const nextId = useRef(1)
  // 銀ちゃん（AI）に送る、これまでの会話
  const turnsRef = useRef<AgentTurn[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const matesRef = useRef(mates)
  useEffect(() => { matesRef.current = mates }, [mates])

  useEffect(() => {
    let live = true
    void bookingAssistantApi().options().then(o => {
      if (!live) return
      const all = usualMenuOrder(o.menus.filter(m => canBeUsual(m.code))) as Menu[]
      const sorted = [...FEATURED.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m), ...all.filter(m => !FEATURED.includes(m.code))]
      setMenus(sorted)
      if (visited) void loadUsual().then(u => { const m = u?.menu ? sorted.find(x => x.code === u.menu!.code) : undefined; if (live && m) setLast(m) }).catch(() => {})
    }).catch(() => { if (live) setMenus([]) })
    return () => { live = false }
  }, [visited])
  // 新しい言葉が出たら下まで送る
  useLayoutEffect(() => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }) }, [msgs, chips, typing, reduce])

  /** 銀ちゃんが話す（少し間をおいて。ボタンはそのあと） */
  const gin = (line: string, next: Chip[] = [], nextAsk: Ask = { k: 'none' }, now = false) => {
    setChips([]); setAsk({ k: 'none' }); setTyping(true)
    window.setTimeout(() => {
      setTyping(false)
      setMsgs(m => [...m, { id: nextId.current++, from: 'gin', text: line }])
      setChips(next); setAsk(nextAsk)
      if (nextAsk.k !== 'none') window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50)
    }, reduce || now ? 0 : 520)
  }
  const you = (line: string) => setMsgs(m => [...m, { id: nextId.current++, from: 'you', text: line }])

  // ── 会話 ──
  const askMenu = (who: Who) => {
    const name = who.kind === 'mate' ? honor(who.name) : null
    const pickChips: Chip[] = [{ label: '一覧から選ぶ', act: () => setList({ who }) }]
    if (who.kind === 'me' && visited && last) {
      gin(`前は「${last.name}」じゃったね。\nいつものも、これでええ？`, [
        { label: 'これでええ', strong: true, act: () => { you('これでええ'); check(who, last) } },
        { label: 'ほかのにする', act: () => { you('ほかのにする'); gin('ほいじゃ、何にする？', pickChips, { k: 'menu', who }) } },
      ])
      return
    }
    if (name) { gin(`${name}は、いつも何にしよるん？`, pickChips, { k: 'menu', who }); return }
    gin(visited ? 'いつもは何にしよるん？' : 'どのメニューにする？\nホットペッパーのメニューも見れるよ。', visited ? pickChips : [
      { label: 'HOT PEPPER で見る', act: () => window.open(HOTPEPPER_MENU_URL, '_blank', 'noopener') },
      { label: 'カット', act: () => hear(who, 'カット') },
      { label: 'パーマ', act: () => hear(who, 'パーマ') },
      { label: 'パンチ・アイパー', act: () => hear(who, 'パンチ') },
      { label: 'まだ迷うとる', act: () => hear(who, '迷う') },
    ], { k: 'menu', who })
  }
  /** お客様の言葉 → メニュー */
  /** お客様の言葉 → メニュー。名前がそのまま分かればすぐ確かめる。それ以外は銀ちゃん（AI）と話す。AI が使えんときは決まった規則で */
  const hear = (who: Who, said: string) => {
    you(said)
    const all = menus ?? []
    const hit = matchMenu(said, all)
    if (hit) { turnsRef.current.push({ role: 'user', text: said }); check(who, hit); return }
    setChips([]); setAsk({ k: 'none' }); setTyping(true)
    const history = turnsRef.current.slice()
    turnsRef.current.push({ role: 'user', text: said })
    void askUsualAi(said, history, { visited, who: who.kind === 'mate' ? who.name : null }).then(r => {
      setTyping(false)
      if (!r) { hearByRules(who, said); return }
      turnsRef.current.push({ role: 'assistant', text: r.say })
      const one = r.menu_code ? all.find(m => m.code === r.menu_code) : undefined
      if (one) { check(who, one, r.say); return }
      const opts = r.options.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m)
      const chips: Chip[] = opts.map(m => ({ label: m.name, sub: yen(m.price), act: () => { you(m.name); turnsRef.current.push({ role: 'user', text: m.name }); check(who, m) } }))
      if (r.action === 'hotpepper') chips.push({ label: 'HOT PEPPER で見る', strong: !opts.length, act: () => window.open(HOTPEPPER_MENU_URL, '_blank', 'noopener') })
      if (r.action === 'phone') chips.push({ label: 'お店に電話する', strong: !opts.length, act: () => { window.location.href = SHOP_PHONE_TEL } })
      chips.push({ label: opts.length ? 'ほかを見る' : '一覧から選ぶ', act: () => setList({ who }) })
      gin(r.say, chips, { k: 'menu', who }, true)
    })
  }
  /** AI が使えんとき：決まった規則で */
  const hearByRules = (who: Who, said: string) => {
    const all = menus ?? []
    if (/迷|まよ|わから|分から|おまかせ|相談/.test(said)) {
      gin('ほいじゃ、写真見て決めてもええし、電話で相談してもええよ。', [
        { label: 'HOT PEPPER で見る', act: () => window.open(HOTPEPPER_MENU_URL, '_blank', 'noopener') },
        { label: '一覧から選ぶ', act: () => setList({ who }) },
        { label: 'お店に電話する', act: () => { window.location.href = SHOP_PHONE_TEL } },
      ], { k: 'menu', who })
      return
    }
    const cand = candidates(said, all)
    if (cand.length) {
      gin('この中なら、どれが近い？', [...cand.map(m => ({ label: m.name, sub: yen(m.price), act: () => { you(m.name); check(who, m) } })), { label: 'ほかを見る', act: () => setList({ who }) }], { k: 'menu', who })
      return
    }
    gin('ごめん、ようわからんかった。\n「パンチ」とか「短く」みたいに言うてみて。', [{ label: '一覧から選ぶ', act: () => setList({ who }) }], { k: 'menu', who })
  }
  /** 正式な名前と料金で確かめる */
  const check = (who: Who, menu: Menu, lead?: string) => {
    const whose = who.kind === 'mate' ? `${honor(who.name)}のいつもは` : 'いつものは'
    gin(`${lead && !lead.includes(menu.name) ? lead + '\n' : ''}${whose}「${menu.name}」${menu.price != null ? ` ${yen(menu.price)}` : ''}じゃね。\nこれで登録してええ？`, [
      { label: '登録する', strong: true, act: () => { you('登録する'); if (menu.maintenance) askMaint(who, menu); else void commit(who, menu, false) } },
      { label: 'ちがう', act: () => { you('ちがう'); gin('ほいじゃ、何にする？', [{ label: '一覧から選ぶ', act: () => setList({ who }) }], { k: 'menu', who }) } },
    ])
  }
  const askMaint = (who: Who, menu: Menu) => gin('14日以内のメンテナンスカットも使えるよ。\n希望する？', [
    { label: 'はい', strong: true, act: () => { you('はい'); void commit(who, menu, true) } },
    { label: 'いいえ', act: () => { you('いいえ'); void commit(who, menu, false) } },
  ])
  const commit = async (who: Who, menu: Menu, maint: boolean) => {
    setChips([]); setTyping(true)
    try {
      if (who.kind === 'me') {
        setUsualMenu({ code: menu.code, name: menu.name })
        await callCustomerRpc('customer_set_usual_menu', { p_code: menu.code })
        if (maint) await setOwnerMaintenance(true)
        setMine({ menu, maint })
        askMate(false)
      } else {
        await saveCompanion(null, who.name, menu.code, maint)
        setMates(x => [...x.filter(m => m.name !== who.name), { name: who.name, menu, maint }])
        askMate(true)
      }
    } catch {
      setTyping(false)
      gin('ごめん、うまく登録できんかった。\n電波を確かめて、もう一回押してみて。', [{ label: 'もう一回', strong: true, act: () => void commit(who, menu, maint) }])
    }
  }
  const askMate = (more: boolean) => {
    if (more && matesRef.current.length + 1 >= MAX_COMPANIONS) { finish(); return }
    gin(more ? 'ほかにも一緒に来る人はおる？' : 'ええね！一緒に来る人もおる？\n登録しとくと、次から楽じゃけぇ。', [
      { label: '登録する', strong: true, act: () => { you('登録する'); gin('お名前は？お店で呼ぶ名前でええよ。', [], { k: 'mateName' }) } },
      { label: more ? 'もうおらん' : '今はええ', act: () => { you(more ? 'もうおらん' : '今はええ'); finish() } },
    ])
  }
  const finish = () => { gin('準備できたけぇ！\n次からは「いつもの」を押すだけよ。'); window.setTimeout(() => setDone(true), reduce ? 0 : 560) }

  const send = () => {
    const t = text.trim()
    if (!t || ask.k === 'none') return
    setText('')
    if (ask.k === 'mateName') {
      const name = t.slice(0, 20)
      if (matesRef.current.some(m => m.name === name)) { you(name); gin('その名前はもう登録しとるよ。別の呼び方にしてみて。', [], { k: 'mateName' }); return }
      you(name); askMenu({ kind: 'mate', name })
      return
    }
    hear(ask.who, t)
  }
  const start = () => { setMode('chat'); askMenu({ kind: 'me' }) }
  const pickFromList = (m: Menu) => { const who = list!.who; setList(null); setShowAll(false); you(m.name); check(who, m) }

  const featured = menus?.filter(m => FEATURED.includes(m.code)) ?? []
  const shown = menus ? (showAll || featured.length === 0 ? menus : featured) : null
  const placeholder = ask.k === 'mateName' ? 'お名前（例：父、たろう）' : ask.k === 'menu' ? '例：パンチで、短めに' : ''

  return (
    <div role="dialog" aria-modal="true" aria-label="いつものメニューを決める" className="v2 gc">
      <div className="gc-top">
        {access.mode === 'verified' && !done
          ? <button type="button" className="gc-quiet" onClick={onClose}>お店で決めてもらう</button>
          : <span />}
        {mode === 'chat' && !done && <button type="button" className="gc-icon" aria-label="あとで" onClick={onClose}><X size={20} /></button>}
      </div>

      {mode === 'intro' ? (
        <div className="gc-intro">
          <div className="gc-rider" aria-hidden="true"><JohnnyRider state="idle" width={260} /></div>
          <p className="gc-hello">よう来んさったのぉ！<br />いつものメニュー、<br />一緒に決めよう！</p>
          <button type="button" className="gc-lens gc-start" onClick={start} disabled={!menus}>
            <span className="gc-start-text">銀ちゃんとAIで話して決める</span>
            <span className="gc-send" aria-hidden="true"><ArrowUp size={18} strokeWidth={2.4} /></span>
          </button>
          <div className="gc-links">
            <button type="button" className="gc-quiet" onClick={() => { setMode('chat'); setList({ who: { kind: 'me' } }) }}>自分で選ぶ</button>
            <span aria-hidden="true">·</span>
            <a className="gc-quiet" href={HOTPEPPER_MENU_URL} target="_blank" rel="noopener noreferrer">HOT PEPPER Beauty</a>
          </div>
          <button type="button" className="gc-quiet gc-later" onClick={onClose}>あとで</button>
        </div>
      ) : (
        <>
          <div className="gc-log" ref={logRef} aria-live="polite">
            {msgs.map((m, i) => (
              <motion.p key={m.id} className={m.from === 'gin' ? 'gc-msg gc-gin' : 'gc-msg gc-you'} data-name={m.from === 'gin' && msgs[i - 1]?.from !== 'gin' ? '銀ちゃん' : undefined}
                initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
                {m.text}
              </motion.p>
            ))}
            {typing && <p className="gc-msg gc-gin gc-typing" aria-label="銀ちゃんが考えています"><i /><i /><i /></p>}
            {chips.length > 0 && (
              <motion.div className="gc-chips" initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, delay: 0.06 }}>
                {chips.map(c => (
                  <button key={c.label} type="button" className={c.strong ? 'gc-chip gc-chip-strong' : 'gc-chip'} onClick={c.act}>
                    {c.label}{c.sub && <small>{c.sub}</small>}
                  </button>
                ))}
              </motion.div>
            )}
            {done && (
              <motion.div className="gc-done" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
                <div className="gc-lens gc-summary">
                  {mine && <p><span>ご本人</span><b>{mine.menu.name}{mine.maint ? '・メンテナンス' : ''}</b></p>}
                  {mates.map(m => <p key={m.name}><span>{honor(m.name)}</span><b>{m.menu.name}{m.maint ? '・メンテナンス' : ''}</b></p>)}
                </div>
                <button type="button" className="gc-home" onClick={onClose}>ホームへ</button>
                {mates.length < MAX_COMPANIONS && <button type="button" className="gc-quiet" onClick={() => { setDone(false); you('もう1人登録する'); gin('お名前は？お店で呼ぶ名前でええよ。', [], { k: 'mateName' }) }}>もう1人登録する</button>}
              </motion.div>
            )}
          </div>
          {!done && (
            <form className={ask.k === 'none' ? 'gc-lens gc-composer gc-composer-off' : 'gc-lens gc-composer'} onSubmit={e => { e.preventDefault(); send() }}>
              <input ref={inputRef} value={text} onChange={e => setText(e.target.value)} placeholder={placeholder || '銀ちゃんが話しよるよ…'}
                disabled={ask.k === 'none'} maxLength={ask.k === 'mateName' ? 20 : 60} enterKeyHint="send" autoComplete="off" aria-label="銀ちゃんへの返事" />
              <button type="submit" className="gc-send" disabled={!text.trim() || ask.k === 'none'} aria-label="送る"><ArrowUp size={18} strokeWidth={2.4} /></button>
            </form>
          )}
        </>
      )}

      {/* 自分で選ぶ：メニューの一覧（下からのガラスの板） */}
      <AnimatePresence>
        {list && (
          <>
            <motion.div key="back" className="gc-sheet-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { setList(null); if (mode === 'chat' && msgs.length === 0) askMenu({ kind: 'me' }) }} />
            <motion.div key="sheet" className="gc-sheet" role="dialog" aria-label="メニューを選ぶ"
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}>
              <div className="gc-grab" />
              <p className="gc-sheet-title">{list.who.kind === 'mate' ? `${honor(list.who.name)}のメニュー` : 'メニューを選ぶ'}</p>
              <div className="gc-menu">
                {shown === null && <p className="gc-note">読み込んどるよ…</p>}
                {shown?.map(m => (
                  <button key={m.code} type="button" onClick={() => pickFromList(m)}>
                    <span>{m.name}</span><small>{yen(m.price)}</small><ChevronRight size={16} aria-hidden="true" />
                  </button>
                ))}
                {menus && shown && shown.length < menus.length && <button type="button" className="gc-more" onClick={() => setShowAll(true)}>ほかのメニューを見る（{menus.length - shown.length}）</button>}
              </div>
              <a className="gc-quiet gc-sheet-link" href={HOTPEPPER_MENU_URL} target="_blank" rel="noopener noreferrer">HOT PEPPER Beauty で写真を見る</a>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
