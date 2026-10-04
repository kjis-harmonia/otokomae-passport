// JOHNNY operator（Supabase Edge Function）。処理は handler.ts（認証 → 事実 → 監査の順。汎用 SQL なし）。
// JOHNNY_ENABLED が 'true' でなければ何もしない（Production では設定しない）。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleJohnny } from './handler.ts'

Deno.serve((req) => {
  const env = (name: string) => Deno.env.get(name)
  return handleJohnny(req, {
    env,
    rpc: async (name, args) => {
      const url = env('SUPABASE_URL')
      const key = env('SUPABASE_SERVICE_ROLE_KEY')
      if (!url || !key) return { data: null, error: { code: 'not_configured', message: 'not_configured' } }
      const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await supabase.rpc(name, args)
      return { data, error: error ? { code: error.code, message: error.message } : null }
    },
  })
})
