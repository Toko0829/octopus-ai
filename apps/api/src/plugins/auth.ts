import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ROLES, type Role } from '@octopus/config';

/**
 * Auth (Phase 0) — stateless Supabase JWT verification against the JWKS endpoint.
 * See docs/30-modules/auth-identity.md. This wires the mechanism; Postgres RLS remains
 * the real backstop. Phase 1 attaches this as a Fastify preHandler and enforces roles.
 */
export interface AuthenticatedUser {
  sub: string;
  role: Role;
  email?: string;
}

function toRole(value: unknown): Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : 'user';
}

/**
 * Build a verifier bound to a project's JWKS. Returns a function that validates a bearer
 * token and returns the authenticated user, or throws if the token is invalid/expired.
 */
export function createAuthVerifier(jwksUrl: string, issuer?: string) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));

  return async function verify(token: string): Promise<AuthenticatedUser> {
    const { payload } = await jwtVerify(token, jwks, issuer ? { issuer } : undefined);
    return {
      sub: String(payload.sub ?? ''),
      role: toRole((payload as Record<string, unknown>).role),
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  };
}
