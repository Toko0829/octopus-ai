# ADR-0012: the OAuth callback lands on the web origin, not on the API

- **Status:** Accepted
- **Date:** 2026-08-29
- **Affects:** [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) · [architecture.md](../10-architecture/architecture.md) · [security-compliance.md](../10-architecture/security-compliance.md) · [integrations.md](../30-modules/integrations.md)

## Context

Connecting a workspace's ad, social or email account is a three-legged OAuth
round trip: we send the person to a platform, they decide, and the platform
redirects their **browser** back to a URI we registered in advance. That
redirect URI has to be chosen now, with only the in-repo `fake` provider
registered, and it is the part of this design that is hardest to change later: a
registered redirect URI lives in somebody else's dashboard, so moving it once
Meta and Google are connected means a migration through each provider's console
with a window where connecting is broken.

Two candidates, and they are not equivalent.

**Terminate at Fastify.** `GET /api/connections/callback` receives the redirect
directly. It matches where the rest of the write path lives and needs no page.

**Terminate at Next.** `/connections/callback` receives the redirect, and the
page hands the code inward through the BFF, which attaches the caller's token.

## Decision

**The redirect lands on the web origin.** `WEB_URL` + `/connections/callback` is
the registered URI for every provider, and Fastify's callback endpoint is an
ordinary authenticated route that the BFF reaches.

## Why

**The browser arriving is already carrying a session, and terminating at Fastify
throws that away.** The redirect is a top-level navigation in the person's own
browser to our own web origin, so the Supabase session cookie is present. That
makes the callback page able to prove _who is finishing the flow_, and lets the
API bind the signed `state` to that user: a state lifted out of one person's
browser history is useless in another's session. Fastify sits on a different
origin, holds no cookie, and would have only the state parameter.

**It would otherwise be the only unauthenticated mutating route in the system.**
Every other write in `apps/api` runs behind `requireAuth` and, for most of them,
behind RLS as well. A public callback that writes to `channel_connections` would
be a single-factor endpoint guarded by one HMAC, on the one table in the schema
that holds credentials and has no RLS policy behind it
([security-compliance.md](../10-architecture/security-compliance.md)). Rule 6
asks for defence in depth; this is the arrangement that has two layers instead
of one.

**A person needs somewhere to land.** The end of an OAuth round trip is a moment
where somebody wants to be told what happened, and told plainly that connecting
an account is not the same as using it. Fastify would answer with JSON or a
redirect; the page says it in words, in the product's own voice, and offers the
way back.

**The cost is one page and it is worth naming.** The callback page reads the
room id out of an **unverified** state to know which endpoint to post to. That is
safe because the API then refuses unless the _signed_ payload names the same
room, so a tampered value fails a comparison rather than selecting a workspace.
It is written down here because "the client reads the state" is the kind of
sentence that looks alarming out of context, and the reason it is fine is
structural rather than obvious.

## Consequences

- Every provider registers `${WEB_URL}/connections/callback`, and that string is
  composed in one place (`connectionRoutes`) rather than configured per provider.
- The callback endpoint is authenticated and owner-checked like any other write.
  There is no public route to review, rate-limit or monitor separately.
- `WEB_URL` becomes load-bearing for connecting accounts, not only for CORS. A
  deployment that gets it wrong fails at the redirect with a provider-side error
  rather than silently.
- The BFF needed a `DELETE` export for disconnect, which a Next route handler
  does not provide by default. That trap is noted in the proxy itself.
- **Not decided here:** where a provider's _webhook_ lands. A webhook is
  server-to-server with no browser and no session, so none of the reasoning above
  applies to it, and it will need its own answer with its own signature scheme.

## Alternatives rejected

**A public Fastify callback with a stricter state.** Rejected because no amount
of strictness in one parameter adds a second factor, and the endpoint would write
credentials. The state is already HMAC-signed, TTL-bounded and user-bound; the
question is what happens when it leaks, and the answer with a session check is
"nothing".

**A callback that redirects to the web app after writing.** This keeps the write
on the API and still lands the person somewhere useful, but the write happens
before anything has proved who is holding the browser, which is the property the
decision turns on.
