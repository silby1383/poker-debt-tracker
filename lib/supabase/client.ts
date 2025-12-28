import { createBrowserClient } from "@supabase/ssr";
import { type Database } from "@/database.types";

export function createClient(sessionToken?: string) {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    sessionToken
      ? {
          global: {
            headers: {
              "x-session-token": sessionToken,
            },
          },
        }
      : undefined
  );
}
