import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadServerEnv } from '@octopus/config';
import { healthRoutes } from './routes/health';
import { messageRoutes } from './routes/messages';
import { roomRoutes } from './routes/rooms';
import { createAuthVerifier } from './plugins/auth';
import { requireSupabaseConfig } from './lib/supabase';

/**
 * Build the Fastify app (authoritative REST API). See docs/10-architecture/architecture.md.
 *
 * The synchronous boundary is deliberately narrow (AGENTS.md rule 4): these routes
 * verify a JWT, persist a message, and read history. Agent loops and any multi-step
 * work run as durable tasks and return `202 + runId` instead.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const env = loadServerEnv();

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  await app.register(cors, {
    origin: env.WEB_URL,
    credentials: true,
  });

  await app.register(healthRoutes);

  // Chat needs Supabase; fail at boot with a named variable rather than 500ing
  // on the first message.
  const supabase = requireSupabaseConfig(env);
  if (!env.SUPABASE_JWKS_URL) {
    throw new Error('Chat routes require SUPABASE_JWKS_URL. See .env.example.');
  }
  const verify = createAuthVerifier(env.SUPABASE_JWKS_URL, env.SUPABASE_JWT_ISSUER);

  await app.register(roomRoutes, { verify, supabase });
  await app.register(messageRoutes, { verify, supabase });

  return app;
}
