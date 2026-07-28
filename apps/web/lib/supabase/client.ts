'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client. Publishable key only — an sb_secret_ key in this file
 * would ship to every visitor and bypass RLS (AGENTS.md rule 6).
 *
 * Used for two things: the sign-in form, and subscribing to Realtime. All data
 * reads and writes go through the BFF to Fastify instead, so the write path
 * stays server-authoritative (docs/30-modules/chat-discord.md).
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. See .env.example.',
    );
  }
  return createBrowserClient(url, key);
}
