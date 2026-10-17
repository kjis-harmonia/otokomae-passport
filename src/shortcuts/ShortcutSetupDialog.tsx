import {useEffect,useRef} from 'react'
import {createPortal} from 'react-dom'

export function ShortcutSetupDialog({onClose}:{onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null)
  const frame=useRef<HTMLIFrameElement>(null)
  useEffect(()=>{
    const element=dialog.current
    if(!element)return
    element.showModal()
    const receive=(event:MessageEvent)=>{
      if(event.origin!==window.location.origin||event.source!==frame.current?.contentWindow)return
      if(event.data?.type==='ginjiro:shortcut-setup-close')onClose()
      if(event.data?.type==='ginjiro:shortcut-auth-changed')window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
    }
    window.addEventListener('message',receive)
    return()=>{window.removeEventListener('message',receive);element.close()}
  },[onClose])
  return createPortal(
    <dialog ref={dialog} aria-label="ホーム画面から予約・メンテナンス" onCancel={event=>{event.preventDefault();onClose()}}
      style={{margin:0,padding:0,border:0,width:'100vw',height:'100dvh',maxWidth:'none',maxHeight:'none',background:'#f7f7f5',color:'#202321'}}>
      <div style={{display:'flex',flexDirection:'column',height:'100%'}}>
        <header style={{display:'flex',alignItems:'center',gap:12,padding:'calc(8px + env(safe-area-inset-top)) 16px 8px',borderBottom:'1px solid #dadcd7',flexShrink:0}}>
          <button type="button" onClick={onClose} style={{minHeight:44,padding:'8px 12px',fontSize:16,color:'#202321',background:'transparent',border:'1px solid #c6cbc4',borderRadius:8}}>閉じる</button>
          <span style={{fontSize:15,fontWeight:600}}>ホーム画面から銀二郎</span>
        </header>
        <iframe ref={frame} src="/shortcuts.html?embedded=1" title="ショートカット連携の設定" style={{width:'100%',flex:1,border:0,minHeight:0}}/>
      </div>
    </dialog>,document.body,
  )
}
