/**
 * The `state` parameter, signed rather than stored.
 *
 * OAuth's `state` exists to answer one question when a browser comes back from a
 * platform: **did we start this?** Without it, anyone can send a person's browser
 * to our callback with a code from an account the person never chose, and we
 * would attach that attacker's ad account to their workspace. That is the whole
 * threat, and it is why the party that checks the state has to be the party that
 * issued it, which is why `packages/marketing` neither mints nor validates one.
 *
 * **No `oauth_states` table.** A row written by one request, read by one other,
 * and dead ten minutes later is a schema whose only reader is itself, which is
 * the shape this repository has now paid for twice (`risk_tier` unreachable for
 * its whole life, `task_deps` empty for two weeks). An HMAC over the same facts
 * needs no migration, no cleanup sweep and no second thing to keep in step.
 *
 * **What replay costs, said plainly rather than assumed away.** A signed state
 * can be presented twice inside its TTL, because there is nothing to mark used.
 * Two things bound that. An authorisation code is single-use at the provider, so
 * the second exchange fails there. And `unique (room_id, provider,
 * external_account_id)` means even a successful second exchange for the same
 * account updates one row rather than creating a rival, which is the property
 * the migration already documents. A stored nonce would close the remaining
 * sliver at the cost of the table above; it is not worth it while the codes
 * themselves are single-use, and this comment is where that trade is recorded.
 *
 * **It binds the user, and that is the second leg.** The callback lands on the
 * web origin where the person is signed in (ADR-0012), so the route can compare
 * the session's subject against the one baked into the state. A state stolen out
 * of one person's browser history is useless in another's session.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface OAuthStateClaims {
  roomId: string;
  /** Who began the flow. The callback refuses a different signed-in user. */
  userId: string;
  provider: string;
  channel: string;
}

interface SignedPayload extends OAuthStateClaims {
  /** Seconds since the epoch. */
  exp: number;
  /** Distinguishes two states issued in the same second for the same facts. */
  nonce: string;
}

export type StateFailure =
  'malformed' | 'bad_signature' | 'expired' | 'wrong_user' | 'wrong_room' | 'wrong_provider';

export type StateVerdict =
  { ok: true; claims: OAuthStateClaims } | { ok: false; rule: StateFailure; reason: string };

export interface StateConfig {
  secret: string;
  ttlSeconds: number;
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Constant-time comparison, and the length check before it is load-bearing:
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * without it a forged state of the wrong length would surface as a 500 instead
 * of a refusal.
 */
function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `now` is a parameter rather than a call to `Date.now()`.
 *
 * The expiry arithmetic is the part worth testing, and a function that reads the
 * clock itself can only be tested by waiting or by mocking a global. The routes
 * pass the real clock; the tests pass a number.
 */
export function signState(
  claims: OAuthStateClaims,
  config: StateConfig,
  now: number,
  nonce: string,
): string {
  const payload: SignedPayload = {
    ...claims,
    exp: Math.floor(now / 1000) + config.ttlSeconds,
    nonce,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, config.secret)}`;
}

/**
 * Verify, then check the claims against what the caller expects.
 *
 * The order matters and is the opposite of the convenient one. Signature first,
 * because every field below is attacker-controlled until it is verified, and a
 * function that compared `roomId` before checking the HMAC would be trusting a
 * string somebody handed it. Expiry next, so a stale-but-genuine state gets its
 * own answer rather than being reported as a mismatch. Only then the bindings.
 */
export function verifyState(
  token: string,
  config: StateConfig,
  expected: OAuthStateClaims,
  now: number,
): StateVerdict {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) {
    return { ok: false, rule: 'malformed', reason: 'That authorisation state is unreadable.' };
  }

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!signatureMatches(sign(body, config.secret), signature)) {
    return { ok: false, rule: 'bad_signature', reason: 'That authorisation did not start here.' };
  }

  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
  } catch {
    // Signed by us and still unparseable means a deploy changed the shape, not
    // an attack. Same refusal either way: we cannot read what it authorises.
    return { ok: false, rule: 'malformed', reason: 'That authorisation state is unreadable.' };
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return {
      ok: false,
      rule: 'expired',
      reason: 'That authorisation took too long. Start connecting the account again.',
    };
  }

  // The bindings, each with its own verdict so a log says which one failed.
  if (payload.userId !== expected.userId) {
    return {
      ok: false,
      rule: 'wrong_user',
      reason: 'That authorisation was started by a different account.',
    };
  }
  if (payload.roomId !== expected.roomId) {
    return {
      ok: false,
      rule: 'wrong_room',
      reason: 'That authorisation was for another workspace.',
    };
  }
  if (payload.provider !== expected.provider || payload.channel !== expected.channel) {
    return {
      ok: false,
      rule: 'wrong_provider',
      reason: 'That authorisation was for a different provider.',
    };
  }

  return {
    ok: true,
    claims: {
      roomId: payload.roomId,
      userId: payload.userId,
      provider: payload.provider,
      channel: payload.channel,
    },
  };
}

/**
 * The config, or null when no secret is set.
 *
 * Null rather than a thrown error at boot, and rather than a default secret.
 * A deployment that never connects an account should start normally; one that
 * tries to should be refused with a sentence naming the variable. A default
 * would be the worst of the three: a signing key in the repository signs a state
 * anyone can forge, which is precisely what this file exists to prevent.
 */
export function stateConfigFrom(env: {
  OAUTH_STATE_SECRET?: string;
  OAUTH_STATE_TTL_SECONDS?: number;
}): StateConfig | null {
  if (!env.OAUTH_STATE_SECRET) return null;
  return {
    secret: env.OAUTH_STATE_SECRET,
    ttlSeconds: env.OAUTH_STATE_TTL_SECONDS ?? 600,
  };
}
