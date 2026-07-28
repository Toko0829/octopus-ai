import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@octopus/config';

/**
 * Postgres access for request-scoped work.
 *
 * We deliberately use the PUBLISHABLE key plus the caller's own access token, not
 * the secret key. That makes `auth.uid()` resolve inside RLS policies, so every
 * query is filtered by room membership in the database itself. Fastify's checks
 * and Postgres RLS then have to BOTH fail for a leak to happen.
 *
 * The secret key bypasses RLS entirely and is reserved for trusted server writes
 * that have no user context (agent/system messages, the matcher adding a node).
 * It must never be used to serve a user request. See AGENTS.md rules 6 and 7 and
 * docs/30-modules/auth-identity.md ("service_role containment").
 */
export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

/**
 * Read the Supabase settings the chat routes need, failing loudly at boot when
 * they are absent rather than at the first request. AGENTS.md rule 16.
 */
export function requireSupabaseConfig(env: Env): SupabaseConfig {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Chat routes require ${missing.join(', ')}. See .env.example and DEVELOPMENT.md.`,
    );
  }
  return {
    url: env.SUPABASE_URL as string,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY as string,
  };
}

/**
 * A Postgres client acting AS the calling user. Every statement it issues is
 * subject to the room-membership policies in 20260728120000_chat.sql.
 */
export function createUserClient(config: SupabaseConfig, accessToken: string): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
