# Security & Compliance

> The consolidated security, authorization, privacy, and legal/regulatory posture — engineering controls **and** business compliance. Update when auth, RLS, guardrails, KYC/AML, or the legal posture changes. Pairs with [auth-identity.md](../30-modules/auth-identity.md) and [payments-billing.md](../30-modules/payments-billing.md).

## Threat model (top surfaces)

1. **`service_role` leakage** — bypasses all RLS. Single biggest footgun.
2. **Dynamic group-chat RLS** — user + AI + multiple time-boxed nodes; the hardest membership surface.
3. **Prompt injection** via retrieved web/document/node content driving side-effecting tools.
4. **Overspend / money movement** via a jailbroken prompt.
5. **Identity fraud** on the node side (account-renting, synthetic identity, collusion).
6. **PII exposure** in URLs, logs, or the RAG index.

## Identity & authentication

- **Supabase Auth (GoTrue)** is the sole IdP, issuing **asymmetric JWTs (ES256/RS256)** published via JWKS.
- Next.js stores the session in cookies (`@supabase/ssr`, refreshed in middleware); Fastify verifies every request's JWT **locally** against cached JWKS (`jose`) in a `preHandler` — no round-trip to Supabase. Note these cookies are **not** `httpOnly`: the browser client must read the session to authenticate the Realtime socket. See the correction in [auth-identity.md](../30-modules/auth-identity.md).
- Roles/claims (`user` / `human_node` / `verified_pro` / `admin` / `ops`) drive both RLS and app authorization.

## Authorization: defense-in-depth

- **App-level checks in Fastify** _plus_ **Postgres RLS as the real backstop.** Never rely on one.
- RLS is **membership-based** (`room_members`, project ownership/assignment), not bare `user_id`.
- Fastify sets `request.jwt.claims` via `set_config()` (or uses the caller's token through supabase-js) so `auth.uid()`/`auth.jwt()` work inside policies.
- **`service_role` containment:** server-only, used by `matcher`/payments/agent system-writes; never shipped to the client; never in browser-reachable env.

  > **Accepted risk, with a trigger (Phase 1).** CI's retrieval-eval job holds `SUPABASE_SECRET_KEY` as a repository secret so it can read the corpus. GitHub exposes repository secrets to **any** workflow in the repo, so anyone able to push a workflow file can exfiltrate it. That is acceptable only while the repository has a single author, which is the case today and is a deliberate decision rather than an oversight.
  >
  > **Trigger to fix: the first additional collaborator.** The eval needs `select` on `documents` / `doc_chunks` and `execute` on `hybrid_search`, nothing more, so the fix is a dedicated least-privilege Postgres role rather than the key that bypasses RLS entirely. Do this before granting anyone else push access, not after.

- **Channel OAuth tokens are stored without envelope encryption.** `channel_connections` (`20260829121000`) holds `access_token` and `refresh_token` as plain columns.

  > **Accepted risk, with a trigger (Phase 2).** Acceptable **only** while the sole registered provider is the in-repo `fake` adapter, whose tokens authorise nothing and reach no network. The row-level control is real and is asserted: the table carries no policy and no grant to `authenticated` or `anon`, so a client is refused rather than shown zero rows, and `supabase/tests/marketing_rls.sql` checks the error code for the owner of the connection's own room as well as for an outsider. What is not protected is the at-rest case, where a database backup or a `service_role` leak yields the tokens directly. Every other control in this document assumes `service_role` containment holds; this one has no second layer behind it.
  >
  > **Trigger to fix: the first real provider credential**, which is the Meta sandbox adapter. Do it in that change, not after it, because the interval between a real token landing and the encryption landing is exactly the exposure. **Known fix:** pgsodium or KMS envelope encryption on the two token columns, with decryption confined to the tool code that makes the call.

- **`channel_connections` is the one table with no reader at all**, and it is a stronger version of the `events` stance rather than the same one. RLS filters rows, not columns, so any select policy that returned the row would return the secrets with it. A member's legitimate view ("Meta account connected, scopes X, expires Y") is an API projection that never selects the token columns.

- **Dynamic group-chat RLS** is tested with **pgTAP** in `supabase/tests/rls_membership.sql` (22 assertions, verified green against the live database). Covers a room shared by an owner, an unexpired node, an **expired** node and an outsider, across `rooms`, `messages`, `action_embeds` and `feedback_events`.

  The load-bearing case is that an **expired node sees nothing at all**: not the room, not the messages, not the plan card. Time-boxed access is what the entire marketplace model rests on, and until this file existed the only evidence it worked was that nothing had visibly leaked.

  The suite also asserts **privileges, not only policies**, because RLS filters rows a grant already permits and the two fail very differently. `TRUNCATE` is checked explicitly since it bypasses RLS entirely.

  Tests run as `authenticated` with `request.jwt.claims` set, exactly as PostgREST would. Running them as `postgres` would prove nothing: that role bypasses RLS, which is precisely how a policy bug survives review. Everything is inside a transaction that `ROLLBACK`s, so it is safe against a live database.

  **Still uncovered:** thread-scoped membership (`room_members.scope`), since threads do not exist yet, and ops/admin access paths.

- **The workflow DAG** is covered by `supabase/tests/rls_workflow.sql` (33 assertions, verified green). Same four actors against `projects` / `tasks` / `task_deps` / `task_runs`, plus the two triggers. Its RLS half runs as a client and its **trigger half runs as `postgres` deliberately**, which is the opposite rule for the opposite reason: RLS must be tested as a client because `postgres` bypasses it, and the state-machine and acyclicity guards must be tested as `postgres` because they are meant to bind trusted server code too. If those ever start passing merely because the caller was privileged, the guard has been lost.

  **Known narrowing:** project visibility is inherited from room membership, which is coarser than the thread-scoped, time-boxed access this document requires of a node. It lands with threads. No node is admitted to any room today.

- **The marketing domain** is covered by `supabase/tests/marketing_rls.sql` (39 assertions, verified green). Same four actors against `campaigns` / `ad_entities` / `campaign_outcomes`, the campaign state machine and the ad-tree guard as `postgres`, and `TRUNCATE` on all four tables. Two assertions are unlike anything else in the suite set: `channel_connections` must answer **`permission denied` rather than zero rows**, since the grant absence is the control and the two failure shapes are indistinguishable through PostgREST; and `campaign_outcomes` must refuse `UPDATE` **to `service_role`**, because a training signal that trusted code can rewrite is not evidence.

- **A policy and a read path that answer the same question differently is a defect waiting to be half-fixed.** `private.is_project_member` resolved a project to its room through `rooms.project_id`, which `materialise_plan` writes once, so only the first project approved in a room was visible to anybody. Measured before the fix: **6 projects with 3 reachable, and 47 tasks and 28 of 58 artifacts unreachable by any client, including their owner.** The identical mistake had already been found and fixed in the delivery path (`roomForProject`) two weeks earlier, and nobody carried it into the policy.

  It survived because **it failed as zero rows rather than as an error**: through PostgREST an invisible project and an empty one are the same response, no advisor lints a predicate for asking the wrong question, and a type checker cannot see one. `20260827110000` accepts either link, and neither widens tenancy since both still terminate in a live `room_members` row. Covered by `supabase/tests/project_membership.sql` (13 assertions, verified green), which asserts the outsider and expired-node cases alongside the regression, because a predicate rewritten to simply return true would pass any one-sided version of that suite.

- **File artifacts are private, signed per request, and never logged.** The `artifacts` bucket (`20260829124000`) is not public, so there is no fetchable object URL. `GET /api/projects/:projectId/artifacts/:artifactId/file-url` reads the artifact row **as the caller**, which is the authorization: RLS row visibility decides whether the file may be handed over, and the service key appears only afterwards to sign. The `storage.objects` select policy is the second layer, and both terminate in `private.is_project_member` so the policy and the route cannot drift apart. The signed URL is a **bearer capability**, treated like a token: ten-minute lifetime, minted per request rather than stored, and kept out of the logs (the route's catch logs `err.message` rather than the error object, because a storage client's error can carry a response body). Covered by `supabase/tests/storage_artifacts.sql` (11 assertions, verified green), including that an object whose path names no tenant is invisible rather than an error, that an expired node sees no file, and that a member can neither insert, delete nor move an object.

  > **Recorded finding, deliberately not changed here.** `anon`, `authenticated` and `service_role` all hold the full table privilege set on `storage.objects`, `TRUNCATE` included, from Supabase's own defaults. That is the same class `20260812120100` closed for `public`, and `TRUNCATE` matters for the same reason: it is not row-level and ignores RLS entirely. Not remotely exploitable, since PostgREST does not expose the `storage` schema and the Storage service reaches Postgres by its own path. Untouched because `storage.objects` is owned by `supabase_storage_admin` rather than `postgres`, and revoking `INSERT`/`UPDATE`/`DELETE` from `authenticated` there would break user-scoped uploads across every future bucket. **Trigger to revisit: the first bucket that clients write to directly**, which is when the grant set actually has to be reasoned about rather than inherited.

- **Run the Supabase advisors after every migration, not just the tests.** `20260813120000` passed all 33 assertions and still introduced six lints. A test suite asserts the properties somebody thought to assert; the advisor checks the ones everybody forgets.

  The one worth remembering: `task_deps_satisfied` was created in `public` as `SECURITY DEFINER` with `EXECUTE` granted to `authenticated`, publishing the scheduler's READY predicate at `/rest/v1/rpc/`. That is lint 0028/0029, **the same lint `20260728160000_harden_security_definer.sql` exists to clear**, reintroduced by someone who had read that migration. It repeats because it looks like ordinary least privilege, and because in Supabase `public` is the API schema, so granting EXECUTE is also publishing. Fixed in `20260813130000` by moving it to `private` and dropping it to `SECURITY INVOKER`: unlike `is_room_member` it is never evaluated inside a policy, so it never needed to bypass RLS at all.

## Agent guardrails (layered defense)

Applied fast→smart as pre-checks on inputs and post-checks on every tool output/artifact — never a single LLM self-judgement.

1. **Deterministic rule checks** → allow-lists, spend caps, PII patterns.
2. **Small classifier** → policy/injection screening.
3. **LLM-judge critic** → maker-checker validation against `acceptance_criteria`.

Key rules:

- **Authorization + spend caps live in tool code, not prompts.** Payment tools check Postgres (escrow balance, budget ceiling, RBAC), not the model's intent. A jailbroken prompt still cannot overspend or move money.
- **Tool risk tiers:** `read-only` (auto) · `reversible` · `external` · `high-risk/irreversible` (mandatory human/user approval via durable interrupt).
- **Injection quarantine:** all tool-returned content (web pages, supplier emails, documents, node proof, chat) is **untrusted data**, kept off the instruction channel.
- **Idempotency / exactly-once** side effects (durable activity + DB unique constraint) so retries never double-register a company, double-notify, or double-pay.
- **Kill switch / pause:** the user can pause any task/project from chat; the durable workflow honors cancellation at the next safe checkpoint.
- **Full audit trail:** every plan diff, tool call, decision, confidence, escalation, and payout is event-sourced and immutable.

## Escalation triggers (must route to human/user)

Legal restriction · physical presence · high-risk/irreversible action · low AI confidence (failed acceptance after 2–3 tries / critic reject / low retrieval confidence) · local/tacit-knowledge gap · missing user-only fact · user opt-in · policy/compliance flag · time/SLA breach. Full list in [ai-orchestrator.md](../30-modules/ai-orchestrator.md).

## Privacy & data minimization

- Comply with **GDPR** (EU users) and equivalent US state laws (e.g. CCPA); Georgian Personal Data law for the future pack.
- **Never** place PII (passport, SSN/tax ID, source-of-wealth, banking, card) in URLs/query strings, logs, or the RAG index.
- Sensitive KYC data is handled by the **licensed party / provider / bank**, not stored by us or used to train/enrich RAG.
- Data-subject rights (access/erasure) supported via the event-sourced model + hard-delete tooling where legally required.

## KYC / AML (marketplace)

- **Node identity verification** (Persona or Stripe Identity): document + passive liveness + **Face Match 1:1** and **Face Search 1:N** across enrolled nodes to kill account-renting / duplicate identity — the defining gig-fraud vector.
- **Sanctions / PEP screening** of both users and nodes.
- **Anti-fraud at match time:** Face Search dedup, geo/IP consistency, collusion/fake-proof detection.
- Verified professional licenses (lawyer/accountant/notary) are checked before a node is eligible for regulated tasks.

## Payments / money-transmission exposure

- Holding escrow and routing payouts is likely a **regulated money-services activity**. Stripe is **not** a licensed escrow provider — we use _separate charges & transfers_ with delayed payouts as an escrow-equivalent.
- **Counsel action items (do not hand-wave):** money-transmission / escrow-licensing analysis per jurisdiction (US state MTL regime, EU e-money/payment-institution rules; GEL/FX for the future Georgia pack); platform-of-record determination; tax reporting (1099-K / DAC7).
- Nodes onboard via **Stripe Connect Express** so the provider handles their KYC/tax and payout compliance.

## Regulated-advice boundaries (UPL / accountancy)

- The AI provides **information/research only** and never presents legal/tax/accounting/investment output as **authoritative** — the binding version comes from a licensed human node carrying professional indemnity.
- **Persistent disclaimers** ("informational, not legal/financial advice; verify with a licensed professional") on every regulated output, logged with the message.
- **Hard prohibitions:** the AI never signs/notarizes, never authenticates _as_ the user, never enters banking/ID/card data, never completes KYC/source-of-wealth for the owner.
- **Per-action confirmation:** any message sent on the user's behalf, public content published, form submitted, or purchase made requires explicit user approval — **per-action, not blanket.**
- Consumer-protection / advertising compliance for AI-generated marketing (truthful claims, alcohol-ad rules, labeling AI-generated content where required).

## Auditability & incident response

- Every recommendation, citation, disclaimer, hand-off, and approval is timestamped and recorded so responsibility is traceable (liability + dispute defense).
- **Secrets:** Doppler/Infisical; env schema Zod-validated; no secrets in the repo or client bundle.
- **Dependency security:** Renovate/Dependabot; majors reviewed.
- **Incident response:** documented in [`docs/50-runbooks/`](../50-runbooks/); Sentry alerting; kill switch for runaway agents.

## Enforcement checklist (per PR)

- [ ] RLS on for new tables; pgTAP membership tests added.
- [ ] No `service_role` in any client-reachable path.
- [ ] Side-effecting tools enforce allow-lists + spend caps + idempotency in code.
- [ ] Retrieved/external content treated as data; no PII in URLs/logs/RAG.
- [ ] Regulated output carries disclaimer + escalation path.
- [ ] Money movement idempotent + event-sourced.
