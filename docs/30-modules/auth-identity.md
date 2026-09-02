# Module: Auth & Identity

> **Owns** user/node/admin identity, session management, stateless JWT verification, role claims, and the RLS membership model every other module's security depends on. It is the **trust root** of the platform.
>
> **Owner paths:** `apps/api/**` (verification), `packages/db` RLS policies · **Depends on:** infra-devops · **Depended on by:** chat-discord, human-nodes-marketplace, payments-billing, ai-orchestrator, admin-ops.
>
> Update this doc on any change to the role model, JWT flow, RLS membership model, or session lifecycle. Schema changes also update [data-model.md](../10-architecture/data-model.md); security changes also update [security-compliance.md](../10-architecture/security-compliance.md).

## Responsibilities

- Issue and refresh user sessions (via Supabase GoTrue).
- Verify JWTs statelessly in Fastify.
- Own the **role model** and the **RLS membership model** that gates every query.
- Contain `service_role` to trusted server code.

> **Implementation status (Phase 1):** the JWKS verifier is wired as a Fastify `preHandler` (`createRequireAuth`, attached per-route so `/api/health` stays public) and enforced on every chat route. `apps/web` has sign-in/sign-up at `/sign-in`, middleware that refreshes the session and redirects unauthenticated `/app` requests, and a thin BFF at `/api/bff/*` that attaches the token server-side. Sign-up passes `display_name` in user metadata, which `handle_new_user()` copies into `profiles`. Verified end-to-end in a browser: missing and malformed tokens are rejected with `401`, and a real sign-in loads a real workspace.

## GoTrue asymmetric JWT / JWKS flow

1. Next.js authenticates with `@supabase/ssr`; the session is stored in **cookies** and refreshed in middleware (Server Components cannot write cookies, so without that step a rotated refresh token is lost mid-visit). Server Components read it; Route Handlers attach the access token when calling Fastify.

   > **Correction (Phase 1):** these cookies are **not `httpOnly`**, and earlier drafts of this doc claimed they were. `@supabase/ssr`'s browser client has to read the session to authenticate the Realtime socket, which `httpOnly` would prevent. The access token is therefore reachable by page scripts, exactly as in Supabase's standard SSR setup. What the BFF still buys us is that the token is attached server-side in one place, the browser never holds a long-lived credential for Fastify, and the API origin is not exposed to the client. If a genuinely `httpOnly` session is wanted later, Realtime has to be brokered server-side too, and that is an ADR-level change.

2. Fastify verifies each request's JWT **locally** against the cached **JWKS** (`jose`, respecting Supabase's key cache) in a `preHandler` hook, populating `request.user` — **no round-trip to Supabase**.
3. Supabase uses **asymmetric** signing keys (ES256/RS256) precisely so edge/backends verify without a shared secret.

## Role model

- Roles: `user` · `human_node` · `verified_pro` · `admin` · `ops`.
- Mirrored in `profiles.role`, **which is the only place anything reads it.** This bullet used to say "carried as a JWT claim _and_ mirrored in `profiles.role`", and slice 8 established by building the first reader that the first half is not true in this deployment: Supabase mints the standard claim `role = 'authenticated'`, `toRole()` in `apps/api/src/plugins/auth.ts` maps anything outside the `ROLES` list to `'user'`, and there is no GoTrue custom-claims hook in this project. So `request.user.role` is `'user'` for every caller including a real operator. A check written against the claim would refuse everybody, **look like a working deny-by-default**, and stay broken until somebody "fixed" it by trusting a claim the client half-controls. Reading the column is not the backstop here; it is the control.
- The **node vs user** distinction drives matcher and payments permissions; `verified_pro` (license-verified) is required for regulated tasks.
- **A role is set by the server and never by its holder** (`20260831110000`). `authenticated` holds a column grant on `profiles` covering `display_name`, `jurisdiction` and `languages` only, and `private.guard_profile_role_self_service` refuses a `role` change from any writer carrying a JWT. `service_role` writes with no claims, so `auth.uid()` reads null and the server path is untouched — which is also what makes the guard fail in the useful direction: a future `SECURITY DEFINER` helper cannot launder a role change on a user's behalf, because the claims travel with the request rather than with the role.

  **`profiles.role` got its first writer in `20260902121000` and its first reader in slice 8.** For six slices this paragraph said the column "still authorises nothing", and that was true and worth saying: a backstop being filled in ahead of its readers is not a control that quietly became live. It is live now, in exactly one place.

  `apps/api/src/plugins/require-ops.ts` reads the column with the service key and admits `ops` or `admin` to `/api/ops/*`. **That is the whole of it.** Every other authorisation in this system is still `rooms.owner_id`, an RLS policy on the caller's own row, or the existence of a `node_profiles` row — including the `/node` surface, which routes on the row rather than the role because the row is the fact and RLS enforces who can see it. Nothing gained a role check in slice 8 except the ops surface.

  Two properties of that reader are worth stating here rather than only in admin-ops.md. It reads the **database**, never the token, for the reason in the roles bullet above. And there is **no RLS policy anywhere that tests `profiles.role`**: an ops-wide policy would need a `SECURITY DEFINER` helper in `public`, which is published at `/rest/v1/rpc/` to anyone holding the anon key — the shape security-compliance.md records being reintroduced once by somebody who had already read the migration that removed it. The route check is the control and "no client grant at all" is the backstop, which is `ledger_entries`' posture and fails in the safe direction: drop the preHandler and the route's own `service_role` reads are still the only path to the data.

  **A role is minted only by a script.** `scripts/grant-ops.mjs` writes `ops` as `service_role`, which needs no migration because the guard below already lets the server path through. It refuses `admin` (indistinguishable from `ops` in this build, so granting it would hand out powers nobody has designed) and refuses to promote a `human_node` (an expert who decides disputes about work they can be offered).

  This was a **promise enforced by nothing** for forty-four migrations. `20260724000000:21` states that role escalation is blocked and that a later migration adds the trigger; none did, and the escalation was confirmed to succeed against the live database before the fix. Two controls rather than one, because the table-wide `update` grant this replaces had already been silently restated once (`20260812120100:31`) by a migration doing something else, and a `grant` line cannot undo a trigger. Asserted in `supabase/tests/rls_membership.sql`.

## RLS membership model

- Access is **membership-based**, not bare `user_id = auth.uid()`.
- `room_members(room_id, user_id, role, scope, expires_at)` gates chat; project ownership/assignment gates workflow/marketplace/payments rows.
- Adding a node to a room is an **`INSERT`** into `room_members`; the AI is a **synthetic member** (`author_kind='agent'`).
- Fastify sets `request.jwt.claims` via `set_config()` (or uses the caller's token through supabase-js) so `auth.uid()`/`auth.jwt()` resolve inside policies.

## `service_role` containment

- Used only by trusted server code (`matcher`, payments, agent system-writes, admin).
- **Never** shipped to the client, never in a browser-reachable env var. A single leak bypasses all security (see [security-compliance.md](../10-architecture/security-compliance.md)).

## Session lifecycle

- Sign-in (OAuth + email), refresh (rotating), and revocation (sign-out, admin force-revoke).
- Node onboarding attaches KYC status to the identity (see [human-nodes-marketplace.md](human-nodes-marketplace.md)).

## Key entities

`users` (Supabase `auth.users`) · `profiles(user_id, role, jurisdiction, languages[])` · `room_members(room_id, user_id, role, scope, expires_at)` · session/refresh tokens (GoTrue-managed).

## Security tests (required)

- **pgTAP** coverage of the RLS membership model, including the hardest surface: a room with the user + AI + multiple nodes with different roles and time-boxed access. A node must see **only** its engaged task thread, **only** while `expires_at` is in the future.
- Negative tests: cross-tenant read attempts, expired node access, `service_role` never reachable client-side.

## Threat model (this module)

`service_role` leakage · forged/expired JWT acceptance · privilege escalation via role claim tampering (backstopped by `profiles.role`) · stale membership after offboarding. Mitigations in [security-compliance.md](../10-architecture/security-compliance.md).
