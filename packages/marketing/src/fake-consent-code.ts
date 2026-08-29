/**
 * The authorization-code format the fake provider issues, as two functions with
 * **no imports at all**.
 *
 * This is a separate module for one reason, and it is a real constraint rather
 * than tidiness: the fake's consent screen runs **in a browser**, and it has to
 * mint a code that `fake-auth-provider.ts` will later decode on the server. Two
 * copies of an encoding that must agree are two copies that can disagree, so the
 * encoding is shared. But `fake-auth-provider.ts` imports `node:crypto` to
 * derive its tokens, and so does `fake-adapter.ts` beside it, so importing
 * either from a client component would drag Node built-ins into the bundle.
 *
 * Hence: no `node:crypto`, no `Buffer`, no base64. Plain string work that runs
 * identically in both places, reachable from the browser through the
 * `./fake-consent-code` subpath export so nothing else in this package follows
 * it there.
 *
 * **All of this disappears with the first real provider.** A real platform hosts
 * its own consent screen and issues its own opaque codes; nothing here has an
 * equivalent, and the file goes when the fake stops being the only entry in the
 * registry.
 */

/** Marks a code as ours. A code without it is one this provider did not issue. */
export const FAKE_CODE_PREFIX = 'fake-code.';

/**
 * A code carrying this is refused as a denial.
 *
 * The consent page's Cancel button does the ordinary OAuth thing and returns
 * `error=access_denied` with no code at all, which the route handles before the
 * provider is reached. This marker exists so the seam's own refusal arm can be
 * asserted without standing up a browser.
 */
export const DENY_MARKER = 'DENY';

/**
 * Separator chosen because no OAuth scope string uses it. Comma and space both
 * appear in real scope lists, and `:` and `/` are common inside a single scope
 * (`ads:read`, `https://www.googleapis.com/auth/adwords`), so any of those would
 * split one scope into two and silently grant something nobody agreed to.
 */
const SEPARATOR = '~';

export function fakeAuthorizationCode(grantedScopes: string[]): string {
  return FAKE_CODE_PREFIX + grantedScopes.join(SEPARATOR);
}

/**
 * The scopes back out of a code.
 *
 * Anything unparseable yields none rather than throwing, and none is the safe
 * direction: an empty grant makes `checkScopes` refuse every call, where a
 * generous guess would let one through on a permission nobody gave.
 */
export function scopesFromFakeCode(code: string): string[] {
  if (!code.startsWith(FAKE_CODE_PREFIX)) return [];
  const body = code.slice(FAKE_CODE_PREFIX.length);
  return body ? body.split(SEPARATOR).filter(Boolean) : [];
}
