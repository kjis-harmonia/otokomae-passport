type Json = Record<string, any>
export interface PasskeyConfig {base:string;serviceKey:string;origin:string;rpID:string}
export interface WebAuthnServer {
  generateRegistrationOptions(input:Json):Promise<Json>
  generateAuthenticationOptions(input:Json):Promise<Json>
  verifyRegistrationResponse(input:Json):Promise<Json>
  verifyAuthenticationResponse(input:Json):Promise<Json>
}
const STAGING='https://kfufxzmucjljjouzpumi.supabase.co'
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
const bytes=(value:string)=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max?value:''
export function createPasskeyHandler(config:PasskeyConfig,webauthn:WebAuthnServer,fetcher:typeof fetch=fetch){
  const cors={'Access-Control-Allow-Origin':config.origin,'Access-Control-Allow-Headers':'content-type, apikey, authorization','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'}
  const reply=(value:Json,status=200)=>Response.json(value,{status,headers:cors})
  async function rpc(action:string,input:Json){
    const response=await fetcher(config.base+'/rest/v1/rpc/customer_passkey_service',{method:'POST',headers:{'Content-Type':'application/json',apikey:config.serviceKey,Authorization:'Bearer '+config.serviceKey},body:JSON.stringify({p_action:action,p_input:input}),signal:AbortSignal.timeout(15000)})
    const value=await response.json()
    if(!response.ok)throw Error(typeof value.message==='string'?value.message:'service_unavailable')
    return value as Json
  }
  return async(request:Request):Promise<Response>=>{
    if(config.base!==STAGING||!config.serviceKey)return reply({error:'unavailable',message:'この機能はStagingで準備中です。'},503)
    if(request.headers.get('origin')!==config.origin)return reply({error:'origin_not_allowed',message:'銀二郎appから開き直してください。'},403)
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors})
    if(request.method!=='POST')return reply({error:'method_not_allowed'},405)
    try{
      const raw=await request.text()
      if(raw.length>32000)return reply({error:'invalid_request'},413)
      const body=JSON.parse(raw) as Json
      if(!body||typeof body!=='object'||Array.isArray(body))return reply({error:'invalid_request'},400)
      const address=(request.headers.get('x-forwarded-for')??'unknown').split(',')[0].trim().slice(0,128)
      const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.serviceKey),{name:'HMAC',hash:'SHA-256'},false,['sign'])
      const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('passkeys:'+address))
      const subject=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')
      if(!(await rpc('limit',{subject})).allowed)return reply({error:'rate_limited',message:'少し待ってから、もう一度お試しください。'},429)
      const session=text(body.session,256)
      if(body.action==='status')return reply(await rpc('status',{session}))
      if(body.action==='register_options'){
        const member=await rpc('register_context',{session})
        const options=await webauthn.generateRegistrationOptions({rpName:'銀二郎',rpID:config.rpID,userID:new TextEncoder().encode(member.handle),userName:member.name,userDisplayName:member.name,attestationType:'none',supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:'required',userVerification:'required',authenticatorAttachment:'platform'},timeout:60000})
        const id=crypto.randomUUID()
        await rpc('put_challenge',{id,kind:'register',challenge:options.challenge,session})
        return reply({id,options})
      }
      if(body.action==='login_options'){
        const options=await webauthn.generateAuthenticationOptions({rpID:config.rpID,userVerification:'required',timeout:60000})
        const id=crypto.randomUUID()
        await rpc('put_challenge',{id,kind:'login',challenge:options.challenge})
        return reply({id,options})
      }
      if(body.action==='register_verify'||body.action==='login_verify'){
        const id=text(body.id,36)
        if(!/^[0-9a-f-]{36}$/.test(id)||!body.response||typeof body.response!=='object')return reply({error:'invalid_request'},400)
        const kind=body.action==='register_verify'?'register':'login'
        const challenge=await rpc('consume_challenge',{id,kind,session})
        const shared={response:body.response,expectedChallenge:challenge.challenge,expectedOrigin:config.origin,expectedRPID:config.rpID,requireUserVerification:true}
        if(kind==='register'){
          const verification=await webauthn.verifyRegistrationResponse(shared)
          if(!verification.verified||!verification.registrationInfo)throw Error('passkey_auth_failed')
          const credential=verification.registrationInfo.credential
          await rpc('finish_register',{session,credential_id:credential.id,public_key:b64(credential.publicKey),counter:credential.counter,transports:credential.transports??[]})
          return reply({ok:true})
        }
        const credential=await rpc('credential',{credential_id:text(body.response.id,2048)})
        const handle=body.response.response?.userHandle
        if(handle!==b64(new TextEncoder().encode(credential.handle)))throw Error('passkey_auth_failed')
        const verification=await webauthn.verifyAuthenticationResponse({...shared,credential:{id:credential.credential_id,publicKey:bytes(credential.public_key),counter:Number(credential.counter),transports:credential.transports}})
        if(!verification.verified||!verification.authenticationInfo)throw Error('passkey_auth_failed')
        return reply(await rpc('finish_login',{credential_id:credential.credential_id,old_counter:credential.counter,new_counter:verification.authenticationInfo.newCounter}))
      }
      if(body.action==='revoke')return reply(await rpc('revoke',{session}))
      return reply({error:'invalid_request'},400)
    }catch(error){
      const message=error instanceof Error?error.message:''
      if(message.includes('already_registered'))return reply({error:'already_registered',message:'かんたんログインは設定済みです。'},409)
      if(message.includes('customer_auth_required'))return reply({error:'customer_auth_required',message:'会員情報でログインしてから、もう一度お試しください。'},401)
      if(message.includes('fresh_passkey_required'))return reply({error:'fresh_passkey_required',message:'解除するには、もう一度本人確認してください。'},401)
      return reply({error:'passkey_auth_failed',message:'本人確認を完了できませんでした。もう一度お試しください。'},400)
    }
  }
}
