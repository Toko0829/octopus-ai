/**
 * The session-reference format the fake verifier issues, as two functions with
 * **no imports at all**.
 *
 * The sibling of `fake-consent-code.ts` in `@octopus/marketing`, and a separate
 * module for the same real constraint: the fake's verification screen runs **in
 * a browser** and has to mint a reference that `fake-verifier.ts` will later
 * decode on the server. Two copies of an encoding that must agree are two copies
 * that can disagree, so the encoding is shared, and it stays free of `Buffer`,
 * `node:crypto` and base64 so it runs identically in both places. Reachable from
 * the browser through the `./fake-verification-ref` subpath export so nothing
 * else in this package follows it there.
 *
 * **All of this disappears with the first real provider**, which hosts its own
 * flow and issues its own opaque inquiry ids.
 */

/** Marks a reference as ours. One without it is not a session we issued. */
export const FAKE_VERIFY_PREFIX = 'fake-verify.';

/**
 * What the person chose on the fake screen.
 *
 * All four exist so that every arc in the KYC map has a writer. A fake that only
 * ever passed would leave `rejected` and the inconclusive return to `unverified`
 * as transitions nothing could make, which is the defect the map itself was
 * deferred to avoid.
 */
export const FAKE_OUTCOMES = ['pass', 'fail', 'inconclusive', 'error'] as const;
export type FakeOutcome = (typeof FAKE_OUTCOMES)[number];

export function fakeVerificationRef(outcome: FakeOutcome): string {
  return FAKE_VERIFY_PREFIX + outcome;
}

/**
 * The outcome back out of a reference.
 *
 * Anything unparseable yields `error` rather than throwing, and `error` is the
 * safe direction: it verifies nobody and returns the node to `unverified` with a
 * resubmission available. Guessing `pass` on a malformed reference would be the
 * one answer that admits somebody to paid work on the strength of a string
 * nobody issued.
 */
export function outcomeFromFakeRef(ref: string): FakeOutcome {
  if (!ref.startsWith(FAKE_VERIFY_PREFIX)) return 'error';
  const body = ref.slice(FAKE_VERIFY_PREFIX.length);
  return (FAKE_OUTCOMES as readonly string[]).includes(body) ? (body as FakeOutcome) : 'error';
}
