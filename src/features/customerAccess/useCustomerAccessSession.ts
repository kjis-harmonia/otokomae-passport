import {useSyncExternalStore} from 'react'
import {getCustomerSession} from '../../utils/customerSession'
function subscribe(listener:()=>void){
  for(const name of ['ginjiro:customer-session-changed','ginjiro:customer-auth-required','storage'])window.addEventListener(name,listener)
  return()=>{for(const name of ['ginjiro:customer-session-changed','ginjiro:customer-auth-required','storage'])window.removeEventListener(name,listener)}
}
export function useCustomerAccessSession(){return useSyncExternalStore(subscribe,getCustomerSession,()=>null)}
