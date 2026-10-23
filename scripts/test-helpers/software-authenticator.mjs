import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto'
// Disposable test authenticator. No real account, biometric, or external service.
const b64=value=>Buffer.from(value).toString('base64url')
const hash=value=>createHash('sha256').update(value).digest()
function cbor(value){
  const head=(major,length)=>length<24?Buffer.from([(major<<5)|length]):length<256?Buffer.from([(major<<5)|24,length]):Buffer.from([(major<<5)|25,length>>8,length&255])
  if(typeof value==='number')return value>=0?head(0,value):head(1,-1-value)
  if(typeof value==='string'){const v=Buffer.from(value);return Buffer.concat([head(3,v.length),v])}
  if(value instanceof Uint8Array)return Buffer.concat([head(2,value.length),value])
  if(value instanceof Map)return Buffer.concat([head(5,value.size),...[...value.entries()].flatMap(([key,v])=>[cbor(key),cbor(v)])])
  throw Error('Unsupported test CBOR value')
}
export function softwareAuthenticator(rpID,origin){
  let userHandle='',counter=0
  const credentialId=randomBytes(32),key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=key.publicKey.export({format:'jwk'})
  const cose=cbor(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]))
  function client(type,challenge,overrideOrigin=origin){return Buffer.from(JSON.stringify({type,challenge,origin:overrideOrigin,crossOrigin:false}))}
  return {
    id:b64(credentialId),
    register(options,changes={}){
      userHandle=options.user.id
      const length=Buffer.alloc(2);length.writeUInt16BE(credentialId.length)
      const authData=Buffer.concat([hash(changes.rpID??rpID),Buffer.from([changes.flags??0x45]),Buffer.alloc(4),Buffer.alloc(16),length,credentialId,cose])
      const attestation=cbor(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))
      return {id:b64(credentialId),rawId:b64(credentialId),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{credProps:{rk:true}},response:{clientDataJSON:b64(client('webauthn.create',changes.challenge??options.challenge,changes.origin)),attestationObject:b64(attestation),transports:['internal']}}
    },
    authenticate(options,changes={}){
      counter=changes.counter??counter+1
      const bytes=Buffer.alloc(4);bytes.writeUInt32BE(counter)
      const authData=Buffer.concat([hash(changes.rpID??rpID),Buffer.from([changes.flags??0x05]),bytes])
      const clientData=client('webauthn.get',changes.challenge??options.challenge,changes.origin)
      const signature=sign('sha256',Buffer.concat([authData,hash(clientData)]),key.privateKey)
      if(changes.badSignature)signature[signature.length-1]^=1
      return {id:changes.id??b64(credentialId),rawId:changes.id??b64(credentialId),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:b64(clientData),authenticatorData:b64(authData),signature:b64(signature),userHandle:changes.userHandle??userHandle}}
    },
  }
}
