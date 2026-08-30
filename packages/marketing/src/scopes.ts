/**
 * Whether a connection is allowed to do the thing about to be attempted.
 *
 * `channel_connections.granted_scopes` carries its own reason for existing, in
 * the migration's words: "Tool code checks a needed scope against this before
 * the call, rather than learning it from the platform's 403." This is that
 * check, and it lives here rather than in `apps/api` for the reason
 * `checkSpendCap` does: rule 7 puts authorisation in tool code, and a rule
 * nobody can read without a database is not one anybody audits.
 *
 * Same verdict shape as `checkSpendCap` and `routeTask`: **which rule fired**
 * and one sentence of why. "Why can't it post?" is the first question, and
 * answering it later means guessing at what the connection held at the time.
 */

/**
 * What publishing a campaign needs a connection to have been granted.
 *
 * A checked-in constant rather than a table, on `adapter-registry.ts`'s
 * reasoning: which permission an act requires is a security judgement, and a file
 * gets reviewed in a diff while a row does not. It is deliberately not
 * per-provider either. Scope vocabularies differ between platforms and the
 * translation belongs in the adapter that already knows one, so inventing a
 * mapping here would be this package guessing at names for platforms it has never
 * called. `defaultScopesFor` in `auth-registry.ts` is what a connection ASKS for;
 * this is what one CALL needs, and keeping them separate is what lets a narrower
 * grant than we asked for be caught before the call rather than at a 403.
 */
export const PUBLISH_REQUIRED_SCOPES: readonly string[] = Object.freeze(['ads:write']);

/**
 * What reading a campaign's performance needs a connection to have been granted.
 *
 * Read rather than write, and that separation is the reason this is its own
 * constant rather than a reuse of the one above. A person can untick a scope on a
 * consent screen, so a connection granted `ads:read` and refused `ads:write` is a
 * legitimate state: it cannot publish and it can still be measured. Requiring the
 * publish scope here would stop the numbers arriving for a campaign that is
 * already live and already spending, which is the worst moment to go quiet.
 *
 * Both constants are checked against `defaultScopesFor(FAKE_PROVIDER)` in the
 * tests, because a requirement the only consent screen in the product cannot
 * grant would be a permanent block that no user action could clear.
 */
export const METRICS_REQUIRED_SCOPES: readonly string[] = Object.freeze(['ads:read']);

/**
 * What pausing or resuming a campaign needs a connection to have been granted.
 *
 * The write scope, because both calls mutate delivery: a pause stops money and a
 * resume restarts it, and neither is a read however protective the intent. Its
 * own constant rather than a reuse of `PUBLISH_REQUIRED_SCOPES` for the reason
 * the metrics constant is: the three acts can grow apart, and a shared constant
 * would make widening one silently widen the others.
 *
 * The named consequence of requiring the write scope: a connection granted only
 * `ads:read` can be measured and cannot be auto-paused, so a breach on it is
 * announced to the room instead of acted on. That is the correct half-measure,
 * because the alternative is a product that promised to enforce a ceiling it
 * had no permission to enforce and said nothing.
 */
export const OPTIMIZE_REQUIRED_SCOPES: readonly string[] = Object.freeze(['ads:write']);

export type ScopeRule = 'connection_not_active' | 'missing_scopes';

export type ScopeVerdict =
  { allowed: true } | { allowed: false; rule: ScopeRule; reason: string; missing: string[] };

export interface ScopeCheckInput {
  /** `channel_connections.granted_scopes`, as the platform reported it. */
  grantedScopes: string[];
  /** What the call about to be made needs. */
  requiredScopes: string[];
  /**
   * `channel_connections.status`. Checked here rather than by the caller so the
   * two questions a caller actually has, "may this connection act" and "may it
   * do this", have one answer and one place to change.
   */
  status: 'active' | 'expired' | 'revoked';
}

/**
 * Decide, in priority order.
 *
 * Status first: an expired or revoked connection fails whatever it was granted
 * a month ago, and reporting the missing scope of a revoked connection would
 * send somebody to fix the wrong thing.
 *
 * Comparison is exact-string and case-sensitive, deliberately. Platforms treat
 * scope strings as opaque identifiers, and a normaliser here would be this
 * codebase guessing that `ads:read` and `ads_read` mean the same thing on a
 * platform it has never called. When a real provider needs a mapping it belongs
 * in that provider's adapter, where the platform's vocabulary is already known.
 */
export function checkScopes(input: ScopeCheckInput): ScopeVerdict {
  const { grantedScopes, requiredScopes, status } = input;

  if (status !== 'active') {
    return {
      allowed: false,
      rule: 'connection_not_active',
      reason:
        status === 'expired'
          ? 'This connection has expired and needs reconnecting before it can be used.'
          : 'This connection was revoked, so it cannot be used.',
      missing: [],
    };
  }

  const granted = new Set(grantedScopes);
  const missing = requiredScopes.filter((s) => !granted.has(s));

  if (missing.length > 0) {
    return {
      allowed: false,
      rule: 'missing_scopes',
      reason:
        `This connection was not granted ${missing.join(', ')}, ` +
        'so reconnecting and approving that permission is what unblocks it.',
      missing,
    };
  }

  return { allowed: true };
}
