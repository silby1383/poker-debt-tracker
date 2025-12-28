import { createBrowserClient } from '@supabase/ssr'
import { type Database } from '@/database.types'

export function createClient(opts?: { sessionToken?: string }) {
  const headers: Record<string, string> = {}
  if (opts?.sessionToken) headers['x-session-token'] = opts.sessionToken

  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers,
      },
    }
  )
}
