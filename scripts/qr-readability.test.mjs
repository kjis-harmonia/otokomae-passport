import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
import {Resvg} from '../.qa/qr/node_modules/@resvg/resvg-js/index.js'
import jsQR from '../.qa/qr/node_modules/jsqr/dist/jsQR.js'
const require=createRequire(import.meta.url)
const root=new URL('../',import.meta.url)
function load(file,mocks={}){
  const exports={}
  const js=ts.transpileModule(readFileSync(new URL(file,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  runInNewContext(js,{exports,require:id=>id in mocks?mocks[id]:require(id)},{filename:file})
  return exports
}
const qr=load('src/components/ReadableQr.tsx')
const memberId='u-qr-test-0123456789abcdefghijklmnopqrstuvwxyz'
const memberName='銀二郎のお客様・検証 太郎'
const passport=load('src/components/PassportCard.tsx',{
  './ReadableQr':qr,'../utils/userId':{getUserId:()=>memberId},
  '../utils/storage':{loadMemberStatus:()=>({memberName}),ONBOARDING_NAME_KEY:'name',getStoredValue:()=>memberName},
  '../utils/customerStore':{},
  '../utils/currentReservation':{CURRENT_RESERVATION_CHANGED_EVENT:'test',loadCurrentReservation:()=>null,toCurrentReservationQrPayload:()=>undefined},
})
const svgOf=html=>{
  const svg=html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0]
  return svg?.includes('xmlns=') ? svg : svg?.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
}
const html=renderToStaticMarkup(React.createElement(passport.PassportCard))
const actualSvg=svgOf(html)
assert.ok(actualSvg)
const rendered=new Resvg(actualSvg).render()
const decoded=jsQR(new Uint8ClampedArray(rendered.pixels),rendered.width,rendered.height,{inversionAttempts:'dontInvert'})
assert.deepEqual(JSON.parse(decoded.data),{type:'ginjiro-member',userId:memberId,name:memberName})
const cases=[
  ['member',decoded.data],
  ['member-with-reservation',JSON.stringify({type:'ginjiro-member',userId:memberId,name:'髪'.repeat(40),reservation:{i:'cut-teitei-special',d:'2026-10-17'}})],
  ['ticket',JSON.stringify({type:'ginjiro-ticket-use',userId:memberId,selectedTicketId:'11111111-1111-4111-8111-111111111111',issuedAt:'2026-10-16T13:00:00.000Z',expiresAt:'2026-10-16T13:30:00.000Z'})],
  ['maintenance',JSON.stringify({type:'ginjiro-maintenance-coupon',v:2,token:'22222222-2222-4222-8222-222222222222'})],
]
let count=1
function blur(pixels,width,height){
  const out=new Uint8ClampedArray(pixels)
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=pixels[((y+dy)*width+x+dx)*4]
    const index=(y*width+x)*4;out[index]=out[index+1]=out[index+2]=Math.round(sum/9);out[index+3]=255
  }
  return out
}
const results=[]
for(const [name,value]of cases){
  const svg=svgOf(renderToStaticMarkup(React.createElement(qr.ReadableQr,{value})))
  const view=Number(svg.match(/viewBox="0 0 (\d+)/)?.[1])
  for(const width of [300,260,240]){
    const image=new Resvg(svg,{fitTo:{mode:'width',value:width}}).render()
    for(const blurred of [false,true]){
      const pixels=blurred?blur(image.pixels,image.width,image.height):new Uint8ClampedArray(image.pixels)
      const result=jsQR(pixels,image.width,image.height,{inversionAttempts:'dontInvert'})
      assert.equal(result?.data,value,`${name} ${width}px blurred=${blurred}`)
      count++
    }
  }
  results.push({name,modulesIncludingMargin:view,pixelsPerModuleAt300:Number((300/view).toFixed(2))})
}
mkdirSync(new URL('../.qa/qr/',import.meta.url),{recursive:true})
writeFileSync(new URL('../.qa/qr/member-readable.png',import.meta.url),rendered.asPng())
console.log(JSON.stringify({passed:count,cases:results,method:'Actual React QR -> SVG -> RGBA -> jsQR; 300/260/240px, with and without 3x3 blur',hardwareCameraTested:false,networkRequests:0},null,2))
