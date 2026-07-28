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
- Carried as a **JWT claim** _and_ mirrored in `profiles.role` (the DB backstop RLS reads).
- The **node vs user** distinction drives matcher and payments permissions; `verified_pro` (license-verified) is required for regulated tasks.

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
