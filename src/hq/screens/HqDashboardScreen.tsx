import { useCallback, useEffect, useRef, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HqStatTile } from '../components/HqStatTile'
import { HqStockAlertSummaryTile } from '../components/HqStockAlertPanel'
import { getHqDashboardData, subscribeHqRealtime } from '../hqDataStore'
import type { HqDashboardData, HqRealtimeStatus } from '../hqDataStore'
import { getProducts, subscribeProductsRealtime } from '../hqInventoryStore'
import type { Product } from '../hqInventoryStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: HqDashboardData }

function yen(v: number): string {
  return `¥${v.toLocaleString()}`
}

function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function LiveSyncBadge({ status, lastUpdated }: { status: HqRealtimeStatus; lastUpdated: Date | null }) {
  const live = status === 'live'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span
        aria-hidden="true"
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: live ? HQ_COLORS.positive : HQ_COLORS.textMute,
          boxShadow: live ? `0 0 6px ${HQ_COLORS.positive}` : 'none',
          animation: live ? 'hqLiveSyncPulse 1.8s ease-in-out infinite' : 'none',
        }}
      />
      <span style={{ fontFamily: HQ_MONO, fontSize: 10, letterSpacing: '0.1em', color: live ? HQ_COLORS.textSecondary : HQ_COLORS.textMute }}>
        {live ? 'LIVE SYNC' : 'LIVE SYNC待機中'}
      </span>
      {lastUpdated && (
        <span style={{ fontFamily: HQ_MONO, fontSize: 10, color: HQ_COLORS.textMute }}>
          最終更新 {fmtClock(lastUpdated)}
        </span>
      )}
      <style>{`
        @keyframes hqLiveSyncPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  )
}

export function HqDashboardScreen() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [realtimeStatus, setRealtimeStatus] = useState<HqRealtimeStatus>('connecting')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [products, setProducts] = useState<Product[]>([])
  const productsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    getHqDashboardData()
      .then((data) => {
        setState({ phase: 'ready', data })
        setLastUpdated(new Date())
      })
      .catch((e) => {
        console.error('[HqDashboardScreen] getHqDashboardData error:', e)
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'error', message: '売上データの取得に失敗しました。' }))
      })
  }, [])

  // 初回fetch（リアルタイム購読の成否に関わらず必ず実行）
  useEffect(() => {
    setState({ phase: 'loading' })
    load()
  }, [load])

  // accounting_sessions / accounting_session_items / shop_status の変更を購読し、再集計する
  useEffect(() => {
    setRealtimeStatus('connecting')
    const unsubscribe = subscribeHqRealtime(
      () => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(load, 400)
      },
      setRealtimeStatus,
    )
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      unsubscribe()
    }
  }, [load])

  // 在庫アラート用に products も独立して取得・購読する（失敗してもダッシュボード本体は壊さない）
  const loadProducts = useCallback(() => {
    getProducts().then(setProducts).catch((e) => {
      console.error('[HqDashboardScreen] getProducts error:', e)
    })
  }, [])

  useEffect(() => { loadProducts() }, [loadProducts])

  useEffect(() => {
    const unsubscribe = subscribeProductsRealtime(() => {
      if (productsDebounceRef.current) clearTimeout(productsDebounceRef.current)
      productsDebounceRef.current = setTimeout(loadProducts, 400)
    })
    return () => {
      if (productsDebounceRef.current) clearTimeout(productsDebounceRef.current)
      unsubscribe()
    }
  }, [loadProducts])

  if (state.phase === 'loading') {
    return (
      <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textSecondary }}>
        読み込み中…
      </p>
    )
  }

  if (state.phase === 'error') {
    return (
      <div style={{
        background: 'rgba(140,31,26,0.10)', border: `1px solid ${HQ_COLORS.red}`,
        borderRadius: 4, padding: '16px 18px',
      }}>
        <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.negative, margin: 0 }}>
          {state.message}
        </p>
      </div>
    )
  }

  const { data } = state
  const isOpen = data.shopStatus === 'open'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <LiveSyncBadge status={realtimeStatus} lastUpdated={lastUpdated} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <HqStatTile label="本日売上" value={yen(data.todaySales)} />
        <HqStatTile label="本日来客" value={`${data.todayVisitors}名`} />
        <HqStatTile label="客単価" value={yen(data.todayUnitPrice)} />
        <HqStatTile label="今月売上" value={yen(data.monthSales)} />

        <div style={{
          flex: '1 1 150px', minWidth: 0,
          background: HQ_COLORS.panel,
          border: `1px solid ${isOpen ? 'rgba(123,201,123,0.35)' : HQ_COLORS.panelBorder}`,
          borderRadius: 4, padding: '14px 16px',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <p style={{ fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.12em', color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 8 }}>
            営業状態
          </p>
          <p style={{
            fontFamily: HQ_SERIF, fontSize: 20, fontWeight: 700, margin: 0,
            color: data.shopStatus === null ? HQ_COLORS.textMute : isOpen ? HQ_COLORS.positive : HQ_COLORS.textSecondary,
          }}>
            {data.shopStatus === null ? '不明' : isOpen ? '営業中' : '営業終了'}
          </p>
        </div>

        <HqStockAlertSummaryTile products={products} />
      </div>

      <HqPanel title="スタイリスト別集計（本日）" code="STAFF">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {data.stylists.map((s) => (
            <div key={s.name} style={{
              flex: '1 1 0', minWidth: 140,
              background: 'rgba(0,0,0,0.25)', border: `1px solid ${HQ_COLORS.panelBorder}`,
              borderRadius: 4, padding: '12px 14px',
            }}>
              <p style={{ fontFamily: HQ_SERIF, fontSize: 15, fontWeight: 700, color: '#fff', margin: 0, marginBottom: 8 }}>
                {s.name}
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 3 }}>
                売上 <span style={{ color: HQ_COLORS.goldHi }}>{yen(s.sales)}</span>
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 3 }}>
                来客 {s.visitors}名
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0 }}>
                客単価 {yen(s.unitPrice)}
              </p>
            </div>
          ))}
        </div>
      </HqPanel>

      <HqPanel title="支払い方法別売上（本日）" code="PAYMENT">
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {data.paymentBreakdown.map((p) => (
            <div key={p.method} style={{ flex: '1 1 0', minWidth: 100 }}>
              <p style={{ fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.1em', color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 4 }}>
                {p.label}
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 16, fontWeight: 700, color: HQ_COLORS.goldHi, margin: 0 }}>
                {yen(p.total)}
              </p>
            </div>
          ))}
        </div>
      </HqPanel>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="人気メニュー（本日）" code="TOP5" style={{ flex: '1 1 280px', minWidth: 0 }}>
          {data.menuRanking.length === 0 ? (
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
              本日のデータなし
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.menuRanking.map((m) => (
                <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary }}>
                    <span style={{ fontFamily: HQ_MONO, color: HQ_COLORS.goldHi, marginRight: 8 }}>{m.rank}位</span>
                    {m.name}
                  </span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textSecondary }}>{m.count}件</span>
                </div>
              ))}
            </div>
          )}
        </HqPanel>

        <HqPanel title="店販（本日）" code="RETAIL" style={{ flex: '1 1 280px', minWidth: 0 }}>
          {data.retailRanking.length === 0 ? (
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
              本日のデータなし
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.retailRanking.map((r) => (
                <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary }}>{r.name}</span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textSecondary }}>{r.count}個</span>
                </div>
              ))}
            </div>
          )}
        </HqPanel>
      </div>
    </div>
  )
}
