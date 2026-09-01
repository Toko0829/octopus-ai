import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { carriesRealMoney, FAKE_PROVIDER } from '@octopus/payments';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createRequireOps } from '../plugins/require-ops';
import { createServiceClient, type SupabaseConfig } from '../lib/supabase';
import { postSystemMessage } from '../lib/system-message';
import { roomForProject } from '../lib/room-for-project';

/**
 * The dispute console, and **the first ops surface in this system.**
 *
 * admin-ops.md specifies seven consoles. This is one of them, deliberately:
 * disputes are the only one whose absence creates a dead end, because
 * `20260908120000` made `disputed` reachable and nothing else can move a task
 * out of it. Moderation, node ops, payments reconciliation and the audit-trail
 * explorer stay Phase 3, which is where the roadmap has them. Pulling one
 * console forward is what closes the state; pulling all seven forward would be
 * building six surfaces with no reachable state behind them, which is the defect
 * this repository keeps recording in the other direction.
 *
 * ---------- This is the first legitimate reader of `ledger_entries` ----------
 *
 * `20260904122000` gave that table RLS with **no policy and no client grant at
 * all**, and said in the migration that "the reader of raw entries is the
 * Phase-3 ops console". `ops_actions` lands with the same posture in
 * `20260908123000`. Both are read here as `service_role`, behind `requireOps`,
 * which reads `profiles.role` from the database rather than from the JWT — the
 * claim does not carry it (see `plugins/require-ops.ts` for why that is not a
 * detail).
 *
 * security-compliance.md:29 sets a stricter precedent — a dedicated
 * least-privilege Postgres role rather than the key that bypasses RLS — and it
 * is **not** taken here, which is a decision rather than an omission. That
 * precedent was written about giving an eval harness database access, where the
 * alternative was handing a scheduled job the service key. Here the service
 * client is already the writer of every marketplace RPC in the same process, so
 * a second connection with narrower rights would narrow nothing that this
 * process does not already hold. It becomes worth building when ops moves out of
 * this API into its own deployment, and that trigger is recorded in
 * security-compliance.md rather than left implied.
 */

const Params = z.object({ disputeId: z.string().uuid() });

const ListQuery = z.object({
  status: z.enum(['open', 'resolved']).default('open'),
});

const ResolveBody = z.object({
  resolution: z.enum(['released', 'refunded', 'partial', 'reassigned', 'rejection_upheld']),
  /**
   * Required, and required **here** as well as in SQL. `ops_actions.reason` is
   * `not null` and checked non-empty, so an unexplained resolution cannot be
   * recorded and therefore cannot happen — but a person deserves to be told that
   * before the request, not by a constraint violation after it.
   */
  reason: z.string().trim().min(1).max(4000),
  /**
   * The node's share, on a partial and nowhere else. **Only the release amount
   * is entered**, and the refund is derived as `hold − release`: two fields that
   * must sum to a third are two ways to type a number that does not add up, and
   * the console shows the derived refund before the operator confirms.
   */
  releaseAmount: z.number().positive().optional(),
});

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/** Postgres raises every deliberate refusal in this domain as a check violation. */
const PG_CHECK_VIOLATION = '23514';

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** The resolutions that settle escrow, and therefore need the counsel gate checked. */
const MOVES_MONEY: ReadonlySet<string> = new Set(['refunded', 'partial', 'reassigned']);

/**
 * The queue row, named because the two orderings below are two separate queries
 * and PostgREST infers nothing useful across a union of them.
 */
interface DisputeListRow {
  id: string;
  task_id: string;
  engagement_id: string;
  project_id: string;
  raised_by: string;
  raised_role: string;
  reason: string;
  from_state: string;
  resolution: string | null;
  release_amount: string | number | null;
  refund_amount: string | number | null;
  resolved_at: string | null;
  created_at: string;
}

export interface OpsRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  /**
   * The registered payment provider, checked before any resolution that settles
   * escrow. Defaults to the in-repo fake exactly as `payoutSweep` does
   * (`deps.provider ?? FAKE_PROVIDER`), so the two money surfaces cannot end up
   * gated against different providers.
   */
  paymentProvider?: string;
}

export async function opsRoutes(app: FastifyInstance, opts: OpsRoutesOptions): Promise<void> {
  const providerName = opts.paymentProvider ?? FAKE_PROVIDER;
  const requireAuth = createRequireAuth(opts.verify);
  const requireOps = createRequireOps(opts.supabase);
  const preHandler = [requireAuth, requireOps];

  /**
   * The role echo the `/ops` page gates on.
   *
   * A separate call rather than a field on some larger payload, because the RSC
   * needs the answer before it renders anything and must not have to fetch a
   * console's worth of data to learn it may not see the console.
   */
  app.get('/api/ops/me', { preHandler }, async (request, reply): Promise<FastifyReply> => {
    const actor = request.opsActor as NonNullable<typeof request.opsActor>;
    return reply.code(200).send({ userId: actor.userId, role: actor.role });
  });

  /**
   * The queue. Open disputes oldest-first, because the oldest freeze is the one
   * where somebody has been waiting longest with their money held.
   */
  app.get('/api/ops/disputes', { preHandler }, async (request, reply): Promise<FastifyReply> => {
    const query = ListQuery.safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, 'bad_request', 'Ask for open or resolved.');

    const admin = createServiceClient(opts.supabase);

    // The two orderings are written out in full rather than built by reassigning
    // one builder: PostgREST infers the row type from the literal select string,
    // and a reassigned builder or a hoisted `columns` variable loses it. They
    // also differ in more than a filter, which is the reason worth stating:
    // **open is oldest-first** because the longest freeze is the one where
    // somebody has been waiting longest with their money held, and **resolved is
    // newest-first** because that list is read to check recent decisions rather
    // than to work through a queue.
    const { data, error } =
      query.data.status === 'open'
        ? await admin
            .from('disputes')
            .select(
              'id, task_id, engagement_id, project_id, raised_by, raised_role, reason, from_state, resolution, release_amount, refund_amount, resolved_at, created_at',
            )
            .is('resolved_at', null)
            .order('created_at', { ascending: true })
            .limit(200)
        : await admin
            .from('disputes')
            .select(
              'id, task_id, engagement_id, project_id, raised_by, raised_role, reason, from_state, resolution, release_amount, refund_amount, resolved_at, created_at',
            )
            .not('resolved_at', 'is', null)
            .order('resolved_at', { ascending: false })
            .limit(200);

    if (error) {
      request.log.error({ err: error }, 'could not list disputes');
      return fail(reply, 500, 'internal_error', 'Could not load the queue.');
    }

    const rows = (data ?? []) as DisputeListRow[];
    // Two batched reads rather than a join, for `payout.ts`' stated reason:
    // PostgREST relationship guessing fails silently, and these are the rows an
    // operator decides money on.
    const taskIds = [...new Set(rows.map((d) => d.task_id as string))];
    const { data: taskRows } = taskIds.length
      ? await admin.from('tasks').select('id, title, state').in('id', taskIds)
      : { data: [] };
    const taskById = new Map((taskRows ?? []).map((t) => [t.id as string, t]));

    return reply.code(200).send({
      disputes: rows.map((d) => ({
        id: d.id,
        taskId: d.task_id,
        taskTitle: (taskById.get(d.task_id as string)?.title as string) ?? 'a step',
        taskState: (taskById.get(d.task_id as string)?.state as string) ?? null,
        raisedRole: d.raised_role,
        reason: d.reason,
        fromState: d.from_state,
        resolution: d.resolution,
        // numeric(12,2) arrives as a string over PostgREST. Converted at the
        // boundary, on the house rule, so nothing downstream does arithmetic on
        // a string.
        releaseAmount: d.release_amount === null ? null : Number(d.release_amount),
        refundAmount: d.refund_amount === null ? null : Number(d.refund_amount),
        resolvedAt: d.resolved_at,
        createdAt: d.created_at,
      })),
    });
  });

  /**
   * One dispute, with everything an operator needs to decide it without leaving
   * the page: the grievance, both parties, the money, and the trail.
   *
   * **The roster includes expired memberships on purpose.** `reassign_engagement`
   * and `resolve_dispute` stamp `room_members.expires_at` rather than deleting
   * the row, "so the roster still records that this person was here, which is
   * what a dispute reads". This is the reader that sentence was written for.
   */
  app.get(
    '/api/ops/disputes/:disputeId',
    { preHandler },
    async (request, reply): Promise<FastifyReply> => {
      const params = Params.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'Bad dispute id.');

      const admin = createServiceClient(opts.supabase);
      const { data: dispute, error } = await admin
        .from('disputes')
        .select('*')
        .eq('id', params.data.disputeId)
        .maybeSingle();
      if (error) {
        request.log.error({ err: error }, 'could not read a dispute');
        return fail(reply, 500, 'internal_error', 'Could not load that dispute.');
      }
      if (!dispute) return fail(reply, 404, 'not_found', 'Dispute not found.');

      const [task, engagement, hold, payout, ledger, thread] = await Promise.all([
        admin
          .from('tasks')
          .select('id, title, state, stage')
          .eq('id', dispute.task_id)
          .maybeSingle(),
        admin
          .from('engagements')
          .select(
            'id, node_id, agreed_price, currency, accepted_at, deadline_at, ended_at, outcome',
          )
          .eq('id', dispute.engagement_id)
          .maybeSingle(),
        admin
          .from('escrow_holds')
          .select('id, amount, currency, state, created_at')
          .eq('task_id', dispute.task_id)
          .order('created_at', { ascending: true }),
        admin
          .from('payouts')
          .select('id, state, amount, currency, transfer_id, created_at')
          .eq('engagement_id', dispute.engagement_id),
        admin
          .from('ledger_entries')
          .select('account, debit, credit, currency, ref_type, ref_id, created_at')
          .eq('ref_type', 'escrow_hold')
          .order('created_at', { ascending: true }),
        admin.from('threads').select('id').eq('task_id', dispute.task_id).maybeSingle(),
      ]);

      const holds = hold.data ?? [];
      const holdIds = new Set(holds.map((h) => h.id as string));
      // Filtered here rather than in the query, because `ref_id` is a uuid across
      // every hold in the system and the interesting set is this task's.
      const entries = (ledger.data ?? []).filter((e) => holdIds.has(e.ref_id as string));

      // **`room_members` has no `created_at`; the column is `joined_at`.** The
      // first version of this select asked for `created_at`, which every other
      // table in this schema does have, and PostgREST answered `42703` for the
      // whole query rather than ignoring the unknown column. The roster then came
      // back empty and rendered as "nobody was admitted to this thread", which is
      // a sentence rather than an error — so the operator lost the one piece of
      // evidence this pane exists to show, and nothing anywhere said why.
      //
      // Neither column is projected below (the response carries `expiresAt` and
      // not a join date), so the fix is to stop asking for it rather than to
      // rename it: a field no reader wants is not worth a contract change.
      //
      // **No route test could have caught this**, and that is the point worth
      // keeping: `ops.test.ts` stubs the Supabase client, so a select string is
      // never parsed by anything. It was found by asking the running API for a
      // real dispute.
      const roster = thread.data?.id
        ? await admin
            .from('room_members')
            .select('user_id, role, scope, expires_at')
            .eq('thread_id', thread.data.id)
        : { data: [], error: null };

      // **Logged rather than swallowed**, which is the other half of the same
      // defect (rule 16). `roster.data ?? []` turns any failure into an empty
      // list, and an empty roster is a legitimate answer here — a dispute raised
      // before anybody was admitted has one — so the two are indistinguishable on
      // the screen. They must at least be distinguishable in the log.
      if (roster.error) {
        request.log.error(
          { err: roster.error, disputeId: params.data.disputeId },
          'could not read the thread roster for a dispute: the pane will show an empty roster',
        );
      }

      // Both parties by name. Read as `service_role` because an operator is
      // neither of them, so `private.engaged_counterparty` would answer false —
      // it is the projection for the two sides, not for a third party who is
      // entitled to see both.
      const partyIds = [dispute.raised_by as string, engagement.data?.node_id as string].filter(
        Boolean,
      );
      const { data: profiles } = partyIds.length
        ? await admin.from('profiles').select('user_id, display_name').in('user_id', partyIds)
        : { data: [] };
      const nameById = new Map(
        (profiles ?? []).map((p) => [p.user_id as string, p.display_name as string | null]),
      );

      return reply.code(200).send({
        dispute: {
          id: dispute.id,
          taskId: dispute.task_id,
          engagementId: dispute.engagement_id,
          projectId: dispute.project_id,
          raisedBy: dispute.raised_by,
          raisedByName: nameById.get(dispute.raised_by as string) ?? null,
          raisedRole: dispute.raised_role,
          reason: dispute.reason,
          evidence: dispute.evidence,
          fromState: dispute.from_state,
          resolution: dispute.resolution,
          releaseAmount: dispute.release_amount === null ? null : Number(dispute.release_amount),
          refundAmount: dispute.refund_amount === null ? null : Number(dispute.refund_amount),
          resolutionNote: dispute.resolution_note,
          resolvedAt: dispute.resolved_at,
          createdAt: dispute.created_at,
        },
        task: task.data
          ? {
              id: task.data.id,
              title: task.data.title,
              state: task.data.state,
              stage: task.data.stage,
            }
          : null,
        engagement: engagement.data
          ? {
              id: engagement.data.id,
              nodeId: engagement.data.node_id,
              nodeName: nameById.get(engagement.data.node_id as string) ?? null,
              agreedPrice: Number(engagement.data.agreed_price),
              currency: engagement.data.currency,
              acceptedAt: engagement.data.accepted_at,
              deadlineAt: engagement.data.deadline_at,
              endedAt: engagement.data.ended_at,
              outcome: engagement.data.outcome,
            }
          : null,
        holds: holds.map((h) => ({
          id: h.id,
          amount: Number(h.amount),
          currency: h.currency,
          state: h.state,
          createdAt: h.created_at,
        })),
        payouts: (payout.data ?? []).map((p) => ({
          id: p.id,
          state: p.state,
          amount: Number(p.amount),
          currency: p.currency,
          transferId: p.transfer_id,
          createdAt: p.created_at,
        })),
        ledger: entries.map((e) => ({
          account: e.account,
          debit: Number(e.debit),
          credit: Number(e.credit),
          currency: e.currency,
          refId: e.ref_id,
          createdAt: e.created_at,
        })),
        roster: (roster.data ?? []).map((m) => ({
          userId: m.user_id,
          name: nameById.get(m.user_id as string) ?? null,
          role: m.role,
          scope: m.scope,
          // Present and non-null means this person's access was ended. Shown
          // rather than filtered: who was here is the point.
          expiresAt: m.expires_at,
        })),
      });
    },
  );

  /**
   * The decision.
   *
   * Everything consequential happens inside `public.resolve_dispute`, in one
   * transaction, because every partial state here is a money defect somebody
   * reconciles by hand. This route's whole job is to refuse readably before that
   * transaction starts, and to say what happened after it commits.
   */
  app.post(
    '/api/ops/disputes/:disputeId/resolve',
    { preHandler },
    async (request, reply): Promise<FastifyReply> => {
      const params = Params.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'Bad dispute id.');
      const body = ResolveBody.safeParse(request.body);
      if (!body.success) {
        return fail(
          reply,
          400,
          'bad_request',
          'Say which resolution, and why. A partial also needs the amount the expert keeps.',
        );
      }

      const actor = request.opsActor as NonNullable<typeof request.opsActor>;
      const { resolution, reason, releaseAmount } = body.data;
      const admin = createServiceClient(opts.supabase);

      if (resolution === 'partial' && releaseAmount === undefined) {
        return fail(reply, 400, 'bad_request', 'Say how much the expert keeps.');
      }
      if (resolution !== 'partial' && releaseAmount !== undefined) {
        return fail(
          reply,
          400,
          'bad_request',
          'An amount only means something on a partial settlement.',
        );
      }

      try {
        // **Replay short-circuit**, the accept-offer idiom. An operator who
        // double-clicked, or a retried request, reads back the decision that was
        // already made rather than being told their own act was a conflict.
        const { data: existing } = await admin
          .from('disputes')
          .select('id, resolution, resolved_at, resolution_note')
          .eq('id', params.data.disputeId)
          .maybeSingle();
        if (!existing) return fail(reply, 404, 'not_found', 'Dispute not found.');
        if (existing.resolved_at) {
          return reply.code(200).send({
            dispute: {
              id: existing.id,
              resolution: existing.resolution,
              resolvedAt: existing.resolved_at,
              resolutionNote: existing.resolution_note,
            },
            replayed: true,
          });
        }

        // **The counsel gate, before anything is written**, and on the same terms
        // as the payout sweep: `carriesRealMoney` raises on an unregistered
        // provider rather than answering `false`, so an unreviewed integration is
        // refused rather than waved through. Only the three resolutions that
        // settle escrow are gated — `released` moves no money here (it returns
        // the step to `approved` and the existing sweep pays, behind that
        // sweep's own identical check) and `rejection_upheld` moves none at all.
        if (MOVES_MONEY.has(resolution) && carriesRealMoney(providerName)) {
          request.log.error(
            { provider: providerName, disputeId: params.data.disputeId },
            'refusing to settle a dispute: this provider moves real money, and the counsel gate ' +
              'in docs/30-modules/payments-billing.md has not been cleared',
          );
          return fail(
            reply,
            503,
            'unavailable',
            'Settling money is not enabled in this deployment.',
          );
        }

        const { data: resolvedId, error: rpcError } = await admin.rpc('resolve_dispute', {
          p_dispute_id: params.data.disputeId,
          p_actor_id: actor.userId,
          p_resolution: resolution,
          p_reason: reason,
          p_release_amount: releaseAmount ?? null,
        });

        if (rpcError) {
          if (pgCode(rpcError) === PG_CHECK_VIOLATION) {
            // The raise's own sentence, verbatim. Those messages are written for
            // exactly this moment and summarising them loses the reason.
            return fail(reply, 409, 'conflict', rpcError.message);
          }
          throw rpcError;
        }

        const { data: settled } = await admin
          .from('disputes')
          .select('id, task_id, project_id, resolution, release_amount, refund_amount, resolved_at')
          .eq('id', resolvedId as string)
          .maybeSingle();

        // The room hears about it, on the standing pattern: an act with a
        // consequence for the owner is announced where they are, keyed so a
        // crash between the act and the announcement cannot produce two lines.
        const roomId = settled?.project_id
          ? await roomForProject(admin, settled.project_id as string)
          : null;
        if (roomId) {
          await postSystemMessage(
            admin,
            request.log,
            roomId,
            `dispute-resolved:${params.data.disputeId}`,
            disputeNotice(resolution),
          );
        }

        request.log.info(
          { disputeId: params.data.disputeId, actorId: actor.userId, resolution },
          'operator resolved a dispute',
        );

        return reply.code(200).send({
          dispute: settled
            ? {
                id: settled.id,
                taskId: settled.task_id,
                resolution: settled.resolution,
                releaseAmount:
                  settled.release_amount === null ? null : Number(settled.release_amount),
                refundAmount: settled.refund_amount === null ? null : Number(settled.refund_amount),
                resolvedAt: settled.resolved_at,
              }
            : { id: resolvedId },
          replayed: false,
        });
      } catch (err) {
        request.log.error(
          { err, disputeId: params.data.disputeId, actorId: actor.userId },
          'could not resolve a dispute',
        );
        return fail(reply, 500, 'internal_error', 'Could not record that decision.');
      }
    },
  );
}

/**
 * What the room is told. Templated rather than generated, because brand voice is
 * an enforced rule and this sentence lands in somebody's chat about their money.
 *
 * It says what happened and not why: the operator's reason is on the dispute
 * record for the parties to read, and paraphrasing an adjudication into a chat
 * line is how a decision acquires a second, looser version of itself.
 */
function disputeNotice(resolution: string): string {
  switch (resolution) {
    case 'released':
      return 'A dispute on this project was resolved in the expert’s favour. The step goes back to being paid.';
    case 'refunded':
      return 'A dispute on this project was resolved in your favour. The escrow has been returned and the step is closed.';
    case 'partial':
      return 'A dispute on this project was settled in part. Some of the escrow went to the expert and the rest came back to you.';
    case 'reassigned':
      return 'A dispute on this project was resolved by returning the step to the market. The escrow came back and a new expert can take it.';
    default:
      return 'A dispute on this project was resolved. The step has gone back to the expert to redo.';
  }
}
