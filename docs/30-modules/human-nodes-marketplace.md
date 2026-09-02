# Module: Human Nodes Marketplace

> Owns the human workforce: node onboarding + KYC, the skill/trust graph, skill-based ranked matching, offers with expiry/cascade, the full engagement lifecycle (accept → escrow → chat → proof → approval → payout → rating), and anti-fraud. It **completes the agent's waitpoint** on verified task completion.
>
> **Owner paths:** `packages/marketplace/**` (pure domain logic) · `apps/api/src/lib/match.ts` (the sweep) · **Depends on:** auth-identity (node role, RLS), payments-billing (escrow, payouts), chat-discord (per-task thread membership), notifications (offer fan-out, expiry cascade), ai-orchestrator (`request_human_node`, waitpoint completion), integrations (KYC/IDV).
>
> Update on any change to onboarding/KYC, matching, the offer flow, the engagement state model, or anti-fraud.

## Implementation status

**Live: the domain, threads, onboarding, the matcher, and now acceptance. A node
can take work, be paid from a budget the owner authorised, and talk to them about
it.**
`20260831120000` … `123000` landed the four tables with RLS, structural
constraints and a 46-assertion pgTAP suite. `20260901120000` … `123000` landed
`threads`, `messages.thread_id` and enforced `room_members.scope`. Both landed
**zero new capability**. `20260902120000` … `122000` were the first writers:
`invite_node` and `decide_node_kyc`, so a node exists, has a profile, claims
skills and licences, and passes an identity check.

`20260903120000` … `121000` are slice 4, and they close the last live dead end.
`escalated` has had no exit but the owner taking the step on themselves since
`router.ts` first routed to it. **An owner now sends the step to the marketplace
from the project panel**, the ticker offers it to one ranked node at a time, a
decline or a 48-hour expiry cascades to the next, and exhaustion returns the step
with an honest message.

**The ordering inverts here on purpose, and it is the first slice in this domain
where it does.** `20260831120000:27-33` deferred `offers` by name because "its
entire content is a lifecycle", and landing a transition map for transitions
nobody can make is the `ad_entities` mistake. So this table ships **with** its
writers in the same change: the matcher sweep and the decline route produce every
arc the map permits.

**Corrected rather than carried.** The slice table below used to say slice 4
restores `matching → failed` and `offered → failed`. It does not, and
[ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)
dates the reversal: `failed` is terminal, it would block every dependent step,
and it would put beyond reach a step the owner can still take with the three
buttons on their panel. `marketplace_rls.sql`'s message text was corrected in the
same change; its verdict is unchanged.

**Also corrected: thread creation does not land here.** `20260901120000:109-114`
said "creation lands with the writer that first needs it, which is the matcher
slice", and slice 4 turns out not to need one. Nothing is admitted to anything in
this slice, so a thread would be a row nobody could read, which is the
fetched-never-rendered defect this repository has recorded twice. Creation moves
to the acceptance slice, which is the first that admits somebody. The applied
migration's comment cannot be edited; this is the correction.

### Slice 5, and the three obligations it discharges

`20260904120000` … `20260904127000` are slice 5. **A node accepts.** The offer
settles to `accepted`, the task walks `offered → claimed → escrow_funded`, an
`engagements` row freezes the price, an `escrow_holds` row models the money
against `projects.budget_ceiling`, a balanced `ledger_entries` pair is written,
the task's thread is created, and the node is admitted to that thread and to
nothing else. **All of it is one transaction**, `public.accept_offer`, because
`claimed → escrow_funded` is the machine's only exit from `claimed`: accepting
without funding would leave somebody holding work nobody paid for, which is
`20260827120000`'s seventeen-permanently-stuck-steps defect built on purpose.

**Nothing is charged.** The only registered payment provider is a deterministic
in-repo fake, `carriesRealMoney` refuses any other before an rpc is made, and the
counsel gate in [payments-billing.md](payments-billing.md) is unmoved: modelling
an obligation against an already-authorised ceiling is not money movement.
`20260904121000`'s header states that at length rather than leaving a reader to
infer it.

**Three obligations booked to this slice by earlier ones land with it**, and all
three were named in advance rather than discovered:

1. **The thread writer.** `20260901120000` shipped `threads` with no writer and
   said creation lands with whatever first needs one. `accept_offer` is it.
2. **The counterparty pair, through `engagements` and never approximated.**
   `20260831120000`, `20260901122000` and `20260901123000` each refused to write
   this policy without a table to join through. `20260904126000` writes it once:
   `private.engaged_counterparty` opens `public.profiles` in both directions
   while an engagement is live, and closes it again when `ended_at` is set.
   **`node_profiles` and `offers` stay closed**, deliberately, and "Who the owner
   can now see" below says why.
3. **The `author_kind = 'node'` writer.** `20260904127000` widens
   `messages_insert_own` so a node posts **through their own grant, on the
   existing client path** (rule 5: every participant INSERTs like any member).
   The route derives `author_kind` from the caller's own membership row and RLS
   re-checks it independently.

**Two structural decisions were taken against earlier bookings, and each has an
ADR.** [ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md): the slice
table booked `claimed → matching` and this slice does not restore it, because
atomic accept-and-fund makes `claimed` transit-only, so the arc has no producer.
[ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md):
`projects.budget_ceiling` now has two classes of committer, and four places have
to move in step.

### What ships

| Piece                                                         | Where                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The KYC lifecycle map                                         | `20260902120000`, inside `private.guard_node_kyc_audit` beside its audit half                                                                                                                                                      |
| The invite                                                    | `20260902121000` `public.invite_node`, plus `scripts/invite-node.mjs`                                                                                                                                                              |
| The verification writer                                       | `20260902122000` `public.decide_node_kyc`                                                                                                                                                                                          |
| **The offer table and its lifecycle**                         | `20260903120000`, with `private.offer_transition_allowed` and its guard trigger                                                                                                                                                    |
| **The matcher's selection index**                             | `20260903121000` `tasks_market_idx`, the first global by-state read of `tasks`                                                                                                                                                     |
| Skill taxonomy, verifier seam and registry, eligibility       | `packages/marketplace` (pure, no IO)                                                                                                                                                                                               |
| **The stage-to-skill map, jurisdiction containment, ranking** | `packages/marketplace/src/{stage-skills,jurisdiction,matching}.ts` (pure, no IO)                                                                                                                                                   |
| **The matcher sweep**                                         | `apps/api/src/lib/match.ts`, on the ticker after optimize and before crawl                                                                                                                                                         |
| **The owner's dispatch**                                      | `find_expert` in `apps/api/src/routes/task-actions.ts` and `lib/task-resolution.ts`                                                                                                                                                |
| **The node's offer routes**                                   | `GET /api/node/offers`, `POST /api/node/offers/:offerId/decline`, `apps/api/src/lib/offers.ts`                                                                                                                                     |
| The node's own routes                                         | `apps/api/src/routes/nodes.ts`, `apps/api/src/lib/nodes.ts`                                                                                                                                                                        |
| The node's own surface                                        | `apps/web/app/node`, plus the fake verifier's screen at `/node/verify`                                                                                                                                                             |
| **The owner's surface**                                       | "Find an expert" in `ProjectPanel.tsx`'s `ResolveStep`                                                                                                                                                                             |
| **The deal, the hold and the ledger**                         | `20260904120000` … `122000`: `engagements` (no state column, ADR-0016), `escrow_holds`, double-entry `ledger_entries`                                                                                                              |
| **Acceptance**                                                | `20260904125000` `public.accept_offer`, one transaction; `20260904124000` gives the offer map its `accepted` arc                                                                                                                   |
| **The ceiling's second committer class**                      | `20260904123000` ([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md)), `packages/payments`, `spend-reads.ts`, `spend.ts`                                                                                          |
| **The counterparty pair**                                     | `20260904126000` `private.engaged_counterparty`, a second policy on `profiles`                                                                                                                                                     |
| **A node's own voice in chat**                                | `20260904127000` widens `messages_insert_own`; `apps/api/src/routes/messages.ts` derives `author_kind` from the membership row                                                                                                     |
| **The money seam and the ledger pairs**                       | `packages/payments` (pure, no IO): chart of accounts, balanced pairs, idempotency keys, provider seam and registry                                                                                                                 |
| **Giving escrow back**                                        | `apps/api/src/lib/escrow-reconcile.ts` on the ticker, the only producer of `held → refunded`                                                                                                                                       |
| **The node's accept and engagement routes**                   | `POST /api/node/offers/:offerId/accept`, `GET /api/node/engagements`, `apps/api/src/lib/engagements.ts`                                                                                                                            |
| Tests                                                         | `supabase/tests/{node_onboarding,marketplace_offers,marketplace_engagements}.sql` (36, 37, 70), `nodes.test.ts` (51), `match.test.ts` (21), `escrow-reconcile.test.ts` (12), `packages/marketplace` (87), `packages/payments` (27) |

### How a step reaches an expert

1. The router sends a human-owned step to `escalated`, as it always has.
2. **The owner clicks "Find an expert."** Not a sweep: twelve steps sit in
   `escalated` on the live database, and a sweep claiming them all on deploy
   would offer a cold-start pool a dozen steps at once while removing the two
   controls that already worked. The route refuses before the step moves if the
   stage maps to no skill, or if nobody eligible claims those skills, so a step
   that cannot be staffed keeps all three buttons and is told why.
3. The task moves `escalated → matching`, conditionally, so an owner resolving it
   in the same instant wins and the loser gets an honest 409.
4. The next tick ranks the pool, inserts one offer, and moves the task to
   `offered`. The offer runs for 48 hours.
5. The node reads it at `/node` and can decline, with an optional reason. **The
   decline route settles the offer and never touches the task**, because the
   sweep is the single writer of `tasks.state` here; two writers racing, one on a
   person and one on a clock, is how a step gets offered to two nodes at once.
6. A settled offer sends the task back to `matching`, and the next pass offers the
   next candidate. Nobody is asked twice: `offers_task_node_idx` is a unique
   index, not a convention.
7. When the pool is exhausted the step returns to `escalated` with a message
   naming it ([ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)).

### What the matcher can actually rank on

The algorithm below specifies "skill/credential fit, jurisdiction exactness,
rating + completion-rate, price, responsiveness, current workload".
`node_skills.verified` and `node_credentials.verified` are false with nothing
able to set them true, and responsiveness has nowhere to be recorded. No task
carries a location, so jurisdiction is never asked for.

**Two of those inputs started moving in slices 7 and 8 and the matcher still does
not read them**, which is stated here rather than left to look like an
oversight. `completed_engagements` gained its writer in `settle_payout` and
`trust_score` gained one in `submit_rating`, so both are real numbers on a row
that has finished a deal. Weighting them is its own slice with its own argument
about what the weights should be, and slice 8 deliberately did not open it (rule
20). Until then the trade is visible: a node with a five-star record is ranked
exactly like one with none.

That leaves **price**, plus a stable tiebreak on node id. `matching.ts` says so
rather than computing a weighted score over columns that were, when it was
written, all constant. The weights arrive with the argument about what they
should be, not merely with the data.

Two consequences stated rather than implied:

- **The pool matches skill claims, not verified skills.** A verified-only filter
  matches nobody, forever, because credential verification needs an evidence
  bucket and a licence registry that do not exist. Matching claims is safe here
  in a way it would not be for a regulated act: these are marketing steps, the
  owner reviews the work, and no money moves in this slice. It stops being the
  posture the moment a jurisdictional skill is matchable.
- **The tiebreak is deterministic, not random.** A crashed sweep re-ranking the
  same pool must reach the same candidate, a dispute needs the ranking
  reconstructible from rows, and sorting on an id is arbitrary and admits it
  where a shuffle pretends to a fairness nothing is measuring.

### Where the requirements come from, since `tasks` has none

`required_skills` appears exactly once in this repository: in the matching
algorithm below. There is no column, no contract field and no type.
`packages/marketplace/src/stage-skills.ts` is the answer: a reviewed map from the
six funnel stages the planner emits to universal skill tags, failing closed on
anything else.

Two alternatives were rejected. Asking the planner for `required_skills` puts a
matching decision inside a model, needs a column and an eval pass, and hands a
model authority over which humans get paid. Asking the owner at dispatch asks
them the question they escalated because they could not answer it.

**The three jurisdictional skills are unreachable from a marketing plan**, so
`jurisdiction.ts` implements ADR-0015's containment and specificity operations
and nothing exercises them against a real match yet. That is stated in the file
rather than left for a reader to discover.

### The offer lifecycle

| From   | To          | Made by                                                      |
| ------ | ----------- | ------------------------------------------------------------ |
| `open` | `declined`  | the node, through the decline route                          |
| `open` | `expired`   | the sweep, settling a passed `expires_at`                    |
| `open` | `withdrawn` | the sweep, when the task left the market underneath          |
| `open` | `accepted`  | the node, through `accept_offer`, which funds escrow with it |

All four settlements are terminal, so a cascade cannot reopen what it closed.
**`accepted` gained its producer in `20260904125000`, which is what let
`20260904124000` add the arc**: acceptance and funding are one transaction, so an
offer can settle a fourth way without leaving anybody holding unfunded work. The
pgTAP assertion that used to pin the refusal flipped with it, and the wording it
had carried was deliberately descriptive rather than promissory, which is why the
flip is one line rather than a correction.

**Expiry is a timestamp, never a status a clock must write**
(`20260831120000:56-59`, applied again): readers compare `expires_at` against
now, so a node is never shown a live offer that a sweep has not got round to
settling. The sweep settles the row for the trail, and no reader depends on it
having run.

Three uniqueness rules carry most of the design: `unique (task_id, round)` is the
sweep's replay contract, `unique (task_id, node_id)` means a node is asked once
ever, and a partial unique on `(task_id) where status = 'open'` makes
one-at-a-time cascade structural rather than sweep discipline.

**Nobody sees an offer but the node it was made to.** The table has one policy and
it is `node_id = auth.uid()`. The owner reads zero rows, deliberately: an offer
names a node, `20260901122000` closed the owner-sees-node and node-sees-owner pair
together, and the engagement slice opens it with a policy written for it. The
panel shows the owner `tasks.state`, which is what they need. pgTAP asserts the
owner's zero, so it stays a decision rather than an oversight somebody fixes.

**Delete and truncate are revoked including from `service_role`**, the
`node_verifications` precedent: the offer trail is what a dispute reads and what
slice 8 rates on.

### The limits this slice ships with

- **A re-dispatch against an unchanged pool exhausts immediately**, because a node
  is offered a task once ever. "Search later" only helps once new nodes join. A
  re-offer policy needs a reason to re-ask, and "the owner clicked again" is not
  one, so it is a later slice's decision.
- ~~**A node is not told about an offer.** The notifications module is specified and
  unbuilt, and there is no push, email or SMS anywhere, so an offer is discovered
  by visiting `/node`. That is what sets the 48-hour window: anything shorter
  would expire against people who had not looked yet.~~ **Closed by notifications
  slice 1** (`20260909120000`…`122000`): `offer.created` derives an inbox row for
  the node it was offered to, and the count moves on their open page without a
  reload ([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)).
  Kept struck through rather than deleted, because **the 48-hour window has not
  changed and this is the sentence that explains why it was that wide**. It is
  now unblocked rather than justified, and shortening it is its own decision.
  Push, email and SMS remain unbuilt.
- **Once dispatched, the owner has no control until the cascade returns the step.**
  There is nothing useful to offer while a stranger is deciding, and the step
  comes back within 48 hours per candidate if nobody takes it.
- **Accepting was disabled with its reason printed**, rather than hidden, for
  the length of slice 4. It is live from slice 5, and both the disabled state and
  the sentence beside it are gone rather than left behind as a control that lies
  about itself.

### Slice 6: the engagement loop, and the arc that turned out not to be needed

`escrow_funded` had been where a funded step stops since slice 5, because
`escrow_funded → in_progress` had no producer. Slice 6 supplies the producers.

```
escrow_funded   → in_progress                        the node's start route
rejected        → in_progress                        the same route, same button
in_progress     → proof_submitted                    the node's hand-over route
proof_submitted → in_review → approved | rejected    the owner, in one request
```

**Every one of those arcs was already in the map**, declared by `20260813120000`
and walkable by nothing, so the core loop lands with **no migration at all**.
That is what guards-before-writers is supposed to produce, and it is the first
time in this domain that the answer to "which migration adds the arc" is "none".

**`proof_submitted → in_progress` stays dropped**, reversing the booking in the
slice table below, and the reason is worth recording because it was found by
building rather than by arguing. It was booked for two uses: a proof withdrawn
before review, and the floor check bouncing a bad submission. Retraction has no
producer. And the bounce does not need it, because **the check runs before
anything is written and before the task moves**, which is `task-actions.ts`' and
`match.ts`' standing idiom, so a bounced submission leaves the step exactly where
it was. Restoring the arc would have put two meaningless transitions in the audit
trail every time somebody left a field blank.

**`blocked → in_progress` also stays dropped**, on
[ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)'s
grounds: nothing writes `blocked` for a human step, so it is an exit from a state
nothing can enter.

**`in_review` is transit-only**, exactly as `claimed` is
([ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md)). A submission
lands at `proof_submitted` and stays there until somebody looks, because that is
the honest state: `in_review` means "being reviewed", which is true for the
instant the owner is deciding and is not where a step should sit for two days
waiting on them. The owner's action walks both hops in one request as two
conditional updates, so every guard fires and both moves write their own audit
row.

#### Proof is an `artifacts` row, not a new table ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md))

The entity table below booked `proof_artifacts` here and left the decision open.
It is decided **against**. `artifact_kind` is an enum carrying `'proof'` since
`20260813160000`, and `alter type ... add value` cannot be rolled back, so a
second table would strand an unremovable value with no writer. It would also need
its own project policy, its own `storage.objects` policy, its own path
convention, its own signed-URL route and its own arm in the owner's panel: the
two-readers-of-one-question shape that `20260829124000` prices at "47 tasks and
28 of 58 artifacts". EXIF and geo are not the reason to split, because a check
produces a **verdict**, and a verdict table keyed on `artifact_id` is a different
thing from a second deliverable table. There is no extractor in this slice, so
such a column would be the `task_deps` defect.

**One submission writes one note row plus zero or more file rows**, all
`kind = 'proof'`. `writeFileArtifact` gets its **first production caller** since
it was written and tested for the creative slice, and one defect goes with it: it
hardcoded `created_by: 'agent'`, so every proof would have lied about its author
on the one surface where authorship is the point.

#### The node reads their own proof by projection, not by policy

A thread-scoped member is not a project member, so they read zero rows from
`artifacts` and zero objects from its bucket, and **slice 6 changes neither**.
`thread_scope.sql`'s zero-artifact assertions keep passing with their verdicts
unchanged.

Opening `artifacts` by engagement was considered and rejected, and the storage
half is what decides it: `private.artifact_object_project` resolves the tenant
from the **project** in path segment one of `<project_id>/<artifact_id>/<filename>`,
and there is no task in that path. An engagement-scoped object policy would need
a per-object text join against `artifacts.storage_path`, or a change to a
convention stated in three places and backfilled across every existing object.
Opening the row half alone would show a node a row whose file 404s. And opening
`artifacts` by engagement would hand over **every** artifact on that task,
including the AI's drafts and the owner's own write-up, which is a disclosure
decision this slice does not need to make and which `20260904126000` already
refused for `node_profiles` and `offers`.

So the four node routes read the caller's own `engagements` row **as them**
through `engagements_select_node`, and the service key does everything after. The
projection is the access control, as it is for offers and engagements.

#### The checker is a floor, and it says so

`packages/core/src/critic.ts` gains `reviewProof` and `nextStateAfterProofReview`.
`review` was the wrong function: its three real checks are about **citations**,
and a node's proof cites nothing by construction, so `lost_grounding` would fail
every proof ever submitted and `fabricated_citation` could never fire.

Three deterministic checks: something was produced; the note is long enough to be
a hand-off rather than "done"; and **every acceptance criterion has a non-empty
response**. That last one gives `tasks.acceptance_criteria` its **first consumer**
since `20260816120000`, which named this as the cost it was accepting.

**No LLM judge, and the reason is stronger here than it was for `review`.** This
gate stands between a person and being paid. A verdict that differs between two
runs of the same input does not belong there, and `stage-skills.ts` already
refused to hand a model authority over which humans get work. It cannot reach
`approved` at all: the only states it produces are `in_review` and `in_progress`,
because the AI does not decide that a person's work is finished.

#### A step nobody delivered goes back to the market ([ADR-0023](../40-adr/0023-a-breached-deadline-reassigns.md))

`escrow_funded` and `in_progress` were the two states where an owner's money is
committed against work that has not arrived, and neither had an exit that was not
the owner cancelling the whole step. An expert who accepted and vanished pinned
part of the budget indefinitely.

**The deadline is agreed before the work is taken.**
`offers.work_deadline_hours` is written by the matcher from `WORK_TTL_HOURS`
(seven days, a constant for `OFFER_TTL_MS`'s reason), so the node sees it on the
offer card; `accept_offer` freezes it onto `engagements.deadline_at`, **reading
the offer row and never an argument**, because the caller of the accept route is
the node and a node naming their own deadline is the same refusal as a node naming
their own price. `deadline_at` had been a column with no writer for two slices.

**A warning comes first**, once ever, a day out, in the node's own thread. Somebody
quietly getting on with it who lost track of the date gets a nudge rather than a
cancellation; somebody who has genuinely disappeared is unaffected either way,
which is why it is a day rather than an hour.

**The reassignment is one database function** for `accept_offer`'s reason, argued
in the ADR: every partial state either double-commits the ceiling against the
replacement or takes money from a node who is still working. Its step 2 is the
whole safety argument, and it is a race with a person rather than with a clock:
the task move is conditional on the two abandonable states, and **zero rows raises
and unwinds everything**, because a node who submitted their proof in that window
has delivered and wins.

**It never reassigns a step that was handed over.** `proof_submitted` and
`in_review` are refused by the transition map and excluded by the sweep's
selection, which is deliberate duplication for the one rule where a single guard
is not enough: a deadline that passes after the work arrives is the **owner's**
failure to review, and reassigning there would take a finished person's fee and
give it to a stranger.

**One defect shipped with the arc and is fixed in the same push.** `cascadeRound`
counted only `offered → matching`, so a task arriving at `matching` from
`escrow_funded` would have re-derived the round its no-show already holds,
collided on `offers_task_round_idx`, read back the **no-show's accepted offer**,
and dispatched a third node against it. That is the second objection ADR-0019
raised against reintroducing an arc into `matching`, arriving as predicted. The
predicate now counts every return from dispatch, which is arithmetically identical
today so no live task renumbers.

**Two arcs restored, three deliberately not.** `claimed → matching` stays dropped
(ADR-0019's premise still holds), `proof_submitted → in_progress` stays dropped
(ADR-0022), `blocked → in_progress` stays dropped (nothing writes `blocked`).
After five consecutive slices restoring none, this one restores two, and both
arrive with their producer in the same push.

#### The limits slice 6 ships with

- ~~**Nothing is paid.**~~ **Closed by slice 7.** `held → released` is in the map
  now and `public.settle_payout` is its producer.
- **The engagement is still not ended on approval**, and that was the right call
  rather than a deferral: ending it is `settle_payout`'s, in the same transaction
  that releases the escrow, because the two facts are one fact — a deal is
  completed when the person is paid, not when the owner says the work is good.
  Between the two the panel still reads a live engagement and the owner still
  reads the node's name.
- **Thread access is revoked on approval**, which discharges the obligation
  `accept_offer` booked by name. Conditional on `expires_at is null` and scoped
  to this task's thread, so it cannot touch a membership the node holds
  elsewhere.
- **`nda_signed_at` and `terms_hash` still have no writer.** The shape is settled
  and the writer is not. `deadline_at` no longer belongs on this list.
- ~~**Nobody is notified of anything, still.** The owner learns a step was handed
  over from a system message in their room; the node learns a verdict by opening
  `/node`. That absence is what sets the deadline at seven days: anything tighter
  would expire against people who had not looked.~~ **Closed by notifications
  slice 1**: `proof.submitted` reaches the owner and `work.approved` /
  `work.rejected` reach the node. Kept struck through because the **seven-day
  deadline is unchanged**, and this is the sentence that says why it was set
  there. It is now unblocked rather than justified.
- **A deadline cannot be extended.** The sweep warns once and then acts. A node
  can ask for longer in the thread and the owner has no way to grant it, because
  an extension writer needs a surface, an authorisation question (whose extension
  is it to grant?) and an audit story, and inventing all three alongside the
  column's first producer is how a control ships without its reasoning.
- **The seven days have never been tested against a real miss.** The number is a
  guess made the way `OFFER_TTL_MS` was, and its falsifier is the first deadline
  missed for a reason other than silence.

### Slice 7: the expert gets paid, and `done` gets its first producer ever

`approved` on a human step was a dead end slice 6 shipped and named. The owner
said the work was finished, the step stopped, and four things stayed as they were:
the hold said `held` and kept committing `projects.budget_ceiling`,
`held → released` was declared and producerless, `engagements.outcome` never
reached `'completed'`, and `node_profiles.completed_engagements` — which slice 8
ranks and rates on — was zero on every row in the database.

**Four migrations, one sweep, and no `task_state` migration**, for the second
slice running: `approved → payout_pending → paid → done` were all declared by
`20260813120000` and walkable by nothing. Slice 6 was the first time the answer to
"which migration adds the arc" was "none"; this is the second.

#### Approving the work is the payout authorisation

There is no second button, on
[ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md)'s argument
unchanged and on payments-billing.md's own money flow, which already said approval
triggers the transfer. The owner authorised this exact figure when the escrow was
funded at acceptance, has seen it on the step, and has read the proof and clicked
approve; a confirmation carrying no new information is one people learn to click
through.

The approve route therefore records **nothing** extra — not even a payout intent.
The sweep selects on `approved` as well as `payout_pending`, so there is no window
in which a crash between two writes in that route could strand a step nobody pays
for.

#### `done` gets a producer, on the human arm only

Nothing in this schema had ever reached `done`. `private.task_state_is_terminal`
is `('done','failed','cancelled')`, so a step stopping at `paid` would be
non-terminal forever and still cancellable — a kill switch could cancel work that
was finished and paid for.

**An AI step still stops at `approved` and is still non-terminal**, which is the
same defect one arm over, and closing it was deliberately declined here.
`approved → done` on an AI step involves no money, belongs to
[business-projects-workflow.md](business-projects-workflow.md), and closing
somebody else's arc from a marketplace slice is how a repository ends up with two
half-owners of one state machine. `marketplace_payout.sql` asserts the absence so
it is written down rather than left to be found.

#### The take rate is not deducted ([ADR-0024](../40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md))

`payouts.platform_fee` lands as a column written from one constant, and that
constant is zero. Escrow holds exactly the `agreed_price` the offer showed the
node **before** they accepted; the matcher ranks on that number, `accept_offer`
freezes it, and the node console renders "Accept and lock the price" beside it.
Deducting a cut at release would mean every one of those surfaces showed somebody
a figure and then paid them a different one. A take rate needs the offer to name
it first, which is a pricing slice with its own surfaces and its own ceiling
arithmetic.

#### What the counterparty pair cost, and why it was not planned

`private.engaged_counterparty` was time-boxed on `ended_at is null`, and
`20260904126000` called that "the entire time-box" — correctly, while the only
endings were `cancelled` and `reassigned`, on neither of which anything was
delivered. `settle_payout` adds a third ending where the opposite is true, so
ending the deal would have done exactly what slice 6 refused to do one step later:
erase the node's name from the owner's panel at the moment they were being paid,
and before slice 8 asks the owner to rate them.

`20260907123000` widens it to `ended_at is null OR outcome = 'completed'`, in both
directions, **permanently rather than on a grace window**: ratings and disputes
both look backwards, and a window would expire in the middle of the thing it
exists to support. `'cancelled'`, `'reassigned'` and the then-future
`'disputed_resolved'` all stayed shut — the first two because nothing was
delivered, the third because slice 7 had no standing to decide what a resolved
dispute leaves the two parties entitled to see, and guessing on its behalf is how
a disclosure decision gets made by whoever wrote the migration first.

**Slice 8 decided it**, in `20260908126000`: `'disputed_resolved'` is admitted, so
both parties keep the record of a deal an operator had to settle. `'cancelled'`
and `'reassigned'` stay shut on their original grounds. The asymmetry that
follows is the intended one and is argued under slice 8 below: such a deal is
**readable and not rateable**.

**Widening the policy alone was not enough, and that was a shipped defect.** The
panel's own query in `apps/api/src/routes/projects.ts` filtered
`ended_at.is.null,outcome.eq.completed` and was left a slice behind, so an owner
whose dispute had just been decided saw **no engagement line at all** — worse
than the "somebody" the migration argued against — while the node kept reading
the same deal at `/node`, which filters on nothing. The two predicates are meant
to be identical by construction and the comment above the query says so; nothing
compares a migration to a query string, so nothing noticed. Found by resolving a
real dispute against the running stack, and fixed in the same push. The general
rule, since this is the second time the pair has moved: **the policy and the read
change together or the read is wrong in the quiet direction.**

This is recorded as a consequence **discovered by building the slice** rather than
one booked in advance, because the alternative reading — that `20260904126000` got
the time-box wrong — is not true. It was right about the deals that could end
then.

#### The limits slice 7 ships with

- **Nothing is transferred.** The only registered provider is the in-repo fake,
  its references are visibly `tr_fake_…`, and `carriesRealMoney` is now checked in
  **two** places rather than one: before the accept rpc and before the transfer.
  The payout check runs once per pass before a single row is read and **throws**
  rather than returning a count, so a refused pass is inert. payments-billing.md's
  counsel gate is unmoved.
- **No Connect Express onboarding, and no column waiting for one.**
  `CreateTransferInput.destination` is the node's own user id in this build. A
  real provider needs an `acct_…` a person establishes through Stripe's hosted
  flow, and that is a slice with a route, a redirect, a webhook and a surface —
  not a `node_profiles.payout_account_id` sitting empty, which is the defect this
  repository has recorded six times.
- **`payouts.failed` is declared and refused**, deliberately the shape `released`
  had. Every failure retries at tick cadence, because a terminal row against work
  somebody did, in a build with no ops console to un-terminal it, is worse.
- ~~**The node is not told they were paid.** Slice 6 revoked their thread access
  when the owner approved, so there is no surface to tell them on; they see it on
  `/node`, where the engagement has moved to "Finished and paid" with the amount
  beside it. Notifications remain specified and unbuilt.~~ **Closed by
  notifications slice 1**, and the revoked thread access is exactly why it needed
  a channel that is not the thread: `payout.settled` derives a row carrying the
  amount, on a topic that belongs to the person rather than to the room.
- **`nda_signed_at` and `terms_hash` still have no writer.**
- ~~**Disputes and ratings are slice 8**, so all four `→ disputed` arcs stay
  dropped and `trust_score` is still NULL on every row.~~ **Closed by slice 8**,
  which restored all four together and gave `trust_score` its first writer. Kept
  struck through rather than deleted, because what slice 7 shipped without is the
  record of why slice 8 existed.

### Slice 8: the last dead end, and the first ops surface

Slice 7 finished the happy path: a step runs from `escalated` all the way to
`done` and somebody is paid. What it left behind was the unhappy one. `disputed`
had been declared since `20260813120000`, narrowed to a single inbound arc by
`20260815220000`, and refused by name in every slice since — most recently
`20260906123000:53-54`: "No `-> disputed` arc is restored. Slice 8, with the ops
console. A `disputed` task nobody can move is the `escalated` defect on purpose."

This slice restores **all four** inbound arcs, adds one new edge, and builds the
console that makes them safe. The reasoning for every arc is
[ADR-0026](../40-adr/0026-the-dispute-exit-map.md); the money half of a partial
settlement is [ADR-0025](../40-adr/0025-a-partial-settlement-is-a-refund-and-a-new-hold.md).

#### The freeze is one statement, and there is no flag

Moving a task to `disputed` **is** the freeze. `PAYABLE_TASK_STATES` in
`apps/api/src/lib/payout.ts` is `('approved', 'payout_pending')`, so the payout
sweep's selection stops matching the step the moment `raise_dispute` commits.
There is no `frozen_at`, no pause row and no flag beside the state, because a
flag is a second thing the sweep has to remember to read and a freeze that
depends on a reader remembering is not a freeze.

This is also why `payout_pending -> disputed` matters: it is the arc that catches
a step in the window between the owner approving and the sweep sending.

#### Both parties can raise, and the node's arc is the load-bearing one

    owner   escrow_funded, in_progress, payout_pending
    node    rejected

The owner's three are "I paid for this and something is wrong", at the three
points where that is still true and the money has not left. The node's one is the
mirror, and it is **the only act in this system a node performs against the
owner**. `rejected` is the only state where a person has told a node no; before
this arc their options were to redo work they believe was fine, or to stop
answering — and stopping is read by the no-show sweep as _their_ failure, which
reassigns the step away from them and costs them both the work and the fee for a
decision they could not contest.

`in_review -> disputed` stays legal and has no button, because `in_review` is
transit-only and no step rests there for somebody to dispute from.
`proof_submitted` is deliberately not disputable by the owner: work handed over
and not yet judged is a review, and `reject_work` with a required note is the
cheaper, more informative act. If that rejection is contested, the node's arc is
what answers it.

#### Ratings, and `trust_score`'s first writer

`node_profiles.trust_score` has been NULL on every row since `20260831120000`,
whose column comment fixed the meaning before there was a writer: "cold start,
never zero, because zero would mean measured and worthless."

    trust_score = round(avg(score) / 5.0, 4)   over ratings received

That is the whole formula, and the restraint is the design. `:908` above
specifies more — "seeds from KYC + verified credentials and grows with completed
jobs/ratings" — and **three of those four inputs cannot be computed in this
build**: KYC is a single in-repo fake so every verified node passed the same
check, no credential can be verified at all so that term reads a column that is
`false` on every row, and folding `completed_engagements` into a _quality_ score
is a decision about what this market rewards rather than a smoothing detail to
settle inside a migration. The count is there for the matcher to read beside the
score, where it is visible.

No prior, no shrinkage, no confidence weighting either. Those exist to stop one
five-star rating outranking a long good record, which is real — and the honest
fix is the matcher reading the count beside the score rather than this function
folding a guess about sample size into a number that silently means something
different for a new node than an established one.

**Two-sided and immediately visible.** Both directions land together because a
market where only the buyer rates puts all the reputational risk on the
individual being paid, and this market's sellers are individual people. Blind
reveal is not built: it is a lifecycle with a hidden state, a clock and a sweep,
and it would be machinery for a risk this build cannot observe, in a market with
no self-service registration. Recorded as a decision with its revisit trigger
named — the first retaliatory pattern an operator sees, or open registration.

**A `disputed_resolved` deal is readable and not rateable**, which is the
intended asymmetry. `20260908126000` admits the outcome to
`private.engaged_counterparty` so both parties keep the record; `submit_rating`
gates on `completed` alone so neither gets a scoreboard entry out of an
adjudication. An operator has already produced a finding, a reason and a money
outcome, which is a better record than a number out of five, and collecting a
score from whoever lost would feed the matcher the output of a grievance.

#### The limits slice 8 ships with

- **Node suspension is not built**, though `:1040` specifies it and
  `node_profiles_suspended_has_reason` has constrained an unreachable value since
  `20260831120000`. It needs three things this slice has not got: a documented
  un-suspend arc, a threshold that is not a kill switch wearing a threshold's
  shape (ADR-0014's zero-ceiling argument), and a moderation console to review
  the evidence. `kyc_status` still has no `* -> suspended` arc.
- **A dispute after `paid` is out of scope.** `payouts.transfer_id` is write-once
  and the money has left; the task is terminal.
- **Nothing is transferred, still.** `carriesRealMoney` gates the three
  resolutions that settle escrow, refusing before anything is written, exactly as
  the payout sweep does. payments-billing.md's counsel gate is unmoved.
- ~~**The node is not told they were disputed**~~, **and their thread is still not
  posted to.** Half of this closed and half of it is a decision that stands.
  `dispute.raised` now derives a row for whichever party did not raise it, and
  `dispute.resolved` derives one for both. **The working thread still gets
  nothing**, for the reason it always got nothing: a dispute is decided by an
  operator rather than negotiated between the parties, and a line in the thread
  would invite exactly that negotiation. An inbox row is not a negotiation. The
  row also carries no `resolved_by`, so an operator is never named to the parties
  ([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)).
- **`nda_signed_at` and `terms_hash` still have no writer.**
- **The matcher is unchanged.** `trust_score` now moves, but
  `packages/marketplace/src/matching.ts` still ranks on price with a
  deterministic tiebreak. Weighting a live score is its own slice with its own
  argument about what the weights should be; scope hygiene (rule 20).

### The limits slice 5 ships with

Stated here rather than discovered, on this section's standing habit.

- **A node has no realtime, and reads their thread by polling.** Thread topics
  are not built: a `'chat:thread:'` branch would still have no broadcaster and no
  subscriber, and both `realtime.messages` policies remain room-scoped. The
  since-cursor `GET` runs as the caller and RLS returns exactly their thread, so
  **the failure mode is a delay of up to one interval, never a disclosure.**
  Topics move to slice 6, which is the second time this obligation has been
  re-dated and the first time it has been re-dated with a working alternative in
  place.
- **One thread per person per room, so a node works one step of a project at a
  time.** `room_members` is keyed on `(room_id, user_id)`
  ([ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md)),
  so admitting somebody twice in one room is not representable. `accept_offer`
  refuses the second acceptance with a sentence rather than absorbing it
  silently, because reusing the existing membership would admit them to the
  wrong thread. A real product limit, and lifting it means a second membership
  row per room, which is a change to that ADR.
- **Hourly nodes are excluded from the pool entirely.** An hourly rate is a price
  per hour, an escrow hold is a total, and there is no hours field anywhere to
  multiply by; estimating one at acceptance would be guessing at the number that
  decides what somebody is paid. `readEligiblePool` filters `rate_period = 'task'`
  and `accept_offer` refuses again behind it. `offerabilityGap` tells such a node
  why nothing arrives, beside the sentence it already carried for a missing rate.
- **`deadline_at`, `nda_signed_at` and `terms_hash` are columns with no writer.**
  The module's step 1 specifies a per-task engagement and NDA; nothing signs one.
  They are columns rather than a later migration because the shape is settled and
  the writer is not, which is the opposite of the `task_deps` mistake: that was a
  _rule_ enforced with no producer, and these are _facts_ with no recorder.
- **Thread access has no clock.** `accept_offer` admits with `expires_at` null on
  purpose, because there is no deadline to box it with and a number invented at
  acceptance would cut somebody off mid-task. Revocation is **explicit**: the
  reconcile sweep stamps `expires_at` when an engagement ends. The module doc
  says "time-boxed" and this is the honest reading of it in a slice with no
  deadlines.
- ~~**Nobody is notified of anything, still.** Notifications remain specified and
  unbuilt, so an owner learns their step was taken from a system message in their
  room, and a node learns nothing until they open `/node`.~~ **Closed by
  notifications slice 1.** Eleven moments across this domain now derive an inbox
  row for the person they concern, in-app only. The sentence above had appeared,
  in one form or another, at the end of every slice from 4 to 8, which is what
  made it the next thing to build rather than the next thing to restate.
- ~~**`held → released` is declared and refused.**~~ **Closed by slice 7**, whose
  `public.settle_payout` is the producer that let `20260907120000` permit the arc.
  The refusal was pinned **descriptively** rather than promissorily, so this is a
  change of fact rather than a promise coming due.

### Who the owner can now see, and what stays closed

The counterparty pair opens **through `engagements`**, never through
`room_members.thread_id`. A membership row outlives the work and the owner shares
no thread with the node, so the deal is the only row that knows both when the
relationship started and when it stopped: `ended_at is null` is the entire
time-box, with no second copy of any expiry rule.

What opens is `public.profiles`, in both directions, which is a display name and
the basics a chat surface needs. What deliberately does not:

- **`node_profiles` stays closed.** The owner learns who took their step, at what
  price, on what date, from the engagement projection. A rate card, a
  jurisdiction list, an availability flag and a trust score are not facts about
  this deal.
- **`offers` stays closed.** An offer names every node who was _asked_, including
  the ones who declined and the one whose offer expired. Publishing a decline
  trail has real consequences for people who said no, and shipping acceptance did
  not require making that decision. `marketplace_offers.sql` keeps asserting the
  owner's zero; only its stated reason changed.
- **`node_verifications` is untouched**, as ever: no policy at all, refused even
  to its own subject, because a face-search result names a third party.

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

**Not built, and not claimed.** The proof loop landed in slice 6, payouts in
slice 7 and disputes, ratings and the ops console in slice 8, so a step runs from
`escalated` all the way to `done`, and when it goes wrong somebody can say so and
an operator can decide. What is still absent:

**No money moves**: the only registered payment provider is the in-repo fake,
`carriesRealMoney` refuses any other at all three writers rather than in a
sentence, and payments-billing.md's counsel gate is unmoved. **No real KYC
provider is wired** either, on the same pattern: Persona and Stripe Identity are
both paid, so the in-repo fake verifier is the only registered one and
`carriesRealPii` refuses the first real one at the writer. Credentials are
claimed and never confirmed. **No node can be suspended**, because that would be
a terminal state with no exit until a moderation console exists. **The matcher
still ranks on price alone**, though `trust_score` and `completed_engagements`
now move. **Nobody is notified outside the app**: notifications slice 1
(`20260909120000`…`122000`) gives every moment in this domain an in-app inbox row
for the person it concerns, and push, email and SMS remain unbuilt because each
needs a paid provider. The 48-hour offer window and the seven-day work deadline
are **unchanged**: the absence that justified them is gone, but shortening them
is its own decision ([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)).

### The slice sequence

| #   | Slice                                                              | What it closes                                                                                                                                              | State arcs it restores                                                                                                                 |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅ **Domain + guards** `20260831120000`…`123000`                   | the enums with no tables behind them                                                                                                                        | none, deliberately, and the suite pins that                                                                                            |
| 2   | ✅ **Threads** `20260901120000`…`123000`                           | the narrowing below; a node would otherwise see the whole project DAG                                                                                       | none                                                                                                                                   |
| 3   | ✅ **Node onboarding** `20260902120000`…`122000`                   | `user_role.human_node`, which had no writer since `20260724000000`. **Not `author_kind.node`**, which needs a node in a room and gets its writer in slice 4 | none, as planned                                                                                                                       |
| 4   | ✅ **Matcher + offers** `20260903120000`…`121000`                  | `MATCHING`, dead since `20260813120000`, and `ESCALATED`'s first exit that is not the owner giving up                                                       | **none, deliberately** ([ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md))                                  |
| 5   | ✅ **Accept, escrow, ledger** `20260904120000`…`127000`            | acceptance, and `CLAIMED`. Accept and fund are inseparable because `claimed → escrow_funded` is the machine's only exit from `claimed`                      | **none, deliberately** ([ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md))                                               |
| 6   | ✅ **The engagement loop to `approved`** `20260906120000`…`125000` | `ESCROW_FUNDED`, and the waitpoint that never completes. The core loop needs **no migration**: every arc it walks was already in the map                    | **none, deliberately** ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md))                                                            |
| 7   | ✅ **Payout** `20260907120000`…`123000`                            | `APPROVED` on a human task, which held its escrow forever and left somebody unpaid. Also **no `task_state` migration**, for the second slice running        | none. It gives three declared arcs their **first producers**: `held → released`, and `payout_pending → paid → done`                    |
| 8   | ✅ **Disputes + ratings** `20260908120000`…`128000`                | `DISPUTED`, reachable from `in_review` with no ops writer. And the **last** dead end in this domain                                                         | **all four `→ disputed` arcs, together**, plus one new edge `disputed → matching` ([ADR-0026](../40-adr/0026-the-dispute-exit-map.md)) |

`20260815220000` silently dropped eight arcs from the original map while
rewriting it for an unrelated reason. Each is restored by the slice that first
makes it reachable, never earlier: a `disputed` task with no ops console is the
`escalated` defect reproduced on purpose. A ninth, `blocked → failed`, was
dropped by the same rewrite and is recorded here because nobody had counted it.

**Two of those eight are now permanently dropped rather than pending.** Slice 4
was booked to restore `matching → failed` and `offered → failed`, built the
matcher, and decided against both
([ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)):
an exhausted cascade returns the step to its owner at `escalated`, because
`failed` is terminal and would strand work three live buttons could still
finish.

**A third is now permanently dropped rather than pending.** Slice 5 was booked to
restore `claimed → matching`, built acceptance, and decided against it
([ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md)): accept and
fund are one transaction, so `claimed` is transit-only and nothing can be
observed sitting in it. The reassignment producer the arc was booked for leaves
from `escrow_funded` or later and lands in slice 6. **Five consecutive slices
have now restored no arc**, which is worth noticing rather than smoothing over:
the machine `20260813120000` declared was drawn wider than the product has
needed, and each slice keeps finding that again.

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
rather than a policy somebody could forget.

**Half of it comes out with slice 4, and half deliberately does not.** This
paragraph used to say both halves would: the sign-up path and the sentence. Only
the sentence has. `NO_WORK_YET` is now `NO_OPEN_OFFERS`, because "Octopus cannot
match you to a task until the matcher ships" stopped being true, and the constant
carried its own note saying that is where the edit belonged.

**Onboarding stays ops-invited**, and the reason is that opening sign-up solves a
problem this slice does not have. The dead end was a verified node with nothing
to do, and the matcher fixes that directly. What open registration would add is
strangers entering a KYC funnel with **no ops console to vet them** (that is
Phase 3, [admin-ops.md](admin-ops.md)) and no answer to who pays for a real
identity provider. An empty marketplace with three invited notaries was a
decision when nothing could be offered; with offers flowing it is still the
decision, for a different reason. Self-service registration gets its own slice
and its own argument.

A second sentence a node is now owed, and it is the quietest dead end in the
domain: `offerabilityGap` tells a verified, available node with **no rate** that
this is why nothing arrives. The matcher's pool query requires a rate, so such a
node passes every check on the page and is still never offered anything.

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

Three obligations were carried forward, and **all three are discharged by slice
5**. Recorded with their outcomes rather than deleted, because what was deferred
and what it was deferred for is the trail:

1. **The counterparty pair is open, in both directions, through `engagements`.**
   `20260904126000` writes `private.engaged_counterparty` and adds
   `profiles_select_counterparty` as a **second** policy on `public.profiles`;
   `private.shares_room_with` is untouched, so the roster narrowing cannot be
   lost by editing the counterparty rule. `node_profiles` and `offers` stay
   closed on purpose ("Who the owner can now see", above).
2. **There is still no realtime for a thread-scoped member, and this slice
   accepts polling explicitly.** That was the choice the obligation offered:
   "land thread topics or explicitly accept polling." The since-cursor `GET` runs
   as the caller, so the failure mode is a delay rather than a disclosure. Topics
   move to slice 6, and the pgTAP assertion pinning their absence was re-dated
   with its verdict unchanged.
3. **`messages_insert_own` now permits `author_kind = 'node'`**, and the open
   question is answered: **a node writes through their own grant, on the existing
   client path.** A server-mediated route would have been a second write path to
   keep in step with the first on the idempotency contract, the channel and
   thread pairing checks, and the broadcast payload; and it would have replaced a
   client insert that RLS re-checks with a `service_role` insert whose only
   control is the route. `20260904127000`'s header argues it in full.

## Node onboarding & KYC

- Identity verification via **Persona** (or Stripe Identity to stay in-stack): document + **passive liveness** + **Face Match 1:1** + **Face Search 1:N** across enrolled nodes to kill account-renting / duplicate-identity fraud (the defining gig-fraud vector).
- Collect jurisdiction, languages, and professional licenses (lawyer/accountant/notary — **verified, not self-attested**).
- Set up the **Stripe Connect Express** connected account (payout rails + tax onboarding handled by the provider).

## Skill & trust graph

- Structured skill taxonomy (`legal-filing:US-TX`, `notary:US-TX`, `real-estate:Austin`, `food-safety-consulting`, `procurement`, `on-site-inspection`), service geo (PostGIS), availability, rate, languages, rating.
- Trust score seeds from KYC + verified credentials and grows with completed jobs/ratings.
- License claims are **hard filters** for regulated tasks, not ranking weights.

## Future idea: AI-administered skill assessment (recorded, scored, owner-chosen)

**Owner-proposed 2026-09-01, deliberately not scheduled.** The proposal: before a
node is chosen for a task, they take a marketing knowledge check on camera —
questions generated and scored by the AI — and the owner reviews every
candidate's recording and score and picks one. Recorded here rather than built,
which was the owner's own call, and listed in
[roadmap.md](../10-architecture/roadmap.md)'s deferred table with its trigger.

What it would close is the matcher's honest gap: today nothing in the system can
set `node_skills.verified` true, so the pool matches claims and ranks on price
because every other specified input is NULL or constant. An AI-scored assessment
is a real signal where a weighted score over constant columns is arithmetic
pretending to be a ranking. And owner-picks-from-candidates already has a hook in
this doc: the "short sealed-bid window for higher-value/negotiable-scope tasks"
offer strategy, which is the shape this idea slots into.

Four constraints to hold when it is built, stated now so the slice arrives to
them rather than discovers them:

1. **Per skill, not per task.** An audition for every dispatch adds a heavy step
   to a cascade that already runs 48 hours per candidate, and makes the same
   person re-prove `copywriting` weekly. A passed assessment should instead be
   the first writer of `node_skills.verified` — a column that has waited for one
   since `20260831121000` — with a validity window, making it a certification
   tier (already named in roadmap Phase 4) rather than a per-task gate. A
   per-task round stays available as the sealed-bid variant for high-value
   steps.
2. **The owner sees all three: the recording, the score and the answers.**
   Decided by the owner 2026-09-01, overriding this section's first draft, which
   proposed sharing only score + answers. The reasoning holds up: the video is
   the richest signal of whether you would trust a stranger with your work, and
   the owner is the evaluator, which is the sharing most video-interview law
   contemplates. What the decision costs is recorded rather than glossed: it
   makes the platform a **custodian of face recordings**, which inverts the
   posture [security-compliance.md](../10-architecture/security-compliance.md)
   built (verdicts and scores kept, faces stay with the provider), so the slice
   that builds this must arrive with the node's **explicit consent before
   recording**, a retention schedule, a deletion path the node can walk
   (Illinois' AIVI Act makes deletion-on-request a statutory right), and access
   limited to owners actually choosing — never a browsable gallery. The
   recording still doubles as the anti-fraud control: proof the test-taker is
   the KYC'd node and not a rented account.
3. **The AI scores; a person decides.** An AI score that hard-filters who gets
   paid work is the authority `stage-skills.ts` refused to hand a model. The
   owner making the final choice keeps the score advisory, which is also what
   the law will demand: AI systems selecting people for work are **high-risk
   under the EU AI Act**, NYC Local Law 144 requires bias audits of automated
   employment decision tools, and Illinois' AI Video Interview Act regulates
   exactly this artifact — consent, explanation, deletion on request, and
   restrictions on sharing the recording. First markets are US + EU, so this is
   not a corner case.
4. **Showing owners candidate videos invites the bias the cascade avoids, and
   that exposure is now accepted rather than avoided.** The price-ranked cascade
   never shows a face before a match; recordings do, and a choice made on accent
   or appearance is a discrimination exposure the platform carries. With the
   owner's 2026-09-01 decision to show the video, the mitigation moves from
   withholding it to ordering it: the surface presents **score and answers
   first, the recording behind a deliberate click**, and the choice is logged
   with what was viewed — the same event-sourcing every other decision here
   gets — so a dispute can read what the pick was made on.

**Trigger to build:** self-service node registration (when strangers, not
ops-vetted invitees, enter the pool), or the first skill market where claims
plus ratings demonstrably misprice work.

## Matching algorithm

**Skill-based ranked matching, not a blind broadcast.** Eligible pool = verified skills cover `required_skills` **AND** service geo/jurisdiction includes the task location **AND** any required license is verified **AND** rate ≤ escrowed task budget **AND** currently available. Rank by weighted score: skill/credential fit, jurisdiction exactness (Austin-local > Texas-state), rating + completion-rate, price, responsiveness, current workload (load-balancing). Offer strategy is task-dependent: **first-accept-wins + cascade** for time-sensitive/commodity tasks; a **short sealed-bid window** for higher-value/negotiable-scope tasks.

> **What slices 4 and 5 implement of the above, and what they cannot.** The pool
> filters on `kyc_status = 'verified'`, `availability = 'available'`, a non-null
> `rate`, and a **claimed** skill from the stage map. **Slice 5 adds a fifth
> filter, `rate_period = 'task'`**, because an escrow hold is a whole amount and
> there is no hours field anywhere to fund an hourly rate against. It still does
> not filter on verified skills or licences (nothing can set either true) or on
> jurisdiction (no task carries one). **"Rate ≤ escrowed task budget" is enforced
> at acceptance rather than at ranking**, which is the right place for it: the
> ceiling can move between an offer and an acceptance, so `accept_offer` re-checks
> it under a row lock over both committer classes
> ([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md)). Ranking is
> price ascending then a stable id tiebreak, because every other specified input is
> NULL or constant on every row. **First-accept-wins with cascade is the shipped
> strategy**, expressed structurally by a partial unique index allowing one open
> offer per task; the sealed-bid window would drop that index and is a different
> slice's decision. See "What the matcher can actually rank on" above.

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

1. **Accept + escrow fund** — ✅ live as of `20260904125000`, with two parts of
   this sentence not yet true. **Nothing is captured**: the hold is modelled
   against the already-authorised `projects.budget_ceiling` and the only
   registered provider is the in-repo fake. **Nothing is e-signed**:
   `engagements.nda_signed_at` and `terms_hash` are columns with no writer. The
   step stops at `ESCROW_FUNDED`; `escrow_funded → in_progress` gains its
   producer in slice 6.
2. **Join group chat** — ✅ live in the same transaction. The node is added to the
   task's thread with `role = 'human_node'` and `scope = 'thread'`, and the chat
   surface badges them "Human node" as a word rather than a colour (rule 15).
   **`expires_at` is null on purpose**: there is no deadline source, so access is
   revoked explicitly when the engagement ends rather than boxed by a clock
   nobody set.
3. **Do the work** — the AI co-pilots in-thread (prepared docs, RAG-grounded checklists, forms, addresses, talking points); the user answers questions; presence/typing show live activity. All coordination stays in-thread for auditability.
4. **Submit proof** — deliverables to Supabase Storage (signed docs, stamped permits, geotagged/timestamped site photos, receipts, filing confirmation numbers), attached as artifacts.
5. **Approval (maker-checker + human)** — AI critic validates proof against `acceptance_criteria` (authenticity, tampering/liveness, correct reference numbers) → the user (and/or AI for low-risk) gives final approval. Rejections return to `IN_PROGRESS` with structured feedback + a re-do window.
6. **Payout** — on approval, escrow releases: Stripe Connect transfer to the node's connected account, platform fee retained (see [payments-billing.md](payments-billing.md)). Instant payout to debit card optional for eligible nodes.
7. **Rating + dispute** — two-sided rating updates the trust graph; disputes freeze the transfer and route to ops with the full audit trail (release / partial / refund / reassign). Repeat low ratings / fraud flags suspend the node.
8. **Offboard from chat** — on task close, the node's thread access is revoked/archived; deliverables + transcript remain on the project record.

## Waitpoint completion

**There is no token to complete** ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)). A human task waits by sitting in a `task_state` the scheduler does not select, at zero compute, for as long as it takes. On approval the marketplace moves that row, and the next tick picks it up in its new state. Resumption is a read rather than a replay, so it is deterministic by construction ([ai-orchestrator.md](ai-orchestrator.md)).

## Anti-fraud

Account-renting / synthetic identity (Face Search 1:N dedup) · geo/IP consistency (impossible-location flags) · collusion / fake proof (proof authenticity + EXIF/geo/timestamp checks) · cold-start (provisional trust score → lower-risk tasks with heavier proof review until a track record accrues).

## Two-sided liquidity

Cold-start supply: KYC + verified credential grants provisional eligibility. Thin skill markets fall back to vetted local professional partners. Certification tiers and node acquisition tracked in [roadmap.md](../10-architecture/roadmap.md) (Phase 4).

## Key entities

Nine were specified from Phase 0. Five exist; the rest carry a trigger rather
than a date, because a list that mixes live tables with intentions reads as
though all nine are there. Column shapes live in
[data-model.md](../10-architecture/data-model.md).

| Entity               | Status                                                                              | Notes                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node_profiles`      | ✅ live `20260831120000`, written by `invite_node` and `decide_node_kyc`            | Keyed on `user_id`: a node **is** a user, so every child predicate is a plain equality. `available` + not-`verified` is unrepresentable, by constraint                                                                                                                                           |
| `node_skills`        | ✅ live `20260831121000`, written by `/api/node/skills`                             | Claim and verified claim on one row, one boolean apart. Tag is shape-checked text; the curated taxonomy is a reviewed code registry landing in slice 3                                                                                                                                           |
| `node_credentials`   | ✅ live `20260831122000`, written by `/api/node/credentials`, claims only           | Renamed from `credentials` (below). `verified` is write-once true — a licence is **revoked**, with a date, never un-verified                                                                                                                                                                     |
| `node_verifications` | ✅ live `20260831123000`, written by `decide_node_kyc`                              | Not in the original nine; forced by them. No policy, no client grant, append-only including for `service_role`                                                                                                                                                                                   |
| `offers`             | ✅ live `20260903120000`, written by the matcher sweep and the decline route        | Its entire content is a lifecycle, so it landed **with** its writers rather than ahead of them, inverting this domain's ordering for the first time. One policy, `node_id = auth.uid()`: the owner reads nothing                                                                                 |
| `engagements`        | ✅ live `20260904120000`, written by `accept_offer`                                 | **No state column** — [ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md). `agreed_price` frozen at acceptance and never following `node_profiles.rate`. One live engagement per task, as a partial unique index, so reassignment can still create a second row                  |
| `escrow_holds`       | ✅ live `20260904121000`, written by `accept_offer` and the reconcile sweep         | Not in the original nine; forced by them. Models an obligation against `projects.budget_ceiling` and **charges nothing**. `held → refunded` is the only mapped arc; `released` waits for a payout ([payments-billing.md](payments-billing.md))                                                   |
| `ledger_entries`     | ✅ live `20260904122000`, written by `accept_offer` and the reconcile sweep         | Double-entry, append-only, immutable including for `service_role`. **No policy and no client grant**: the reader is the Phase-3 ops console, and a member's view of money is the projection                                                                                                      |
| `proof_artifacts`    | ❌ **not built, deliberately** ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md)) | Slice 6 decided against it. Proof is an `artifacts` row with `kind = 'proof'`, which the enum has carried since `20260813160000`. A second table strands an unremovable enum value and duplicates five guard and reader surfaces; EXIF/geo belong to a verdict table once an extractor exists    |
| `payouts`            | ✅ live `20260907121000`, written by the payout sweep and `settle_payout`           | Not in the original nine; forced by them. `pending → paid` is the only mapped arc and `failed` is declared with no producer, the shape `released` had. `platform_fee` is a column written from a constant `0` ([ADR-0024](../40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md)) |
| `ratings`            | ✅ live `20260908127000`, written by `submit_rating`                                | Two-sided, one per side per deal, append-only including for `service_role`. Gated on `outcome = 'completed'`, which excludes a `disputed_resolved` deal deliberately. Its writer is also `trust_score`'s first, in the same transaction                                                          |
| `disputes`           | ✅ live `20260908122000`, written by `raise_dispute` and `resolve_dispute`          | **No state column** (ADR-0016): `tasks.state` is the machine and open is derived as `resolved_at is null`, as a partial unique index. `evidence` is text and deliberately not a join — six immutable surfaces already hold what a dispute reads                                                  |
| `ops_actions`        | ✅ live `20260908123000`, written by `resolve_dispute`                              | Not in the original nine; forced by them. `actor_id` and `reason` are both `not null`, which is the whole reason it is not a verb in `events`: every `service_role` write lands there as `system` with a null actor. Append-only including for `service_role`                                    |

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
- **`offer_status`** `open | declined | expired | withdrawn | accepted`. Three
  settlements rather than one, because they answer different questions and a
  cascade reads differently depending which it was: `declined` is a person saying
  no and is the only one that can carry a reason, `expired` is a person saying
  nothing, and `withdrawn` is the offer ceasing to matter through no act of the
  node's. **`accepted` was declared and unreachable for two slices** and became
  reachable in `20260904124000`, which is exactly the ordering this domain
  intends: `alter type ... add value` is irreversible, so the label was cheap to
  declare early, and the arc stayed out until `accept_offer` could fund escrow in
  the same transaction. **No `cascading`**: that is the task's state, not the offer's, and a second machine
  over one truth is what [ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)
  refuses.
- **`verification_result`** `passed | failed | inconclusive | error`. The last
  two decide retryability oppositely: the provider could not tell (retrying the
  same evidence is pointless) versus our call failed (retrying is exactly
  right). **No `pending`** — that is `kyc_status`.
