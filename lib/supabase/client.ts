import { createBrowserClient } from "@supabase/ssr";
import { type Database } from "@/database.types";

export function createClient(opts?: { sessionToken?: string }) {
  const headers: Record<string, string> = {};
  if (opts?.sessionToken) headers["x-session-token"] = opts.sessionToken;

  // Keep the schema generic to prevent `never` table types, but don't force a
  // SupabaseClient<> return type (your installed supabase-js types use a different generic arity).
  return createBrowserClient<Database, "public">(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers,
      },
    }
  );
}
