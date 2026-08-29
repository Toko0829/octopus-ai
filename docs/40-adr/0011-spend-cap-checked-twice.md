# ADR-0011 — The spend cap is checked twice, and the model never proposes a budget

- **Status:** Accepted
- **Date:** Phase 2
- **Context docs:** [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md), [data-model.md](../10-architecture/data-model.md), [architecture.md](../10-architecture/architecture.md), [ai-orchestrator.md](../30-modules/ai-orchestrator.md)

## Context

The campaign card is the first surface in this product whose approval commits money. Two decisions had to be made before it could exist, and both cut against a default this repository normally holds.

**One implementation of a rule, or two.** `checkSpendCap` in `packages/marketing` is pure, tested at its boundary in both directions, and composes `projects.budget_ceiling` with the caps already committed to non-terminal sibling campaigns. Calling it from the approval route is the obvious design, and it is not sufficient. The route reads the committed total, decides, and then writes. Two campaign cards approved in the same instant both pass, because each reads before either writes. The conditional update on `action_embeds` makes one card single-use and says nothing about two.

The consequence is not an inconvenience. The sum of authorised caps would exceed the ceiling **inside the table whose entire purpose is recording what was authorised**, and no later reader could tell it had happened: every row would look individually legitimate. This is the same class as the defects this repository keeps finding, where nothing raises and the wrong answer looks like a right one.

**Whether the reasoning core proposes a budget.** Every other card in the system shows what a model proposed and asks yes or no. Extending that here would mean the core emitting a number, the card rendering it, and the owner approving. The problem is what that number becomes: once written, a figure a model invented and a figure a person authorised are the same `budget_cap` on the same row, with the same audit trail behind them. The distinction cannot be recovered afterwards, and it is the distinction this entire card exists to preserve.

The `budget_band` intake slot was considered as a source. It is free text a person typed to describe a range, not an authorisation of an amount, and parsing it into a cap would manufacture precision nobody supplied.

## Decision

**The cap is checked twice, in two places, on purpose. The core proposes no budget at all.**

1. **Readable pre-flight, in `apps/api/src/routes/embeds.ts`.** `readSpendInputs` performs the two reads, `checkSpendCap` decides, and a refusal returns 409 carrying the verdict's own sentence. The card stays `pending`, so entering a smaller figure and approving the same card is the obvious next move.

2. **Authoritative re-check, inside `public.materialise_campaign`.** `select budget_ceiling ... for update` serialises concurrent approvals on the project row before the committed total is summed, so the arithmetic cannot be invalidated between reading and inserting.

3. **`ProposeCampaignProposal` has no budget field**, in the pydantic model and in its Zod mirror. `draft_campaign` additionally strips budget-shaped keys before validation, and the prompt forbids emitting one. `campaignEmbedPayload` sets `budgetCap: null` unconditionally and takes no parameter for it.

4. **The owner's number is written into the card payload** by the same conditional UPDATE that records the verdict, so `materialise_campaign` reads what the person approved rather than taking it as an argument, and `feedback_events.subject` stores the payload including that number.

5. **A card with no cap is refused by the writer**, with `check_violation` and a hint. Zero is legal, since email and organic social genuinely spend nothing.

## Consequences

**Accepted, and stated plainly: this is a second implementation of a money rule.** Rule 20 and this repository's general stance both push against it, and `tools/rag-lens` was deliberately built to report rather than gate for exactly this reason, since a second implementation of the eval's arithmetic is a second thing that can disagree with CI.

The mitigation is that the two are pinned to the same boundary by two suites that must both pass:

- `packages/marketing/src/spend.test.ts` asserts the TypeScript `>` boundary in both directions.
- `supabase/tests/materialise_campaign.sql` asserts the SQL one: a campaign landing exactly on the ceiling is authorised, and one cent past it is refused, along with the two filtering conditions (terminal siblings hold none of the ceiling, a null cap contributes nothing).

Drift therefore fails a test rather than passing quietly, which is the only form of duplication this codebase accepts.

**This does not contradict "the spend cap is enforced in tool code, not by a constraint"** ([data-model.md](../10-architecture/data-model.md)). That rule forbids a CHECK constraint, which is the database applying a rule to itself with no idea what was authorised or by whom. `materialise_campaign` is the transactional arm of the tool, executable by `service_role` alone, and it reads the authorisation off the card.

**The card is slower to fill in than a pre-filled one would be**, and that is the cost being paid deliberately. A person has to type a number rather than accept one. In exchange, every `campaigns.budget_cap` in the database is a figure a human being entered, which is a property worth more than the keystrokes.

**The writer shipped one defect against this, and the test caught it.** The first version guarded the cap with `jsonb_typeof(payload->'budgetCap') <> 'number'`. For an absent key that expression is `NULL <> 'number'`, which is NULL rather than true, so the guard did not fire, every later comparison inherited the NULL, and the insert wrote `budget_cap = NULL` at state `ready`: a campaign that authorised nothing while reporting itself authorised. It is `is distinct from` now. This is the NULL twin of the `NaN` case `spend.ts` already guards on the TypeScript side, and it is recorded here because the shape recurs: not an error, not a type mismatch, just a wrong answer wearing the shape of a right one.

## Alternatives rejected

- **Route check only.** Loses to the concurrent-approval race, which corrupts the authorisation record itself.
- **SQL check only.** A refusal after the verdict was already written is an opaque failure at the worst moment; the owner would see an approved card and no campaign, with the reason only in a log.
- **A CHECK constraint or a trigger on `campaigns`.** Cannot see the ceiling in the context of the approval that is happening, and would make an operational correction impossible without dropping the constraint.
- **`SERIALIZABLE` isolation instead of a row lock.** Correct, and it pushes the failure into a serialisation error the route would have to recognise and retry. The lock is narrower, is local to the one function, and produces the error message the owner needs.
- **The core proposes a budget the owner can edit.** The pre-filled number is the one people accept, which is precisely the outcome this decision exists to prevent.
