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
- Next.js stores the session in httpOnly cookies (`@supabase/ssr`); Fastify verifies every request's JWT **locally** against cached JWKS (`jose`) in a `preHandler` — no round-trip to Supabase.
- Roles/claims (`user` / `human_node` / `verified_pro` / `admin` / `ops`) drive both RLS and app authorization.

## Authorization: defense-in-depth

- **App-level checks in Fastify** *plus* **Postgres RLS as the real backstop.** Never rely on one.
- RLS is **membership-based** (`room_members`, project ownership/assignment), not bare `user_id`.
- Fastify sets `request.jwt.claims` via `set_config()` (or uses the caller's token through supabase-js) so `auth.uid()`/`auth.jwt()` work inside policies.
- **`service_role` containment:** server-only, used by `matcher`/payments/agent system-writes; never shipped to the client; never in browser-reachable env.
- **Dynamic group-chat RLS** is tested exhaustively with **pgTAP**: user sees their rooms; a node sees only the task thread it's engaged on, only while `expires_at` is in the future; the AI writes as a member; ops access is audited.

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

- Holding escrow and routing payouts is likely a **regulated money-services activity**. Stripe is **not** a licensed escrow provider — we use *separate charges & transfers* with delayed payouts as an escrow-equivalent.
- **Counsel action items (do not hand-wave):** money-transmission / escrow-licensing analysis per jurisdiction (US state MTL regime, EU e-money/payment-institution rules; GEL/FX for the future Georgia pack); platform-of-record determination; tax reporting (1099-K / DAC7).
- Nodes onboard via **Stripe Connect Express** so the provider handles their KYC/tax and payout compliance.

## Regulated-advice boundaries (UPL / accountancy)

- The AI provides **information/research only** and never presents legal/tax/accounting/investment output as **authoritative** — the binding version comes from a licensed human node carrying professional indemnity.
- **Persistent disclaimers** ("informational, not legal/financial advice; verify with a licensed professional") on every regulated output, logged with the message.
- **Hard prohibitions:** the AI never signs/notarizes, never authenticates *as* the user, never enters banking/ID/card data, never completes KYC/source-of-wealth for the owner.
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
