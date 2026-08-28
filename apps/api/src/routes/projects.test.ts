/**
 * The file-url route's branch, extracted so it can be checked without a Supabase
 * client.
 *
 * The case worth pinning is the ordinary text artifact. Every artifact the
 * product has ever written has a `body` and a null `storage_path`, so this
 * branch is the common one, and asking Storage to sign a null path would either
 * throw deep inside the client or sign something. Either way an ordinary
 * artifact would surface as a 500.
 */

import { describe, expect, it } from 'vitest';
import { decideFileUrl, signedUrlExpiresAt, SIGNED_URL_TTL_SECONDS } from './projects';

describe('decideFileUrl', () => {
  it('signs an artifact that has a file', () => {
    const decision = decideFileUrl({ storage_path: 'proj/art/brief.pdf' });

    expect(decision).toEqual({ kind: 'sign', storagePath: 'proj/art/brief.pdf' });
  });

  it('refuses a text artifact rather than trying to sign nothing', () => {
    const decision = decideFileUrl({ storage_path: null });

    expect(decision.kind).toBe('not_found');
    expect(decision.kind === 'not_found' && decision.reason).toBe('not_a_file');
  });

  it('treats a blank path as no file', () => {
    // An empty string is not a path, and it is what an over-eager writer or a
    // hand-edited row leaves behind. `createSignedUrl('')` is a request nobody
    // wants to find out the answer to.
    for (const blank of ['', '   ', '\n']) {
      expect(decideFileUrl({ storage_path: blank }).kind).toBe('not_found');
    }
  });

  it('reports an invisible or absent row as the same thing', () => {
    // RLS returns no row for both "does not exist" and "not yours", and the
    // route answers 404 to both on purpose: the API does not confirm the
    // existence of something it will not show you.
    const decision = decideFileUrl(null);

    expect(decision.kind === 'not_found' && decision.reason).toBe('invisible_or_absent');
  });

  it('distinguishes the two misses for the log, though not for the caller', () => {
    const reasons = [decideFileUrl(null), decideFileUrl({ storage_path: null })].map((d) =>
      d.kind === 'not_found' ? d.reason : 'sign',
    );

    expect(new Set(reasons).size).toBe(2);
  });
});

describe('signedUrlExpiresAt', () => {
  it('is the mint time plus the ttl, as an instant the client can compare', () => {
    const now = Date.UTC(2026, 7, 29, 12, 0, 0);

    expect(signedUrlExpiresAt(now)).toBe('2026-08-29T12:10:00.000Z');
  });

  it('keeps the window short, because the link is a bearer capability', () => {
    // Anyone holding the URL can fetch the object without presenting a token, so
    // the ttl is the exposure if one is copied out of a history or a screenshot.
    // A change to this number is a security decision and should fail here first.
    expect(SIGNED_URL_TTL_SECONDS).toBe(600);
  });
});
