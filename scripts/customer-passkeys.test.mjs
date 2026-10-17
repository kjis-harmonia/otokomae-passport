// Node 24+. Real WebAuthn verification, disposable software credential, no network.
import assert from 'node:assert/strict'
import * as webauthn from '@simplewebauthn/server'
import {softwareAuthenticator} from './test-helpers/software-authenticator.mjs'
import {createPasskeyHandler} from '../supabase/functions/customer-passkeys/bridge.ts'
const rpID='localhost',origin='http://localhost:5296',auth=softwareAuthenticator(rpID,origin),checks=[]
const options=await webauthn.generateRegistrationOptions({rpName:'Local fixture',rpID,userID:new TextEncoder().encode('local-test-handle'),userName:'Local fixture',attestationType:'none',supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:'required',userVerification:'required'}})
const registration=auth.register(options)
const registered=await webauthn.verifyRegistrationResponse({response:registration,expectedChallenge:options.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true})
assert.equal(registered.verified,true);checks.push('real registration attestation is verified')
const credential=registered.registrationInfo.credential
for(const [name,changes] of [['wrong registration origin',{origin:'https://other.example'}],['wrong registration RP ID',{rpID:'other.example'}],['missing registration user verification',{flags:0x41}]]){
  await assert.rejects(()=>webauthn.verifyRegistrationResponse({response:auth.register(options,changes),expectedChallenge:options.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true}));checks.push('rejects '+name)
}
const request=await webauthn.generateAuthenticationOptions({rpID,userVerification:'required'})
const assertion=auth.authenticate(request)
const verified=await webauthn.verifyAuthenticationResponse({response:assertion,expectedChallenge:request.challenge,expectedOrigin:origin,expectedRPID:rpID,credential,requireUserVerification:true})
assert.equal(verified.verified,true);checks.push('real authentication signature is verified')
for(const [name,changes] of [['tampered signature',{badSignature:true}],['wrong origin',{origin:'https://other.example'}],['wrong RP ID',{rpID:'other.example'}],['missing user verification',{flags:1}],['wrong challenge',{challenge:'another-challenge'}]]){
  let accepted=false
  try{accepted=(await webauthn.verifyAuthenticationResponse({response:auth.authenticate(request,changes),expectedChallenge:request.challenge,expectedOrigin:origin,expectedRPID:rpID,credential,requireUserVerification:true})).verified}catch{}
  assert.equal(accepted,false);checks.push('rejects '+name)
}
await assert.rejects(()=>webauthn.verifyAuthenticationResponse({response:assertion,expectedChallenge:request.challenge,expectedOrigin:origin,expectedRPID:rpID,credential:{...credential,counter:1},requireUserVerification:true}));checks.push('rejects signature counter reuse')
let databaseCalls=0
const fakeFetch=async()=>{databaseCalls++;throw Error('Unexpected service call')}
const config={base:'https://kfufxzmucjljjouzpumi.supabase.co',serviceKey:'local-only-test',origin,rpID}
const foreign=await createPasskeyHandler(config,webauthn,fakeFetch)(new Request(origin,{method:'POST',headers:{origin:'https://other.example'},body:'{}'}))
assert.equal(foreign.status,403);assert.equal(databaseCalls,0);checks.push('foreign origins fail before database access')
const otherProject=await createPasskeyHandler({...config,base:'https://other-project.supabase.co'},webauthn,fakeFetch)(new Request(origin,{method:'POST',headers:{origin},body:'{}'}))
assert.equal(otherProject.status,503);assert.equal(databaseCalls,0);checks.push('all non-Staging projects are refused before database access')
console.log(JSON.stringify({passed:checks.length,checks,externalNetworkCalls:0},null,2))
