# ADR-0029 — A question is answered on the card, beside the plan, from what the workspace already knows

**Status:** Accepted, all three decisions built · **Date:** 2026-09-10 · **Slices:** intake 1 (answer on the card), intake 2 (plan immediately), intake 3 (business facts on the workspace)

## Context

The product's promise is one line in and real growth out ([vision.md](../00-overview/vision.md)), with "user-touch-count per result" listed as a guardrail to drive down and "not a chatbot wrapper" listed as a non-goal. The intake step contradicted all three in the same shape.

A whole-funnel goal produced up to four questions as plain text in the room. The owner answered all of them by typing one chat message, and a model parsed that prose back into the five slots the playbook needs. Nothing was planned until the questions were answered. And because an answer and a goal were the same event on the wire, a pending question card had to **claim every message the owner wrote** so the run could tell which one was the answer. [architecture.md](../10-architecture/architecture.md) records two cards holding rooms for nearly two days that way, one having swallowed a request its author meant as a new goal; the patch was a two-hour expiry and a `new goal:` prefix the copy advertised. The card itself was never rendered ([design-system-frontend.md](../30-modules/design-system-frontend.md) said so), and the same slots were asked again for every goal in a room, because nothing stored them.

That is a form wearing a chat costume. Intake needs structured slots and collected unstructured text, then hoped a model recovered the structure. The "batch everything into one reply" rule was solving the touch-count problem in the wrong place.

## Decision 1: an answer is an embed action, and a chat message is always a goal

Built in slice 1 (`20260910120000`).

The question card renders (`QuestionCard.tsx`) with one control per question: a chip group for a slot whose value is a choice (`budget_band`, `timeline`, with the vocabulary defined once in `packages/contracts` so the card and the route agree by construction), a short field with its own Save for a slot whose value is a phrase, and one field per step on a card the plan raised. Each answer is `POST /api/rooms/:roomId/embeds/:embedId/actions` with `action: 'answer'` and a slot or a task, or `action: 'finish'`. That is the same route every other card is acted on through, which makes `required_role` the enforcement rather than a hint: the owner check runs before anything is written, and a refusal writes nothing.

Because an answer no longer arrives as a message, **every chat message is a goal**. `decideIntakeTurn`, the two-hour `expires_at`, the stall counter, the `awaiting: 'goal'` card and the `new goal:` escape are removed together, because each existed only to manage the ambiguity that is gone. An owner's new goal dismisses the intake cards that were about the previous one, decided per card from the parsed payload (`dismissableQuestion`) rather than by a filter string on the jsonb, and never a task card, since that one belongs to a plan already running.

**Each answer is one statement.** `answer_question_slot` and `answer_question_task` replace-or-append the one value they were given with `jsonb_set`, `where state = 'pending'` in the same statement. Two chips clicked in the same second are two requests, and a read-modify-write of the whole payload from Node would let the second drop the first with nothing raising. A miss returns null, which the route reports as "already acted on" rather than as a fault. The card closes itself, conditionally on `pending`, when the last required slot it asked about lands or on `finish`, and only the writer that won continues the run.

**The action response carries the card's new payload.** Realtime broadcasts message inserts only, so a card on screen kept the payload it was first fetched with. This was already a defect on a card that existed: a campaign approved at 2000 read "approved at 0". `EmbedActionResponse.payload` and `remaining` let the client patch one card in place.

### Alternatives rejected

- **Keep answers in chat and improve the parsing.** The parsing was never the problem. The claim on the room was, and the claim is unavoidable while an answer and a goal share a wire.
- **A separate answers route.** A second authorisation boundary for a card that already has one is a second place for the owner check to drift.
- **Serialise submits on the client and write the whole payload from Node.** Simpler, and it accepts a lost update whenever two tabs, two devices or a retry race. The rpc costs one migration and removes the race rather than narrowing it.
- **`expired` for a card a new goal made moot.** Wrong word: nobody's window closed. `dismissed` already exists for a card somebody walked away from, and `feedback_events` reads these states as labels, so the word has to be true.

### Accepted cost

The `answers` list in the intake contract stays, empty, and `awaiting: 'goal'` stays in the schema, so rows written before this parse and render as closed. A conversation opening with "Hello" twice gets the opener twice, which is the honest behaviour of a system that replies to what it is sent and is much less costly than a card that decides what the next message means.

## Decision 2: planning starts immediately, and the card refines it

Built in slice 2.

On `needs_detail` the run posts the question card, tells the room work has started, and plans in the same run from the refined goal and whatever slots are known, so the owner sees a plan with visibly empty stages beside the questions that would fill them. The card and the plan share a `runId`. Finishing the card continues the run under the deterministic id `${runId}:r${round + 1}`: if the plan is already an approved, running project, the answers become a `replan` card through the same producer the panel uses (`lib/replan-diff.ts`, extracted for this second caller) with a templated reason, and nothing is applied without that card; otherwise intake runs again on the merged slots, a new plan is requested, and only then is the pending plan moved to `expired` with `expires_at = now()` and the new one posted carrying `supersedes`.

### Alternatives rejected

- **Keep waiting for the answers.** It is the product's own guardrail turned into an interview, and the plan can be produced from what is known; a thin plan with empty stages is a better first minute than a form.
- **Replan a pending plan in place.** A pending plan is a card nobody has read; replacing it is cheaper and clearer than a diff against a proposal.
- **`dismissed` or a new enum value for a superseded plan.** The person did nothing to the old card, so `dismissed` is untrue, and `expired` already means "its window closed" and is not a verdict `feedback_events` would read. A new value would strand an unremovable enum member for one sentence.
- **Expire the old plan before requesting the new one.** Simpler ordering, and it leaves the person with no plan if the request fails. The wasted case the chosen ordering accepts is one duplicate AI call when the action side and the run side both continue, which the deterministic run id turns into a collision rather than a second card.

### Accepted cost

A continuation is one more AI call per finished card, on the CPU the reasoning core already has. The finish-before-plan race is handled rather than prevented: the run re-reads its card after posting the plan and continues if it was finished meanwhile, and the action side skips planning when the continuation's plan already exists.

## Decision 3: business facts live on the workspace

Built in slice 3.

ICP, offer, budget band and timeline are facts about the business, not about the goal. `room_profiles` (`20260911120000`) holds one row per room, owner-only to read through `private.is_room_owner`, the first owner-only policy in the database, and written only by the API as `service_role`: from the question card as each slot lands, from the run when intake finishes with something the owner stated, and from the panel's "About your business" block through `PATCH /api/rooms/:roomId/profile`. All three write through `writeProfileFields`, which writes only the keys it is given, so an intake that established a budget band cannot erase an audience the owner typed a minute earlier. Intake's round 0 is seeded from the profile as stated slots, so the second goal in a room asks nothing. `target_metric` is goal-specific and never stored. The chip slots are persisted from intake only when canonical, because the model returns free text for a budget and a chip group cannot select "about two thousand". `merge_slots` in the AI service now lets a newer stated value replace an older one, or a stored profile would beat what the person just typed.

### Alternatives rejected

- **A document in the room's corpus.** `documents.owner_room_id` already holds prose about the business, and intake deliberately does not retrieve: what somebody sells is not something to search for. Facts the planner needs as slots have to be slots.
- **No policy, an API projection** (the `channel_connections` precedent). That precedent exists for credentials. Four sentences with one reader are the ordinary case for RLS, and a policy that says "owner" in SQL is a control a suite asserts directly.
- **Store the goal's target metric too.** It changes per goal, and a stale one seeded into a new goal would plan for a number nobody asked for.

## Consequences

- [chat-discord.md](../30-modules/chat-discord.md), [architecture.md](../10-architecture/architecture.md), [core-loop.md](../00-overview/core-loop.md) and [ai-orchestrator.md](../30-modules/ai-orchestrator.md) describe the new answer path; [business-projects-workflow.md](../30-modules/business-projects-workflow.md) describes what replaced `decideIntakeTurn` in `@octopus/core`.
- The waiting digest and the question copy no longer teach a `new goal:` prefix, and a test pins that.
- The task-answer arc (`needs_user -> approved -> done`) is written once, in `completeTaskWithAnswer`, and both the panel and the card call it.
