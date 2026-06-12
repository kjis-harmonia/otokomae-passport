import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !key) {
  console.warn('[Supabase] 環境変数 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。Supabase機能は無効です。')
}

// 未設定時もcreateClientがthrowしないようプレースホルダーを使用
export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  key || 'placeholder-anon-key'
)
