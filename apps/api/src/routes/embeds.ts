import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CampaignEmbedPayload, EmbedActionBody } from '@octopus/contracts';
import { summarise, tick } from '@octopus/core';
import { checkSpendCap } from '@octopus/marketing';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { createSchedulerPorts } from '../lib/scheduler';
import { notifyWaiting } from '../lib/waiting';
import { produceCampaignCards } from '../lib/campaign-cards';
import { readSpendInputs, spendCapInput } from '../lib/spend-reads';

/**
 * Acting on an interactive embed: the approve / request-changes path for a plan
 * card, and the shape Pay / Sign / Assign will reuse.
 *
 * Five checks, in order, none of which the client can supply an answer for:
 *
 *   1. **Membership**, evaluated by RLS as the caller. A non-member gets 404, not
 *      403: the room is invisible to them and the API does not confirm it exists.
 *   2. **Component**, as an allow-list. `approve` means "materialise this plan",
 *      so a card that is not a plan has nothing for this route to do and is
 *      refused rather than passed to a function written for a different payload.
 *   3. **`required_role`**, re-checked here. The UI is told the role so it can
 *      disable what the caller cannot do, but that is a courtesy. A rule enforced
 *      only in React is not enforced.
 *   4. **State**, so an embed is single-use. Approving twice is two approvals,
 *      which matters little for a plan and enormously for Pay and Sign, so the
 *      guard belongs here rather than being added when money arrives.
 *   5. **A conditional update**, so two concurrent approvals cannot both win.
 *      Checking state and then writing it is a race; `eq('state','pending')` in
 *      the same statement is not.
 *
 * The verdict is also recorded as a `feedback_events` row: flywheel v0. That is
 * the point of the feature, not a side effect of it.
 */

const Params = z.object({
  roomId: z.string().uuid(),
  embedId: z.string().uuid(),
});

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface EmbedRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  /** Budget for one execution step. Defaults to the production value. */
  aiTimeoutMs?: number;
}

export async function embedRoutes(app: FastifyInstance, opts: EmbedRoutesOptions): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  app.post(
    '/api/rooms/:roomId/embeds/:embedId/actions',
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = Params.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'roomId and embedId must be UUIDs.');
      }
      const parsed = EmbedActionBody.safeParse(request.body);
      if (!parsed.success) {
        return fail(reply, 400, 'bad_request', 'action must be approve or request_changes.');
      }

      const { roomId, embedId } = params.data;
      const { action, note, budgetCap } = parsed.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      // (1) Read as the caller, so RLS decides visibility rather than this code
      // re-implementing membership.
      const db = createUserClient(opts.supabase, request.accessToken as string);
      const { data: embed, error: readError } = await db
        .from('action_embeds')
        .select('id, room_id, component, payload, required_role, state')
        .eq('id', embedId)
        .eq('room_id', roomId)
        .maybeSingle();

      if (readError) {
        request.log.error({ err: readError, embedId }, 'embed read failed');
        return fail(reply, 500, 'internal_error', 'Could not load the card.');
      }
      if (!embed) return fail(reply, 404, 'not_found', 'Card not found.');

      // (2) The card must be one this route knows how to act on, and the list is
      // an allow-list rather than a deny-list.
      //
      // `approve` means "commit what this card proposes", and which commit that is
      // depends on the component: a plan becomes a project, a replan changes one
      // that is already running. It is reached by embed id alone, so a question
      // card, which has no verdict to give and no stages to build from, would hand
      // a payload to a function never written for it. Any component added later is
      // refused until someone writes what acting on it means, which is the same
      // direction the `required_role` check below already fails in.
      if (
        embed.component !== 'plan' &&
        embed.component !== 'replan' &&
        embed.component !== 'campaign'
      ) {
        return fail(reply, 409, 'conflict', 'This card is not one you approve or reject.');
      }

      // `budgetCap` is meaningful on exactly one component, and a number sent
      // with any other card is refused rather than ignored. Ignoring it would
      // accept a request that says "authorise this much", act on it as though it
      // said nothing about money, and answer 200: the caller would have every
      // reason to believe a figure had been recorded.
      if (budgetCap !== undefined && embed.component !== 'campaign') {
        return fail(reply, 400, 'bad_request', 'Only a campaign card carries a budget.');
      }

      // (3) required_role. Only 'owner' exists today; an unknown value denies
      // rather than defaults to permitted, so adding a role cannot accidentally
      // open an action before its check is written.
      if (embed.required_role === 'owner') {
        const { data: room, error: roomError } = await db
          .from('rooms')
          .select('owner_id')
          .eq('id', roomId)
          .maybeSingle();
        if (roomError) {
          request.log.error({ err: roomError, roomId }, 'owner check failed');
          return fail(reply, 500, 'internal_error', 'Could not check permissions.');
        }
        if (!room?.owner_id || room.owner_id !== userId) {
          return fail(reply, 403, 'forbidden', 'Only the workspace owner can act on this card.');
        }
      } else {
        return fail(reply, 403, 'forbidden', 'You cannot act on this card.');
      }

      // (4) Single-use.
      if (embed.state !== 'pending') {
        return fail(reply, 409, 'conflict', `This card was already ${embed.state}.`);
      }

      const nextState = action === 'approve' ? 'approved' : 'rejected';
      const admin = createServiceClient(opts.supabase);

      // (6) Approving a campaign is authorising spend, so the cap is checked
      // before the verdict is recorded rather than after.
      //
      // This is the readable half of a check that exists twice. Here it can
      // refuse with the numbers in a sentence and leave the card PENDING, so the
      // owner can enter a smaller figure and approve the same card. The
      // authoritative half is inside `materialise_campaign`, under a row lock,
      // because two cards approved in the same instant both pass this one: each
      // reads the committed total before either writes. Neither is redundant.
      // Dropping this one turns a lowered budget into an opaque failure after the
      // decision was already recorded; dropping that one lets the sum of
      // authorised caps exceed the ceiling in the table whose whole purpose is
      // recording what was authorised.
      let approvedPayload: Record<string, unknown> | null = null;
      if (embed.component === 'campaign' && action === 'approve') {
        if (budgetCap === undefined) {
          return fail(reply, 400, 'bad_request', 'Enter a budget before approving this campaign.');
        }

        const payload = CampaignEmbedPayload.safeParse(embed.payload);
        if (!payload.success) {
          request.log.error({ embedId }, 'campaign card payload is unreadable');
          return fail(reply, 409, 'conflict', 'This card cannot be read.');
        }

        let reads;
        try {
          reads = await readSpendInputs(admin, payload.data.projectId);
        } catch (err) {
          request.log.error({ err, embedId }, 'could not read the spend inputs');
          return fail(reply, 500, 'internal_error', 'Could not check the budget.');
        }

        const verdict = checkSpendCap(spendCapInput(reads, budgetCap));
        if (!verdict.allowed) {
          // 409 and not 403: nothing about the caller is wrong, the number is.
          // The card stays pending, which is what makes retrying with a smaller
          // figure the obvious next move rather than a dead end.
          request.log.info(
            { embedId, rule: verdict.rule, projectId: payload.data.projectId },
            'campaign approval refused by the spend cap',
          );
          return fail(reply, 409, 'conflict', verdict.reason);
        }

        // The number the owner typed becomes part of the card, written in the
        // same statement that records the verdict below. What was approved has to
        // be what gets built, and `materialise_campaign` reads the payload rather
        // than taking arguments, so a cap passed alongside the card instead of
        // into it would be a figure nobody could later prove was authorised.
        approvedPayload = { ...payload.data, budgetCap };
      }

      // (5) Conditional on still being pending, so a double submit updates once.
      const { data: updated, error: updateError } = await admin
        .from('action_embeds')
        .update({
          state: nextState,
          acted_by: userId,
          acted_at: new Date().toISOString(),
          ...(approvedPayload ? { payload: approvedPayload } : {}),
        })
        .eq('id', embedId)
        .eq('state', 'pending')
        .select('id, state')
        .maybeSingle();

      if (updateError) {
        request.log.error({ err: updateError, embedId }, 'embed update failed');
        return fail(reply, 500, 'internal_error', 'Could not record the decision.');
      }
      if (!updated) return fail(reply, 409, 'conflict', 'This card was already acted on.');

      // Flywheel v0. Written after the state change so a recorded label always
      // corresponds to a decision that actually took effect, and failing here
      // must not un-approve the plan: the decision stands, the label is retried
      // by whoever notices the gap. Logged loudly rather than swallowed.
      const { error: feedbackError } = await admin.from('feedback_events').insert({
        room_id: roomId,
        embed_id: embedId,
        actor_id: userId,
        verdict: action === 'approve' ? 'approved' : 'changes_requested',
        note: note ?? null,
        // The payload as approved, which for a campaign includes the cap the
        // owner just typed. Recording the pre-update read instead would hand the
        // flywheel a labelled example of somebody approving a campaign with no
        // budget, which is not what happened and is the one field on this card
        // that a person, rather than a model, supplied.
        subject: approvedPayload ?? embed.payload,
      });
      if (feedbackError) {
        request.log.error(
          { err: feedbackError, embedId, roomId },
          'flywheel signal not recorded; the decision stands but the label is missing',
        );
      }

      // Approving a plan is what turns it into work: a project, and one task per
      // step. Everything happens inside `materialise_plan`, because supabase-js
      // speaks PostgREST and has no transactions, and a project created without
      // its tasks is a project the scheduler would call finished.
      //
      // The function reads the payload from the embed itself rather than taking a
      // task list from here. That is the point: the person approved a specific
      // plan, so the rows built must be derived from the thing they read, not
      // from whatever this code happens to send.
      //
      // Ordered after the state change, and idempotent per embed, which together
      // decide what a retry does. If this fails, the decision still stands and the
      // card still reads approved; retrying materialises exactly once, because
      // `projects.source_embed_id` is unique. Failing loudly here rather than
      // rolling back the approval keeps the person's decision from being silently
      // undone by an error they cannot see.
      // A replan card commits through its own function, and the two are siblings
      // rather than variants: both read the payload from the card, both are
      // idempotent by their own provenance, and both are one transaction because
      // half an applied diff is a project in a state nobody reviewed.
      // A campaign card commits through its own function, the third sibling of
      // the same shape: one transaction, payload read from the card, idempotent
      // by its own provenance, and unknown values raise.
      const commit =
        embed.component === 'replan'
          ? 'apply_plan_diff'
          : embed.component === 'campaign'
            ? 'materialise_campaign'
            : 'materialise_plan';

      let projectId: string | null = null;
      let campaignId: string | null = null;
      if (action === 'approve') {
        const { data, error: materialiseError } = await admin.rpc(commit, {
          p_embed_id: embedId,
        });
        if (materialiseError) {
          request.log.error(
            { err: materialiseError, embedId, roomId, commit },
            'card approved but not committed; the card stands and the change is missing',
          );
        } else if (embed.component === 'campaign') {
          // This function returns the campaign, not the project. The project is
          // the one named in the payload, and it is reported so the client can
          // refresh the panel the new campaign appears in.
          campaignId = data as string;
          const parsedPayload = CampaignEmbedPayload.safeParse(approvedPayload ?? embed.payload);
          projectId = parsedPayload.success ? parsedPayload.data.projectId : null;
          request.log.info({ embedId, roomId, campaignId, projectId }, 'campaign authorised');
        } else {
          projectId = data as string;
          request.log.info({ embedId, roomId, projectId, commit }, 'card committed');
        }

        // One scheduler tick, immediately, whichever card this was. A project
        // whose tasks sit PENDING until some future trigger fires is
        // indistinguishable from a project that did not get created, and the
        // person just approved it: the useful moment to show what happens next is
        // now.
        //
        // It matters for a campaign too, and not only for a plan.
        // `materialise_campaign` moves the authorising step to `approved`, which
        // is exactly what makes anything depending on it ready, so skipping the
        // tick here would leave the unblocked work sitting until the next
        // 30-second pass for no reason.
        //
        // Not awaited-into-the-response-shape and not fatal. The approval and
        // whatever it created both stand whatever the tick does, and the next
        // tick will find the same tasks and pick them up.
        if (projectId) {
          try {
            const ports = createSchedulerPorts(admin, {
              aiServiceUrl: opts.aiServiceUrl,
              aiTimeoutMs: opts.aiTimeoutMs,
              log: request.log,
            });
            const report = await tick(projectId, ports);
            request.log.info({ projectId, ...summarise(report) }, 'scheduler tick after approval');
            // The person is right here, having just approved. A step that needs
            // them should say so now rather than on the next tick.
            await notifyWaiting(admin, report, request.log);
            // And a step that stopped for an authorisation gets the card that
            // lets them give it, on the same pass.
            await produceCampaignCards(admin, report, {
              aiServiceUrl: opts.aiServiceUrl,
              aiTimeoutMs: opts.aiTimeoutMs,
              log: request.log,
            });
          } catch (tickError) {
            request.log.error(
              { err: tickError, projectId },
              'scheduler tick failed; the project stands and its tasks remain pending',
            );
          }
        }
      }

      // The decision belongs in the room as a system message: the chat is the
      // audit trail (discord-chat-spec.md), and a state change nobody can see is
      // not one anyone can dispute.
      const approvedCopy =
        embed.component === 'replan'
          ? 'Plan changes applied.'
          : embed.component === 'campaign'
            ? // Says what happens next as plainly as what just happened. This
              // sentence used to promise that nothing would be published, and it
              // was true until the publish sweep existed. Approving IS the
              // authorisation now (ADR-0013), so the promise had to change where
              // it was made rather than quietly stop being kept.
              'Campaign approved. Publishing starts on the next pass, usually within half a minute. ' +
              'It will never spend more than the cap you set.'
            : 'Plan approved.';
      const rejectedCopy =
        embed.component === 'campaign'
          ? 'Campaign not approved. The step still needs you.'
          : 'Changes requested.';
      const summary =
        action === 'approve' ? approvedCopy : `${rejectedCopy}${note ? ` Note: ${note}` : ''}`;
      const { error: noticeError } = await admin.from('messages').insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'system',
        body: summary,
        idempotency_key: `embed-action:${embedId}`,
      });
      if (noticeError && noticeError.code !== '23505') {
        request.log.error({ err: noticeError, embedId }, 'could not post decision notice');
      }

      request.log.info(
        { embedId, roomId, userId, action, projectId, campaignId },
        'embed action recorded',
      );
      return reply.code(200).send({ id: updated.id, state: updated.state, projectId, campaignId });
    },
  );
}
