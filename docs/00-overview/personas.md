# Personas

> Who Octopus serves and who operates it. Design, copy, permissions, and escalation logic all reference these. Update when a new role or major user segment appears.

## 1. The User (primary) — first ICP: solo founder / creator

- **Who (first vertical):** a solo founder, indie maker, or creator — a personal brand, app, newsletter, or small product — who needs growth but can't afford an agency or the time to become a marketer. Later verticals widen to SMBs, e-commerce, and full business owners (the cafe owner).
- **Goal:** get real growth (customers / audience / revenue) with minimal personal grind; avoid wasting ad budget on things that don't work.
- **Pain today:** generic advice that ignores what works for *people like them*; juggling content, ads, SEO, email, and analytics alone.
- **What they do in Octopus:** state the goal; answer the *few* questions only they can (budget ceiling, brand voice, subjective taste calls); authorize connecting accounts, publishing, and ad spend; watch progress in one calm chat.
- **Success:** business launched with the fewest touches; every regulated step handled by an accountable party.
- **Design implications:** editorial, trustworthy, low-anxiety surfaces; money always in tabular numerics; approvals are unmistakable and never accidental; the AI's reasoning is transparent and cited.

## 2. The AI Agent (first-class actor)

- **Who:** the "business operator" — a durable, supervisor-pattern agent that is a **member of the chat**, not a widget.
- **Goal:** execute everything AI-doable correctly and safely; escalate precisely; keep the user minimally involved.
- **Behavior:** plans a cited task DAG; runs tools; streams its work inline; batches questions; funds/holds escrow only within caps; suspends on human waitpoints; reports in digestible digests.
- **Constraints:** never signs/notarizes/authenticates-as-user/enters credentials; never presents regulated output as binding advice; obeys guardrails and the kill switch.
- **Design implications:** a distinct inline identity (accent bar + AI tag + live working pulse), never a corner bubble; its messages double as the project's audit trail.

## 3. The Human Node (worker / supply side)

- **Who (first vertical):** a vetted **expert marketer** — creative director, video editor, copywriter, paid-ads specialist, SEO, or influencer/PR outreach pro — who plugs in for judgment, taste, relationships, or account access. Later verticals add **Verified Pros** (licensed lawyer / accountant / notary) for regulated business-formation tasks.
  - **Generalist node** — content, editing, creative direction, outreach, account setup.
  - **Verified Pro** — credentialed specialist (license verified, not self-attested; carries professional indemnity).
- **Goal:** get matched to well-scoped, fairly-priced tasks; get paid reliably; build reputation.
- **Flywheel role:** every correction/approval a node makes is captured as labeled data that trains Octopus ([learning-flywheel.md](../10-architecture/learning-flywheel.md)) — nodes are both workers *and* teachers.
- **Journey:** KYC onboarding (liveness, Face Match 1:1, Face Search 1:N dedup) → skill/credential/geo/availability profile → ranked matching → offer (scope, escrowed price, deadline) → accept + e-sign engagement/NDA → join the task thread → do the work → submit proof → approval → payout → rating.
- **Design implications:** a fast, mobile-friendly "Warm Concierge" surface; clear scope + escrow-confirmed price up front; least-privilege chat access scoped to the task and time-boxed.

## 4. Ops / Admin (internal)

- **Who:** Octopus staff running the marketplace and platform integrity.
- **Goal:** resolve disputes, moderate node-submitted proof, review node verification, reconcile payments, unstick stalled runs, triage stale RAG sources.
- **Behavior:** acts through audited ops consoles with least-privilege RBAC; every action is event-sourced.
- **Design implications:** dense, data-first tools (Retool-as-reference, higher craft); an audit-trail explorer per project/run; nothing destructive without a trail.

## Relationships & permissions (summary)

| | Business Owner | AI Agent | Human Node | Ops/Admin |
|---|---|---|---|---|
| Post in project chat | ✅ | ✅ (inline) | ✅ (scoped to task thread) | ✅ (with audit) |
| Approve money/irreversible | ✅ | ❌ (proposes only) | ❌ | via dispute flow |
| Execute regulated/physical acts | own person | ❌ | ✅ (if verified) | ❌ |
| See full project | ✅ | ✅ | task thread only | ✅ (audited) |
| Move funds | ❌ | proposes within caps | ❌ | dispute actions only |

Authorization is enforced by role claims + Postgres RLS membership — see [auth-identity.md](../30-modules/auth-identity.md) and [security-compliance.md](../10-architecture/security-compliance.md).
