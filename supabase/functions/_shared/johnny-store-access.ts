// No AI call occurs until this check completes. Missing DB support fails closed on Staging.
export async function checkJohnnyStoreAccess(base:string,anonKey:string,session:unknown,fetcher:typeof fetch=fetch):Promise<{status:number;error:string}|null>{
  if(base!=='https://kfufxzmucjljjouzpumi.supabase.co')return null // rollout is Staging-only
  if(typeof session!=='string'||session.length<32||session.length>256)return {status:401,error:'customer_auth_required'}
  try{
    const response=await fetcher(base+'/rest/v1/rpc/customer_store_access_status',{
      method:'POST',headers:{apikey:anonKey,Authorization:'Bearer '+anonKey,'Content-Type':'application/json'},
      body:JSON.stringify({p_session:session}),signal:AbortSignal.timeout(10000),
    })
    const result=await response.json()
    if(!response.ok)return result.code==='28000'?{status:401,error:'customer_auth_required'}:{status:503,error:'store_access_unavailable'}
    return result.verified===true?null:{status:403,error:'store_verification_required'}
  }catch{return {status:503,error:'store_access_unavailable'}}
}
