/**
 * SALON BOARD（HOT PEPPER Beauty）の予約メールを、Gmail から銀二郎 SB の予約表へ送る Google Apps Script。
 *
 * 使い方（予約メールが届く Google アカウントで 1 回だけ）：
 *   1. https://script.google.com で「新しいプロジェクト」を作り、このファイルの中身を貼る
 *   2. 下の 3 つの値を入れる（IMPORT_KEY は本部が DB に登録した合言葉）
 *   3. 関数「setup」を選んで実行 → Google の許可画面で許可する
 *   これで 1 分ごとに新しい予約メールを探して送る。同じメールを二度送っても予約表には一度しか入らない。
 */
const SUPABASE_URL = 'https://<project-ref>.supabase.co'
const ANON_KEY = '<anon key>'
const IMPORT_KEY = '<合言葉>'

const SEARCH = '"SALON BOARD" 予約番号 newer_than:3d'
const DONE_KEY = 'done_message_ids'

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))
  ScriptApp.newTrigger('importSalonBoardMails').timeBased().everyMinutes(1).create()
  importSalonBoardMails()
}

function importSalonBoardMails() {
  const props = PropertiesService.getScriptProperties()
  const done = JSON.parse(props.getProperty(DONE_KEY) || '[]')
  const messages = GmailApp.search(SEARCH, 0, 50)
    .flatMap(thread => thread.getMessages())
    .filter(m => done.indexOf(m.getId()) < 0 && /SALON BOARD/.test(m.getPlainBody()) && /予約番号/.test(m.getPlainBody()))
    .sort((a, b) => a.getDate() - b.getDate())
  for (const m of messages) {
    const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/hpb_ingest_mail', {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY },
      payload: JSON.stringify({ p_key: IMPORT_KEY, p_text: m.getSubject() + '\n' + m.getPlainBody() }),
      muteHttpExceptions: true,
    })
    const body = res.getContentText()
    if (res.getResponseCode() !== 200 || /unauthorized/.test(body)) {
      console.warn('送れませんでした（次の回にもう一度送ります）', res.getResponseCode(), body)
      break
    }
    done.push(m.getId())
  }
  props.setProperty(DONE_KEY, JSON.stringify(done.slice(-500)))
}
