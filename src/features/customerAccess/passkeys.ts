import {clearCustomerSession,getCustomerSession,saveCustomerSession} from '../../utils/customerSession'
import {getStoredValue,loadMemberStatus,saveMemberStatus,setStoredValue,ONBOARDING_DONE_KEY,ONBOARDING_NAME_KEY} from '../../utils/storage'
import {USER_ID_KEY} from '../../utils/userId'
import type {PublicKeyCredentialCreationOptionsJSON,PublicKeyCredentialRequestOptionsJSON} from '@simplewebauthn/browser'

import {customerAccessEnabled,customerEnvironment} from '../../../supabase/functions/_shared/customer-environment.ts'
export const CUSTOMER_ACCESS_ENABLED=customerAccessEnabled(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_CUSTOMER_ACCESS_ENABLED==='true')
const ENVIRONMENT=customerEnvironment(import.meta.env.VITE_SUPABASE_URL)
const ENDPOINT=ENVIRONMENT?ENVIRONMENT.base+'/functions/v1/customer-passkeys':''
export interface PasskeyStatus {user_id:string;name:string;registered:boolean}
interface MemberIdentity {user_id:string;name:string;session:string}
export class PasskeyError extends Error {code:string;constructor(code:string,message:string){super(message);this.code=code}}
export function supportsPasskeys(){return CUSTOMER_ACCESS_ENABLED&&window.isSecureContext&&typeof PublicKeyCredential!=='undefined'}
function requireStorage(){
  try{localStorage.setItem('ginjiro_access_probe','1');if(localStorage.getItem('ginjiro_access_probe')!=='1')throw Error();localStorage.removeItem('ginjiro_access_probe')}
  catch{throw new Error('会員情報を保存できません。通常のブラウザーで開いてください。')}
}
async function request<T>(action:string,input:Record<string,unknown>={}):Promise<T>{
  if(!CUSTOMER_ACCESS_ENABLED)throw new Error('現在この機能の準備中です。')
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),20000)
  try{
    const response=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',apikey:import.meta.env.VITE_SUPABASE_ANON_KEY??''},body:JSON.stringify({action,...input}),signal:controller.signal})
    const result=await response.json()
    if(!response.ok){
      if(result.error==='customer_auth_required'&&input.session===getCustomerSession()){clearCustomerSession();window.dispatchEvent(new Event('ginjiro:customer-session-changed'))}
      throw new PasskeyError(result.error??'unavailable',result.message??'通信できませんでした。もう一度お試しください。')
    }
    return result as T
  }finally{
    clearTimeout(timer)
  }
}
export function adoptMember(member:MemberIdentity){
  requireStorage()
  if(typeof member.user_id!=='string'||typeof member.name!=='string'||typeof member.session!=='string'||member.session.length<32)throw Error('会員情報を確認できませんでした。')
  const previous=getStoredValue<string|null>(USER_ID_KEY,null)
  // User-owned server data stays unchanged. Do not carry another member's local display cache.
  if(previous!==member.user_id){
    for(const key of ['otokomae_coupons','otokomae_gacha_date','otokomae_gacha_result','ginjiro_active_ticket','ginjiro_pending_contact','ginjiro_current_reservation','ginjiro_companion_reservations','ginjiro_member_issued_at','ginjiro_next_reservation'])localStorage.removeItem(key)
    saveMemberStatus({memberName:member.name,rank:'ブロンズ',visitCount:0,stampCount:0,exp:0,points:0})
  }else saveMemberStatus({...loadMemberStatus(),memberName:member.name})
  setStoredValue(ONBOARDING_NAME_KEY,member.name)
  setStoredValue(ONBOARDING_DONE_KEY,true)
  saveCustomerSession(member.user_id,member.session)
  if(getCustomerSession()!==member.session)throw new Error('会員情報を保存できませんでした。通常のブラウザーでお試しください。')
}
export async function passkeyStatus(){return request<PasskeyStatus>('status',{session:getCustomerSession()})}
export async function resumeSavedMember(){
  requireStorage()
  const session=getCustomerSession()
  if(!session)throw Error('このブラウザーに会員情報がありません。')
  const status=await passkeyStatus()
  if(getCustomerSession()!==session)throw new Error('会員情報が更新されました。')
  adoptMember({...status,session})
}
export async function enrollPasskey(){
  requireStorage()
  if(!supportsPasskeys())throw Error('この端末はパスキーに対応していません。今の会員情報で引き続き使えます。')
  const session=getCustomerSession()
  if(!session)throw Error('会員情報でログインしてから設定してください。')
  const {startRegistration}=await import('@simplewebauthn/browser')
  let prepared:{id:string;options:PublicKeyCredentialCreationOptionsJSON}
  try{prepared=await request('register_options',{session})}
  catch(error){if(error instanceof PasskeyError&&error.code==='already_registered')return;throw error}
  const response=await startRegistration({optionsJSON:prepared.options})
  await request('register_verify',{session,id:prepared.id,response})
}
export async function loginPasskey(){
  requireStorage()
  if(!supportsPasskeys())throw Error('この端末ではパスキーを使えません。対応するブラウザーで開いてください。')
  const {startAuthentication}=await import('@simplewebauthn/browser')
  const prepared=await request<{id:string;options:PublicKeyCredentialRequestOptionsJSON}>('login_options')
  const response=await startAuthentication({optionsJSON:prepared.options})
  adoptMember(await request<MemberIdentity>('login_verify',{id:prepared.id,response}))
}
export async function revokePasskeys(){
  // Fresh user verification is required even when an older session is still valid.
  await loginPasskey()
  await request('revoke',{session:getCustomerSession()})
  localStorage.removeItem('ginjiro_customer_session')
  setStoredValue(ONBOARDING_DONE_KEY,false)
  window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
}
export function passkeyMessage(error:unknown){
  if(error instanceof Error&&['NotAllowedError','AbortError','WebAuthnError'].includes(error.name))return '本人確認を中止しました。準備ができたら、もう一度お試しください。'
  return error instanceof Error?error.message:'通信できませんでした。もう一度お試しください。'
}
