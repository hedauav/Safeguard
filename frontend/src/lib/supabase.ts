import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** True when real credentials are present; false means realtime views will be empty. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

if (!isSupabaseConfigured) {
  // Fall through to a non-functional client rather than throwing, so the
  // landing page still renders — but say so plainly instead of failing silently.
  console.warn(
    '[SafeGuard] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. ' +
      'Dashboard realtime data will not load.'
  )
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder'
)
