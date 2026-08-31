# Module: Human Nodes Marketplace

> Owns the human workforce: node onboarding + KYC, the skill/trust graph, skill-based ranked matching, offers with expiry/cascade, the full engagement lifecycle (accept → escrow → chat → proof → approval → payout → rating), and anti-fraud. It **completes the agent's waitpoint** on verified task completion.
>
> **Owner paths:** `apps/matcher/**` · **Depends on:** auth-identity (node role, RLS), payments-billing (escrow, payouts), chat-discord (per-task thread membership), notifications (offer fan-out, expiry cascade), ai-orchestrator (`request_human_node`, waitpoint completion), integrations (KYC/IDV).
>
> Update on any change to onboarding/KYC, matching, the offer flow, the engagement state model, or anti-fraud.

## Implementation status

**Live: the domain, threads, and now onboarding. A node exists.**
`20260831120000` … `20260831123000` landed `node_profiles`, `node_skills`,
`node_credentials` and `node_verifications` with RLS, structural constraints, two
triggers and a 46-assertion pgTAP suite. `20260901120000` … `20260901123000`
landed `threads`, `messages.thread_id`, and `room_members.scope` finally being
enforced, with a second 46-assertion suite. **Both landed zero new capability**:
no route, no adapter, no registry, no client grant that permits a write.

`20260902120000` … `20260902122000` are the first writers. `user_role.human_node`
has had no writer since `20260724000000` and now has exactly one:
`public.invite_node`, reachable by `service_role` alone, called by
`scripts/invite-node.mjs` and by nothing else. An invited person signs in at
`/node`, states where they work and what they do, claims any licences they hold,
and passes an identity check. **No `task_state` arc is restored** and `matching`
is still dead: this slice creates the people slice 4 will match, and nothing that
matches them.

**Corrected here rather than carried forward.** The slice table below used to say
this slice closes `user_role.human_node` **and** `author_kind.node`. It closes
the first. `messages_insert_own` still pins `author_kind = 'user'`, and no node
can be admitted to a room or a thread, so `author_kind.node` still has no writer.
It gets one from the slice that first admits somebody.

### What ships

| Piece                                                   | Where                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The KYC lifecycle map                                   | `20260902120000`, inside `private.guard_node_kyc_audit` beside its audit half                |
| The invite                                              | `20260902121000` `public.invite_node`, plus `scripts/invite-node.mjs`                        |
| The verification writer                                 | `20260902122000` `public.decide_node_kyc`                                                    |
| Skill taxonomy, verifier seam and registry, eligibility | `packages/marketplace` (pure, no IO)                                                         |
| The node's own routes                                   | `apps/api/src/routes/nodes.ts`, `apps/api/src/lib/nodes.ts`                                  |
| The node's own surface                                  | `apps/web/app/node`, plus the fake verifier's screen at `/node/verify`                       |
| Tests                                                   | `supabase/tests/node_onboarding.sql` (36), `nodes.test.ts` (27), `packages/marketplace` (49) |

### The KYC lifecycle map

`20260831120000:252-268` deferred it and named this slice and this function as
where it goes, "beside the insert rather than instead of it, because the house
rule is one trigger for both so that an audit entry cannot be forgotten by a
caller and cannot describe a transition that did not happen." Five arcs:

| From         | To           | Made by                            |
| ------------ | ------------ | ---------------------------------- |
| `unverified` | `pending`    | the node submits                   |
| `pending`    | `verified`   | every check passed                 |
| `pending`    | `rejected`   | a check failed                     |
| `pending`    | `unverified` | inconclusive or errored: try again |
| `rejected`   | `pending`    | the node resubmits                 |

**Nothing reaches `suspended`, and nothing leaves `verified`.** Both absences are
the same discipline that deferred the map in the first place: suspension has no
writer until an ops console exists (Phase 3), and re-verification has none until
somebody renews a licence, so permitting either would be the `task_deps` defect.
`node_profiles_suspended_has_reason` is therefore an **unreachable** structural
constraint for now, which is recorded in `marketplace_rls.sql` beside the
assertion that used to exercise it and now passes for a different reason.

**No status is terminal.** `rejected` reads like one and is not: a person whose
document was blurred resubmits, and a lifecycle with no way back is the dead-end
shape this repository has recorded five times. Offboarding is `availability`.

**The trigger binds `service_role` too**, because a trigger is not a grant, so
`decide_node_kyc` cannot route around the map. A node who never submitted cannot
be verified, and that ordering is enforced in Postgres rather than merely
observed by the route.

### Ops-invited, and what that means concretely

The mitigation named under "Cold start" below is now the implementation. There is
no route, no policy and no client grant anywhere that can create a
`node_profiles` row. `invite_node` is granted to `service_role` alone; its only
caller is a checked-in script run by somebody holding the secret key; and it

- refuses an account that does not exist, because an invitation attaches to an
  account and creating one would be minting a credential;
- **never demotes** — `admin` and `ops` are refused outright, since a promotion
  that runs backwards is a privilege bug wearing an onboarding shape;
- requires at least one jurisdiction and one language, which the table's own
  constraints do not, because a node who serves nowhere can never be matched and
  inviting one would create the dead end this ordering exists to avoid;
- is idempotent on a re-invite and does not reset anybody's KYC or overwrite what
  they have since set themselves;
- writes a `node.invited` event, because the invite changes no `kyc_status` and
  would otherwise be the one act in this domain with no trail behind it.

**This is not an ops console and is not dressed up as one.** The admin surfaces
are Phase 3 ([admin-ops.md](admin-ops.md)). A role-gated route would have made
`profiles.role` load-bearing for the first time and still needed a script to mint
the first operator.

### The verification writer, and why it looks like that

`node_verifications` has `update`, `delete` and `truncate` revoked **from
`service_role` as well** (`20260831123000:140`), so `insert ... on conflict do
nothing` is the only idiom available and `idempotency_key` is the entire replay
contract. That forced the design rather than following it:

- **The verdict is derived from the rows in the table after the insert, never
  from the payload.** A replay inserts nothing, so re-deciding from the argument
  would work by accident where re-deciding from the table works by construction.
  This is `campaign_outcomes`' lesson (`20260829123000`) applied to identity: when
  the only available write is an append, the read has to be the source of truth.
- **The idempotency prefix is per submission, not per node.** Two attempts are two
  decisions: somebody whose first check was inconclusive submits again, and
  reusing the prefix would hand back the first attempt's verdict forever. That is
  the inverse of the publish key ([ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md)),
  which is derived from the campaign id alone precisely because a campaign must be
  sent once. Publishing twice spends money twice; verifying twice is a person
  trying again.
- **`detail` holds verdicts, scores and references and never a document, an image,
  a date of birth or a number.** Keeping it that way is the registry's job at the
  boundary, not a shape the function could usefully assert.

### The provider registry, and the accepted risk it enforces

`20260831123000:70-73` left `provider` as unconstrained text and named a code
registry as its validator: "a provider is a reviewed file, and a check constraint
would need a migration per provider." `packages/marketplace/src/verification-registry.ts`
is that file. One entry, `fake`, and `verifierFor` and `carriesRealPii` both
**raise on an unregistered name rather than answering falsy**, because "a provider
we have never heard of certainly collects no real documents" is the exact
inversion that matters.

`carriesRealPii` is the enforced half of an accepted risk, the way
`carriesRealCredentials` is for channel tokens. The writer in
`apps/api/src/lib/nodes.ts` refuses on it, so the first person to wire Persona or
Stripe Identity hits a failing write rather than a paragraph they did not read.
A real verifier arrives with a DPA, a retention schedule, a recorded lawful basis
and a deletion path, in that change and not after it.

### The skill taxonomy

`20260831121000:22-27` put the shape in the column and deferred the vocabulary to
"a reviewed code registry landing in slice 3". `packages/marketplace/src/skill-taxonomy.ts`
is it: ten entries, each carrying whether the skill means anything without a place
attached. The column's regex accepts `growth-hacking`; the taxonomy does not,
because a matcher that has to guess whether that means `outreach` returns one
person for a skill two people have. It also refuses a jurisdictional skill claimed
with no place (a claim to be a notary everywhere) and a universal skill carrying
one (which would split `copywriting` into as many tags as there are territories).

### The node's own surface

`/node`, a standalone page rather than a panel in `/app`, because the two answer
to different people: a node is admitted to a task thread and to nothing else, and
rendering the owner's shell for somebody who can see almost none of it would be
dishonest. A signed-in person with no record is told plainly that they have not
been invited, rather than being offered a form that would strand them.

Routing reads the **`node_profiles` row, not `profiles.role`**. The row is the
fact and RLS enforces who can see it; `profiles.role` gains its first writer in
this slice and still authorises nothing anywhere, exactly as
`20260831110000:27-35` describes. See [auth-identity.md](auth-identity.md).

Three things the surface says out loud rather than implying:

- **A verified, available node is told there is no work yet.** `NO_WORK_YET` in
  `packages/marketplace/src/eligibility.ts` is where that sentence lives and where
  it gets deleted when the matcher ships.
- **Every skill and licence is labelled a claim.** `verified` is false on all of
  them and nothing in this slice can set it true.
- **The verification log is not shown, and the page says why.** The subject of a
  `node_verifications` row is refused it by grant, because a face-search result
  names a third party they may be a duplicate of. An empty list would have looked
  like a bug.

### Deliberately not built in this slice

Credential **verification**. `node_credentials.verified` is write-once true and
requires `verified_at` and `evidence_path`, which requires a storage bucket that
does not exist, and confirming a licence requires a registry we cannot call. So a
licence is claimed and never confirmed, there is no upload control, and
`evidence_path` stays a column with no reader and no writer rather than a
half-read one.

One gap recorded rather than discovered later: `node_credentials`' unique key is
`(node_id, kind, jurisdiction, licence_number)` and `licence_number` is nullable,
so under Postgres's default `NULLS DISTINCT` two claims to be a Texas notary with
no number given **both insert**. The constraint is doing what it was declared to
do and simply cannot express this case, so `findDuplicateCredential` in
`apps/api/src/lib/nodes.ts` checks before the insert.

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

**Not built, and not claimed:** the matcher, offers, engagements, escrow, the
proof loop, payouts, disputes and ratings. **No thread can be created** —
`threads` has no write policy and no client write grant, and creation lands with
the matcher. **No node is admitted to any room**, and that is load-bearing rather
than incidental — see "Thread access" below. **No real KYC provider is wired**:
Persona and Stripe Identity are both paid, so the in-repo fake verifier is the
only registered provider, and `carriesRealPii` refuses the first real one at the
writer rather than in a sentence. Credentials are claimed and never confirmed.
`matching` remains a state with no code behind it, so a verified, available node
has nowhere to be sent, which is what makes ops-invited onboarding the whole
cold-start answer for now.

### The slice sequence

| #   | Slice                                            | What it closes                                                                                                                                              | State arcs it restores                                   |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | ✅ **Domain + guards** `20260831120000`…`123000` | the enums with no tables behind them                                                                                                                        | none, deliberately, and the suite pins that              |
| 2   | ✅ **Threads** `20260901120000`…`123000`         | the narrowing below; a node would otherwise see the whole project DAG                                                                                       | none                                                     |
| 3   | ✅ **Node onboarding** `20260902120000`…`122000` | `user_role.human_node`, which had no writer since `20260724000000`. **Not `author_kind.node`**, which needs a node in a room and gets its writer in slice 4 | none, as planned                                         |
| 4   | **Matcher + offers**                             | `MATCHING`, dead since `20260813120000`, and `ESCALATED`'s only exit                                                                                        | `matching → failed`, `offered → failed`                  |
| 5   | **Accept, escrow, ledger**                       | acceptance. Accept and fund are inseparable because `claimed → escrow_funded` is the machine's only exit from `claimed`                                     | `claimed → matching`                                     |
| 6   | **The engagement loop to `approved`**            | `ESCROW_FUNDED`, and the waitpoint that never completes                                                                                                     | `proof_submitted → in_progress`, `blocked → in_progress` |
| 7   | **Payout**                                       | `APPROVED` on a human task, which today can only reach `done` and leave somebody unpaid                                                                     | none                                                     |
| 8   | **Disputes + ratings**                           | `DISPUTED`, reachable from `in_review` with no ops writer                                                                                                   | all four `→ disputed` arcs, together                     |

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

**Taken, as of `20260902121000`.** `invite_node` is granted to `service_role`
alone and there is no route that reaches it, so the mitigation is structural
rather than a policy somebody could forget. The second half is that `/node` tells
a verified, available person there is no work to offer yet and why, rather than
leaving them to conclude the product is broken. Both halves come out together
when slice 4 lands: the sign-up path and the sentence.

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

| Entity               | Status                                                                    | Notes                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_profiles`      | ✅ live `20260831120000`, written by `invite_node` and `decide_node_kyc`  | Keyed on `user_id`: a node **is** a user, so every child predicate is a plain equality. `available` + not-`verified` is unrepresentable, by constraint   |
| `node_skills`        | ✅ live `20260831121000`, written by `/api/node/skills`                   | Claim and verified claim on one row, one boolean apart. Tag is shape-checked text; the curated taxonomy is a reviewed code registry landing in slice 3   |
| `node_credentials`   | ✅ live `20260831122000`, written by `/api/node/credentials`, claims only | Renamed from `credentials` (below). `verified` is write-once true — a licence is **revoked**, with a date, never un-verified                             |
| `node_verifications` | ✅ live `20260831123000`, written by `decide_node_kyc`                    | Not in the original nine; forced by them. No policy, no client grant, append-only including for `service_role`                                           |
| `offers`             | ⏳ slice 4                                                                | Its entire content is a lifecycle. Landing a transition map for transitions nobody can make is the `ad_entities` mistake, already corrected once         |
| `engagements`        | ⏳ slice 5                                                                | **No state column** — [ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)                                                                |
| `proof_artifacts`    | ⏳ slice 6                                                                | `artifacts` already has `kind` and `storage_path`. Slice 6 decides new table vs. EXIF/geo columns; deciding earlier would be deciding without the writer |
| `ratings`            | ⏳ slice 8                                                                | Feeds `trust_score`, which lands now as a nullable column so the writer arrives to a column rather than a migration                                      |
| `disputes`           | ⏳ slice 8                                                                | With the ops path. A `disputed` task and no ops console is a state nobody can leave                                                                      |

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
