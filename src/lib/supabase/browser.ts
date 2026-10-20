import { createBrowserClient } from '@supabase/ssr'

/** Browser client: publishable key only. It reads the session cookies; RLS and column grants still apply to every query. */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!)
}
