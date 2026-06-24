/**
 * Shared Supabase browser client.
 *
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from the Vite env and exports
 * a single configured client used app-wide for auth (GoTrue) — sessions persist
 * to localStorage, tokens auto-refresh, and the OAuth hash is parsed on load.
 * Logs a clear error if the env vars are missing rather than failing later.
 */
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Surface misconfiguration early rather than failing on first auth call
  console.error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in."
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
