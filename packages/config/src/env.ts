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
   * Whether this deployment publishes approved campaigns.
   *
   * **On by default, which inverts `CRAWL_ENABLED` above deliberately.** The two
   * look alike and the reasoning is opposite. Crawling is off by default to
   * protect somebody else's servers from every developer's laptop; publishing has
   * no stranger to protect. The sweep is inert until a workspace connects an
   * account AND an owner approves a campaign with a budget on it, and the only
   * registered provider makes no network call at all.
   *
   * Off by default would also make the product lie. Approving a campaign card now
   * says "publishing starts shortly", and on an unconfigured deployment that
   * sentence would be false while the campaign sat at `ready` in silence, which
   * is the exact defect shape this module has already paid for twice. So the
   * knob is a kill switch rather than an enablement: set it to `false` to stop a
   * deployment publishing, and nothing else changes.
   */
  PUBLISH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many campaigns one pass may publish.
   *
   * Small for the reason the crawl bound is small: a pass shares its lease with
   * the DAG walk and holds it while each platform call is in flight. Three drains
   * any realistic backlog within a couple of minutes, since a campaign leaves
   * `ready` on its first pass and only a retry comes back.
   */
  PUBLISH_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * Whether this deployment records what live campaigns spent.
   *
   * **On by default, sharing `PUBLISH_ENABLED`'s polarity rather than
   * `CRAWL_ENABLED`'s**, and for the same reason each of those was chosen. There
   * is no stranger to protect: this sweep reads only the accounts a workspace
   * connected, about campaigns it approved, and the only registered provider
   * makes no network call at all. It is inert until something is live.
   *
   * Off by default would repeat the defect the publish flag was inverted to
   * avoid. The project panel now shows a spend figure per campaign, and on an
   * unconfigured deployment that block would sit permanently at "No numbers yet"
   * while the campaign really was spending, which is a false surface rather than
   * an absent one. So this is a kill switch: set it to `false` to stop a
   * deployment measuring, and nothing else changes.
   */
  METRICS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many campaigns one pass may measure.
   *
   * Three, matching the publish bound, and bounded the same way: a pass shares
   * its lease with the DAG walk and holds it while each platform call is in
   * flight. Steady state is one day owed per live campaign per day, so this only
   * decides how fast a backlog drains, and each campaign is separately capped at
   * seven days per pass by `MAX_PERIODS_PER_PULL`.
   */
  METRICS_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * Whether this deployment enforces the CPA ceilings owners have typed.
   *
   * **On by default, and of the three sweep flags this one has the strongest
   * claim to that polarity.** The sweep is doubly inert until a person opts in:
   * it selects only live campaigns, and only those whose owner typed a ceiling
   * on the panel, and nothing else writes that column. Setting a ceiling is the
   * authorisation to pause (ADR-0014), so off by default would make a figure
   * somebody typed an unenforced promise, which on a money surface is a false
   * statement rather than a missing feature. A kill switch, exactly like its
   * two siblings: set it to `false` and campaigns are still measured, still
   * shown, and never paused from here.
   */
  OPTIMIZE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many ceiling breaches one pass may act on.
   *
   * Three, matching its siblings, and it bounds pauses ATTEMPTED rather than
   * campaigns judged: judging is a cheap indexed read plus a pure function, so
   * a workspace of healthy campaigns costs nothing against this, and a queue of
   * caught-up campaigns cannot starve the one that is breaching.
   */
  OPTIMIZE_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * Whether this deployment offers escalated steps to expert nodes.
   *
   * **On by default, and it belongs with the three above rather than with
   * `CRAWL_ENABLED`.** The polarity rule this file has followed since publish is
   * that a sweep is off by default only when there is a stranger to protect:
   * crawling reaches regulators' servers and can be rude, so it opts in. The
   * matcher reaches nobody. Every row it writes is ours, every read is indexed,
   * and it moves no money at all, since escrow is a later slice.
   *
   * It is also doubly inert, which is the `OPTIMIZE_ENABLED` argument repeated:
   * nothing enters `matching` except an owner clicking "Find an expert" on a
   * step that stopped, and nothing else writes that state. So a deployment that
   * never dispatches never pays for this flag being on.
   *
   * The reason it is not off by default is the one that decided the other three.
   * The panel offers a button that says an expert will be found; with the sweep
   * disabled, clicking it moves the step to `matching` and leaves it there
   * forever, which is a false statement on the surface this whole slice exists
   * to make honest. A kill switch, like its siblings: set it to `false` and
   * steps can still be dispatched, still show "Finding an expert", and no offer
   * is ever made.
   */
  MATCHER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many offers one pass may create.
   *
   * Three, matching its siblings, and it bounds offers CREATED rather than tasks
   * examined. Settling an expired offer and cascading a declined one are both
   * cheap conditional updates and are deliberately not counted against this, so
   * a backlog of steps waiting for their next candidate cannot starve the one
   * step whose offer is ready to go out.
   */
  MATCHER_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * Whether this deployment gives back escrow held against steps that stopped.
   *
   * **On by default, and the polarity argument here is the strongest of the
   * five.** The other four flags are kill switches over things a deployment
   * might reasonably not want to do: reach a stranger's server, publish, measure,
   * pause. This one is the only sweep whose absence actively takes something
   * away from a person. A step that is cancelled after its escrow was funded
   * leaves the hold at `held` forever, and a held hold counts against
   * `projects.budget_ceiling` (ADR-0020), so the owner's authorised budget stays
   * pinned against work that will never happen and **nothing else in the product
   * can release it**. `held -> refunded` has exactly one producer and it is this.
   *
   * It is inert in the same doubly-safe way its siblings are: it selects only
   * holds at `held` whose task has reached `cancelled` or `failed`, and a
   * workspace where nothing was cancelled costs one indexed read per pass.
   *
   * A kill switch, like its siblings: set it to `false` and steps can still be
   * accepted and funded, and no hold is ever unwound. That is a supported
   * configuration and a bad one, which is why it is not the default.
   */
  ESCROW_RECONCILE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many holds one pass may refund.
   *
   * Three, matching its siblings, and it bounds refunds PERFORMED rather than
   * holds examined. Reading which held holds sit on stopped steps is one indexed
   * query for the whole batch and is deliberately not counted against this, so a
   * backlog of live engagements cannot starve the one cancelled step whose money
   * is waiting to go back.
   */
  ESCROW_RECONCILE_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * The no-show sweep: an expert took a step, missed the agreed date, and the
   * work goes back to the marketplace with the money released to the owner.
   *
   * **On by default**, the polarity every sweep here has except `CRAWL_ENABLED`:
   * off-by-default is for the one that reaches a stranger's server, and this
   * reaches nobody outside the system. Turning it off is a deployment-shaped kill
   * switch, and the cost of it being off is stated rather than implied: an
   * abandoned step stays `escrow_funded` forever and its hold keeps committing
   * the owner's ceiling, which is exactly the dead end slice 6 exists to close.
   *
   * **Doubly inert until somebody misses a deadline**, since it selects only live
   * engagements whose `deadline_at` has passed and whose task is still
   * `escrow_funded` or `in_progress`.
   */
  NO_SHOW_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many engagements one pass may reassign.
   *
   * Three, matching its siblings, and it bounds reassignments PERFORMED rather
   * than engagements examined: the warnings this sweep sends are free and are
   * deliberately not counted against it, so a batch of nodes approaching their
   * deadline cannot starve the one that passed it. Small on purpose for a second
   * reason the money sweeps do not have: each reassignment produces a task at
   * `matching` that the matcher picks up in the same pass, so a large number here
   * would push a burst of offers at a cold-start pool.
   */
  NO_SHOW_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * The payout sweep: an owner approved an expert's work, so the escrow held
   * against that step is released to them and the step is finished.
   *
   * **On by default**, the polarity every sweep here has except `CRAWL_ENABLED`.
   * The cost of turning it off is the sharpest on this list and is stated rather
   * than implied: an approved step stops at `approved` holding its escrow, the
   * hold keeps committing `projects.budget_ceiling`, `engagements.outcome` never
   * reaches `'completed'`, and **somebody who did the work is not paid**. Nothing
   * else anywhere produces `held -> released`.
   *
   * **Nothing is transferred whatever this is set to.** The only registered
   * payment provider is the in-repo fake; `carriesRealMoney` refuses a real one
   * in `apps/api/src/lib/payout.ts` before the call, and the counsel gate in
   * payments-billing.md is unmoved.
   *
   * **Inert until an owner approves an expert's work**, since it selects only
   * live engagements whose task is `approved` or `payout_pending` and which still
   * have a `held` hold.
   */
  PAYOUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many payouts one pass may make.
   *
   * Three, matching its siblings, and it bounds payouts PERFORMED rather than
   * engagements examined. Small for the reason every money sweep here is small
   * rather than for the matcher's reason: each payout is four writes and an
   * outbound call, and a pass that fell behind is a pass that ran again thirty
   * seconds later.
   */
  PAYOUT_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

  /**
   * The heal sweep: an AI step the executor approved and did not finish, because
   * the process died between the `approved` write and the `done` write, is
   * walked on and its artifact is delivered.
   *
   * **On by default**, the polarity every sweep here has except `CRAWL_ENABLED`,
   * and for the family's reason: it reaches nobody outside the system. What
   * turning it off costs: a finished step stays at `approved`, which is not
   * terminal, so any later replan may cancel work that passed its check, and
   * the cited artifact it produced sits in a table nobody but a developer can
   * read.
   *
   * **Doubly inert** until a worker actually dies in that window: it selects
   * only AI-owned steps at `approved` for longer than the grace window, and it
   * never touches a human step (that state is the payout authorisation there)
   * or a campaign step (approved is where a campaign's own lifecycle begins).
   */
  HEAL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * How many stranded steps one pass may finish.
   *
   * Three, matching its siblings, and it bounds steps FINISHED rather than
   * examined. Each one is a delivery into a room, and the live database holds a
   * backlog of them from before the executor walked on at all, so a large
   * number here would post a burst of old deliverables into rooms at once.
   */
  HEAL_MAX_PER_TICK: z.coerce.number().int().positive().default(3),

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

  /**
   * Master key for the customer model keys in `model_connections` (ADR-0032).
   *
   * **Optional here and required at the point of use**, the same pair as
   * `OAUTH_STATE_SECRET` above and for the reason one step stronger. Requiring
   * it would stop every deployment booting for a feature most are not using. A
   * default would be worse than either: a master key checked into a repository
   * encrypts somebody else's paid API key with a value anybody can read, which
   * is indistinguishable from storing it in plaintext while looking safe.
   *
   * So a missing secret refuses to connect a provider, by name, and breaks
   * nothing else. It also fails a run whose workspace already has routes,
   * rather than falling back to the house key: a silent fallback would send a
   * customer's work to a provider they did not choose and bill it to us.
   *
   * Exactly 64 hex characters, which is a 32-byte AES-256 key. Length is checked
   * here rather than at first use so a truncated paste fails at boot.
   * `openssl rand -hex 32`.
   */
  MODEL_KEY_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'MODEL_KEY_SECRET must be 64 hex characters (openssl rand -hex 32)')
    .optional(),

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
