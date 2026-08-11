import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client bound to the request's cookies.
 *
 * The session cookies are deliberately **not** `httpOnly`: `@supabase/ssr`'s browser
 * client has to read them to authenticate the Realtime socket, which `httpOnly` would
 * prevent. The access token is therefore reachable by page scripts, exactly as in
 * Supabase's standard SSR setup. A genuinely `httpOnly` session would require
 * brokering Realtime server-side too, and that is an ADR-level change
 * (docs/30-modules/auth-identity.md).
 */
export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  }

  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server Components cannot set cookies. The middleware refreshes the
          // session instead, so this is safe to ignore here (and only here).
        }
      },
    },
  });
}

/**
 * The caller's access token, or null when signed out. This is what the BFF
 * forwards to Fastify as the bearer token.
 */
export async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}
