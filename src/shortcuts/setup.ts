import './setup.css'
import {getCustomerSession} from '../utils/customerSession'
import {supabase} from '../lib/supabase'

const ENDPOINT='https://kfufxzmucjljjouzpumi.supabase.co/functions/v1/customer-shortcuts'
const root=document.querySelector<HTMLElement>('#shortcuts-root')!
root.innerHTML=`
  <a href="/?tab=mypage">銀二郎appへ戻る</a>
  <header><p class="steps-label">IPHONE・STAGING</p><h1>ホーム画面から銀二郎</h1><p class="muted">メンテナンスを確認する。Johnnyに予約を頼む。<br>次からは、ショートカットを押すだけ。</p></header>
  <div id="preview" aria-label="ショートカットの使い方"><span class="muted">ホーム画面に置く2つの入口</span><strong>メンテナンス確認</strong><span>優待の残り日数と次の予約を読み上げます。</span><hr><strong>Johnnyで予約</strong><span>声で希望を伝え、内容を確認して予約します。</span></div>
  <section><h2>1. このiPhoneを連携する</h2><p>初回だけ、銀二郎appの会員情報とつなぎます。連携は30日間有効です。</p><button id="pair" class="primary">連携キーを発行</button><button id="revoke">すべての連携を解除</button><p id="feedback" role="status" aria-live="polite"></p>
    <div id="paired" hidden><p>発行したキーを、2つのショートカットの「テキスト」に設定してください。</p><code id="token" class="pair-key"></code><button id="copy-key">キーをコピー</button><p class="muted">キーはこの画面を閉じるまで表示します。キー入りのショートカットは他の人と共有しないでください。</p></div>
  </section>
  <section><h2>2. 「メンテナンス確認」を作る</h2><p>iPhoneの「ショートカット」で新規作成し、次の4つを並べます。</p><ol>
    <li><b>テキスト</b>：上で発行した連携キーを貼り付ける。</li>
    <li><b>URLの内容を取得</b>：下のURL、メソッドはPOST。本文はJSONにして、<code>action</code> は <code>status</code>、<code>token</code> は1のテキストを指定。</li>
    <li><b>辞書の値を取得</b>：応答から <code>say</code> を取得。</li>
    <li><b>テキストを読み上げる</b>：3の値を指定。名前を「メンテナンス確認」にする。</li>
  </ol><pre>${ENDPOINT}</pre><button id="copy-url">URLをコピー</button></section>
  <section><h2>3. 「Johnnyで予約」を作る</h2><p>会話中は <code>state</code> を次のリクエストに渡します。確定は専用のメニューで行います。</p>
  <ol><li><b>テキスト</b>に連携キーを設定し、変数「連携キー」に保存。「会話」は空のテキストで初期化。</li>
  <li><b>繰り返す</b>を10回に設定。繰り返しの中で<b>テキストを音声入力</b>（日本語）を追加。</li>
  <li><b>URLの内容を取得</b>：上と同じURLへPOST。JSON本文：<code>action</code>＝<code>talk</code>、<code>token</code>＝連携キー、<code>message</code>＝音声入力、<code>state</code>＝会話。</li>
  <li>応答の <code>say</code> を<b>読み上げ</b>、応答の <code>state</code> を変数「会話」に保存。</li>
  <li><code>kind</code> が <code>confirm</code> なら<b>メニューから選択</b>を表示：「この内容で予約する」「話し直す」「終了」。</li>
  <li>「この内容で予約する」では、同じURLへPOST。<code>action</code>＝<code>confirm</code>、<code>token</code>＝連携キー、<code>state</code>＝会話。応答の <code>say</code> を読み上げ、<b>このショートカットを停止</b>。</li>
  <li>「話し直す」は次の繰り返しへ。「終了」、または応答の <code>kind</code> が <code>error</code>・<code>handoff</code> なら<b>停止</b>。名前を「Johnnyで予約」にする。</li></ol>
  <p class="muted">「はい」と話すだけでは確定しません。確認に表示された内容で「この内容で予約する」を選ぶと確定します。仮確保の期限が切れたら、日時を伝え直してください。</p></section>
  <section><h2>4. ホーム画面に置く</h2><p>ホーム画面を長押し → ウィジェットを追加 → ショートカット。作った2つを選びます。「Siri、Johnnyで予約」からも起動できます。</p><p class="muted">これはショートカットを起動するウィジェットです。残り日数の常時表示は、今後の専用iPhoneアプリで対応します。操作によってはショートカットアプリが開きます。</p></section>
`
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T
const feedback=(say:string,error=false)=>{$('feedback').textContent=say;$('feedback').classList.toggle('error',error)}
let token=''
let busy=false
const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);feedback('コピーしました。')}catch{feedback('コピーできませんでした。テキストを長押ししてコピーしてください。',true)}}
$('copy-key').onclick=()=>{void copy(token)}
$('copy-url').onclick=()=>{void copy(ENDPOINT)}
const staging=import.meta.env.VITE_SUPABASE_URL==='https://kfufxzmucjljjouzpumi.supabase.co'
if(!staging){$('pair').setAttribute('disabled','');$('revoke').setAttribute('disabled','');feedback('この機能はStagingで準備中です。',true)}
else if(!getCustomerSession())feedback('銀二郎appのマイページから開いてください。初回は会員情報の登録・引き継ぎが必要です。',true)
async function run(action:'pair'|'revoke'){
  if(busy||!staging)return
  const session=getCustomerSession()
  if(!session){feedback('銀二郎appのマイページで会員情報を確認してから、もう一度開いてください。',true);return}
  busy=true;$<HTMLButtonElement>('pair').disabled=true;$<HTMLButtonElement>('revoke').disabled=true
  feedback(action==='pair'?'連携しています…':'連携を解除しています…')
  try{
    if(action==='revoke'){
      const {data,error}=await supabase.rpc('customer_revoke_shortcut_devices',{p_session:session})
      if(error||data?.error)throw Error('連携を解除できませんでした。通信環境を確認してお試しください。')
      token='';$('token').textContent='';$('paired').hidden=true;feedback('すべてのショートカット連携を解除しました。');return
    }
    const r=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'pair',session}),signal:AbortSignal.timeout(20000)})
    const data=await r.json()
    if(!r.ok||data.kind!=='paired'||!/^gjsc_[A-Za-z0-9_-]{43}$/.test(data.token))throw Error(typeof data.say==='string'?data.say:'連携できませんでした。')
    token=data.token;$('token').textContent=token;$('paired').hidden=false;feedback('連携しました。キーをコピーして次へ進んでください。')
  }catch(e){feedback(e instanceof Error?e.message:'通信できませんでした。',true)}
  finally{busy=false;$<HTMLButtonElement>('pair').disabled=false;$<HTMLButtonElement>('revoke').disabled=false}
}
$('pair').onclick=()=>{void run('pair')}
$('revoke').onclick=()=>{void run('revoke')}
