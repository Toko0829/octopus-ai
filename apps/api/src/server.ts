import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadServerEnv } from '@octopus/config';
import { healthRoutes } from './routes/health';

/**
 * Build the Fastify app (authoritative REST API). See docs/10-architecture/architecture.md.
 * Phase 0: env validation, CORS, and the health route. Phase 1 adds JWKS auth preHandler,
 * the chat write path, and project/task CRUD.
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

  return app;
}
