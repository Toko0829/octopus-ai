import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AddNodeCredentialBody,
  AddNodeSkillBody,
  DeclineOfferBody,
  PatchNodeBody,
  SubmitNodeVerificationBody,
} from '@octopus/contracts';
import {
  VerificationError,
  isKnownSkill,
  isRegisteredVerifier,
  skillRejectionReason,
  verifierFor,
} from '@octopus/marketplace';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import {
  addNodeCredential,
  addNodeSkill,
  auditNode,
  decideNodeKyc,
  findDuplicateCredential,
  patchNodeProfile,
  readNodeProfile,
  readNodeSkill,
  removeNodeSkill,
  revokeNodeCredential,
} from '../lib/nodes';
import { auditOfferDeclined, declineOffer, readNodeOffers } from '../lib/offers';

/**
 * A node's own record, and nothing else in the marketplace.
 *
 * **Every path is `/api/node`, singular, with no id segment.** The caller is
 * always the subject, which removes an entire class of bug before it can be
 * written: there is no `:userId` to forget to compare against `request.user.sub`,
 * so no request can name somebody else's record. When the matcher lands and a
 * node has to be read *by* an owner, that is a different route with a different
 * authorisation question, and it should look different.
 *
 * **Existence is decided by RLS, refusal is a 404.** The three readable tables
 * carry `select`-own policies keyed on `auth.uid()`, so the read below runs as
 * the caller and a person who was never invited sees no row. They are told
 * "not found" rather than "forbidden", matching every other route here: whether
 * somebody is a node is not a fact strangers get to confirm.
 *
 * **Writes run as the service role, and the route is then the entire control.**
 * None of the four tables has an INSERT or UPDATE grant to `authenticated`, and
 * `supabase/tests/marketplace_rls.sql:232-241` pins that deliberately, so there
 * is no as-the-caller write available even in principle. Every handler therefore
 * reads as the caller first and passes `userId` into the writer, which constrains
 * on it.
 *
 * **Nothing here creates a node.** `invite_node` is reachable by `service_role`
 * alone and its only caller is `scripts/invite-node.mjs`. That is the cold-start
 * decision in human-nodes-marketplace.md: ops-invited, never a public sign-up
 * form, for as long as there is no matcher to offer anybody anything.
 */

const SkillParams = z.object({ tag: z.string().min(1) });
const CredentialParams = z.object({ credentialId: z.string().uuid() });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/** Postgres SQLSTATEs this route translates into HTTP rather than leaking as 500s. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export interface NodeRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
}

export async function nodeRoutes(app: FastifyInstance, opts: NodeRoutesOptions): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  /**
   * The caller's node record, or a 404 that has already been sent.
   *
   * Read as the caller on purpose even though every write that follows uses the
   * service key: this one read is what stands between an authenticated stranger
   * and a service-role write against a `node_id` they invented.
   */
  async function requireNode(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request.user as NonNullable<typeof request.user>).sub;
    const db = createUserClient(opts.supabase, request.accessToken as string);
    try {
      const profile = await readNodeProfile(db, userId);
      if (!profile) {
        void fail(reply, 404, 'not_found', 'You do not have a marketplace profile.');
        return null;
      }
      return { userId, profile };
    } catch (err) {
      request.log.error({ err, userId }, 'node profile read failed');
      void fail(reply, 500, 'internal_error', 'Could not load your marketplace profile.');
      return null;
    }
  }

  app.get('/api/node', { preHandler: requireAuth }, async (request, reply) => {
    const found = await requireNode(request, reply);
    if (!found) return reply;
    return reply.code(200).send({ node: found.profile });
  });

  /**
   * A node's own edits.
   *
   * `PatchNodeBody` is `.strict()`, so a body carrying `kycStatus` or
   * `trustScore` is a 400 rather than a field quietly dropped. That matters more
   * than it looks: a silent drop returns 200 and the caller believes it worked,
   * which is how somebody discovers months later that a control they thought they
   * had was never applied.
   */
  app.patch('/api/node', { preHandler: requireAuth }, async (request, reply) => {
    const body = PatchNodeBody.safeParse(request.body);
    if (!body.success) {
      return fail(
        reply,
        400,
        'bad_request',
        'Only your jurisdictions, languages, rate, currency and availability can be changed here.',
      );
    }
    if (Object.keys(body.data).length === 0) {
      return fail(reply, 400, 'bad_request', 'Nothing to change.');
    }
    // The table requires both or neither (`node_profiles_rate_has_period`).
    // Caught here so a half-sent rate is a sentence rather than a 23514.
    const rateGiven = body.data.rate !== undefined;
    const periodGiven = body.data.ratePeriod !== undefined;
    if (rateGiven !== periodGiven) {
      return fail(
        reply,
        400,
        'bad_request',
        'A rate and its period are set together or not at all.',
      );
    }

    const found = await requireNode(request, reply);
    if (!found) return reply;

    const admin = createServiceClient(opts.supabase);
    try {
      const updated = await patchNodeProfile(admin, found.userId, body.data, new Date());
      await auditNode(
        admin,
        {
          verb: 'node.profile_updated',
          actorId: found.userId,
          nodeId: found.userId,
          payload: { fields: Object.keys(body.data) },
        },
        request.log,
      );
      return reply.code(200).send({ node: updated });
    } catch (err) {
      // `node_profiles_available_requires_kyc` is the one eligibility rule with
      // no second layer, so going available while unverified has to be a
      // sentence rather than a 500. A jurisdiction code the shape check refuses
      // arrives the same way.
      if (pgCode(err) === PG_CHECK_VIOLATION) {
        return fail(
          reply,
          409,
          'conflict',
          'That change is not allowed yet. You can only make yourself available once your identity is verified, and jurisdictions look like US or US-TX.',
        );
      }
      request.log.error({ err, userId: found.userId }, 'node profile update failed');
      return fail(reply, 500, 'internal_error', 'Could not save your changes.');
    }
  });

  /**
   * Claim a skill.
   *
   * The taxonomy refuses before Postgres does, and it refuses more: the column's
   * regex accepts `growth-hacking`, and a matcher that has to guess whether that
   * means the same as `outreach` is a matcher that returns one person for a
   * skill two people have.
   */
  app.post('/api/node/skills', { preHandler: requireAuth }, async (request, reply) => {
    const body = AddNodeSkillBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'A skill tag is required.');

    const reason = skillRejectionReason(body.data.tag);
    if (reason !== null || !isKnownSkill(body.data.tag)) {
      return fail(reply, 400, 'bad_request', reason ?? 'That is not a skill Octopus recognises.');
    }

    const found = await requireNode(request, reply);
    if (!found) return reply;

    const admin = createServiceClient(opts.supabase);
    try {
      const skill = await addNodeSkill(admin, found.userId, body.data.tag);
      await auditNode(
        admin,
        {
          verb: 'node.skill_claimed',
          actorId: found.userId,
          nodeId: found.userId,
          payload: { tag: body.data.tag },
        },
        request.log,
      );
      return reply.code(201).send({ skill });
    } catch (err) {
      // Claiming the same skill twice is a replay, not an error. The existing
      // row is returned rather than upserted, because an upsert would reset
      // `verified` and let a node un-verify their own confirmed skill.
      if (pgCode(err) === PG_UNIQUE_VIOLATION) {
        const existing = await readNodeSkill(admin, found.userId, body.data.tag);
        if (existing) return reply.code(200).send({ skill: existing });
      }
      request.log.error({ err, userId: found.userId }, 'skill claim failed');
      return fail(reply, 500, 'internal_error', 'Could not add that skill.');
    }
  });

  app.delete('/api/node/skills/:tag', { preHandler: requireAuth }, async (request, reply) => {
    const params = SkillParams.safeParse(request.params);
    if (!params.success) return fail(reply, 400, 'bad_request', 'A skill tag is required.');

    const found = await requireNode(request, reply);
    if (!found) return reply;

    const admin = createServiceClient(opts.supabase);
    try {
      const removed = await removeNodeSkill(admin, found.userId, params.data.tag);
      if (!removed) return fail(reply, 404, 'not_found', 'You have not claimed that skill.');
      await auditNode(
        admin,
        {
          verb: 'node.skill_dropped',
          actorId: found.userId,
          nodeId: found.userId,
          payload: { tag: params.data.tag },
        },
        request.log,
      );
      return reply.code(204).send();
    } catch (err) {
      request.log.error({ err, userId: found.userId }, 'skill removal failed');
      return fail(reply, 500, 'internal_error', 'Could not remove that skill.');
    }
  });

  /**
   * Claim a licence, and only claim it.
   *
   * The duplicate check is here rather than in the table because the table
   * cannot express it: the unique key ends in `licence_number`, which is
   * nullable, so two claims to be a Texas notary with no number given both
   * insert under `NULLS DISTINCT`. Recorded in the module doc rather than left
   * to be discovered as two identical rows.
   */
  app.post('/api/node/credentials', { preHandler: requireAuth }, async (request, reply) => {
    const body = AddNodeCredentialBody.safeParse(request.body);
    if (!body.success) {
      return fail(reply, 400, 'bad_request', 'A credential needs a kind and a jurisdiction.');
    }

    const found = await requireNode(request, reply);
    if (!found) return reply;

    const admin = createServiceClient(opts.supabase);
    try {
      const duplicate = await findDuplicateCredential(admin, found.userId, body.data);
      if (duplicate) return reply.code(200).send({ credential: duplicate });

      const credential = await addNodeCredential(admin, found.userId, body.data);
      await auditNode(
        admin,
        {
          verb: 'node.credential_claimed',
          actorId: found.userId,
          nodeId: found.userId,
          payload: { kind: body.data.kind, jurisdiction: body.data.jurisdiction },
        },
        request.log,
      );
      return reply.code(201).send({ credential });
    } catch (err) {
      if (pgCode(err) === PG_UNIQUE_VIOLATION) {
        const duplicate = await findDuplicateCredential(admin, found.userId, body.data);
        if (duplicate) return reply.code(200).send({ credential: duplicate });
      }
      if (pgCode(err) === PG_CHECK_VIOLATION) {
        return fail(
          reply,
          400,
          'bad_request',
          'A jurisdiction looks like US or US-TX, in capitals.',
        );
      }
      request.log.error({ err, userId: found.userId }, 'credential claim failed');
      return fail(reply, 500, 'internal_error', 'Could not add that credential.');
    }
  });

  /** Revoking, not deleting: a licence we once asserted leaves a dated trail. */
  app.post(
    '/api/node/credentials/:credentialId/revoke',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = CredentialParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'credentialId must be a UUID.');

      const found = await requireNode(request, reply);
      if (!found) return reply;

      const admin = createServiceClient(opts.supabase);
      try {
        const credential = await revokeNodeCredential(
          admin,
          found.userId,
          params.data.credentialId,
          new Date(),
        );
        if (!credential) {
          return fail(reply, 404, 'not_found', 'No such credential, or it is already revoked.');
        }
        await auditNode(
          admin,
          {
            verb: 'node.credential_revoked',
            actorId: found.userId,
            nodeId: found.userId,
            payload: { credentialId: params.data.credentialId },
          },
          request.log,
        );
        return reply.code(200).send({ credential });
      } catch (err) {
        request.log.error({ err, userId: found.userId }, 'credential revoke failed');
        return fail(reply, 500, 'internal_error', 'Could not revoke that credential.');
      }
    },
  );

  /**
   * Submit an identity check.
   *
   * Three things happen in order, and the order is the crash story. The node
   * moves to `pending` first, so a crash anywhere after that leaves a status a
   * resubmission can move out of rather than a person stuck looking verified or
   * looking untouched. The provider is then asked. Postgres decides last, in one
   * transaction, deriving the verdict from the rows it can see rather than from
   * what the provider returned, so a retry converges instead of re-deciding.
   *
   * **The idempotency prefix is per submission, not per node.** Two attempts are
   * two decisions: a person whose first check was inconclusive submits again, and
   * reusing the prefix would hand back the first attempt's rows and the first
   * attempt's verdict forever. That is the inverse of the publish key, which is
   * derived from the campaign id alone precisely because a campaign must be sent
   * once, and the difference is worth stating: publishing twice spends money
   * twice, where verifying twice is a person trying again.
   */
  app.post('/api/node/verification', { preHandler: requireAuth }, async (request, reply) => {
    const body = SubmitNodeVerificationBody.safeParse(request.body);
    if (!body.success) {
      return fail(reply, 400, 'bad_request', 'A provider and a session reference are required.');
    }
    if (!isRegisteredVerifier(body.data.provider)) {
      return fail(reply, 400, 'bad_request', 'That identity provider is not available.');
    }

    const found = await requireNode(request, reply);
    if (!found) return reply;

    if (found.profile.kycStatus === 'verified') {
      return fail(reply, 409, 'conflict', 'Your identity is already verified.');
    }
    if (found.profile.kycStatus === 'suspended') {
      return fail(reply, 409, 'conflict', 'Your account is suspended. Support has the details.');
    }

    const admin = createServiceClient(opts.supabase);
    const userId = found.userId;

    try {
      if (found.profile.kycStatus !== 'pending') {
        const { error } = await admin
          .from('node_profiles')
          .update({ kyc_status: 'pending' })
          .eq('user_id', userId);
        if (error) throw error;
      }

      const checks = await verifierFor(body.data.provider).verify({
        nodeId: userId,
        sessionRef: body.data.sessionRef,
      });

      const status = await decideNodeKyc(admin, {
        nodeId: userId,
        provider: body.data.provider,
        checks,
        idempotencyPrefix: `node-kyc:${userId}:${randomUUID()}`,
      });

      await auditNode(
        admin,
        {
          verb: 'node.verification_submitted',
          actorId: userId,
          nodeId: userId,
          payload: { provider: body.data.provider, status },
        },
        request.log,
      );

      const profile = await readNodeProfile(admin, userId);
      return reply.code(200).send({ node: profile });
    } catch (err) {
      // A provider that could not answer is not a verdict about the person.
      // The node is already at `pending`, which they can resubmit from, so the
      // honest reply is that we could not check rather than that they failed.
      if (err instanceof VerificationError) {
        request.log.warn({ err, userId }, 'identity verifier could not answer');
        return fail(
          reply,
          502,
          'provider_error',
          'The identity provider could not complete the check. Nothing about you was decided. Try again.',
        );
      }
      if (pgCode(err) === PG_CHECK_VIOLATION) {
        return fail(reply, 409, 'conflict', 'Your identity check cannot move from where it is.');
      }
      request.log.error({ err, userId }, 'verification submission failed');
      return fail(reply, 500, 'internal_error', 'Could not submit your identity check.');
    }
  });

  /**
   * The offers made to this node.
   *
   * A separate route rather than a field on `GET /api/node`, because the two
   * change on different clocks: a profile changes when the node edits it, and
   * offers change when somebody else's step moves. Folding them together would
   * refetch the whole record after every decline.
   *
   * **The projection is the access control here, exactly as it is for channel
   * connections.** A node has no RLS grant on `tasks` or `projects` and gains
   * none: the three task fields on the card are read with the service key and
   * copied in. What is deliberately absent is the owner, because
   * `20260901122000` closed the node-sees-owner and owner-sees-node halves
   * together and the engagement slice is where that pair gets opened on purpose.
   */
  app.get('/api/node/offers', { preHandler: requireAuth }, async (request, reply) => {
    const found = await requireNode(request, reply);
    if (!found) return reply;

    const admin = createServiceClient(opts.supabase);
    try {
      const offers = await readNodeOffers(admin, found.userId);
      return reply.code(200).send({ offers });
    } catch (err) {
      request.log.error({ err, userId: found.userId }, 'offer list read failed');
      return fail(reply, 500, 'internal_error', 'Could not load your offers.');
    }
  });

  /**
   * Saying no.
   *
   * **This route settles the offer and never touches the task.** The matcher
   * sweep is the single writer of `tasks.state` in this domain, and it moves the
   * task back to `matching` on its next pass when it sees a settled offer. Two
   * writers racing on one task, one reacting to a person and one to a clock, is
   * how a step gets offered to two nodes at once.
   *
   * The consequence is visible and accepted: for up to one tick the node has
   * declined and the owner still reads "Offered to an expert". That is a delay
   * in a status line, where the alternative is a double offer.
   *
   * **There is no accept route**, and its absence is the slice boundary rather
   * than an omission. Accepting is inseparable from funding escrow, so an accept
   * that wrote no ledger row would leave somebody holding work nobody had paid
   * for. The surface says so where the button would be.
   */
  app.post(
    '/api/node/offers/:offerId/decline',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = z.object({ offerId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'Bad offer id.');

      const body = DeclineOfferBody.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          400,
          'bad_request',
          'A decline takes an optional reason and nothing else.',
        );
      }

      const found = await requireNode(request, reply);
      if (!found) return reply;

      const admin = createServiceClient(opts.supabase);
      try {
        const outcome = await declineOffer(admin, {
          offerId: params.data.offerId,
          nodeId: found.userId,
          reason: body.data.reason ?? null,
        });

        if (outcome.kind === 'not_found') {
          return fail(reply, 404, 'not_found', 'Offer not found.');
        }
        if (outcome.kind === 'expired') {
          return fail(
            reply,
            409,
            'conflict',
            'That offer has expired, so there is nothing to decline.',
          );
        }
        if (outcome.kind === 'settled') {
          return fail(
            reply,
            409,
            'conflict',
            'That offer is no longer open, so there is nothing to decline.',
          );
        }

        // A replay is the mechanism working: the node clicked twice, or retried a
        // request whose response they never saw. Returning the row they already
        // wrote is the honest answer, and it matches how a repeated skill claim
        // is treated two routes above.
        if (outcome.kind === 'declined') {
          await auditOfferDeclined(
            admin,
            {
              projectId: outcome.projectId,
              nodeId: found.userId,
              offerId: outcome.offer.id,
              taskId: outcome.taskId,
              round: outcome.round,
              reason: body.data.reason ?? null,
            },
            request.log,
          );
        }

        return reply.code(200).send({ offer: outcome.offer });
      } catch (err) {
        request.log.error({ err, userId: found.userId }, 'offer decline failed');
        return fail(reply, 500, 'internal_error', 'Could not decline that offer.');
      }
    },
  );
}
