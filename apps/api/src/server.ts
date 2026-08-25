import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadServerEnv } from '@octopus/config';
import { healthRoutes } from './routes/health';
import { messageRoutes } from './routes/messages';
import { roomRoutes } from './routes/rooms';
import { agentRunRoutes } from './routes/agent-runs';
import { embedRoutes } from './routes/embeds';
import { createAuthVerifier } from './plugins/auth';
import { startTicker } from './lib/ticker';
import { createServiceClient, requireSupabaseConfig } from './lib/supabase';

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
  await app.register(agentRunRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
    aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    intakeTimeoutMs: env.INTAKE_REQUEST_TIMEOUT_MS,
  });
  // Approving a plan runs a scheduler tick, and a tick can execute AI tasks, so
  // this route needs the same reasoning-core wiring as agent runs.
  await app.register(embedRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
    aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  });

  // The durable backbone (ADR-0010). Started here rather than as a separate
  // process because there is nothing to separate yet: a run's state is rows, so
  // the ticker is a loop that wakes up, recovers what died, and walks the graph.
  // `apps/agent` is where this moves when it earns its own deployment.
  //
  // Registered as a Fastify hook so a closing server stops ticking and releases
  // its claim, rather than leaving a lease that the next instance has to wait out.
  const stopTicker = startTicker({
    admin: createServiceClient(supabase),
    executor: {
      aiServiceUrl: env.AI_SERVICE_URL,
      aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      log: app.log,
    },
    stepBudgetMs: env.AI_REQUEST_TIMEOUT_MS,
    intervalMs: env.TICK_INTERVAL_MS,
    log: app.log,
  });
  app.addHook('onClose', async () => stopTicker());

  return app;
}
