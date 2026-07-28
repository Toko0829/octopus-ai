import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ROLES, type Role } from '@octopus/config';

/**
 * Auth — stateless Supabase JWT verification against the JWKS endpoint.
 * See docs/30-modules/auth-identity.md.
 *
 * This is only the FIRST of two layers. Postgres RLS is the real backstop: routes
 * act on Postgres through a client carrying the caller's own access token, so
 * `auth.uid()` resolves inside policies and a bug here cannot become a data leak.
 * AGENTS.md rule 6 (defense-in-depth).
 */
export interface AuthenticatedUser {
  sub: string;
  role: Role;
  email?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Absent on unauthenticated routes. */
    user?: AuthenticatedUser;
    /** The caller's raw bearer token, forwarded to Postgres so RLS sees them. */
    accessToken?: string;
  }
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
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) throw new Error('token has no subject');
    return {
      sub,
      role: toRole((payload as Record<string, unknown>).role),
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  };
}

export type AuthVerifier = ReturnType<typeof createAuthVerifier>;

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/**
 * Fastify preHandler enforcing a valid Supabase JWT. Attach per-route rather than
 * globally so public routes (health) stay reachable without a token.
 */
export function createRequireAuth(verify: AuthVerifier): preHandlerAsyncHookHandler {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const token = bearerFrom(request.headers.authorization);
    if (!token) {
      await reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing bearer token.',
      });
      return reply;
    }

    try {
      request.user = await verify(token);
      request.accessToken = token;
    } catch (err) {
      // Log the reason (never the token itself) so auth failures are debuggable.
      // AGENTS.md rule 16: no silent failures.
      request.log.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'jwt verification failed',
      );
      await reply.code(401).send({
        error: 'unauthorized',
        message: 'Invalid or expired token.',
      });
      return reply;
    }

    return undefined;
  };
}
