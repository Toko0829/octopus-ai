import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  Artifact,
  ArtifactFileUrl,
  ProjectDetail,
  ProjectSummary,
  Task,
} from '@octopus/contracts';
import {
  CampaignState,
  MarketingChannel,
  SetCampaignCpaCeilingBody,
  SetProjectBudgetBody,
} from '@octopus/contracts';
import type { CampaignSummary } from '@octopus/contracts';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { citationTitles, summariseProjects } from '../lib/project-progress';
import { resolveProjectOwner } from '../lib/project-owner';
import { rollupOutcomes, type OutcomeReadRow } from '../lib/metrics';
import { markConnectionExpired, readPublishableConnections } from '../lib/connections';
import { roomForProject } from '../lib/room-for-project';
import {
  adapterFor,
  checkScopes,
  chooseConnection,
  decidePauseOutcome,
  METRICS_SOURCE,
  OPTIMIZE_REQUIRED_SCOPES,
  resumeIdempotencyKey,
} from '@octopus/marketing';

/**
 * Reading what an approved plan became: the project, its tasks, and what those
 * tasks produced.
 *
 * Until these routes existed the workflow engine had no surface at all. A person
 * approved a plan, the scheduler routed eight steps, the executor wrote eight
 * artifacts, and the only evidence was a handful of cards scattered through the
 * chat stream. "Planning visibly and delivering invisibly is worse than doing
 * neither" is already the argument for the artifact card; this is the same
 * argument one level up, for the work as a whole.
 *
 * Every query runs as the caller, so RLS decides what exists. None of these
 * handlers filter by membership themselves.
 *
 * **A room is resolved to its projects through the plan card, never through
 * `rooms.project_id`.** That column is written once, by `materialise_plan`, under
 * `where ... and project_id is null`, so the first plan approved in a room claims
 * it permanently and every later project is linked to nothing. Reading it here
 * would show one project and silently omit the rest, which is the same defect
 * that lost eight delivered artifacts (see `room-for-project.ts`) and the same one
 * `20260827110000` removed from the RLS predicate. `projects.source_embed_id` is
 * unique, set at creation and never changed.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });
const ProjectParams = z.object({ projectId: z.string().uuid() });
const ArtifactParams = z.object({
  projectId: z.string().uuid(),
  artifactId: z.string().uuid(),
});

export const ProjectRow = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.enum(['draft', 'planning', 'active', 'paused', 'completed', 'cancelled']),
  created_at: z.string(),
  source_embed_id: z.string().nullable(),
  // numeric(12,2) arrives from PostgREST as a string. Coerced rather than cast,
  // because `'900' > 1000` is false in JavaScript for the wrong reason and this
  // number is the one a spend decision is made against.
  budget_ceiling: z.coerce.number().nullable(),
  currency: z.string(),
});

/**
 * Every column a read of `projects` must select, in one place.
 *
 * One constant rather than three inline strings, because `ProjectRow` parses all
 * three reads and a select that omits a field the schema requires fails at
 * **runtime**, not at compile time: `z.coerce.number()` turns an absent
 * `budget_ceiling` into `NaN`, which `.nullable()` then refuses.
 *
 * That is not hypothetical. `6fcd0d6` added `budget_ceiling` and `currency` to
 * the schema, updated the detail read, and missed both reads in `listProjects`.
 * `GET /api/rooms/:roomId/projects` returned 500 for every room holding a
 * project from that commit until somebody opened the panel and found it dead.
 * Nothing caught it: the type checker cannot see inside a PostgREST select
 * string, and the route suite only covered a pure helper. `projects.test.ts` now
 * pins the constant against the schema, which is the check that would have.
 */
export const PROJECT_COLUMNS =
  'id, goal, status, created_at, source_embed_id, budget_ceiling, currency';

export const CampaignRow = z.object({
  id: z.string(),
  name: z.string(),
  channel: MarketingChannel,
  state: CampaignState,
  budget_cap: z.coerce.number().nullable(),
  // Same numeric(12,2)-arrives-as-a-string coercion as budget_cap, and the same
  // stakes: this is the figure the optimizer judges spend against.
  cpa_ceiling: z.coerce.number().nullable(),
  pause_reason: z.enum(['kill_switch', 'cpa_breach', 'user', 'optimizer']).nullable(),
  currency: z.string(),
  created_at: z.string(),
});

/**
 * Every column a read of `campaigns` must select, in one place.
 *
 * `PROJECT_COLUMNS`'s reasoning applied to the table that gained columns this
 * slice: `CampaignRow` coerces two numerics, so a select that omits one fails at
 * runtime as a NaN complaint about a value nobody sent, which is exactly how
 * `6fcd0d6` broke `listProjects`. The select was an inline string until the
 * schema grew, which is the moment the constant earns its place.
 */
export const CAMPAIGN_COLUMNS =
  'id, name, channel, state, budget_cap, cpa_ceiling, pause_reason, currency, created_at';

/** Terminal campaigns hold none of the ceiling. Mirrors `private.campaign_state_is_terminal`. */
const TERMINAL_CAMPAIGN_STATES = new Set(['completed', 'cancelled', 'failed']);

/**
 * What the project has committed against its authorised ceiling.
 *
 * **The fourth of ADR-0020's four places**, exported and pure so that it is
 * pinned by a test rather than reviewed inside a handler. The other three are
 * `checkSpendCap`, `readSpendInputs`, and the sums inside `materialise_campaign`
 * and `accept_offer`; all four apply the same filters, and a suite asserts the
 * same boundary on each so drift fails a test rather than passing quietly.
 *
 * Both classes, filtered identically to their SQL twins: a terminal campaign
 * holds none of the ceiling, a campaign with no cap contributes nothing rather
 * than turning the sum into NULL, and only a `held` escrow row commits anything.
 *
 * `escrowHeld` is returned separately as well as folded into the total, because
 * the two halves settle on different clocks and an owner reading a number they
 * cannot reduce needs to know which half is which.
 *
 * Hold amounts arrive as `numeric(12,2)`, which PostgREST hands back as a
 * **string**. Converted here rather than compared as one: `'900' > 1000` is
 * false in JavaScript for the wrong reason, and a money figure that is right by
 * accident is not right.
 */
export function projectCommitments(input: {
  campaigns: { state: string; budgetCap: number | null }[];
  heldAmounts: (number | string | null)[];
}): { committedBudget: number; escrowHeld: number } {
  const campaignCommitted = input.campaigns
    .filter((c) => !TERMINAL_CAMPAIGN_STATES.has(c.state) && c.budgetCap !== null)
    .reduce((sum, c) => sum + (c.budgetCap ?? 0), 0);

  const escrowHeld = input.heldAmounts
    .filter((a): a is number | string => a !== null)
    .reduce((sum: number, a) => sum + Number(a), 0);

  return { committedBudget: campaignCommitted + escrowHeld, escrowHeld };
}

const TaskRow = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  stage: z.string().nullable(),
  owner_type: z.enum(['ai', 'human', 'user']),
  state: z.string(),
  risk_tier: z.enum(['read_only', 'reversible', 'external', 'high_risk']),
  position: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ArtifactRow = z.object({
  id: z.string(),
  task_id: z.string(),
  kind: z.enum(['draft', 'analysis', 'asset', 'proof', 'answer']),
  title: z.string().nullable(),
  body: z.string().nullable(),
  storage_path: z.string().nullable(),
  citations: z.unknown(),
  created_by: z.enum(['user', 'agent', 'node', 'system']),
  created_at: z.string(),
});

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/**
 * How long a download link lives.
 *
 * Ten minutes. The link is a bearer capability, so the window is the exposure if
 * one is copied out of a browser's history or a screenshot; ten minutes is long
 * enough to click and download a large file and short enough that a leaked one
 * is stale before it is useful. It is minted per request, so a shorter-lived
 * link costs nothing but a round trip.
 */
export const SIGNED_URL_TTL_SECONDS = 600;

/**
 * What the file-url route should do about an artifact row, decided separately
 * from doing it.
 *
 * Pure so the branch is testable without a Supabase client, and specifically so
 * the **"text artifact" case is pinned**. A row with no `storage_path` is not a
 * file, and asking Storage to sign a null path would either throw deep inside
 * the client or, worse, sign something. Both would surface as a 500 for a
 * perfectly ordinary artifact.
 *
 * All three misses are 404, matching how a non-member gets 404 on a room: the
 * API does not confirm the existence of something it will not show you. The
 * `reason` distinguishes them for the log, which is where the difference is
 * actually useful.
 */
export type FileUrlDecision =
  | { kind: 'sign'; storagePath: string }
  | { kind: 'not_found'; reason: 'invisible_or_absent' | 'not_a_file' };

export function decideFileUrl(row: { storage_path: string | null } | null): FileUrlDecision {
  if (!row) return { kind: 'not_found', reason: 'invisible_or_absent' };
  const path = row.storage_path?.trim();
  if (!path) return { kind: 'not_found', reason: 'not_a_file' };
  return { kind: 'sign', storagePath: path };
}

/** When a link minted now stops working, as an instant the client can compare against. */
export function signedUrlExpiresAt(nowMs: number, ttlSeconds = SIGNED_URL_TTL_SECONDS): string {
  return new Date(nowMs + ttlSeconds * 1000).toISOString();
}

export interface ProjectRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
}

export async function projectRoutes(
  app: FastifyInstance,
  opts: ProjectRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  app.get(
    '/api/rooms/:roomId/projects',
    { preHandler: requireAuth },
    async (request, reply): Promise<{ projects: ProjectSummary[] } | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const roomId = params.data.roomId;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        // Confirm the room first. A room the caller cannot see and a room with no
        // projects both yield an empty list otherwise, and telling those apart is
        // the whole reason this surface exists.
        const { data: room, error: roomErr } = await db
          .from('rooms')
          .select('id, project_id')
          .eq('id', roomId)
          .maybeSingle<{ id: string; project_id: string | null }>();
        if (roomErr) throw roomErr;
        if (!room) return fail(reply, 404, 'not_found', 'Room not found.');

        const { data: embeds, error: embedErr } = await db
          .from('action_embeds')
          .select('id')
          .eq('room_id', roomId)
          .eq('component', 'plan');
        if (embedErr) throw embedErr;

        const embedIds = (embeds ?? []).map((e) => (e as { id: string }).id);

        // Two plain reads merged here rather than one `.or()` filter string.
        // Same reasoning as `roomForProject`: a hand-built PostgREST filter fails
        // silently when it is wrong, and silently returning fewer projects than
        // exist is precisely the defect being removed.
        const byCard = embedIds.length
          ? await db.from('projects').select(PROJECT_COLUMNS).in('source_embed_id', embedIds)
          : { data: [], error: null };
        if (byCard.error) throw byCard.error;

        const byRoom = room.project_id
          ? await db.from('projects').select(PROJECT_COLUMNS).eq('id', room.project_id)
          : { data: [], error: null };
        if (byRoom.error) throw byRoom.error;

        const projects = new Map<string, z.infer<typeof ProjectRow>>();
        for (const row of [...(byCard.data ?? []), ...(byRoom.data ?? [])]) {
          const p = ProjectRow.parse(row);
          projects.set(p.id, p);
        }
        if (projects.size === 0) return { projects: [] };

        const ids = [...projects.keys()];

        const [{ data: tasks, error: taskErr }, { data: artifacts, error: artErr }] =
          await Promise.all([
            db.from('tasks').select('id, project_id, state').in('project_id', ids),
            db.from('artifacts').select('id, project_id').in('project_id', ids),
          ]);
        if (taskErr) throw taskErr;
        if (artErr) throw artErr;

        return {
          projects: summariseProjects(
            [...projects.values()].map((p) => ({
              id: p.id,
              goal: p.goal,
              status: p.status,
              created_at: p.created_at,
            })),
            (tasks ?? []) as { project_id: string; state: string }[],
            (artifacts ?? []) as { project_id: string }[],
          ),
        };
      } catch (err) {
        request.log.error({ err, roomId, userId: request.user?.sub }, 'listProjects failed');
        return fail(reply, 500, 'internal_error', 'Could not load projects.');
      }
    },
  );

  app.get(
    '/api/projects/:projectId',
    { preHandler: requireAuth },
    async (request, reply): Promise<ProjectDetail | FastifyReply> => {
      const params = ProjectParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'projectId must be a UUID.');
      const projectId = params.data.projectId;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const detail = await buildProjectDetail(db, projectId);
        // Invisible and absent are the same answer on purpose, the same way a
        // non-member gets 404 on a room: the API does not confirm that a project
        // it will not show you exists.
        if (!detail) return fail(reply, 404, 'not_found', 'Project not found.');
        return detail;
      } catch (err) {
        request.log.error({ err, projectId, userId: request.user?.sub }, 'getProject failed');
        return fail(reply, 500, 'internal_error', 'Could not load the project.');
      }
    },
  );

  /**
   * Set or clear what the owner authorises for this project.
   *
   * **This route is why the spend cap is reachable at all.** `budget_ceiling` has
   * existed since `20260813120000` with no reader and no writer anywhere in
   * TypeScript, so `checkSpendCap` would have refused every campaign forever with
   * `no_ceiling_authorised`. That is the defect class this repository has now paid
   * for twice, with `risk_tier` unreachable for its whole life and `task_deps`
   * enforcing an empty set for two weeks: a guard whose input nothing supplies.
   *
   * **Owner only, and checked here rather than by RLS.** Clients hold no UPDATE
   * grant on `projects` at all, so the write goes through the service client and
   * the authorisation has to be made in this handler. `resolveProjectOwner` reads
   * with the caller's own client, so a person who cannot see the project cannot
   * learn who owns it.
   *
   * **Clearing is legal and deliberately narrow.** `null` blocks every future
   * campaign approval and touches no campaign already authorised: withdrawing
   * permission to commit more is not the same act as stopping spend that is
   * already committed, and doing both here would pause campaigns nobody asked to
   * pause.
   */
  app.patch(
    '/api/projects/:projectId',
    { preHandler: requireAuth },
    async (request, reply): Promise<ProjectDetail | FastifyReply> => {
      const params = ProjectParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'projectId must be a UUID.');
      const body = SetProjectBudgetBody.safeParse(request.body);
      if (!body.success) {
        return fail(
          reply,
          400,
          'bad_request',
          'budgetCeiling must be a number of at least 0, or null to clear it.',
        );
      }

      const projectId = params.data.projectId;
      const userId = (request.user as NonNullable<typeof request.user>).sub;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { ownerId } = await resolveProjectOwner(db, projectId);
        if (!ownerId) return fail(reply, 404, 'not_found', 'Project not found.');
        if (ownerId !== userId) {
          return fail(reply, 403, 'forbidden', 'Only the workspace owner can authorise a budget.');
        }

        const admin = createServiceClient(opts.supabase);
        const { data: before, error: beforeErr } = await admin
          .from('projects')
          .select('budget_ceiling, currency')
          .eq('id', projectId)
          .maybeSingle<{ budget_ceiling: number | string | null; currency: string }>();
        if (beforeErr) throw beforeErr;
        if (!before) return fail(reply, 404, 'not_found', 'Project not found.');

        const { error: updateErr } = await admin
          .from('projects')
          .update({ budget_ceiling: body.data.budgetCeiling })
          .eq('id', projectId);
        if (updateErr) throw updateErr;

        // Audited, because this is an authorisation rather than a preference.
        // `actor_id` is passed explicitly: the `auth.uid()` idiom the SQL writers
        // use reads null under the service key, which would record a person's
        // decision as the system's.
        const { error: eventErr } = await admin.from('events').insert({
          project_id: projectId,
          actor_id: userId,
          actor_kind: 'user',
          verb: 'project.budget_set',
          subject_type: 'project',
          subject_id: projectId,
          payload: {
            from: before.budget_ceiling === null ? null : Number(before.budget_ceiling),
            to: body.data.budgetCeiling,
            currency: before.currency,
          },
        });
        if (eventErr) {
          request.log.error(
            { err: eventErr, projectId },
            'budget set but not audited; the ceiling stands and the event is missing',
          );
        }

        const detail = await buildProjectDetail(db, projectId);
        if (!detail) return fail(reply, 404, 'not_found', 'Project not found.');
        request.log.info(
          { projectId, userId, budgetCeiling: body.data.budgetCeiling },
          'project budget ceiling set',
        );
        return detail;
      } catch (err) {
        request.log.error({ err, projectId, userId }, 'setProjectBudget failed');
        return fail(reply, 500, 'internal_error', 'Could not set the budget.');
      }
    },
  );

  const CampaignActionParams = z.object({
    projectId: z.string().uuid(),
    campaignId: z.string().uuid(),
  });

  /**
   * Set or clear the ceiling the optimizer judges this campaign against.
   *
   * **Setting it is the authorisation for the automatic pause** (ADR-0014), so
   * this is owner-only and audited on the budget route's exact pattern, and the
   * model never proposes the figure: nothing else writes this column, the card
   * has no field for it, and the sweep only ever reads it.
   *
   * The campaign read carries `.eq('project_id', ...)` as well as the id, which
   * is the cross-project guard: without it a valid campaign id under a project
   * the caller owns nothing of would pass the ownership check made on the
   * project named in the path.
   *
   * Legal in any campaign state, deliberately: the sweep only judges `live`
   * campaigns, so a ceiling on a terminal one is inert by construction, and
   * refusing it here would add a rule with nothing behind it. Raising or
   * clearing the ceiling on a `paused` campaign is the documented first half of
   * resuming one.
   */
  app.patch(
    '/api/projects/:projectId/campaigns/:campaignId',
    { preHandler: requireAuth },
    async (request, reply): Promise<ProjectDetail | FastifyReply> => {
      const params = CampaignActionParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'projectId and campaignId must be UUIDs.');
      }
      const body = SetCampaignCpaCeilingBody.safeParse(request.body);
      if (!body.success) {
        return fail(
          reply,
          400,
          'bad_request',
          'cpaCeiling must be a number above 0, or null to clear it.',
        );
      }

      const { projectId, campaignId } = params.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { ownerId } = await resolveProjectOwner(db, projectId);
        if (!ownerId) return fail(reply, 404, 'not_found', 'Project not found.');
        if (ownerId !== userId) {
          return fail(reply, 403, 'forbidden', 'Only the workspace owner can set a ceiling.');
        }

        const admin = createServiceClient(opts.supabase);
        const { data: before, error: beforeErr } = await admin
          .from('campaigns')
          .select('cpa_ceiling, currency')
          .eq('id', campaignId)
          .eq('project_id', projectId)
          .maybeSingle<{ cpa_ceiling: number | string | null; currency: string }>();
        if (beforeErr) throw beforeErr;
        if (!before) return fail(reply, 404, 'not_found', 'Campaign not found.');

        const { error: updateErr } = await admin
          .from('campaigns')
          .update({ cpa_ceiling: body.data.cpaCeiling })
          .eq('id', campaignId);
        if (updateErr) throw updateErr;

        // Audited with an explicit actor, exactly as the budget is: this is the
        // authorisation the sweep acts on, and `auth.uid()` reads null under the
        // service key.
        const { error: eventErr } = await admin.from('events').insert({
          project_id: projectId,
          actor_id: userId,
          actor_kind: 'user',
          verb: 'campaign.cpa_ceiling_set',
          subject_type: 'campaign',
          subject_id: campaignId,
          payload: {
            from: before.cpa_ceiling === null ? null : Number(before.cpa_ceiling),
            to: body.data.cpaCeiling,
            currency: before.currency,
          },
        });
        if (eventErr) {
          request.log.error(
            { err: eventErr, campaignId },
            'ceiling set but not audited; the ceiling stands and the event is missing',
          );
        }

        const detail = await buildProjectDetail(db, projectId);
        if (!detail) return fail(reply, 404, 'not_found', 'Project not found.');
        request.log.info(
          { projectId, campaignId, userId, cpaCeiling: body.data.cpaCeiling },
          'campaign cpa ceiling set',
        );
        return detail;
      } catch (err) {
        request.log.error({ err, projectId, campaignId, userId }, 'setCampaignCpaCeiling failed');
        return fail(reply, 500, 'internal_error', 'Could not set the ceiling.');
      }
    },
  );

  /**
   * Start a paused campaign's spend again.
   *
   * The other half of what the auto-pause slice owes: a pause with no resume
   * surface would be a product-irreversible act at `external` tier and the
   * dead-end shape this repository has recorded three times, at the worst
   * possible surface, which is somebody's money stopped with no button.
   *
   * **Resume does not clear the breach.** The ceiling is the authorisation, so
   * if the measured rollup still breaches it, the next sweep pauses the
   * campaign again under a new epoch, correctly; the panel says so beside the
   * button. Clearing `pause_reason` in the same UPDATE as the transition keeps
   * "why it was paused" in the events history, which is where a settled reason
   * belongs.
   *
   * **The platform is called before the rows move**, on the sweep's own
   * argument: a resume creates nothing and re-derives cleanly, since the epoch
   * counts `live -> paused` transitions and the campaign stays `paused` here
   * until the write lands, so a retry presents the same key. The one
   * deliberately permissive edge: this route resumes ANY paused campaign,
   * including a future `kill_switch` pause. The kill switch has no writer yet,
   * and the slice that writes one owns deciding whether an owner's resume is
   * refused there.
   */
  app.post(
    '/api/projects/:projectId/campaigns/:campaignId/resume',
    { preHandler: requireAuth },
    async (request, reply): Promise<ProjectDetail | FastifyReply> => {
      const params = CampaignActionParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'projectId and campaignId must be UUIDs.');
      }

      const { projectId, campaignId } = params.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { ownerId } = await resolveProjectOwner(db, projectId);
        if (!ownerId) return fail(reply, 404, 'not_found', 'Project not found.');
        if (ownerId !== userId) {
          return fail(reply, 403, 'forbidden', 'Only the workspace owner can resume a campaign.');
        }

        const admin = createServiceClient(opts.supabase);
        const { data: campaign, error: campaignErr } = await admin
          .from('campaigns')
          .select('id, state, channel, pause_reason')
          .eq('id', campaignId)
          .eq('project_id', projectId)
          .maybeSingle<{
            id: string;
            state: string;
            channel: string;
            pause_reason: string | null;
          }>();
        if (campaignErr) throw campaignErr;
        if (!campaign) return fail(reply, 404, 'not_found', 'Campaign not found.');
        if (campaign.state !== 'paused') {
          return fail(reply, 409, 'not_paused', 'Only a paused campaign can be resumed.');
        }

        const { data: root, error: rootErr } = await admin
          .from('ad_entities')
          .select('id, external_id')
          .eq('campaign_id', campaignId)
          .eq('kind', 'campaign')
          .not('external_id', 'is', null)
          .limit(1)
          .maybeSingle<{ id: string; external_id: string }>();
        if (rootErr) throw rootErr;
        if (!root) {
          return fail(
            reply,
            409,
            'never_published',
            'This campaign was never published, so there is nothing to resume.',
          );
        }

        const roomId = await roomForProject(admin, projectId);
        if (!roomId) {
          return fail(reply, 409, 'no_room', 'This project has no room to read an account from.');
        }

        const choice = chooseConnection(
          await readPublishableConnections(admin, roomId, campaign.channel),
        );
        if (!choice.chosen) return fail(reply, 409, choice.rule, choice.reason);
        const connection = choice.connection;

        const scopes = checkScopes({
          grantedScopes: connection.grantedScopes,
          requiredScopes: [...OPTIMIZE_REQUIRED_SCOPES],
          status: connection.status,
        });
        if (!scopes.allowed) return fail(reply, 409, scopes.rule, scopes.reason);

        // The count of prior `live -> paused` transitions. Stable through this
        // request, because the campaign is `paused` here until our write lands.
        const { count, error: countErr } = await admin
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('verb', 'campaign.transitioned')
          .eq('subject_type', 'campaign')
          .eq('subject_id', campaignId)
          .eq('payload->>from', 'live')
          .eq('payload->>to', 'paused');
        if (countErr) throw countErr;

        const adapter = adapterFor(connection.provider);
        const decision = decidePauseOutcome(
          await adapter.resume(
            { externalId: root.external_id },
            resumeIdempotencyKey(campaignId, count ?? 0),
          ),
        );

        if (decision.action === 'await_reconnect') {
          await markConnectionExpired(admin, connection.id, new Date());
          return fail(
            reply,
            409,
            'auth_expired',
            'The connection expired. Reconnect the account, then resume the campaign again.',
          );
        }
        if (decision.action === 'gone') {
          return fail(
            reply,
            409,
            'not_found_on_platform',
            `The platform no longer recognises this campaign. It said: ${decision.message}`,
          );
        }
        if (decision.action === 'retry') {
          // Synchronous HTTP rather than a sweep, so "later pass" becomes "try
          // again shortly" and the person keeps the retry button.
          if (decision.contractViolation) {
            request.log.error(
              { campaignId, kind: decision.kind, message: decision.message },
              'the adapter refused a resume with an error kind a resume cannot produce',
            );
          }
          return fail(
            reply,
            503,
            decision.kind,
            'The platform did not accept the request yet. Trying again shortly usually resolves this.',
          );
        }

        const { error: entityErr } = await admin
          .from('ad_entities')
          .update({ state: 'live' })
          .eq('id', root.id)
          .eq('state', 'paused');
        if (entityErr) throw entityErr;

        const { error: moveErr } = await admin
          .from('campaigns')
          .update({ state: 'live', pause_reason: null })
          .eq('id', campaignId)
          .eq('state', 'paused');
        if (moveErr) throw moveErr;

        // Audited with the actor, because unlike the sweep's pause this IS a
        // person's act: they pressed the button, and the trigger-written
        // transition event cannot carry who.
        const { error: eventErr } = await admin.from('events').insert({
          project_id: projectId,
          actor_id: userId,
          actor_kind: 'user',
          verb: 'campaign.resumed',
          subject_type: 'campaign',
          subject_id: campaignId,
          payload: {
            cleared_pause_reason: campaign.pause_reason,
            provider: connection.provider,
            external_id: root.external_id,
            already_existed: decision.alreadyExisted,
          },
        });
        if (eventErr) {
          request.log.error(
            { err: eventErr, campaignId },
            'campaign resumed but not audited; it is live and the event is missing',
          );
        }

        const detail = await buildProjectDetail(db, projectId);
        if (!detail) return fail(reply, 404, 'not_found', 'Project not found.');
        request.log.info({ projectId, campaignId, userId }, 'campaign resumed');
        return detail;
      } catch (err) {
        request.log.error({ err, projectId, campaignId, userId }, 'resumeCampaign failed');
        return fail(reply, 500, 'internal_error', 'Could not resume the campaign.');
      }
    },
  );

  /**
   * One project, as both the detail route and the budget route return it.
   *
   * Shared rather than duplicated so a PATCH cannot answer with a different shape
   * from the GET that follows it, which is how a panel ends up showing a stale
   * headroom figure next to a fresh ceiling.
   *
   * Reads with the caller's client throughout, so RLS decides what is visible and
   * `committedBudget` counts only campaigns this person may see.
   */
  async function buildProjectDetail(
    db: ReturnType<typeof createUserClient>,
    projectId: string,
  ): Promise<ProjectDetail | null> {
    {
      const { data: projectRow, error: projectErr } = await db
        .from('projects')
        .select(PROJECT_COLUMNS)
        .eq('id', projectId)
        .maybeSingle();
      if (projectErr) throw projectErr;
      if (!projectRow) return null;
      const project = ProjectRow.parse(projectRow);

      const [{ data: taskRows, error: taskErr }, { data: artifactRows, error: artErr }] =
        await Promise.all([
          db
            .from('tasks')
            .select(
              'id, project_id, title, detail, stage, owner_type, state, risk_tier, position, created_at, updated_at',
            )
            .eq('project_id', projectId)
            .order('position', { ascending: true }),
          db
            .from('artifacts')
            .select(
              'id, task_id, kind, title, body, storage_path, citations, created_by, created_at',
            )
            .eq('project_id', projectId)
            .order('created_at', { ascending: true }),
        ]);
      if (taskErr) throw taskErr;
      if (artErr) throw artErr;

      const byTask = new Map<string, Artifact[]>();
      for (const row of artifactRows ?? []) {
        const a = ArtifactRow.parse(row);
        const list = byTask.get(a.task_id) ?? [];
        list.push({
          id: a.id,
          taskId: a.task_id,
          kind: a.kind,
          title: a.title,
          body: a.body,
          storagePath: a.storage_path,
          citations: citationTitles(a.citations),
          createdBy: a.created_by,
          createdAt: a.created_at,
        });
        byTask.set(a.task_id, list);
      }

      // **Who took which step, read as the caller.** `engagements_select_member`
      // is `private.is_project_member(project_id)`, so this returns rows only
      // for somebody who is actually in the project's room, and this handler
      // adds no membership logic of its own.
      //
      // **Live engagements, and completed ones.** Live-only was right while the
      // only ways a deal could end were `cancelled` and `reassigned`: nothing was
      // delivered on either, the step went back to the market, and showing that
      // node's name beside it would have been a stale name presented as a current
      // one. `settle_payout` adds a third ending in which the opposite is true —
      // the work was delivered, the step is `done`, and the person who did it is
      // exactly who the owner should still see, not least because slice 8 is
      // going to ask them to rate them.
      //
      // The two other outcomes stay excluded, which is why this filters on
      // `outcome` rather than dropping the time-box: `cancelled` and
      // `reassigned` remain absent, and the panel line still never names somebody
      // beside a step they are not doing.
      const { data: engagementRows, error: engagementErr } = await db
        .from('engagements')
        .select('task_id, node_id, agreed_price, currency, accepted_at, ended_at, outcome')
        .eq('project_id', projectId)
        .or('ended_at.is.null,outcome.eq.completed');
      if (engagementErr) throw engagementErr;

      const engagements = (engagementRows ?? []) as {
        task_id: string;
        node_id: string;
        agreed_price: number | string;
        currency: string;
        accepted_at: string;
        ended_at: string | null;
        outcome: string | null;
      }[];

      // The counterparty's name, also read as the caller, through
      // `profiles_select_counterparty` (`20260904126000`, widened by
      // `20260907123000`). That policy joins through `engagements` and admits a
      // deal that is live **or** completed, which is the same predicate as the
      // read above, so the two agree by construction: a name that came back is a
      // name this person is entitled to, and one that did not renders as null
      // rather than as an error. Keeping those two conditions identical is the
      // whole reason the policy was widened in the same slice.
      //
      // **`node_profiles` is deliberately not read here.** The owner learns who
      // took their step and at what price; the node's rate card, jurisdictions
      // and availability are not facts about this deal.
      const nodeIds = [...new Set(engagements.map((e) => e.node_id))];
      const nameByNode = new Map<string, string | null>();
      if (nodeIds.length > 0) {
        const { data: profileRows, error: profileErr } = await db
          .from('profiles')
          .select('user_id, display_name')
          .in('user_id', nodeIds);
        if (profileErr) throw profileErr;
        for (const p of profileRows ?? []) {
          nameByNode.set(p.user_id as string, (p.display_name as string | null) ?? null);
        }
      }

      const engagementByTask = new Map(
        engagements.map((e) => [
          e.task_id,
          {
            nodeDisplayName: nameByNode.get(e.node_id) ?? null,
            // numeric(12,2) arrives as a string over PostgREST. Converted so the
            // panel renders a number rather than sorting money as text.
            agreedPrice: Number(e.agreed_price),
            currency: e.currency,
            acceptedAt: e.accepted_at,
            // Non-null exactly when this deal was paid, since `completed` is the
            // only ended outcome this read admits and `settle_payout` is what
            // writes it. Derived from the deal rather than joined from `payouts`:
            // one fewer read, and it cannot disagree with the row it came from.
            paidAt: e.outcome === 'completed' ? e.ended_at : null,
          },
        ]),
      );

      const tasks: Task[] = (taskRows ?? []).map((row) => {
        const t = TaskRow.parse(row);
        return {
          id: t.id,
          projectId: t.project_id,
          title: t.title,
          detail: t.detail,
          stage: t.stage,
          ownerType: t.owner_type,
          state: t.state as Task['state'],
          riskTier: t.risk_tier,
          position: t.position,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          artifacts: byTask.get(t.id) ?? [],
          engagement: engagementByTask.get(t.id) ?? null,
        };
      });

      // The room is read through the card, matching both the delivery path and
      // the RLS predicate. Null is a legacy project rather than an error.
      let roomId: string | null = null;
      if (project.source_embed_id) {
        const { data: embed, error: embedErr } = await db
          .from('action_embeds')
          .select('room_id')
          .eq('id', project.source_embed_id)
          .maybeSingle<{ room_id: string }>();
        if (embedErr) throw embedErr;
        roomId = embed?.room_id ?? null;
      }

      const { data: campaignRows, error: campaignErr } = await db
        .from('campaigns')
        .select(CAMPAIGN_COLUMNS)
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      if (campaignErr) throw campaignErr;

      // What those campaigns actually did. Read AS THE CALLER like everything
      // else on this route, so `campaign_outcomes_select_member` decides what is
      // visible and this handler adds no membership logic of its own.
      //
      // Scoped to `pull_metrics`: a `manual` correction is a second row for the
      // same window rather than a replacement, so summing both sources would
      // count a corrected day twice. The slice that writes the first manual row
      // owns that rule.
      const { data: outcomeRows, error: outcomeErr } = await db
        .from('campaign_outcomes')
        .select('campaign_id, spend, impressions, clicks, conversions, period_end')
        .eq('project_id', projectId)
        .eq('source', METRICS_SOURCE);
      if (outcomeErr) throw outcomeErr;

      const rollups = rollupOutcomes((outcomeRows ?? []) as OutcomeReadRow[]);

      const campaigns: CampaignSummary[] = (campaignRows ?? []).map((row) => {
        const c = CampaignRow.parse(row);
        // Absent from the map means nothing has been measured, which is null on
        // every figure rather than zero on any of them.
        const measured = rollups.get(c.id);
        return {
          id: c.id,
          name: c.name,
          channel: c.channel,
          state: c.state,
          budgetCap: c.budget_cap,
          currency: c.currency,
          createdAt: c.created_at,
          spendToDate: measured?.spendToDate ?? null,
          impressionsToDate: measured?.impressionsToDate ?? null,
          clicksToDate: measured?.clicksToDate ?? null,
          conversionsToDate: measured?.conversionsToDate ?? null,
          lastMeasuredAt: measured?.lastMeasuredAt ?? null,
          cpaCeiling: c.cpa_ceiling,
          pauseReason: c.pause_reason,
        };
      });

      // **The fourth of ADR-0020's four places.** The ceiling has two committer
      // classes since `20260904121000`, and a panel counting only campaigns
      // would show headroom that the next acceptance refuses to spend, which
      // reads as a broken check rather than as a full budget.
      //
      // Read as the caller, through `escrow_holds_select_member`. A hold names
      // no node: it is an amount, a currency and a state against a step, which
      // is exactly the figure this line needs.
      const { data: holdRows, error: holdErr } = await db
        .from('escrow_holds')
        .select('amount')
        .eq('project_id', projectId)
        .eq('state', 'held');
      if (holdErr) throw holdErr;

      // The same conditions `readSpendInputs`, `materialise_campaign` and
      // `accept_offer` apply, so the headroom a person reads is the arithmetic
      // those three perform rather than a friendlier version of it. The
      // arithmetic itself is a pure exported function so that a test can pin it
      // (ADR-0020).
      const { committedBudget, escrowHeld } = projectCommitments({
        campaigns,
        heldAmounts: ((holdRows ?? []) as { amount: number | string | null }[]).map(
          (h) => h.amount,
        ),
      });

      return {
        id: project.id,
        goal: project.goal,
        status: project.status,
        createdAt: project.created_at,
        roomId,
        budgetCeiling: project.budget_ceiling,
        currency: project.currency,
        committedBudget,
        // Broken out as well as folded in, because the two halves settle on
        // different clocks and an owner looking at a number they cannot reduce
        // needs to know which half is which.
        escrowHeld,
        tasks,
        campaigns,
      };
    }
  }

  /**
   * A short-lived download link for one file artifact.
   *
   * **The artifact row is read with the caller-scoped client, and that read is
   * the authorization.** RLS row visibility decides whether this person may have
   * the file: if `artifacts_select_member` does not return the row, there is
   * nothing to sign. The service client is used only afterwards, to mint the
   * URL, because signing needs a key no client may hold. Reading the row with
   * the service client and then checking membership in code would put the
   * authorization back in this handler, where the next handler would have to
   * remember to repeat it.
   *
   * The `storage.objects` select policy added by `20260829124000` is the second
   * layer, and both terminate in `private.is_project_member`, so the policy and
   * this route agree by construction rather than by two people remembering the
   * same rule.
   *
   * **The signed URL is never logged.** It is a bearer capability: anyone holding
   * it can fetch the object until it expires, so it belongs in the response and
   * nowhere else, exactly like an access token.
   */
  app.get(
    '/api/projects/:projectId/artifacts/:artifactId/file-url',
    { preHandler: requireAuth },
    async (request, reply): Promise<ArtifactFileUrl | FastifyReply> => {
      const params = ArtifactParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'projectId and artifactId must be UUIDs.');
      }
      const { projectId, artifactId } = params.data;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { data: row, error } = await db
          .from('artifacts')
          .select('id, storage_path')
          .eq('id', artifactId)
          .eq('project_id', projectId)
          .maybeSingle<{ id: string; storage_path: string | null }>();
        if (error) throw error;

        const decision = decideFileUrl(row);
        if (decision.kind === 'not_found') {
          request.log.info(
            { projectId, artifactId, reason: decision.reason, userId: request.user?.sub },
            'file url refused',
          );
          return fail(reply, 404, 'not_found', 'No file is available for that artifact.');
        }

        const admin = createServiceClient(opts.supabase);
        const { data: signed, error: signErr } = await admin.storage
          .from('artifacts')
          .createSignedUrl(decision.storagePath, SIGNED_URL_TTL_SECONDS);
        if (signErr) throw signErr;

        // An absent URL with no error would otherwise be returned as `undefined`
        // and fail Zod parsing at the client, which reads as a contract bug
        // rather than as a missing object.
        if (!signed?.signedUrl) {
          request.log.error({ projectId, artifactId }, 'storage returned no signed url');
          return fail(reply, 404, 'not_found', 'No file is available for that artifact.');
        }

        return { url: signed.signedUrl, expiresAt: signedUrlExpiresAt(Date.now()) };
      } catch (err) {
        // The message, not the error object. Rule 16 forbids a silent failure, so
        // something has to be logged; the storage client's errors can carry a
        // response body, and a signed URL that reached the logs would outlive the
        // request that was allowed to have it.
        request.log.error(
          {
            projectId,
            artifactId,
            userId: request.user?.sub,
            err: err instanceof Error ? err.message : String(err),
          },
          'getArtifactFileUrl failed',
        );
        return fail(reply, 500, 'internal_error', 'Could not prepare the download.');
      }
    },
  );
}
