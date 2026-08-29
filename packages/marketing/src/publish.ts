/**
 * The decisions publishing makes, without the IO that makes them matter.
 *
 * Same split as `spend.ts` and `scopes.ts`, for the same reason: publishing is
 * the first thing in this product that acts outside the system, so what it
 * decides should be readable without a database, a platform account, or a
 * running ticker. The sweep in `apps/api/src/lib/publish.ts` is the IO half, and
 * it is deliberately thin: read some rows, ask the functions here, write the rows
 * back.
 *
 * Three decisions live here.
 *
 * **The idempotency key** (`publishIdempotencyKey`), because it is the whole
 * crash-safety story and it must be derivable from a campaign id alone. Postgres
 * has no transaction across a platform call, so the only thing making a publish
 * re-enterable is that the second attempt asks for exactly the same side effect
 * under exactly the same name. A key computed from a clock, a run id or a random
 * value would produce a second ad instead of finding the first.
 *
 * **Which connection publishes** (`chooseConnection`), which is a real choice
 * rather than a lookup: connections are room-scoped and a room may hold several
 * for one channel.
 *
 * **What to do about what the platform said** (`decidePublishOutcome`). The
 * adapter's error kinds are already chosen by what the caller should do, so this
 * is mostly a translation, but it is a translation worth having in one readable
 * place: getting it wrong means either retrying a policy rejection forever or
 * closing a campaign because a network blipped.
 */

import type { AdapterEntityRef, AdapterResult } from './adapter';
import { isRegisteredProvider, registeredProviders } from './adapter-registry';

/* ------------------------------------------------------------------- keys */

/**
 * The name of one intended side effect: publishing this campaign's root entity.
 *
 * `namespace:stableId` as everything else in this codebase keys its side effects,
 * with the tree level on the end. The suffix is not decoration: slice 6 publishes
 * ad sets and ads under the same campaign and needs keys that cannot collide with
 * this one, and adding the level later would change the key of every campaign
 * already published, which is the one edit this value must never suffer.
 *
 * The durable half is `ad_entities.idempotency_key`, unique across the table, so
 * a retried publish collides in Postgres rather than creating a second row, and
 * the adapter is asked under the same key so it collides at the platform too.
 */
export function publishIdempotencyKey(campaignId: string): string {
  return `publish:${campaignId}:campaign`;
}

/* ------------------------------------------------------- choosing an account */

/**
 * A connection as the publisher needs to see it.
 *
 * **No token fields, and that is the point rather than an omission.** The only
 * registered provider takes no credential, so slice 1 reads none; when a real
 * provider lands, the credential travels to its adapter and still has no reason
 * to pass through this decision. What a publisher decides is *which account*, and
 * that question is answerable from a provider, a status and a scope list.
 */
export interface PublishConnectionCandidate {
  id: string;
  /** `channel_connections.provider`. Validated against the adapter registry here. */
  provider: string;
  grantedScopes: string[];
  status: 'active' | 'expired' | 'revoked';
  /** ISO-8601. Newest wins, so reconnecting supersedes without deleting anything. */
  createdAt: string;
}

export type ConnectionChoiceRule = 'no_connection' | 'no_registered_provider';

export type ConnectionChoice =
  | { chosen: true; connection: PublishConnectionCandidate }
  | { chosen: false; rule: ConnectionChoiceRule; reason: string };

function newestFirst(rows: PublishConnectionCandidate[]): PublishConnectionCandidate[] {
  return [...rows].sort((a, b) => {
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    // An unparseable timestamp sorts last rather than first. Both choices are
    // arbitrary; this one means a malformed row can never outrank a good one.
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
}

/**
 * Pick the account this campaign publishes through.
 *
 * Newest active first, because reconnecting is how somebody replaces an account
 * and `revokeConnection` keeps the old row for its audit trail. Ordering by
 * anything else would let a revoked row from March decide where money goes in
 * August.
 *
 * **A non-active connection is still returned when it is the only one**, and that
 * is the subtle half. The alternative is refusing with "no connection", which is
 * false: there is a connection and it expired. `checkScopes` runs next and says
 * so in a sentence that tells the owner to reconnect, and telling somebody to
 * connect an account they already connected is how a person concludes the product
 * is broken.
 *
 * An unregistered provider is never chosen, on `adapterFor`'s reasoning: a
 * provider nobody reviewed must not be handed somebody's ad account, and the
 * refusal names the registry rather than the account so the fix is findable.
 */
export function chooseConnection(rows: PublishConnectionCandidate[]): ConnectionChoice {
  if (rows.length === 0) {
    return {
      chosen: false,
      rule: 'no_connection',
      reason: 'No account is connected for this channel yet, so there is nowhere to publish it.',
    };
  }

  const registered = rows.filter((r) => isRegisteredProvider(r.provider));
  if (registered.length === 0) {
    return {
      chosen: false,
      rule: 'no_registered_provider',
      reason:
        `The connected accounts use providers this build cannot publish through ` +
        `(registered: ${registeredProviders().join(', ')}).`,
    };
  }

  const ordered = newestFirst(registered);
  const active = ordered.find((r) => r.status === 'active');
  return { chosen: true, connection: active ?? ordered[0]! };
}

/* ------------------------------------------------ what the platform answered */

/**
 * What to do next, named by the action rather than by the error.
 *
 * The five actions are the five genuinely different next steps, and the mapping
 * from the adapter's six error kinds onto them is the safety-critical part of
 * this slice:
 *
 * - `confirm`: it worked. Record the id and finish.
 * - `reject`: the platform disapproved. **Terminal**, because retrying unchanged
 *   asks the same reviewer the same question, and the module rule is revise and
 *   re-approve through a person.
 * - `stop`: we sent something that will never be accepted. Also terminal, and
 *   also our bug rather than theirs.
 * - `await_reconnect`: not retryable by us and fully recoverable by the owner.
 * - `retry`: try the same call again with the same key.
 *
 * Every failure carries the platform's own `message` untouched, because the
 * sentence a person needs is the one the platform wrote, and paraphrasing it
 * would be this codebase inventing a reason for somebody else's decision.
 */
export type PublishDecision =
  | { action: 'confirm'; externalId: string; alreadyExisted: boolean }
  | {
      action: 'reject';
      kind: 'policy_rejected';
      message: string;
      detail?: string;
      reason: string;
    }
  | { action: 'stop'; kind: 'invalid_spec' | 'not_found'; message: string; reason: string }
  | { action: 'await_reconnect'; kind: 'auth_expired'; message: string; reason: string }
  | {
      action: 'retry';
      kind: 'rate_limited' | 'provider_error';
      message: string;
      reason: string;
      retryAfterMs?: number;
      status?: number;
    };

export function decidePublishOutcome(result: AdapterResult<AdapterEntityRef>): PublishDecision {
  if (result.ok) {
    return {
      action: 'confirm',
      externalId: result.value.externalId,
      // Carried through rather than collapsed, so a retry reads in the audit
      // trail as a retry instead of as a second creation.
      alreadyExisted: result.alreadyExisted,
    };
  }

  const error = result.error;
  switch (error.kind) {
    case 'policy_rejected':
      return {
        action: 'reject',
        kind: 'policy_rejected',
        message: error.message,
        detail: error.detail,
        reason:
          'The platform disapproved this campaign, so it is closed rather than retried: ' +
          'asking again unchanged puts the same question to the same reviewer.',
      };
    case 'invalid_spec':
      return {
        action: 'stop',
        kind: 'invalid_spec',
        message: error.message,
        reason:
          'The platform will never accept this request, so retrying it would be the same ' +
          'refusal more slowly. This is a defect on our side.',
      };
    case 'not_found':
      return {
        action: 'stop',
        kind: 'not_found',
        message: error.message,
        reason:
          'The platform does not recognise what this request referred to, and retrying blind ' +
          'is the only worse option.',
      };
    case 'auth_expired':
      return {
        action: 'await_reconnect',
        kind: 'auth_expired',
        message: error.message,
        reason:
          'The connection needs reconnecting by its owner. Nothing here can fix it, and ' +
          'nothing is lost by waiting: the same key republishes once it is back.',
      };
    case 'rate_limited':
      return {
        action: 'retry',
        kind: 'rate_limited',
        message: error.message,
        retryAfterMs: error.retryAfterMs,
        reason: 'The platform asked us to slow down, so the same call is made again later.',
      };
    case 'provider_error':
      return {
        action: 'retry',
        kind: 'provider_error',
        message: error.message,
        status: error.status,
        reason:
          'The platform failed in a way that may not repeat, so the same call is made again ' +
          'later under the same key.',
      };
  }
}
