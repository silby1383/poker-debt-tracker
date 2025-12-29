import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { type Database } from "@/database.types";

type CookieStore = Awaited<ReturnType<typeof cookies>>;
type CookieToSet = {
  name: string;
  value: string;
  options?: Parameters<CookieStore["set"]>[2];
};

export async function createClient() {
  const cookieStore = await cookies();

  // Keep schema generic ('public') so table types don't become `never`.
  // Don't annotate return type with SupabaseClient<> due to generic-arity mismatch.
  return createServerClient<Database, "public">(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // ignore (Server Components can't set cookies)
          }
        },
      },
    }
  );
}
