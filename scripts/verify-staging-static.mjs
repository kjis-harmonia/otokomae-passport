import assert from 'node:assert/strict'
const origin='https://otokomae-passport-staging.vercel.app'
const assets=new Set(),routes=[]
for(const path of ['/','/staff','/sb','/headquarters']){
  const response=await fetch(origin+path),html=await response.text()
  assert.equal(response.status,200,path)
  const scripts=[...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.js)"/g)].map(m=>m[1])
  assert.ok(scripts.length,path+' has a JS entry')
  scripts.forEach(p=>assets.add(p))
  routes.push({path,status:response.status,entries:scripts})
}
const fetched=new Map()
while(fetched.size<assets.size){
  assert.ok(assets.size<100,'bounded static asset inspection')
  const next=[...assets].filter(a=>!fetched.has(a))
  for(const path of next){
    const response=await fetch(origin+path);assert.equal(response.status,200,path)
    const source=await response.text();fetched.set(path,source)
    for(const m of source.matchAll(/["']((?:\.\/|\/assets\/)[a-zA-Z0-9_-]+\.js)["']/g))assets.add(new URL(m[1],origin+path).pathname)
  }
}
const all=[...fetched.values()].join('\n')
assert.ok(all.includes('kfufxzmucjljjouzpumi.supabase.co'),'Staging Supabase compiled in')
assert.ok(!all.includes('ufyzynpmkxytnhebombq'),'No production Supabase reference in fetched bundles')
assert.ok(all.includes('このQRを店舗端末にかざしてください'),'Large member QR deployed')
assert.ok(all.includes('QR全体が映るよう'),'Full-frame scanner deployed')
assert.ok(all.includes('staff_issue_tickets_once'),'Safe issuance RPC deployed')
assert.ok(all.includes('同じ発行を確認・再試行'),'Pending issuance recovery UI deployed')
console.log(JSON.stringify({routes,staticBundles:fetched.size,stagingBackend:true,productionBackendReferences:0,safeIssuanceDeployed:true,pendingRecoveryDeployed:true,dbRequests:0},null,2))
