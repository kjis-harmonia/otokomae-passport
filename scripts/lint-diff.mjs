import {ESLint} from 'eslint'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
const eslint=new ESLint(),root=process.cwd()
const files=['src/App.tsx','src/components/FreshnessWidget.tsx','src/screens/AdminScreen.tsx','src/screens/TicketWalletScreen.tsx']
let newIssues=0
for(const file of files){
  const before=execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'show','HEAD:'+file],{encoding:'utf8'})
  const after=readFileSync(file,'utf8')
  const [baseline,current]=await Promise.all([eslint.lintText(before,{filePath:file}),eslint.lintText(after,{filePath:file})])
  const key=m=>m.ruleId+' '+m.message.split('\n')[0].split('\n')[0]
  const counts=new Map()
  for(const message of baseline[0].messages)counts.set(key(message),(counts.get(key(message))??0)+1)
  const added=[]
  for(const message of current[0].messages){const k=key(message);if((counts.get(k)??0)>0)counts.set(k,counts.get(k)-1);else added.push(message)}
  newIssues+=added.length
  console.log(JSON.stringify({file,baseline:baseline[0].messages.length,current:current[0].messages.length,newIssues:added.map(m=>({rule:m.ruleId,line:m.line,message:m.message.slice(0,140)}))}))
}
if(newIssues)process.exitCode=1
