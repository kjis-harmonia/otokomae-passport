import {useState} from 'react'
import {approveStoreAccess, type StoreAccessMode} from './storeAccess'
import {CUSTOMER_ACCESS_ENABLED} from './passkeys'
import './customerAccess.css'

export function StoreRequestNotice({mode,error,onRefresh}:{mode:StoreAccessMode;error:string;onRefresh:()=>void}){
  if(!CUSTOMER_ACCESS_ENABLED||mode==='verified')return null
  return <section className="customer-access access-settings" aria-label="来店時の本人確認">
    <h2>AI予約は、初回のご来店時の確認のあとに</h2>
    <p>この会員QRをスタッフに見せてください。確認が済むと、アプリからAI予約ができます。Face IDでのログインも設定できます。</p>
    {error?<><p role="alert" className="access-error">{error}</p><button type="button" className="access-secondary" onClick={onRefresh}>確認用QRを更新</button></>:<p role="status" className="access-hint">スタッフの確認を待っています。この画面のままでお待ちください。</p>}
  </section>
}

export function StaffStoreApproval({requestId,userId,memberName,staffName}:{requestId:string;userId:string;memberName:string;staffName:string}){
  const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('')
  if(!CUSTOMER_ACCESS_ENABLED)return null
  return <section className="store-staff-approval" aria-label="AI予約の初回本人確認">
    <h2>AI予約の初回本人確認</h2>
    {done?<p role="status">確認しました。お客さまの端末でFace IDなどを設定できます。</p>:<>
      <p>{memberName}様ご本人の来店を確認してから押してください。</p>
      <button type="button" disabled={busy||!staffName.trim()} onClick={()=>{
        if(busy)return
        setBusy(true);setError('')
        void approveStoreAccess(requestId,userId,staffName).then(()=>setDone(true)).catch(()=>setError('確認できませんでした。お客さまのQRを更新して読み取り直してください。')).finally(()=>setBusy(false))
      }}>{busy?'確認しています…':'本人を確認してAI予約を有効にする'}</button>
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>
}
