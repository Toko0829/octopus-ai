/**
 * The fake exists so every arc of the KYC map has a writer, so the test that
 * matters is the one asserting all four outcomes are reachable and that each
 * lands on the result the map expects.
 */

import { describe, expect, it } from 'vitest';
import { createFakeVerifier } from './fake-verifier';
import {
  FAKE_OUTCOMES,
  fakeVerificationRef,
  outcomeFromFakeRef,
  type FakeOutcome,
} from './fake-verification-ref';
import { VerificationError } from './verification';

const NODE = '11111111-1111-4111-8111-111111111111';

function run(outcome: FakeOutcome) {
  return createFakeVerifier().verify({ nodeId: NODE, sessionRef: fakeVerificationRef(outcome) });
}

describe('the reference encoding round-trips', () => {
  it.each(FAKE_OUTCOMES)('%s survives minting and decoding', (outcome) => {
    expect(outcomeFromFakeRef(fakeVerificationRef(outcome))).toBe(outcome);
  });

  it('decodes anything unissued as error, never as pass', () => {
    // The one guess that would admit somebody to paid work on a string nobody
    // issued.
    expect(outcomeFromFakeRef('')).toBe('error');
    expect(outcomeFromFakeRef('pass')).toBe('error');
    expect(outcomeFromFakeRef('fake-verify.')).toBe('error');
    expect(outcomeFromFakeRef('fake-verify.PASS')).toBe('error');
    expect(outcomeFromFakeRef('persona-inquiry-123')).toBe('error');
  });
});

describe('the verifier', () => {
  it('always returns three checks, never none', () => {
    // An empty array would let a caller derive `verified` from an absence.
    return Promise.all(
      FAKE_OUTCOMES.map(async (outcome) => {
        const checks = await run(outcome);
        expect(checks).toHaveLength(3);
        expect(checks.map((c) => c.kind)).toEqual(['document', 'liveness', 'sanctions_pep']);
      }),
    );
  });

  it('passes everything on pass, which is the only route to verified', async () => {
    const checks = await run('pass');
    expect(checks.every((c) => c.result === 'passed')).toBe(true);
  });

  it('fails one check on fail, not all three', async () => {
    // No real provider fails three unrelated checks together, and a fake that
    // did would let downstream code assume failures arrive in bulk.
    const checks = await run('fail');
    expect(checks.filter((c) => c.result === 'failed').map((c) => c.kind)).toEqual(['document']);
  });

  it('marks every check inconclusive, which returns the node to unverified', async () => {
    const checks = await run('inconclusive');
    expect(checks.every((c) => c.result === 'inconclusive')).toBe(true);
  });

  it('marks every check errored, which also returns the node to unverified', async () => {
    const checks = await run('error');
    expect(checks.every((c) => c.result === 'error')).toBe(true);
  });

  it('never reports a face_search, so it never names a third party', async () => {
    // A duplicate-identity finding is an accusation about somebody else and is
    // the reason node_verifications has no policy at all.
    for (const outcome of FAKE_OUTCOMES) {
      const checks = await run(outcome);
      expect(checks.some((c) => c.kind === 'face_search')).toBe(false);
    }
  });

  it('says in the record that it checked nothing', async () => {
    const checks = await run('pass');
    expect(String(checks[0]!.detail.note)).toMatch(/no identity was checked/i);
  });

  it('throws on a reference it did not issue rather than returning failed', async () => {
    // A transport problem is not a verdict about the person: `failed` would
    // reject somebody for our own plumbing, and rejected has to be appealed out
    // of.
    await expect(
      createFakeVerifier().verify({ nodeId: NODE, sessionRef: 'persona-inquiry-123' }),
    ).rejects.toBeInstanceOf(VerificationError);
  });
});
