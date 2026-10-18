import {useEffect,useState} from 'react'
import {callRpc,callStaffRpc,RpcError} from '../../utils/staffSession'
import {clearCustomerSession,getCustomerSession} from '../../utils/customerSession'
import {getUserId} from '../../utils/userId'
import {adoptMember,ONE_TAP_STAGING} from './passkeys'
import {useCustomerAccessSession} from './useCustomerAccessSession'

export type StoreAccessMode='checking'|'verified'|'unverified'|'unauthenticated'|'error'
export function useStoreAccess(){
  const session=useCustomerAccessSession()
  const [result,setResult]=useState<{session:string;verified:boolean;failed:boolean}|null>(null)
  const [tick,setTick]=useState(0)
  useEffect(()=>{
    if(!ONE_TAP_STAGING||!session)return
    let alive=true
    const refresh=()=>{void callRpc<{verified:boolean}>('customer_store_access_status',{p_session:session}).then(r=>{if(alive)setResult({session,verified:r.verified===true,failed:false})}).catch(error=>{if(import.meta.env.DEV)console.warn('store_status_failed',error instanceof RpcError?error.code:'unexpected');if(!alive)return;if(error instanceof Error&&error.message.includes('customer_auth_required')&&getCustomerSession()===session){clearCustomerSession();window.dispatchEvent(new Event('ginjiro:customer-session-changed'))}else setResult({session,verified:false,failed:true})})}
    refresh();window.addEventListener('focus',refresh)
    return()=>{alive=false;window.removeEventListener('focus',refresh)}
  },[session,tick])
  const mode:StoreAccessMode=!ONE_TAP_STAGING?'verified':!session?'unauthenticated':result?.session!==session?'checking':result.failed?'error':result.verified?'verified':'unverified'
  return {mode,refresh:()=>setTick(n=>n+1)}
}
interface StoreRequest {id:string;proof:string;user_id:string;expires_in:number}
export function useStoreRequest(enabled:boolean){
  const session=useCustomerAccessSession(),userId=getUserId()
  const [request,setRequest]=useState<StoreRequest|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0)
  useEffect(()=>{
    if(!ONE_TAP_STAGING||!enabled)return
    let alive=true,checking=false,expires=0
    const expectedSession=session
    let pending:StoreRequest|null=null
    async function poll(){
      if(!alive||checking||!pending)return
      if(Date.now()>=expires){setError('確認用QRの期限が切れました。更新して読み取ってもらってください。');return}
      checking=true
      try{
        const member=await callRpc<{pending?:boolean;user_id:string;name:string;session:string}>('customer_store_access_claim',{p_request_id:pending.id,p_proof:pending.proof})
        if(!alive)return
        if(member.pending){setError('');return}
        if(member.user_id!==pending.user_id)throw Error('wrong_member')
        if(getCustomerSession()!==expectedSession){alive=false;return}
        adoptMember(member);alive=false
        window.dispatchEvent(new Event('ginjiro:store-verified'))
      }catch(error){if(import.meta.env.DEV)console.warn('store_claim_failed',error instanceof RpcError?error.code:'unexpected');if(alive)setError('確認できませんでした。QRを更新して、もう一度お試しください。')}
      finally{checking=false}
    }
    void callRpc<StoreRequest>('customer_store_access_start',{p_user_id:userId,p_session:session}).then(r=>{
      if(!alive)return
      if(typeof r.id!=='string'||typeof r.proof!=='string'||r.user_id!==userId)throw Error('invalid_request')
      pending=r;expires=Date.now()+r.expires_in*1000;setRequest(r);setError('');void poll()
    }).catch(()=>{if(alive)setError('確認用QRを準備できませんでした。通信を確認して更新してください。')})
    const timer=window.setInterval(()=>void poll(),2500)
    const visible=()=>{if(!document.hidden)void poll()}
    document.addEventListener('visibilitychange',visible)
    return()=>{alive=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible)}
  },[enabled,userId,session,tick])
  return {request:enabled?request:null,error,refresh:()=>{setRequest(null);setError('');setTick(n=>n+1)}}
}
export function approveStoreAccess(requestId:string,userId:string,staffName:string){
  return callStaffRpc<{ok:boolean}>('staff_approve_store_access',{p_request_id:requestId,p_user_id:userId,p_staff_name:staffName})
}
