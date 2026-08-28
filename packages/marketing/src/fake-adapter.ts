/**
 * A complete, deterministic implementation of the seam, with no platform behind
 * it.
 *
 * This is the only provider registered today, and it is what makes every later
 * slice testable: a publish executor, a metrics puller and an optimizer can all
 * be written and asserted against real behaviour without an ad account, without
 * a network, and without anyone's money. It is a **provider**, not a channel, so
 * it lives on `channel_connections.provider` and never in `marketing_channel`.
 *
 * Three properties, and each is deliberate.
 *
 * **External ids are derived from the idempotency key, not invented.** Same key,
 * same id, in this process or the next one or in CI. A test can assert the exact
 * string, and a retried publish produces the identical ref rather than a second
 * plausible-looking one.
 *
 * **No clock, no randomness, no network.** Nothing here reads `Date.now()` or
 * `Math.random()`, so a test that passes today passes in six months. Metrics are
 * a function of the ref and the period asked for.
 *
 * **`POLICY_VIOLATION` anywhere in a spec is rejected.** A deliberate, testable
 * lever for the one failure mode that must not be retried automatically. Slice 3
 * needs to prove that an ad-policy rejection routes to revise-and-re-approve
 * rather than into the retry loop, and proving it requires being able to cause
 * one on demand.
 *
 * The `alreadyExisted` memory is per instance and per process, which is what a
 * test double should be. The durable half of idempotency is
 * `ad_entities.idempotency_key`, which is unique in Postgres; this flag exists so
 * a retry is legible rather than as a substitute for that constraint.
 */

import { createHash } from 'node:crypto';
import type {
  AdChannelAdapter,
  AdapterEntityRef,
  AdapterResult,
  CreateAdSetSpec,
  CreateAdSpec,
  CreateCampaignSpec,
  MetricsPeriod,
  MetricsRow,
} from './adapter';

/** The string that makes the fake refuse. Exported so tests name it once. */
export const POLICY_VIOLATION_MARKER = 'POLICY_VIOLATION';

export const FAKE_PROVIDER = 'fake';

function refFor(idempotencyKey: string): AdapterEntityRef {
  return {
    externalId: `fake:${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12)}`,
  };
}

/**
 * A stable non-negative integer from a string. Used only to give the fake's
 * metrics plausible, repeatable shape; nothing depends on the distribution.
 */
function seedFrom(text: string): number {
  return parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);
}

function rejectsPolicy(spec: unknown): boolean {
  return JSON.stringify(spec ?? null)?.includes(POLICY_VIOLATION_MARKER) ?? false;
}

export function createFakeAdapter(): AdChannelAdapter {
  // Which keys this instance has already served. Not a cache of results: the
  // result is derived, so only the fact of the earlier call needs remembering.
  const seen = new Set<string>();

  function settle(idempotencyKey: string): AdapterResult<AdapterEntityRef> {
    const alreadyExisted = seen.has(idempotencyKey);
    seen.add(idempotencyKey);
    return { ok: true, value: refFor(idempotencyKey), alreadyExisted };
  }

  function mutate(spec: unknown, idempotencyKey: string): AdapterResult<AdapterEntityRef> {
    if (rejectsPolicy(spec)) {
      return {
        ok: false,
        error: {
          kind: 'policy_rejected',
          message: 'The platform disapproved this creative.',
          detail: `Spec contained ${POLICY_VIOLATION_MARKER}.`,
        },
      };
    }
    return settle(idempotencyKey);
  }

  return {
    provider: FAKE_PROVIDER,

    async createCampaign(spec: CreateCampaignSpec, idempotencyKey: string) {
      return mutate(spec, idempotencyKey);
    },

    async createAdSet(spec: CreateAdSetSpec, idempotencyKey: string) {
      return mutate(spec, idempotencyKey);
    },

    async createAd(spec: CreateAdSpec, idempotencyKey: string) {
      return mutate(spec, idempotencyKey);
    },

    async setBudget(ref: AdapterEntityRef, amount: number, idempotencyKey: string) {
      // A negative budget is a bug on our side rather than a platform opinion,
      // and it is worth refusing here so the seam's own contract is exercised by
      // the only implementation that exists.
      if (!Number.isFinite(amount) || amount < 0) {
        return {
          ok: false as const,
          error: {
            kind: 'invalid_spec' as const,
            message: `Budget ${amount} is not a usable amount.`,
          },
        };
      }
      seen.add(idempotencyKey);
      return { ok: true as const, value: ref, alreadyExisted: false };
    },

    async pause(ref: AdapterEntityRef, idempotencyKey: string) {
      const alreadyExisted = seen.has(idempotencyKey);
      seen.add(idempotencyKey);
      return { ok: true as const, value: ref, alreadyExisted };
    },

    async pullMetrics(ref: AdapterEntityRef, period: MetricsPeriod) {
      const seed = seedFrom(`${ref.externalId}|${period.start}|${period.end}`);
      const impressions = 1000 + (seed % 9000);
      const clicks = Math.floor(impressions / 40);
      const rows: MetricsRow[] = [
        {
          externalId: ref.externalId,
          periodStart: period.start,
          periodEnd: period.end,
          // Two decimal places, because `campaign_outcomes.spend` is numeric(12,2)
          // and a fake that produced values the real column cannot hold would let
          // a rounding defect through every test that uses it.
          spend: Math.round(clicks * 85) / 100,
          impressions,
          clicks,
          conversions: Math.floor(clicks / 20),
          revenue: Math.round(Math.floor(clicks / 20) * 4200) / 100,
          extras: {},
        },
      ];
      return { ok: true as const, value: rows, alreadyExisted: false };
    },
  };
}
