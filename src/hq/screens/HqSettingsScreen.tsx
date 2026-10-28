import { useEffect, useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { getBookingMasters, type BookingMasters } from '../hqBookingStore'
import { HQ_AUTH_REQUIRED_EVENT, hqLogout } from '../hqSession'
import { isHqPreview } from '../hqPreview'
import { isStaging } from '../../utils/env'
import { HqHqDevices, HqStaffDevices } from './HqStaffDevices'

export function HqSettingsScreen() {
  const [masters, setMasters] = useState<BookingMasters | null>(null)
  const [failed, setFailed] = useState(false)
  const [scale, setScale] = useState(() => { try { return localStorage.getItem('ginjiro_hq_text_scale') ?? 'standard' } catch { return 'standard' } })
  useEffect(() => {
    let alive = true
    getBookingMasters().then(data => { if (alive) setMasters(data) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])
  function changeScale(value: string) {
    setScale(value)
    document.documentElement.dataset.hqTextScale = value
    try { localStorage.setItem('ginjiro_hq_text_scale', value) } catch { /* Preference is optional. */ }
  }
  async function lock() { await hqLogout(); window.dispatchEvent(new Event(HQ_AUTH_REQUIRED_EVENT)) }
  return <div className="hq-settings-list"><section className="hq-surface"><div className="hq-surface-header"><h2>店舗と接続</h2></div><div className="hq-setting-row"><strong>店舗</strong><span className="hq-setting-value">銀二郎</span></div><div className="hq-setting-row"><strong>接続環境</strong><span className="hq-setting-value">{isHqPreview() ? '画面プレビュー（サンプル）' : isStaging() ? 'Staging' : '本番'}</span></div><div className="hq-setting-row"><div><strong>登録スタッフ</strong><p>予約設定で管理しています。</p></div><span className="hq-setting-value">{masters ? masters.staff.filter(s => s.is_active).length + ' 名' : failed ? '取得できません' : '取得中…'}</span></div><div className="hq-setting-row"><div><strong>アプリからの予約</strong><p>変更は「予約設定」から行います。</p></div><span className="hq-setting-value">{masters ? masters.settings.app_booking_enabled ? '受付中' : '停止中' : failed ? '取得できません' : '取得中…'}</span></div></section><HqStaffDevices /><HqHqDevices /><section className="hq-surface" style={{ marginTop: 20 }}><div className="hq-surface-header"><h2>この端末の表示</h2></div><div className="hq-setting-row"><div><strong>文字の大きさ</strong><p>このブラウザに保存します。</p></div><select value={scale} onChange={e => changeScale(e.target.value)} aria-label="本部の文字の大きさ"><option value="standard">標準</option><option value="large">大きめ</option></select></div></section><section className="hq-surface" style={{ marginTop: 20 }}><div className="hq-surface-header"><h2>本部セッション</h2></div><div className="hq-setting-row"><div><strong>本部をロックする</strong><p>再度開くときは本部専用PINが必要です。</p></div><button className="hq-button" disabled={isHqPreview()} onClick={() => void lock()}><LockKeyhole size={14} />ロック</button></div></section></div>
}
