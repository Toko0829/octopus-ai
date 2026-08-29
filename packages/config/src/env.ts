import { z } from 'zod';

/**
 * Environment schema — the single validated definition of what Octopus needs to boot.
 * See docs/30-modules/infra-devops.md (env schema validation) and .env.example.
 * Rule: SUPABASE_SERVICE_ROLE_KEY is SERVER-ONLY and must never reach the client.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Web (public, browser-safe). Publishable key only, never a secret key.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),

  // API (server-only). Supabase new key format: sb_publishable_... and sb_secret_...
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_ISSUER: z.string().url().optional(),

  // Python AI service (ADR-0006). Node calls it over an OpenAPI-typed seam.
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  // Budget for one grounded planning turn. Reranking is in-process CPU work
  // (ADR-0009), so the real cost scales with the cores the AI service has:
  // ~71s per goal on 12 threads, ~230s on one. Raise this on a small instance.
  // The default is not raised to cover the slowest case, because agent runs are
  // async (202 + runId) and a long default only delays reporting a hung service.
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  /**
   * Intake's own budget, deliberately far shorter than the planning one.
   *
   * Intake is a single cheap-tier model call with no retrieval, measured at
   * roughly 1.3s warm, so 20s is generous for steady state. It is configurable
   * for the cold case rather than the slow one: the reasoning service loads a
   * 2.2GB embedder during startup and does not serve until it has, so a request
   * arriving during a boot or a dev-server reload queues behind that and can
   * exceed a budget sized for warm traffic. Raising this trades a slower failure
   * for fewer spurious ones; it is not a fix for an intake that is genuinely slow.
   */
  INTAKE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /**
   * How often the durable backbone walks the DAG (ADR-0010).
   *
   * A heartbeat, not an event stream: work starts within one interval rather than
   * instantly. That is affordable because the interactive path does not wait on
   * it, since approving a plan already runs a tick inline, so this only bounds how
   * quickly background progress is noticed and how quickly a lost worker is
   * reclaimed.
   */
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * Whether this deployment crawls the external source registry.
   *
   * **Off by default, and that default is the point.** The registry names real
   * public pages at regulators and ad platforms. Every developer running the API
   * locally would otherwise start requesting them on boot and again on every
   * interval, which is a burst of pointless traffic aimed at somebody else's
   * servers from an address that has no reason to be asking. One deployment
   * crawls; laptops read what it ingested.
   */
  CRAWL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /**
   * How many due sources one pass may fetch.
   *
   * Small on purpose. A pass already shares its lease with the DAG walk, and a
   * sweep that fetched twenty pages would hold it while doing so. Sources come
   * due on a cadence measured in days, so two per pass drains any backlog within
   * minutes while never making this the slow part of a tick.
   */
  CRAWL_MAX_PER_TICK: z.coerce.number().int().positive().default(2),

  /**
   * Signing key for the OAuth `state` parameter.
   *
   * **Optional in this schema and required at the point of use**, which is a
   * deliberate pair rather than an oversight. Making it required would stop
   * every deployment from booting for a feature most of them are not using;
   * giving it a default would be worse than either, because a constant checked
   * into a repository signs a state anybody can forge, and the forgery is
   * exactly what this value exists to prevent. So a missing secret disables
   * connecting an account, loudly, and breaks nothing else.
   *
   * 32 bytes minimum. `openssl rand -hex 32` or `crypto.randomBytes(32)`.
   */
  OAUTH_STATE_SECRET: z.string().min(32).optional(),
  /**
   * How long an authorisation may sit half-finished before the state expires.
   *
   * Ten minutes covers a person reading a consent screen carefully; it does not
   * cover a state pasted out of a log a day later. Short because there is no
   * server-side record to revoke: the signature is the whole control, so its
   * lifetime is the whole window.
   */
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // Services.
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:3001'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate and return the server environment. Throws (loudly) on invalid config so a
 * misconfigured service fails fast at boot instead of behaving mysteriously later.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = JSON.stringify(parsed.error.flatten().fieldErrors, null, 2);
    // eslint-disable-next-line no-console
    console.error('[config] Invalid environment configuration:\n' + issues);
    throw new Error('Invalid environment configuration');
  }
  return parsed.data;
}
