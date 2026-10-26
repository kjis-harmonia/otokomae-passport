import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {useCustomerAccessSession} from './useCustomerAccessSession'
import {enrollPasskey,loginPasskey,passkeyMessage,passkeyStatus,resumeSavedMember,revokePasskeys,CUSTOMER_ACCESS_ENABLED,supportsPasskeys,type PasskeyStatus} from './passkeys'
import './customerAccess.css'

/** quiet：小さな文字のボタンにして説明文を出さない（ほかに主な操作がある画面用） */
export function PasskeyLoginButton({onSignedIn,label='Face IDなどでログイン',disabled=false,onBusyChange,quiet=false}:{onSignedIn?:()=>void;label?:string;disabled?:boolean;onBusyChange?:(busy:boolean)=>void;quiet?:boolean}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  if(!CUSTOMER_ACCESS_ENABLED)return null
  return <div className="customer-access">
    <button type="button" className={quiet?'access-text':'access-primary'} disabled={busy||disabled} onClick={()=>{
      if(busy||disabled)return
      setBusy(true);onBusyChange?.(true);setError('')
      void loginPasskey().then(()=>{if(onSignedIn)onSignedIn();else window.location.reload()}).catch(e=>setError(passkeyMessage(e))).finally(()=>{setBusy(false);onBusyChange?.(false)})
    }}>{busy?'本人確認しています…':label}</button>
    {!quiet&&<p className="access-hint">設定済みの方はこちら。初回は、会員証が表示される銀二郎appのQRを店頭で見せてください。スタッフの本人確認後にFace IDなどを設定できます。再登録は不要です。</p>}
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
    if(!CUSTOMER_ACCESS_ENABLED||!session)return
    let alive=true
    void passkeyStatus().then(value=>{if(alive){setLoaded({session,status:value});setError('')}}).catch(e=>{if(alive)setError(passkeyMessage(e))})
    return()=>{alive=false}
  },[session])
  if(!CUSTOMER_ACCESS_ENABLED)return null
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
    <h2 id="passkey-offer-title">Face IDでかんたんログイン</h2><p>Face IDなどを設定すると、機種変更のときも会員情報を自分で引き継げます。あとからでも ☰ の「ログインと引き継ぎ」で設定できます。</p>
    <button type="button" className="access-primary" disabled={busy} onClick={()=>{setBusy(true);setError('');void enrollPasskey().then(onClose).catch(e=>setError(passkeyMessage(e))).finally(()=>setBusy(false))}}>{busy?'設定しています…':'Face IDなどを設定'}</button>
    <button type="button" className="access-text" disabled={busy} onClick={onClose}>あとで</button>{error&&<p role="alert" className="access-error">{error}</p>}
  </dialog>,document.body)
}
