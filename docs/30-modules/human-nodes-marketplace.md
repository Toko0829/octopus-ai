# Module: Human Nodes Marketplace

> Owns the human workforce: node onboarding + KYC, the skill/trust graph, skill-based ranked matching, offers with expiry/cascade, the full engagement lifecycle (accept → escrow → chat → proof → approval → payout → rating), and anti-fraud. It **completes the agent's waitpoint** on verified task completion.
>
> **Owner paths:** `apps/matcher/**` · **Depends on:** auth-identity (node role, RLS), payments-billing (escrow, payouts), chat-discord (per-task thread membership), notifications (offer fan-out, expiry cascade), ai-orchestrator (`request_human_node`, waitpoint completion), integrations (KYC/IDV).
>
> Update on any change to onboarding/KYC, matching, the offer flow, the engagement state model, or anti-fraud.

## Implementation status

**Live: the domain and its guards, plus threads, and nothing else.**
`20260831120000` … `20260831123000` land `node_profiles`, `node_skills`,
`node_credentials` and `node_verifications` with RLS, structural constraints, two
triggers and a 46-assertion pgTAP suite. `20260901120000` … `20260901123000` land
`threads`, `messages.thread_id`, and `room_members.scope` finally being enforced,
with a second 46-assertion suite. **Zero new capability from either**: no route,
no adapter, no registry, no client grant that permits a write. Nothing a person
can do after those migrations that they could not do before them.

That ordering is the marketing domain's, repeated on purpose. Guards land ahead
of writers here because the recorded failure in this repository is the other
order: `tasks.risk_tier` was unreachable for its entire life, `task_deps` held
no row for two weeks while enforcing an empty set, `artifacts.storage_path` had
no bucket, `projects.budget_ceiling` had no writer, and `profiles.role` had a
guard that was only ever a sentence in a comment (`20260831110000`, which exists
_because_ of this module: `human_node` is about to mean "eligible for paid work
funded from somebody else's authorised budget").

**Why now.** `escalated` is the last live dead end in the product.
`packages/core/src/router.ts:93` sends every human-owned step there with the
reason "Needs expert human judgement, so it goes to the marketplace", and
**twelve tasks sit in that state on the live database**. `20260827120000`
measured seventeen, gave the owner a way to take such a step on themselves, and
said in as many words that it "is not the marketplace and must not be dressed up
as one."

**Not built, and not claimed:** onboarding (there is no writer, so no node
exists), the matcher, offers, engagements, escrow, the proof loop, payouts,
disputes and ratings. **No thread can be created either** — `threads` has no
write policy and no client write grant, and creation lands with the matcher.
**No node is admitted to any room**, and that is load-bearing rather than
incidental — see "Thread access" below. No real KYC
provider is wired: Persona and Stripe Identity are both paid, and slice 3 lands
an in-repo fake verifier as the only registered provider.

### The slice sequence

| #   | Slice                                            | What it closes                                                                                                          | State arcs it restores                                   |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | ✅ **Domain + guards** `20260831120000`…`123000` | the enums with no tables behind them                                                                                    | none, deliberately, and the suite pins that              |
| 2   | ✅ **Threads** `20260901120000`…`123000`         | the narrowing below; a node would otherwise see the whole project DAG                                                   | none                                                     |
| 3   | **Node onboarding writer**                       | `user_role.human_node` and `author_kind.node`, which have had no writer since `20260724000000`                          | none                                                     |
| 4   | **Matcher + offers**                             | `MATCHING`, dead since `20260813120000`, and `ESCALATED`'s only exit                                                    | `matching → failed`, `offered → failed`                  |
| 5   | **Accept, escrow, ledger**                       | acceptance. Accept and fund are inseparable because `claimed → escrow_funded` is the machine's only exit from `claimed` | `claimed → matching`                                     |
| 6   | **The engagement loop to `approved`**            | `ESCROW_FUNDED`, and the waitpoint that never completes                                                                 | `proof_submitted → in_progress`, `blocked → in_progress` |
| 7   | **Payout**                                       | `APPROVED` on a human task, which today can only reach `done` and leave somebody unpaid                                 | none                                                     |
| 8   | **Disputes + ratings**                           | `DISPUTED`, reachable from `in_review` with no ops writer                                                               | all four `→ disputed` arcs, together                     |

`20260815220000` silently dropped eight arcs from the original map while
rewriting it for an unrelated reason. Each is restored by the slice that first
makes it reachable, never earlier — a `disputed` task with no ops console is the
`escalated` defect reproduced on purpose. A ninth, `blocked → failed`, was
dropped by the same rewrite and is recorded here because nobody had counted it.

### Cold start, and the dead end this sequence must not create

A person who completes KYC and is never offered anything is a dead end in this
repository's exact sense. **It is not a slice-1 risk** — slice 1 creates no row,
has no route and no client INSERT grant, so nobody can enter that state. It
bites if **slice 3 ships without slice 4**.

The mitigation is that slice 3 ships **ops-invited onboarding, not open
self-registration**, which is also this doc's own cold-start answer ("thin skill
markets fall back to vetted local professional partners"). An empty marketplace
with three invited notaries is a decision; an empty marketplace with a public
sign-up form is a dead end.

### Thread access

**Live as of slice 2** (`20260901120000` … `20260901123000`), and still with no
writer that can admit anybody. A thread-scoped membership is a nullable
`room_members.thread_id` bound to `scope` by a check constraint, rather than a
second table ([ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md)).

What a thread-scoped member will see, asserted in `supabase/tests/thread_scope.sql`
(46 assertions):

- the **room shell** (`private.is_room_member` is deliberately unchanged, since a
  client that cannot read the room cannot render anything at all);
- their own thread, its channel, and only messages carrying their `thread_id` —
  **never the null-thread room stream**, which is the owner's conversation with
  the AI and the bulk of what a node must not read;
- only the embeds on messages they can already see;
- **only their own membership row**, not the roster and not another node admitted
  to the same thread;
- **no project, task, artifact, `feedback_events` or realtime.**

Three obligations are carried forward rather than left implied:

1. **The counterparty pair is still closed, in both directions now.**
   `node_profiles` has no counterparty policy, and slice 2 additionally narrowed
   `private.shares_room_with` to require `scope = 'room'` on both sides, closing
   a leak neither KNOWN NARROWING comment had named: a thread-scoped node would
   otherwise have read the profile basics of every member of the whole room. The
   consequence is that an admitted node sees **nobody**, including the owner they
   work for. The engagement slice must open that pair, or slice 5/6 ships a node
   who cannot see who engaged them.
2. **There is no realtime for a thread-scoped member.** Thread topics are not
   built: a `'chat:thread:'` branch would have no broadcaster and no subscriber
   today. Both `realtime.messages` policies were narrowed to room scope in place,
   so an admitted node reads through the since-cursor `GET` instead. The slice
   that first admits a node must land thread topics or explicitly accept polling.
3. **`messages_insert_own` still pins `author_kind = 'user'`.** A node posting as
   `author_kind = 'node'` has no client path and gains none. Whether nodes write
   through the server or through their own grant is the writer slice's decision.

## Node onboarding & KYC

- Identity verification via **Persona** (or Stripe Identity to stay in-stack): document + **passive liveness** + **Face Match 1:1** + **Face Search 1:N** across enrolled nodes to kill account-renting / duplicate-identity fraud (the defining gig-fraud vector).
- Collect jurisdiction, languages, and professional licenses (lawyer/accountant/notary — **verified, not self-attested**).
- Set up the **Stripe Connect Express** connected account (payout rails + tax onboarding handled by the provider).

## Skill & trust graph

- Structured skill taxonomy (`legal-filing:US-TX`, `notary:US-TX`, `real-estate:Austin`, `food-safety-consulting`, `procurement`, `on-site-inspection`), service geo (PostGIS), availability, rate, languages, rating.
- Trust score seeds from KYC + verified credentials and grows with completed jobs/ratings.
- License claims are **hard filters** for regulated tasks, not ranking weights.

## Matching algorithm

**Skill-based ranked matching, not a blind broadcast.** Eligible pool = verified skills cover `required_skills` **AND** service geo/jurisdiction includes the task location **AND** any required license is verified **AND** rate ≤ escrowed task budget **AND** currently available. Rank by weighted score: skill/credential fit, jurisdiction exactness (Austin-local > Texas-state), rating + completion-rate, price, responsiveness, current workload (load-balancing). Offer strategy is task-dependent: **first-accept-wins + cascade** for time-sensitive/commodity tasks; a **short sealed-bid window** for higher-value/negotiable-scope tasks.

## Offer flow

Top-ranked nodes get a push/email/in-app **offer** (scope, `acceptance_criteria`, escrowed price, deadline, expiry) via [notifications](notifications.md). Expired/declined offers **auto-cascade** to the next candidate. No task stalls on a silent node.

## Engagement lifecycle & state

`CLAIMED → ESCROW_FUNDED → IN_PROGRESS → PROOF_SUBMITTED → IN_REVIEW → APPROVED → PAID` (with `REJECTED → IN_PROGRESS` bounded re-do, and `DISPUTED` → ops).

**These are `public.task_state` values, and `engagements` will carry no state
column of its own** ([ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)).
Every state above already exists in the machine `20260813120000` declared,
already has its arcs enforced by trigger **including against `service_role`**,
and already writes an audit event on every transition. A parallel enum would be
two machines over one truth, and it would drift silently, because "the
engagement says `in_progress` and the task says `in_review`" is a confusing
screen rather than an error. `engagements` carries facts about the **deal** —
`agreed_price` at acceptance, `deadline_at`, `terms_hash`, `outcome` — while
`tasks.state` carries the fact about the **work**.

Two consequences follow and are stated now so slice 5 arrives to them: **one
live engagement per task** (a partial unique index on `ended_at is null`, not a
plain unique, because reassignment after a no-show creates a second engagement
and `claimed → matching` exists to say so), and **multi-node splits deferred**
until the first acceptance criteria naming more than one node.

1. **Accept + escrow fund** — escrow confirmed funded (charge already captured from the user's authorized budget; transfer deferred). Node e-signs a per-task engagement + NDA. A signal moves the task to `IN_PROGRESS`.
2. **Join group chat** — node added to the project's channel/thread with a distinct **Human Node** role/badge, **scoped to this task's thread** and **time-boxed** (`room_members.scope`, `expires_at`).
3. **Do the work** — the AI co-pilots in-thread (prepared docs, RAG-grounded checklists, forms, addresses, talking points); the user answers questions; presence/typing show live activity. All coordination stays in-thread for auditability.
4. **Submit proof** — deliverables to Supabase Storage (signed docs, stamped permits, geotagged/timestamped site photos, receipts, filing confirmation numbers), attached as artifacts.
5. **Approval (maker-checker + human)** — AI critic validates proof against `acceptance_criteria` (authenticity, tampering/liveness, correct reference numbers) → the user (and/or AI for low-risk) gives final approval. Rejections return to `IN_PROGRESS` with structured feedback + a re-do window.
6. **Payout** — on approval, escrow releases: Stripe Connect transfer to the node's connected account, platform fee retained (see [payments-billing.md](payments-billing.md)). Instant payout to debit card optional for eligible nodes.
7. **Rating + dispute** — two-sided rating updates the trust graph; disputes freeze the transfer and route to ops with the full audit trail (release / partial / refund / reassign). Repeat low ratings / fraud flags suspend the node.
8. **Offboard from chat** — on task close, the node's thread access is revoked/archived; deliverables + transcript remain on the project record.

## Waitpoint completion

On approval, the marketplace/Fastify **completes the agent's Trigger.dev waitpoint token**, and the durable run **resumes deterministically** at the suspended step ([ai-orchestrator.md](ai-orchestrator.md)).

## Anti-fraud

Account-renting / synthetic identity (Face Search 1:N dedup) · geo/IP consistency (impossible-location flags) · collusion / fake proof (proof authenticity + EXIF/geo/timestamp checks) · cold-start (provisional trust score → lower-risk tasks with heavier proof review until a track record accrues).

## Two-sided liquidity

Cold-start supply: KYC + verified credential grants provisional eligibility. Thin skill markets fall back to vetted local professional partners. Certification tiers and node acquisition tracked in [roadmap.md](../10-architecture/roadmap.md) (Phase 4).

## Key entities

Nine were specified from Phase 0. Four exist; the rest carry a trigger rather
than a date, because a list that mixes live tables with intentions reads as
though all nine are there. Column shapes live in
[data-model.md](../10-architecture/data-model.md).

| Entity               | Status                                  | Notes                                                                                                                                                    |
| -------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_profiles`      | ✅ live `20260831120000`, **no writer** | Keyed on `user_id`: a node **is** a user, so every child predicate is a plain equality. `available` + not-`verified` is unrepresentable, by constraint   |
| `node_skills`        | ✅ live `20260831121000`, **no writer** | Claim and verified claim on one row, one boolean apart. Tag is shape-checked text; the curated taxonomy is a reviewed code registry landing in slice 3   |
| `node_credentials`   | ✅ live `20260831122000`, **no writer** | Renamed from `credentials` (below). `verified` is write-once true — a licence is **revoked**, with a date, never un-verified                             |
| `node_verifications` | ✅ live `20260831123000`, **no writer** | Not in the original nine; forced by them. No policy, no client grant, append-only including for `service_role`                                           |
| `offers`             | ⏳ slice 4                              | Its entire content is a lifecycle. Landing a transition map for transitions nobody can make is the `ad_entities` mistake, already corrected once         |
| `engagements`        | ⏳ slice 5                              | **No state column** — [ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)                                                                |
| `proof_artifacts`    | ⏳ slice 6                              | `artifacts` already has `kind` and `storage_path`. Slice 6 decides new table vs. EXIF/geo columns; deciding earlier would be deciding without the writer |
| `ratings`            | ⏳ slice 8                              | Feeds `trust_score`, which lands now as a nullable column so the writer arrives to a column rather than a migration                                      |
| `disputes`           | ⏳ slice 8                              | With the ops path. A `disputed` task and no ops console is a state nobody can leave                                                                      |

**Two deliberate divergences from what this doc used to say, reconciled rather
than left to drift (rule 1):**

- **`credentials` is `node_credentials`.** A table called `public.credentials`
  sitting three tables from `channel_connections` reads as auth credentials to
  every future schema browser, and this repository's posture is that the next
  reader should not have to check.
- **`service_geo` (PostGIS) is `service_jurisdictions text[]`.** PostGIS is not
  installed, and the matching rule this doc specifies — "service geo/jurisdiction
  **includes** the task location", ranked by "jurisdiction **exactness**" — is a
  containment test over a hierarchy plus a specificity ordering, not a geometry
  query. Argued, with its trigger to revisit, in
  [ADR-0015](../40-adr/0015-service-geo-is-a-jurisdiction-code.md).

### Enum values, and the contested ones

- **`kyc_status`** `unverified | pending | verified | rejected | suspended`.
  `rejected` and `suspended` differ in what can undo them, so collapsing them
  makes "can this person try again" unanswerable from the row. **No `expired`**:
  a state you must run a clock to enter is wrong between sweeps, so credential
  expiry is a date evaluated at match time.
- **`node_availability`** `available | paused | offboarded`. **No `busy`**:
  workload is derivable by counting live engagements, and this doc already
  treats it as a ranking input rather than an eligibility gate. Defaults to
  `paused`, because a permissive default is one every future writer must
  remember to override.
- **`credential_kind`** `lawyer | accountant | notary`. **No `other`**: a hard
  filter that matches everything is the regulated-task control switched off.
- **`verification_kind`** `document | liveness | face_match | face_search |
sanctions_pep | license_check`. The 1:1 and 1:N face checks are separate
  because only the second can name a third party.
- **`verification_result`** `passed | failed | inconclusive | error`. The last
  two decide retryability oppositely: the provider could not tell (retrying the
  same evidence is pointless) versus our call failed (retrying is exactly
  right). **No `pending`** — that is `kyc_status`.
