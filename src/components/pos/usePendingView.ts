import { useSyncExternalStore } from 'react'
import { getPendingView, subscribePendingOps, type PendingView } from '../../utils/pendingOps'

/** 端末に記録した未解決の金銭操作（別タブの変更も反映する） */
export function usePendingView(): PendingView {
  return useSyncExternalStore(subscribePendingOps, getPendingView, getPendingView)
}
