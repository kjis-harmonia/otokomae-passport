import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {useCustomerAccessSession} from './useCustomerAccessSession'
import {enrollPasskey,loginPasskey,passkeyMessage,passkeyStatus,resumeSavedMember,revokePasskeys,ONE_TAP_STAGING,supportsPasskeys,type PasskeyStatus} from './passkeys'
import './customerAccess.css'

export function PasskeyLoginButton({onSignedIn,label='Face IDなどでログイン',disabled=false,onBusyChange}:{onSignedIn?:()=>void;label?:string;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  if(!ONE_TAP_STAGING)return null
  return <div className="customer-access">
    <button type="button" className="access-primary" disabled={busy||disabled} onClick={()=>{
      if(busy||disabled)return
      setBusy(true);onBusyChange?.(true);setError('')
      void loginPasskey().then(()=>{if(onSignedIn)onSignedIn();else window.location.reload()}).catch(e=>setError(passkeyMessage(e))).finally(()=>{setBusy(false);onBusyChange?.(false)})
    }}>{busy?'本人確認しています…':label}</button>
    <p className="access-hint">設定済みの方専用です。初回はホーム画面の銀二郎appで「Face IDなどを設定」を押してください。</p>
    {error&&<p role="alert" className="access-error">{error}</p>}
  </div>
}
export function SavedMemberButton({onSignedIn}:{onSignedIn:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const session=useCustomerAccessSession()
  if(!session)return null
  return <div className="customer-access"><button type="button" className="access-primary" disabled={busy} onClick={()=>{
    setBusy(true);setError('');void resumeSavedMember().then(onSignedIn).catch(e=>setError(passkeyMessage(e))).finally(()=>setBusy(false))
  }}>{busy?'会員情報を確認しています…':'保存済みの会員情報で続ける'}</button>{error&&<p role="alert" className="access-error">{error}</p>}</div>
}
export function CustomerAccessSettings({onRecovered}:{onRecovered?:()=>void}){
  const session=useCustomerAccessSession()
  const [loaded,setLoaded]=useState<{session:string;status:PasskeyStatus}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[confirmRevoke,setConfirmRevoke]=useState(false)
  const status=loaded?.session===session?loaded.status:null
  useEffect(()=>{
    if(!ONE_TAP_STAGING||!session)return
    let alive=true
    void passkeyStatus().then(value=>{if(alive){setLoaded({session,status:value});setError('')}}).catch(e=>{if(alive)setError(passkeyMessage(e))})
    return()=>{alive=false}
  },[session])
  if(!ONE_TAP_STAGING)return null
  const register=async()=>{
    if(busy)return
    setBusy(true);setError('');setMessage('')
    try{await enrollPasskey();if(session)setLoaded({session,status:await passkeyStatus()});setMessage('設定しました。次回から入力せずにログインできます。')}
    catch(e){setError(passkeyMessage(e))}
    finally{setBusy(false)}
  }
  return <section className="customer-access access-settings" aria-label="かんたんログイン">
    <h2>かんたんログイン</h2>
    {!session?<><p>登録済みの会員情報を、この端末で使います。</p><PasskeyLoginButton onSignedIn={onRecovered}/></>:
      status?.registered?<><p>設定済み。Face IDなどで会員情報を引き継げます。</p>{!confirmRevoke?<button className="access-text" type="button" onClick={()=>setConfirmRevoke(true)}>設定を解除する</button>:<><p>すべての端末からログアウトします。もう一度本人確認して解除します。</p><div className="access-actions"><button type="button" className="access-secondary" disabled={busy} onClick={()=>setConfirmRevoke(false)}>戻る</button><button type="button" className="access-secondary" disabled={busy} onClick={()=>{setBusy(true);setError('');void revokePasskeys().then(()=>window.location.reload()).catch(e=>setError(passkeyMessage(e))).finally(()=>setBusy(false))}}>{busy?'本人確認しています…':'本人確認して解除'}</button></div></>}</>:
      <><p>機種変更やログイン切れでも、店頭でのコード発行が不要になります。</p><button type="button" className="access-primary" disabled={busy||!status||!supportsPasskeys()} onClick={()=>void register()}>{busy?'設定しています…':'Face IDなどを設定'}</button><p className="access-hint">初回だけ、Face ID・指紋認証などで確認します。</p>{!supportsPasskeys()&&<p className="access-hint">この端末ではパスキーを設定できません。今の会員情報で引き続き使えます。</p>}</>}
    {message&&<p role="status">{message}</p>}{error&&<p role="alert" className="access-error">{error}</p>}
  </section>
}
export function PasskeyEnrollmentOffer({onClose}:{onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{const element=dialog.current;if(!element)return;element.showModal();return()=>element.close()},[])
  return createPortal(<dialog ref={dialog} className="customer-access access-offer" aria-labelledby="passkey-offer-title" onCancel={event=>{event.preventDefault();if(!busy)onClose()}}>
    <h2 id="passkey-offer-title">Face IDでかんたんログイン</h2><p>Face IDなどを設定すると、会員情報を自分で引き継げます。</p>
    <button type="button" className="access-primary" disabled={busy} onClick={()=>{setBusy(true);setError('');void enrollPasskey().then(onClose).catch(e=>setError(passkeyMessage(e))).finally(()=>setBusy(false))}}>{busy?'設定しています…':'Face IDなどを設定'}</button>
    <button type="button" className="access-text" disabled={busy} onClick={onClose}>あとで</button>{error&&<p role="alert" className="access-error">{error}</p>}
  </dialog>,document.body)
}
