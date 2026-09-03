/**
 * The API with every route and NO ticker, for driving the web app by hand
 * against the live database.
 *
 * `buildServer` starts the durable ticker on boot, and a second instance ticking
 * against live projects with no AI service reachable escalates real tasks
 * (README records exactly that risk as the reason a slice was not exercised in a
 * browser). This mirrors `server.ts`'s route registrations, omits `startTicker`,
 * and listens on the same port the web app's BFF targets, so a browser check
 * exercises real routes, real RLS and real PostgREST without a sweep running.
 *
 * Run from `apps/api`:
 *   npx tsx --env-file=.env scripts/serve-without-ticker.ts
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadServerEnv } from '@octopus/config';
import { healthRoutes } from '../src/routes/health';
import { messageRoutes } from '../src/routes/messages';
import { projectRoutes } from '../src/routes/projects';
import { replanRoutes } from '../src/routes/replan';
import { taskActionRoutes } from '../src/routes/task-actions';
import { roomRoutes } from '../src/routes/rooms';
import { agentRunRoutes } from '../src/routes/agent-runs';
import { embedRoutes } from '../src/routes/embeds';
import { sourceRoutes } from '../src/routes/sources';
import { connectionRoutes } from '../src/routes/connections';
import { nodeRoutes } from '../src/routes/nodes';
import { notificationRoutes } from '../src/routes/notifications';
import { opsRoutes } from '../src/routes/ops';
import { createAuthVerifier } from '../src/plugins/auth';
import { stateConfigFrom } from '../src/lib/oauth-state';
import { requireSupabaseConfig } from '../src/lib/supabase';
import { MAX_PROOF_FILES, MAX_PROOF_FILE_BYTES } from '../src/lib/proof';

async function main() {
  const env = loadServerEnv();
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  await app.register(cors, { origin: env.WEB_URL, credentials: true });
  await app.register(multipart, {
    limits: { files: MAX_PROOF_FILES, fileSize: MAX_PROOF_FILE_BYTES, fields: 8, fieldSize: 8192 },
  });
  await app.register(healthRoutes);

  const supabase = requireSupabaseConfig(env);
  if (!env.SUPABASE_JWKS_URL) throw new Error('SUPABASE_JWKS_URL is required');
  const verify = createAuthVerifier(env.SUPABASE_JWKS_URL, env.SUPABASE_JWT_ISSUER);
  const ai = { aiServiceUrl: env.AI_SERVICE_URL, aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS };

  await app.register(roomRoutes, { verify, supabase });
  await app.register(projectRoutes, { verify, supabase });
  await app.register(taskActionRoutes, { verify, supabase, ...ai });
  await app.register(replanRoutes, { verify, supabase, ...ai });
  await app.register(messageRoutes, { verify, supabase });
  await app.register(agentRunRoutes, {
    verify,
    supabase,
    ...ai,
    intakeTimeoutMs: env.INTAKE_REQUEST_TIMEOUT_MS,
  });
  await app.register(embedRoutes, {
    verify,
    supabase,
    ...ai,
    intakeTimeoutMs: env.INTAKE_REQUEST_TIMEOUT_MS,
  });
  await app.register(sourceRoutes, { verify, supabase, aiServiceUrl: env.AI_SERVICE_URL });
  await app.register(connectionRoutes, {
    verify,
    supabase,
    webUrl: env.WEB_URL,
    state: stateConfigFrom(env),
  });
  await app.register(nodeRoutes, { verify, supabase });
  await app.register(opsRoutes, { verify, supabase });
  await app.register(notificationRoutes, { verify, supabase });

  const port = Number(process.env.API_PORT ?? 3011);
  await app.listen({ port, host: '127.0.0.1' });
  app.log.warn({ port }, 'api up WITHOUT the ticker: nothing sweeps while this runs');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
