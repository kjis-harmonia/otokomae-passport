// 会計の顧客がサーバーでどう決まるか（app_private.resolve_pos_client_context と同じ規則）。
// 未解決の記録（pendingOps）が止める対象と、成功応答の照合（checkoutApi）はこの結果だけを使う。
//
//   予約あり        予約の顧客（client_root）。client_id を送るなら予約の顧客と一致が必要（不一致はサーバーが拒否）。
//   スキャンのみ    スキャンの顧客。client_id を送るならスキャンの顧客と一致が必要。B-1 の既知の制約のまま、本人確認は増やさない。
//   どちらも無い    client_id を送っても無視され、匿名の会計になる。
//
// 画面から分からない・形が正しくないときは匿名として扱う（匿名の未解決は端末のすべての会計を止めるので、最も強く止まる側に倒す）。

export type SaleContext = 'reservation' | 'scan' | 'anonymous'

export const ANONYMOUS_SALE_TARGET = 'sale:anonymous'

export interface SaleIdentity {
  context: SaleContext
  /** サーバーが記録する予約（匿名なら null） */
  reservationId: string | null
  /** サーバーが記録する顧客（client_root）。匿名・顧客の無い予約なら null */
  clientId: string | null
  /** 同じ対象への新しい操作を止める単位 */
  targets: string[]
}

export interface SaleIdentityInput {
  reservation_id?: unknown
  client_id?: unknown
  scan_session_id?: unknown
}

type IdValue = string | null | 'invalid'

function idOf(v: unknown): IdValue {
  if (v === undefined || v === null) return null
  return typeof v === 'string' && v !== '' && v.trim() === v ? v : 'invalid'
}

/**
 * 送る内容から、サーバーが決める会計の顧客を求める。
 * reservationClientId は予約の顧客（会計画面の文脈で読んだ client_root。顧客の無い予約は null）。
 * 予約の会計で渡されない（undefined）ときは顧客が分からないので匿名として止める。
 */
export function resolveSaleIdentity(input: SaleIdentityInput, reservationClientId?: string | null): SaleIdentity {
  const r = idOf(input.reservation_id)
  const c = idOf(input.client_id)
  const s = idOf(input.scan_session_id)

  // 判定できない：匿名として止める。送った予約・顧客があれば、それも合わせて止める
  const ambiguous = (): SaleIdentity => ({
    context: 'anonymous',
    reservationId: null,
    clientId: null,
    targets: [
      ANONYMOUS_SALE_TARGET,
      ...(typeof r === 'string' && r !== 'invalid' ? [`reservation:${r}`] : []),
      ...(typeof c === 'string' && c !== 'invalid' ? [`client:${c}`] : []),
    ],
  })

  if (r === 'invalid' || c === 'invalid' || s === 'invalid') return ambiguous()

  if (r !== null) {
    if (reservationClientId === undefined) return ambiguous()
    const rc = idOf(reservationClientId)
    if (rc === 'invalid') return ambiguous()
    if (c !== null && c !== rc) return ambiguous() // サーバーが customer_context_mismatch で拒否する組み合わせ
    return {
      context: 'reservation',
      reservationId: r,
      clientId: rc,
      targets: [`reservation:${r}`, ...(rc ? [`client:${rc}`] : [])],
    }
  }

  if (s !== null) {
    // スキャンの顧客は画面からは分からない。送った client_id と一致したときだけサーバーが受け付ける
    if (c === null) return ambiguous()
    return { context: 'scan', reservationId: null, clientId: c, targets: [`client:${c}`] }
  }

  return { context: 'anonymous', reservationId: null, clientId: null, targets: [ANONYMOUS_SALE_TARGET] }
}
