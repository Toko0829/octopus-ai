# ADR-0031 — An agent persona is a voice, not a writer

**Status:** Accepted · **Date:** 2026-09-12 · **Slice:** agent personas

## Context

The chat has had exactly one AI identity since `20260728120000`. Every message the agent writes is `author_id = null, author_kind = 'agent'`, and `MessageStream.tsx` rendered all of them under one hardcoded name, `Octopus`. That was right when there was one thing the AI did. It is wrong now: the same account posts the plan, asks the intake questions, hands over a landing page draft, proposes a campaign, and announces that a campaign was paused for crossing its cost ceiling. A person reading the room cannot tell which of those came from the part of the system that thinks about positioning and which came from the part that watches spend, and the audit trail records the same flat answer.

The request that started this was a product one: make the specialists visible, the way a team is visible, and let somebody address one of them. The risk in that request is precise and worth naming, because it is the shape most "multi-agent" products take: **several agents that each plan and each act.** This system's guardrails all assume the opposite. `routeTask` is the single place a step's owner and risk tier decide who may run it. `checkSpendCap` composes one project ceiling against every sibling campaign and every held escrow, and [ADR-0020](0020-the-ceiling-has-two-committer-classes.md) records the four places that sum must move in step. `apply_plan_diff` is the only thing that changes a running DAG, and it runs behind an owner-gated card. Three agents each holding a plan and a budget would defeat all three, and would do it quietly: three campaigns of 400 pass a 1000 ceiling individually and commit 1200 between them, which is the exact failure `checkSpendCap` exists to prevent and which a second planner would reintroduce from a different direction.

## Decision 1: a persona names who spoke, never who may act

A persona is a label on a message. It is chosen in `apps/api` from the step's own `tasks.stage`, a column that already exists and that the planner already fills.

Nothing else moves. There is still one writer to the task DAG, still one router, still one spend cap, still one `apply_plan_diff`. `personaForStage` is a lookup in a frozen map in `packages/contracts`; no model chooses it and it takes no argument a model controls beyond the stage the plan already carried. A message signed `Ads` has exactly the authority an unsigned agent message had, which is none: it can say things, and every act it describes went through the same check it would have gone through unsigned.

The stage-to-voice map, which is the whole of the mechanism:

| Persona    | Stages                             | Also posts                                                                    |
| ---------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Strategist | `strategy`, and anything unmatched | intake, the plan card, the question card, the replan card, the waiting digest |
| Content    | `content`, `creative`, `conversion` | the delivered artifact for those stages                                       |
| Ads        | `channels`                          | the campaign card, and the publish sweep's outcome notices                    |
| Analyst    | `measurement`                       | the metrics and optimize sweeps' notices, including the CPA-ceiling pause      |

Two divisions in that table were decisions rather than defaults.

**Conversion belongs to Content, not to Ads.** A landing page is a piece of writing before it is a channel, and `deliverable.py` already classifies such a step's output as `landing` beside `copy` and `sequence`. Filing it under Ads would split one writer's work across two names on the strength of where the traffic came from.

**Strategist is the fallback, not a peer.** `tasks.stage` is free text (`20260813120000:119` says why), so it receives whatever the planner wrote, including a stage nobody defined and `null`. Those are exactly the moments when nobody has decided what kind of work this is, which is the planner's business. `personaForStage` is total and returns `strategist` for them; it never throws, because a thrown label would mean delivered work that never reaches the room, and this repository has already recorded that failure once.

**Four, not nine.** The idea this came from listed nine specialists. Five of them have no tool behind them here: no creative provider is wired, `generate_creative` still returns a brief as text, there is no site connector for SEO or CRO, and no ad-library reader. A persona with nothing to do is an empty chair that implies a capability the product does not have, which is the specific dishonesty this system's "not built, and not claimed" lists exist to avoid. Each of the other five arrives with its provider.

## Decision 2: the label is `text` with a check, not an enum and not a membership row

Three shapes were available.

**A `room_members` row per persona** would make a persona a member in the literal sense, which is what the product idea describes. It is not possible without a larger change than the feature deserves: `room_members.user_id` is `not null references auth.users (id)`, and `public.user_role` has no agent value. Giving the AI real credentials so it can sit in a membership table is a security decision about authentication, and this is a decision about a name in a stream. The members panel can show the four voices without any of them holding a row, which is what it does.

**A Postgres enum**, mirroring `author_kind`, is the shape a reader would expect and the one that cannot be undone: an enum value cannot be dropped. This set is expected to move, in both directions. [ADR-0022](0022-proof-is-an-artifact.md) reversed a plan for exactly this reason, that it "would strand an unremovable enum value".

**`text` plus two named checks**, which is what `20260912120000` does, and which is already this repository's answer to a set that may shrink (`room_members_scope_known`). Two constraints rather than one, because they refuse different mistakes: `messages_persona_known` catches a value nobody defined, and `messages_persona_agent_only` catches a persona on a row that is not the agent's, which would be a system notice or a person's message wearing an AI's name.

The insert policy gains `and persona is null`, so a client can never name one. That mirrors `author_kind`, which the route derives and RLS re-checks independently (`20260904127000`), and it matters for the same reason: a client that could set this could file a message under a specialist's name in somebody's audit trail without the route being involved at all.

## Decision 3: a mention becomes a card, never an act

`@Ads move the budget to Meta` does not move a budget. It resolves to the project running in that room and produces a **replan card** through `produceDiff`, signed by the persona that was addressed, which the owner approves or does not. That is the same boundary an owner's own replan request crosses from the project panel, and the same one a finished question card crosses.

This is what keeps the mention from being a second command channel. The alternative, a mention that dispatches work directly, would let a sentence in a chat message reach a side effect without passing `routeTask` or an approval, which is precisely what rule 7 forbids ("a jailbroken prompt must still be unable to overspend escrow").

A mention by anyone other than the workspace owner is an ordinary message and starts an ordinary run, because the cards are about the owner's business and a member's sentence is not an authorisation.

## Decision 4: nothing is backfilled

Every agent message written before `20260912120000` keeps `persona = null` and renders under the legacy single name. Choosing a specialist for those rows now would mean inferring, from a stage recorded for a different purpose, who "would have" written a message at a time when nobody did. A guess written beside an audit trail is indistinguishable from a fact, and the chat is the surface this product asks people to trust with money decisions.

## Decision 5: the reasoning core is untouched, and voice differentiation is named-not-built

`services/ai` still has one set of prompts, all opening "You are Octopus". A persona changes who a message is attributed to, not how it was written, so `/plan`, `/execute`, `/campaign` and `/replan` are unchanged and there is no prompt change to gate an eval on. That is deliberate rather than incidental: the words in these messages are ours and templated (`INTAKE_COPY` records the rule), and a per-persona voice in the model would be a generated trust surface one prompt drift away from breaking rule 22.

**What would make it right to change that:** evidence that a specialist's output reads wrong under its own name, which needs the personas to exist first. If it lands, it lands as a prompt change with an eval pass, not as a persona field on a request.

## Consequences

- A message now says who spoke, and `events.payload.persona` records the same on `task.reviewed` and `task.executed`, so the audit trail names a speaker.
- The four voices appear in the members panel without holding membership rows, and a working one shows the agent pulse, which stays the single reserved use of glow (rule 14).
- One more thing must move in step: the registry in `packages/contracts` and the check constraint in `20260912120000` are two copies of the same four names. `message_persona.sql` pins the database half, and `personaForStage`'s callers pin the other; a fifth persona is a migration and a registry entry in one change.
- The legacy name survives in old rooms indefinitely, which is a permanent two-state rendering rather than a migration that finishes.
