import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { createServiceClient, type SupabaseConfig } from '../lib/supabase';

/**
 * The operator check, and **the first authorisation in this system that reads
 * `profiles.role`.**
 *
 * auth-identity.md has stated for forty-odd migrations that the column
 * "authorises nothing anywhere in this system": every check until now has been
 * `rooms.owner_id`, an RLS policy on the caller's own row, or the existence of a
 * `node_profiles` row. `20260902121000` gave the column its first writer and the
 * doc was careful to say that filling a backstop in ahead of its readers is not
 * the same as the backstop becoming live. This is the reader arriving.
 *
 * ---------- The role is read from the database, never from the token ----------
 *
 * This is the part that is easy to get wrong, and getting it wrong would be
 * silent. `apps/api/src/plugins/auth.ts` already puts a `role` on
 * `request.user`, which looks exactly like the thing to check here. **It is
 * not.** `toRole()` maps `payload.role` through the `ROLES` list and falls back
 * to `'user'` for anything unrecognised, and Supabase mints the standard claim
 * `role = 'authenticated'`, which is not in that list. There is no GoTrue
 * custom-claims hook in this project. So `request.user.role` is `'user'` for
 * every caller, including a real operator — and a check written against it would
 * refuse everybody, look like a working deny-by-default, and quietly stay broken
 * until somebody "fixed" it by trusting a claim the client half-controls.
 *
 * The claim is therefore ignored entirely and the row is read as
 * `service_role`. That is also the honest layering: `profiles.role` is what the
 * escalation guard in `20260831110000` protects, so it is the fact worth
 * reading.
 *
 * ---------- Why this is not RLS ----------
 *
 * `disputes` and `ratings` carry policies for the two *parties*; `ops_actions`
 * and `ledger_entries` carry none at all, and the ops console reads all four as
 * `service_role` behind this check. An ops-wide RLS policy would have to test
 * `profiles.role` inside a policy, which needs a SECURITY DEFINER helper in
 * `public` — and security-compliance.md:99 records that shape being reintroduced
 * once by somebody who had read the migration that removed it, because such a
 * function is published at `/rest/v1/rpc/` for anyone holding the anon key.
 *
 * So the layering here is: this check is the control, and "no client grant at
 * all" is the backstop. That is the same posture `ledger_entries` has had since
 * `20260904122000`, and it fails in the safe direction — if this preHandler were
 * ever dropped from a route, the route's own `service_role` reads would still be
 * the only path to the data, and no client key would reach it.
 *
 * ---------- `admin` as well as `ops` ----------
 *
 * Both, because `user_role` has carried both since `20260724000000` and nothing
 * in this build distinguishes them. Scoped permissions between the two are
 * admin-ops.md's Phase-3 concern; inventing a distinction here would mean
 * inventing which of the two is allowed to release somebody's escrow, on no
 * evidence.
 */

/** The roles that may reach an ops surface. Read from the database, never the JWT. */
const OPS_ROLES: ReadonlySet<string> = new Set(['ops', 'admin']);

export interface OpsActor {
  userId: string;
  role: 'ops' | 'admin';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireOps`. Absent on every route that is not an ops surface. */
    opsActor?: OpsActor;
  }
}

/**
 * Reads the caller's role and refuses anybody who is not an operator.
 *
 * Attach **after** `requireAuth`, which is what puts `request.user` in place.
 * On success it sets `request.opsActor`, so a route never re-reads the role and
 * never has to decide for itself what counts as an operator.
 */
export function createRequireOps(config: SupabaseConfig): preHandlerAsyncHookHandler {
  return async function requireOps(request: FastifyRequest, reply: FastifyReply) {
    const sub = request.user?.sub;
    if (!sub) {
      // Only reachable if this is attached without `requireAuth` in front of it.
      // Refused loudly rather than treated as anonymous: a mis-ordered preHandler
      // on an ops route is a wiring bug that must not degrade into an open route.
      request.log.error('requireOps ran without requireAuth: no subject on the request');
      await reply.code(401).send({ error: 'unauthorized', message: 'Sign in first.' });
      return reply;
    }

    const admin = createServiceClient(config);
    const { data, error } = await admin
      .from('profiles')
      .select('role')
      .eq('user_id', sub)
      .maybeSingle();

    if (error) {
      // Never a 403. A read that failed is not a role that was refused, and
      // telling somebody they lack permission when the database was unreachable
      // sends them to ask for access they already have (rule 16).
      request.log.error({ err: error }, 'could not read the caller role for an ops route');
      await reply
        .code(503)
        .send({ error: 'unavailable', message: 'Could not check your access just now.' });
      return reply;
    }

    const role = (data?.role as string | undefined) ?? 'user';
    if (!OPS_ROLES.has(role)) {
      // **403 and not 404.** The rest of this API answers a foreign row with a
      // 404 so that existence is not disclosed, and that reasoning does not
      // apply here: `/api/ops` is a fixed, documented surface whose existence is
      // in the repository, so pretending it is absent protects nothing and only
      // makes a misconfigured operator account look like a broken deployment.
      request.log.warn({ userId: sub, role }, 'non-operator asked for an ops surface');
      await reply.code(403).send({
        error: 'forbidden',
        message: 'That surface is for operators.',
      });
      return reply;
    }

    request.opsActor = { userId: sub, role: role as 'ops' | 'admin' };
    return undefined;
  };
}
