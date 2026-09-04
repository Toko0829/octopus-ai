import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadServerEnv } from '@octopus/config';
import { healthRoutes } from './routes/health';
import { messageRoutes } from './routes/messages';
import { projectRoutes } from './routes/projects';
import { replanRoutes } from './routes/replan';
import { taskActionRoutes } from './routes/task-actions';
import { roomRoutes } from './routes/rooms';
import { agentRunRoutes } from './routes/agent-runs';
import { embedRoutes } from './routes/embeds';
import { sourceRoutes } from './routes/sources';
import { connectionRoutes } from './routes/connections';
import { modelRoutes } from './routes/models';
import { nodeRoutes } from './routes/nodes';
import { notificationRoutes } from './routes/notifications';
import { opsRoutes } from './routes/ops';
import { createAuthVerifier } from './plugins/auth';
import { stateConfigFrom } from './lib/oauth-state';
import { startTicker } from './lib/ticker';
import { createServiceClient, requireSupabaseConfig } from './lib/supabase';
import { MAX_PROOF_FILES, MAX_PROOF_FILE_BYTES } from './lib/proof';

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

  // **One route reads bytes: a node handing over proof of finished work.** The
  // caps are here rather than only in the handler so a body larger than the limit
  // is refused by the parser before it is buffered, and `attachFieldsToBody` is
  // deliberately off: `nodes.ts` iterates `request.parts()` so a file that fails
  // the content-type allow-list is refused without being read to the end.
  // Everything else in this API is JSON and is unaffected.
  await app.register(multipart, {
    limits: {
      files: MAX_PROOF_FILES,
      fileSize: MAX_PROOF_FILE_BYTES,
      fields: 8,
      fieldSize: 8192,
    },
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
  await app.register(projectRoutes, { verify, supabase });

  // Resolving a stuck step from the project panel. A retry re-routes and can
  // dispatch to the executor, so it needs the same reasoning-core wiring the
  // approval tick does.
  await app.register(taskActionRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
    aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    modelKeySecret: env.MODEL_KEY_SECRET ?? null,
  });

  // Changing a plan that is already running. Produces a card; applying it is the
  // embed-action route, so a diff crosses the same authorisation boundary a plan
  // does.
  await app.register(replanRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
    aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    modelKeySecret: env.MODEL_KEY_SECRET ?? null,
  });
  await app.register(messageRoutes, { verify, supabase });
  await app.register(agentRunRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
    aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    intakeTimeoutMs: env.INTAKE_REQUEST_TIMEOUT_MS,
    // Every path that can reach the reasoning core takes the master key, because
    // every one of them can be the first call in a room that routes its own
    // provider. A deployment that never sets it passes null everywhere and keeps
    // planning on the house default; a room with routes and no key fails the run
    // with the variable named (ADR-0032).
    modelKeySecret: env.MODEL_KEY_SECRET ?? null,
  });
  // Approving a plan runs a scheduler tick, and a tick can execute AI tasks, so
  // this route needs the same reasoning-core wiring as agent runs.
  await app.register(embedRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
    aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    // Finishing a question card continues the run that asked, so this route
    // needs the intake budget as well.
    intakeTimeoutMs: env.INTAKE_REQUEST_TIMEOUT_MS,
    modelKeySecret: env.MODEL_KEY_SECRET ?? null,
  });

  // What the workspace tells us about its own business. Ingestion is embedding
  // work rather than a reasoning step, so it does not share the plan budget: the
  // route replies 202 and the default source timeout applies to the background
  // continuation, where nobody is waiting on it.
  await app.register(sourceRoutes, {
    verify,
    supabase,
    aiServiceUrl: env.AI_SERVICE_URL,
  });

  // Connecting the workspace's own ad, social and email accounts. Takes the web
  // URL because the OAuth redirect lands on the web origin rather than here
  // (ADR-0012), and a state config that is null when no secret is set: a
  // deployment that never connects an account boots normally, and one that tries
  // to is refused with the variable named.
  await app.register(connectionRoutes, {
    verify,
    supabase,
    webUrl: env.WEB_URL,
    state: stateConfigFrom(env),
  });

  // The workspace's own reasoning provider (ADR-0032). Registered beside the
  // channel connections because it is the same shape of decision one table
  // along: a customer-held credential, an owner-only write, and a projection
  // that carries no secret. Takes the master key as null when MODEL_KEY_SECRET
  // is unset, so a deployment that never connects a provider boots normally and
  // one that tries to is refused with the variable named; and the AI service URL,
  // because what "Auto" means is read from that service rather than restated in
  // a second environment variable that could disagree with it.
  await app.register(modelRoutes, {
    verify,
    supabase,
    modelKeySecret: env.MODEL_KEY_SECRET ?? null,
    aiServiceUrl: env.AI_SERVICE_URL,
  });

  // A node's own record. Takes no web URL and no state config, because nothing
  // here redirects anywhere: the identity provider's flow is a page in our own
  // app for as long as the only registered verifier is the in-repo fake.
  // Creating a node is deliberately absent from this route group and from every
  // other one, since onboarding is ops-invited through `invite_node`.
  await app.register(nodeRoutes, { verify, supabase });

  // The dispute console, and the first ops surface in this system. Registered
  // like any other route group rather than behind a flag: `disputed` is
  // reachable from four states as of `20260908120000`, and nothing else can move
  // a task out of it, so a deployment without this is a deployment where a
  // dispute is a dead end. Access is `profiles.role`, read from the database by
  // `requireOps` because the JWT does not carry it, and granted only by
  // `scripts/grant-ops.mjs`.
  await app.register(opsRoutes, { verify, supabase });

  // The inbox. Registered without a flag and without a role check, because it is
  // the one route group whose authorisation is total and uniform: every caller
  // reads their own rows and writes one column of them, decided by RLS rather
  // than by anything here. A deployment without it is one where an offer, a
  // handover and a dispute are all discovered by looking, which is the condition
  // `20260909121000` exists to end.
  await app.register(notificationRoutes, { verify, supabase });

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
      modelKeySecret: env.MODEL_KEY_SECRET ?? null,
      imageGenEnabled: env.IMAGE_GEN_ENABLED,
      log: app.log,
    },
    stepBudgetMs: env.AI_REQUEST_TIMEOUT_MS,
    intervalMs: env.TICK_INTERVAL_MS,
    // The freshness pipeline rides the same pass, and only where it is turned on.
    // One deployment crawls the registry; every laptop reads what it ingested,
    // because the alternative is a dozen developers pointing repeated requests at
    // ftc.gov for no benefit to anyone.
    crawl: env.CRAWL_ENABLED
      ? {
          aiServiceUrl: env.AI_SERVICE_URL,
          aiTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
          maxPerPass: env.CRAWL_MAX_PER_TICK,
        }
      : undefined,
    // Publishing what an owner already authorised. The two human gates are the
    // real control (an account has to be connected, and a campaign has to be
    // approved with a budget typed on it), so this flag is the deployment-shaped
    // off switch rather than the authorisation. It is on unless set to `false`.
    publish: env.PUBLISH_ENABLED ? { maxPerPass: env.PUBLISH_MAX_PER_TICK } : undefined,
    // Recording what those campaigns spent. Reads only, appends only, and inert
    // until something is live, so the same kill-switch shape as publishing.
    metrics: env.METRICS_ENABLED ? { maxPerPass: env.METRICS_MAX_PER_TICK } : undefined,
    // Enforcing the ceilings owners typed against what those campaigns spent.
    // Doubly inert until somebody sets a ceiling, so the same kill-switch shape.
    optimize: env.OPTIMIZE_ENABLED ? { maxPerPass: env.OPTIMIZE_MAX_PER_TICK } : undefined,
    // Returning a step to the market when the expert who took it went quiet.
    // Inert until somebody misses a deadline, and placed before the matcher on
    // the pass so a replacement is offered without waiting another tick.
    noShow: env.NO_SHOW_ENABLED ? { maxPerPass: env.NO_SHOW_MAX_PER_TICK } : undefined,
    // Paying an expert for a step the owner approved. The only producer of
    // `held -> released` anywhere: with this off, an approved step holds its
    // escrow forever and somebody who did the work is never paid. Nothing is
    // transferred whatever it is set to — the only registered provider is the
    // in-repo fake and `carriesRealMoney` refuses a real one at the writer.
    payout: env.PAYOUT_ENABLED ? { maxPerPass: env.PAYOUT_MAX_PER_TICK } : undefined,
    // Finishing AI steps a dead worker left at `approved`, and delivering the
    // work it never announced. Doubly inert until a process dies in that window;
    // `false` leaves such a step cancellable forever and its artifact unseen.
    heal: env.HEAL_ENABLED ? { maxPerPass: env.HEAL_MAX_PER_TICK } : undefined,
    // Offering escalated steps to expert nodes. Inert until an owner clicks, so
    // the same kill-switch shape again: `false` still lets a step be dispatched
    // and still shows "Finding an expert", and no offer is ever made.
    matcher: env.MATCHER_ENABLED ? { maxPerPass: env.MATCHER_MAX_PER_TICK } : undefined,
    // Giving back escrow held against steps that stopped before delivery. The
    // only producer of `held -> refunded` anywhere: with this off, a cancelled
    // step pins part of the owner's authorised budget permanently and no other
    // code path can release it.
    escrow: env.ESCROW_RECONCILE_ENABLED
      ? { maxPerPass: env.ESCROW_RECONCILE_MAX_PER_TICK }
      : undefined,
    log: app.log,
  });
  app.addHook('onClose', async () => stopTicker());

  return app;
}
