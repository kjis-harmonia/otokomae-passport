import {generateRegistrationOptions,generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse} from 'npm:@simplewebauthn/server@13.3.3'
import {createPasskeyHandler,type WebAuthnServer} from './bridge.ts'
import {customerEnvironment} from '../_shared/customer-environment.ts'
const base=Deno.env.get('SUPABASE_URL')??''
const environment=customerEnvironment(base)
Deno.serve(createPasskeyHandler({
  base,serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',
  origin:environment?.origin??'',rpID:environment?.rpID??'',
  productionEnabled:Deno.env.get('CUSTOMER_ACCESS_ENABLED')==='true',
},{generateRegistrationOptions,generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse} as WebAuthnServer))
