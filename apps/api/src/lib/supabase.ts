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
  /** Present only where trusted writes are needed. Never sent anywhere. */
  secretKey?: string;
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
    ...(env.SUPABASE_SECRET_KEY ? { secretKey: env.SUPABASE_SECRET_KEY } : {}),
  };
}

/**
 * A client that BYPASSES RLS. Only for operations that legitimately have no user
 * row-context to act within, and only after the route has authorised the caller
 * itself.
 *
 * Bootstrapping a room is the case: the creator cannot insert their own
 * membership under RLS (they are not a member until the row exists), which is the
 * same chicken-and-egg the matcher resolves when it admits a node to a task
 * thread. Never reach for this to make a permission error go away.
 */
export function createServiceClient(config: SupabaseConfig): SupabaseClient {
  if (!config.secretKey) {
    throw new Error('SUPABASE_SECRET_KEY is required for this operation. See .env.example.');
  }
  return createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
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
