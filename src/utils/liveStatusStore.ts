import { supabase } from '../lib/supabase'
import type { LiveStatusRow, LiveStatusValue } from '../data/liveStatus'

export async function getLiveStatuses(): Promise<LiveStatusRow[]> {
  const { data, error } = await supabase
    .from('live_statuses')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error || !data) return []
  return data as LiveStatusRow[]
}

export async function setLiveStatus(id: string, status: LiveStatusValue): Promise<LiveStatusRow | null> {
  const { data, error } = await supabase
    .from('live_statuses')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error || !data) return null
  return data as LiveStatusRow
}

export function subscribeLiveStatuses(onChange: (row: LiveStatusRow) => void) {
  const channel = supabase
    .channel('live-statuses-realtime')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'live_statuses' },
      (payload) => onChange(payload.new as LiveStatusRow),
    )
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
}
