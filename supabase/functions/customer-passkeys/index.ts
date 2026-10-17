import {generateRegistrationOptions,generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse} from 'npm:@simplewebauthn/server@13.3.3'
import {createPasskeyHandler,type WebAuthnServer} from './bridge.ts'
Deno.serve(createPasskeyHandler({
  base:Deno.env.get('SUPABASE_URL')??'',serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',
  origin:'https://otokomae-passport-staging.vercel.app',rpID:'otokomae-passport-staging.vercel.app',
},{generateRegistrationOptions,generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse} as WebAuthnServer))
