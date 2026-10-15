import { useEffect, useRef, useState } from 'react'
import { ArrowUpLeft, Search, X } from 'lucide-react'
import { HQ_TABS, type HqTab } from '../hqMockData'

export function HqCommandMenu({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (tab: HqTab) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const results = HQ_TABS.filter(tab => `${tab.label} ${tab.code}`.toLowerCase().includes(query.toLowerCase().trim()))
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  const choose = (tab: HqTab) => { onNavigate(tab); onClose(); setQuery('') }
  return <dialog ref={dialog} className="hq-command-dialog" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="hq-command-search"><Search size={20} /><input aria-label="本部のページを検索" placeholder="どのページを開きますか？" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && results[0]) choose(results[0].id) }} /><button className="hq-icon-button" onClick={onClose} aria-label="検索を閉じる"><X size={18} /></button></div>
    <div className="hq-command-results">{results.length ? results.map(tab => <button key={tab.id} onClick={() => choose(tab.id)}><span>{tab.label}</span><ArrowUpLeft size={15} /></button>) : <p>一致するページがありません。</p>}</div>
    <div className="hq-command-foot">Enter で先頭のページを開く<span>Esc で閉じる</span></div>
  </dialog>
}
