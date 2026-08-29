/**
 * The `state` parameter, which is the only thing standing between a workspace
 * and somebody else's ad account.
 *
 * The threat is worth restating because it decides what is asserted here: without
 * a state check, anyone can send a signed-in person's browser to our callback
 * carrying a code for an account that person never chose, and we would attach it
 * to their workspace. So the properties under test are not "does it round-trip"
 * but the four ways a forged or stale state has to fail, each with its own
 * verdict so a log says which one it was.
 *
 * `now` is a parameter throughout, so expiry is tested by arithmetic rather than
 * by waiting or by mocking a global.
 */

import { describe, expect, it } from 'vitest';
import { signState, stateConfigFrom, verifyState, type StateConfig } from './oauth-state';

const CONFIG: StateConfig = { secret: 'x'.repeat(48), ttlSeconds: 600 };
const NOW = 1_800_000_000_000;

const CLAIMS = {
  roomId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  provider: 'fake',
  channel: 'meta',
};

const sign = (now = NOW) => signState(CLAIMS, CONFIG, now, 'nonce-1');

describe('signing and verifying a state', () => {
  it('round-trips the claims it was issued for', () => {
    const verdict = verifyState(sign(), CONFIG, CLAIMS, NOW);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.claims).toEqual(CLAIMS);
  });

  it('gives two states for the same facts different values', () => {
    // The nonce. Two authorisations started in the same second for the same
    // room and provider must not be the same string, or one browser's history
    // entry is another's valid state.
    const a = signState(CLAIMS, CONFIG, NOW, 'nonce-1');
    const b = signState(CLAIMS, CONFIG, NOW, 'nonce-2');
    expect(a).not.toBe(b);
  });

  it('refuses a payload edited after signing', () => {
    // The forgery that matters: swap the room, keep the signature.
    const token = sign();
    const [body, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(body as string, 'base64url').toString('utf8'));
    payload.roomId = '33333333-3333-4333-8333-333333333333';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;

    const verdict = verifyState(forged, CONFIG, { ...CLAIMS, roomId: payload.roomId }, NOW);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rule).toBe('bad_signature');
  });

  it('refuses a state signed with a different secret', () => {
    const other = signState(CLAIMS, { ...CONFIG, secret: 'y'.repeat(48) }, NOW, 'nonce-1');
    const verdict = verifyState(other, CONFIG, CLAIMS, NOW);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rule).toBe('bad_signature');
  });

  it('refuses a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning false.
    // Without the length guard before it, a forged state of the wrong size would
    // surface as a 500 instead of a refusal.
    const verdict = verifyState(`${sign().split('.')[0]}.short`, CONFIG, CLAIMS, NOW);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rule).toBe('bad_signature');
  });

  it.each(['', 'nodot', '.leadingdot'])('refuses %o as malformed', (token) => {
    const verdict = verifyState(token, CONFIG, CLAIMS, NOW);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rule).toBe('malformed');
  });

  describe('expiry', () => {
    it('accepts a state one second inside the window', () => {
      const verdict = verifyState(sign(), CONFIG, CLAIMS, NOW + 599_000);
      expect(verdict.ok).toBe(true);
    });

    it('refuses one at the boundary, because the window is closed at the end', () => {
      // Exactly at `exp` is expired. A state that outlives its own stated
      // lifetime by a second is a state whose lifetime is a suggestion.
      const verdict = verifyState(sign(), CONFIG, CLAIMS, NOW + 600_000);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.rule).toBe('expired');
    });

    it('reports expiry as its own verdict, not as a mismatch', () => {
      // A stale-but-genuine state should tell somebody to start again, which is
      // a different instruction from "that did not start here".
      const verdict = verifyState(sign(), CONFIG, CLAIMS, NOW + 3_600_000);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.rule).toBe('expired');
      expect(verdict.reason).toContain('again');
    });
  });

  describe('bindings', () => {
    it('refuses a state belonging to a different signed-in user', () => {
      // The second leg (ADR-0012). A state lifted out of one person's browser
      // history is useless in somebody else's session.
      const verdict = verifyState(
        sign(),
        CONFIG,
        { ...CLAIMS, userId: '44444444-4444-4444-8444-444444444444' },
        NOW,
      );
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.rule).toBe('wrong_user');
    });

    it('refuses a state replayed into another workspace', () => {
      const verdict = verifyState(
        sign(),
        CONFIG,
        { ...CLAIMS, roomId: '55555555-5555-4555-8555-555555555555' },
        NOW,
      );
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.rule).toBe('wrong_room');
    });

    it.each([
      ['provider', { provider: 'meta' }],
      ['channel', { channel: 'google' }],
    ])('refuses a state whose %s was swapped', (_label, override) => {
      // Without this, a state issued for `fake` could complete a connection
      // recorded against a provider the person never authorised.
      const verdict = verifyState(sign(), CONFIG, { ...CLAIMS, ...override }, NOW);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.rule).toBe('wrong_provider');
    });

    it('checks the signature before any binding', () => {
      // Order is the safety property: every field is attacker-supplied until the
      // HMAC checks out, so a wrong-user state signed by somebody else must fail
      // as a bad signature rather than as a mismatch.
      const other = signState(CLAIMS, { ...CONFIG, secret: 'z'.repeat(48) }, NOW, 'n');
      const verdict = verifyState(other, CONFIG, { ...CLAIMS, userId: 'someone-else' }, NOW);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.rule).toBe('bad_signature');
    });
  });
});

describe('stateConfigFrom', () => {
  it('is null with no secret, so connecting is refused rather than forged', () => {
    // Never a default. A signing key checked into a repository signs a state
    // anybody can forge, which is the one thing this file exists to prevent.
    expect(stateConfigFrom({})).toBeNull();
  });

  it('carries the configured TTL', () => {
    expect(
      stateConfigFrom({ OAUTH_STATE_SECRET: 'a'.repeat(32), OAUTH_STATE_TTL_SECONDS: 90 }),
    ).toEqual({ secret: 'a'.repeat(32), ttlSeconds: 90 });
  });
});
