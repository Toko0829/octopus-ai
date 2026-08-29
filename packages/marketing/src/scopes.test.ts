import { describe, expect, it } from 'vitest';
import { checkScopes } from './scopes';

const active = { status: 'active' as const };

describe('checkScopes', () => {
  it('allows a connection that holds everything asked for', () => {
    expect(
      checkScopes({
        ...active,
        grantedScopes: ['ads:read', 'ads:write'],
        requiredScopes: ['ads:read'],
      }),
    ).toEqual({ allowed: true });
  });

  it('allows a call that needs nothing', () => {
    expect(checkScopes({ ...active, grantedScopes: [], requiredScopes: [] })).toEqual({
      allowed: true,
    });
  });

  it('names every missing scope rather than the first', () => {
    const verdict = checkScopes({
      ...active,
      grantedScopes: ['ads:read'],
      requiredScopes: ['ads:read', 'ads:write', 'pages:publish'],
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe('missing_scopes');
    // Both, so a person reconnects once rather than discovering the second gap
    // after granting the first.
    expect(verdict.missing).toEqual(['ads:write', 'pages:publish']);
    expect(verdict.reason).toContain('ads:write');
    expect(verdict.reason).toContain('pages:publish');
  });

  // Status outranks scopes: telling somebody to grant a permission they already
  // granted, on a connection that was revoked, sends them to fix the wrong thing.
  it.each([
    ['expired', 'expired'],
    ['revoked', 'revoked'],
  ] as const)('refuses a %s connection before looking at scopes', (status, word) => {
    const verdict = checkScopes({
      status,
      grantedScopes: ['ads:read'],
      requiredScopes: ['ads:write'],
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe('connection_not_active');
    expect(verdict.missing).toEqual([]);
    expect(verdict.reason).toContain(word);
  });

  it('compares scope strings exactly, without normalising', () => {
    // A platform's scope strings are opaque identifiers. Guessing that
    // `ads_read` means `ads:read` is this codebase inventing a mapping for a
    // platform it has never called.
    const verdict = checkScopes({
      ...active,
      grantedScopes: ['ads_read', 'ADS:READ'],
      requiredScopes: ['ads:read'],
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.missing).toEqual(['ads:read']);
  });
});
