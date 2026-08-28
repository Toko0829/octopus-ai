/**
 * The seam every ad platform sits behind.
 *
 * This interface exists **before** any executor calls it, deliberately. Slice 2
 * and slice 3 write publish and optimize code, and if the seam arrived with the
 * first real provider then that provider's shape would become the interface, and
 * the second provider would be the one that has to bend. Writing it first also
 * means every later slice is testable without a provider account, because the
 * fake beside this file is a complete implementation of it.
 *
 * **Every mutating method takes the idempotency key in its signature.** Not an
 * options bag, not a field on the spec, not something the caller may pass. Rules
 * 9 and 12 require a key on every external side effect, and the way to make that
 * unforgettable is to make the type refuse to compile without one. The database
 * half is `ad_entities.idempotency_key`, which is unique, so a retry collides
 * there rather than creating a second ad.
 *
 * **A policy rejection is a result, not a throw.** The module rule is "ad-policy
 * rejection leads to revise, never silently keep spending", and a rejection that
 * arrives as an exception gets caught by whatever catches transport failures and
 * retried, which is precisely the silent-keep-spending path. It is a first-class
 * error kind here so the caller has to decide what to do with it.
 */

import { z } from 'zod';

/**
 * Mirrors `public.marketing_channel`.
 *
 * Declared here rather than in `packages/contracts` because nothing crosses a
 * wire yet: no route accepts it and no card renders it. It moves to `contracts`
 * in the slice that first sends it somewhere (rule 9 is about shared boundaries,
 * and a type with one consumer has no boundary to share). A `fake` value is
 * absent on purpose: `fake` is a **provider**, and this is a channel.
 */
export const MarketingChannel = z.enum(['meta', 'google', 'email', 'organic_social']);
export type MarketingChannel = z.infer<typeof MarketingChannel>;

/** A window of measured performance, as ISO-8601 instants. */
export const MetricsPeriod = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
});
export type MetricsPeriod = z.infer<typeof MetricsPeriod>;

/* ------------------------------------------------------------------ specs */

/**
 * The approved brief for a campaign, as the adapter needs it.
 *
 * Deliberately thin. Everything a platform supports that we have not decided to
 * expose is absent rather than optional, because an optional field nobody sets
 * is a promise the next reader assumes we keep. What lands in
 * `ad_entities.spec` is this, and the publisher reads that column rather than
 * regenerating: what was approved is what is published.
 */
export const CreateCampaignSpec = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(500).optional(),
  channel: MarketingChannel,
  /**
   * The authorised ceiling for this campaign, already checked by
   * `checkSpendCap`. The adapter does not re-derive it: an adapter that decided
   * its own budgets would be authorisation living in the integration layer,
   * which is the thing rule 7 moves out of prompts and should not land in a
   * provider instead.
   */
  budgetCap: z.number().finite().nonnegative(),
  currency: z.string().length(3),
});
export type CreateCampaignSpec = z.infer<typeof CreateCampaignSpec>;

export const CreateAdSetSpec = z.object({
  name: z.string().trim().min(1).max(200),
  /** The campaign this hangs off, as the platform knows it. */
  parentExternalId: z.string().min(1),
  /**
   * Targeting, as the approved brief stated it. Opaque here on purpose: every
   * platform's targeting vocabulary is different, and a lowest-common-
   * denominator schema would quietly drop what the person actually approved.
   * The adapter for a given provider is where it is translated, and it is
   * carried verbatim in `ad_entities.spec` so what was approved stays readable.
   */
  targeting: z.record(z.unknown()).default({}),
  dailyBudget: z.number().finite().nonnegative().optional(),
});
export type CreateAdSetSpec = z.infer<typeof CreateAdSetSpec>;

export const CreateAdSpec = z.object({
  name: z.string().trim().min(1).max(200),
  parentExternalId: z.string().min(1),
  /** Headline, body, call to action. Reviewed before it gets here. */
  creative: z.object({
    headline: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1),
    callToAction: z.string().trim().max(100).optional(),
    /**
     * The artifact holding the image or video, once creative generation
     * produces files. A reference rather than bytes: an adapter that took bytes
     * would need the storage keys, and the Python service is deliberately kept
     * away from those (ADR-0006).
     */
    assetArtifactId: z.string().uuid().optional(),
  }),
  landingUrl: z.string().url().optional(),
});
export type CreateAdSpec = z.infer<typeof CreateAdSpec>;

/* ---------------------------------------------------------------- results */

/** What the platform calls the thing we just made. */
export const AdapterEntityRef = z.object({
  externalId: z.string().min(1),
});
export type AdapterEntityRef = z.infer<typeof AdapterEntityRef>;

/**
 * One measured period for one entity. Mirrors `campaign_outcomes` closely, since
 * that is where it is written, but is not the row: the row also carries our own
 * tenancy columns and its provenance.
 */
export const MetricsRow = z.object({
  externalId: z.string().min(1),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  spend: z.number().finite().nonnegative(),
  impressions: z.number().int().nonnegative().nullable().default(null),
  clicks: z.number().int().nonnegative().nullable().default(null),
  conversions: z.number().int().nonnegative().nullable().default(null),
  revenue: z.number().finite().nullable().default(null),
  /** Channel extras that do not generalise. Lands in `campaign_outcomes.metrics`. */
  extras: z.record(z.unknown()).default({}),
});
export type MetricsRow = z.infer<typeof MetricsRow>;

/**
 * Why a call did not do what was asked.
 *
 * Discriminated by `kind` so a caller has to handle the cases rather than match
 * on a message string. The kinds are chosen by **what the caller should do**,
 * which is the only useful axis: retry the same call, refresh a token and retry,
 * revise and re-approve, or stop.
 */
export const AdapterError = z.discriminatedUnion('kind', [
  /**
   * The platform disapproved this specific creative or targeting. A first-class
   * kind, never a throw: retrying it unchanged asks the same question of the
   * same reviewer, and the answer is revise-and-resubmit through a person.
   */
  z.object({
    kind: z.literal('policy_rejected'),
    message: z.string(),
    detail: z.string().optional(),
  }),
  /** Back off and retry the same call with the same idempotency key. */
  z.object({
    kind: z.literal('rate_limited'),
    message: z.string(),
    retryAfterMs: z.number().int().positive().optional(),
  }),
  /** The connection needs reconnecting by its owner. Not retryable by us. */
  z.object({ kind: z.literal('auth_expired'), message: z.string() }),
  /** We sent something the platform will never accept. A bug on our side. */
  z.object({ kind: z.literal('invalid_spec'), message: z.string() }),
  /** The entity is gone, or was never ours. */
  z.object({ kind: z.literal('not_found'), message: z.string() }),
  /** Anything else the platform said. Retryable, cautiously. */
  z.object({
    kind: z.literal('provider_error'),
    message: z.string(),
    status: z.number().int().optional(),
  }),
]);
export type AdapterError = z.infer<typeof AdapterError>;

/**
 * Success or a named failure, never a bare throw for anything the platform
 * decided. Transport failures may still throw: those are our problem, and
 * flattening them into this union would make "the network is down" and "your ad
 * was rejected" the same shape.
 */
export type AdapterResult<T> =
  | {
      ok: true;
      value: T;
      /**
       * True when the idempotency key had already been used and this is the
       * original result rather than a new side effect. The caller writes the
       * same row either way; the flag exists so a retry is legible in the audit
       * trail as a retry rather than as a second creation.
       */
      alreadyExisted: boolean;
    }
  | { ok: false; error: AdapterError };

/* --------------------------------------------------------------- the seam */

export interface AdChannelAdapter {
  /** The registry key. Matches `channel_connections.provider`. */
  readonly provider: string;

  createCampaign(
    spec: CreateCampaignSpec,
    idempotencyKey: string,
  ): Promise<AdapterResult<AdapterEntityRef>>;

  createAdSet(
    spec: CreateAdSetSpec,
    idempotencyKey: string,
  ): Promise<AdapterResult<AdapterEntityRef>>;

  createAd(spec: CreateAdSpec, idempotencyKey: string): Promise<AdapterResult<AdapterEntityRef>>;

  /**
   * Change what an entity may spend. The amount is authorised before it gets
   * here; this call carries it out.
   */
  setBudget(
    ref: AdapterEntityRef,
    amount: number,
    idempotencyKey: string,
  ): Promise<AdapterResult<AdapterEntityRef>>;

  /**
   * Stop the spend. Takes an idempotency key like every other mutation: pausing
   * twice is harmless on most platforms and is not harmless on all of them, and
   * the seam should not be where that difference is discovered.
   */
  pause(ref: AdapterEntityRef, idempotencyKey: string): Promise<AdapterResult<AdapterEntityRef>>;

  /** Read-only, so no key: reading twice is reading twice. */
  pullMetrics(ref: AdapterEntityRef, period: MetricsPeriod): Promise<AdapterResult<MetricsRow[]>>;
}
