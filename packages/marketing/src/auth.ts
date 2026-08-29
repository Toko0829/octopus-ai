/**
 * The seam every channel account sits behind, for the act of connecting it.
 *
 * Separate from `AdChannelAdapter` on purpose, and the reason is lifecycle
 * rather than tidiness. An ad adapter acts **with** a credential that already
 * exists; this seam is how the credential comes to exist, and the two change for
 * different reasons: a platform can rewrite its campaign API without touching
 * its OAuth endpoints, and a platform can move to a new consent flow without
 * changing a single ad call. Folding both into one interface would mean every
 * provider implements six methods it does not need to answer the one question
 * asked here.
 *
 * Written **before** any real provider, exactly as `adapter.ts` was, and for the
 * same reason: if this arrived with Meta, Meta's shape would become the
 * interface and Google would be the one that has to bend.
 *
 * **Three-legged, and the third leg is deliberately absent from this file.** A
 * provider hands back tokens; it never decides whether the person asking was
 * entitled to ask. That is the `state` parameter and the session check, and both
 * live in `apps/api` because both are IO. What belongs here is only what a
 * provider knows.
 */

import { z } from 'zod';
import { AdapterError } from './adapter';

/**
 * What a completed authorisation yields.
 *
 * `refreshToken` and `expiresAt` are nullable rather than optional: a provider
 * that issues a non-expiring token is stating a fact, and `null` records that
 * fact where `undefined` would leave the next reader unsure whether the field
 * was absent or unasked. `channel_connections` stores both as nullable columns
 * for the same reason.
 */
export const ChannelCredential = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable().default(null),
  /**
   * Lifetime in seconds, **relative**, or null for a token that does not age
   * out. Relative rather than an absolute instant on purpose, twice over: it is
   * what OAuth 2 actually returns (`expires_in`), and it is what keeps a clock
   * out of this package. The caller adds it to `now` when it writes
   * `channel_connections.token_expires_at`, because the caller is the half that
   * is allowed to know what time it is.
   */
  expiresInSeconds: z.number().int().positive().nullable().default(null),
  /**
   * What the platform actually granted, which is not always what was asked for.
   * A person can untick a scope on the consent screen, and discovering that in a
   * 403 three days later is the failure `checkScopes` exists to prevent.
   */
  grantedScopes: z.array(z.string()).default([]),
  /**
   * The platform's own account id, so two connected accounts are tellable apart.
   * Nullable because some providers only reveal it on the first authenticated
   * call, which is the case `channel_connections.external_account_id` is
   * nullable for.
   */
  externalAccountId: z.string().min(1).nullable().default(null),
});
export type ChannelCredential = z.infer<typeof ChannelCredential>;

/** Where to send someone, and what we will have said we wanted. */
export const AuthorizeRequest = z.object({
  /**
   * The opaque, signed, single-use value the callback must return. This seam
   * neither creates nor validates it: a provider that minted its own state
   * would be deciding its own CSRF defence, and the whole point of the parameter
   * is that the party who checks it is the party who issued it.
   */
  state: z.string().min(1),
  /** Where the platform sends the browser back. Registered with the provider. */
  redirectUri: z.string().url(),
  /** What we are asking for. The platform decides what it grants. */
  scopes: z.array(z.string()).default([]),
});
export type AuthorizeRequest = z.infer<typeof AuthorizeRequest>;

export const ExchangeRequest = z.object({
  /** The single-use code the platform handed back. */
  code: z.string().min(1),
  /**
   * The same value sent to `authorizeUrl`. Providers require it to match, and
   * passing it again rather than remembering it keeps this seam stateless.
   */
  redirectUri: z.string().url(),
});
export type ExchangeRequest = z.infer<typeof ExchangeRequest>;

/**
 * `AdapterError`'s kinds, plus the one this seam has that publishing does not.
 *
 * Extended rather than redeclared: the existing kinds are chosen by what the
 * caller should do, and that axis is identical here. `auth_expired` means
 * reconnect, `rate_limited` means back off, `invalid_spec` means we sent
 * something wrong, `provider_error` means the platform said something else.
 *
 * **`access_denied` is the addition, and it is not an error by anything.**
 * Somebody declining on a consent screen is an ordinary outcome of asking, and
 * it is modelled as a value for the reason `policy_rejected` is: an exception
 * would be caught by whatever catches transport failures and retried, which
 * means asking a person who just said no to say no again. It is also the arm
 * that never gets written, so it is in the type where it cannot be skipped.
 */
export const AuthError = z.discriminatedUnion('kind', [
  ...AdapterError.options,
  z.object({ kind: z.literal('access_denied'), message: z.string() }),
]);
export type AuthError = z.infer<typeof AuthError>;

/** `AdapterResult`'s shape over `AuthError`. Transport failures still throw. */
export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthError };

export interface ChannelAuthProvider {
  /** The registry key. Matches `channel_connections.provider`. */
  readonly provider: string;

  /**
   * Where to send the person's browser. Synchronous and pure: building this URL
   * is string work, and a provider that needed a network round trip to produce
   * it would be doing something this seam should see.
   */
  authorizeUrl(request: AuthorizeRequest): string;

  /**
   * Trade the code for a credential.
   *
   * No idempotency key, unlike every mutating method on `AdChannelAdapter`, and
   * the difference is real rather than an omission: an authorisation code is
   * single-use **at the provider**, so a replay fails there. The durable half on
   * our side is `unique (room_id, provider, external_account_id)`, which turns a
   * second successful exchange for the same account into an update of one row
   * rather than a rival second row.
   */
  exchangeCode(request: ExchangeRequest): Promise<AuthResult<ChannelCredential>>;

  /**
   * Trade a refresh token for a fresh credential.
   *
   * On the seam and called by nothing yet. It is here because leaving it out
   * would mean the first provider whose tokens actually expire gets to define
   * it, which is the thing writing a seam early exists to prevent.
   */
  refresh(refreshToken: string): Promise<AuthResult<ChannelCredential>>;
}
