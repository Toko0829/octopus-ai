# ADR-0014: setting a CPA ceiling authorises the automatic pause, and the platform is called first

- **Status:** Accepted
- **Date:** 2026-08-30
- **Affects:** [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) · [data-model.md](../10-architecture/data-model.md) · [learning-flywheel.md](../10-architecture/learning-flywheel.md) · [analytics.md](../30-modules/analytics.md)

## Context

The metrics sweep records what a campaign spent and deliberately stops there:
"acting on a CPA ceiling needs a ceiling, which has no writer yet." The
auto-optimize slice supplies the ceiling (`campaigns.cpa_ceiling`, owner-only
writer on the project panel) and the sweep that acts on it: a live campaign
whose measured whole days breach `spend > ceiling × (conversions + 1)` is
paused, at the platform and then here.

That raises the question every side effect in this product has had to answer
individually: **who authorised this?** Pausing is the first act on money with no
click immediately behind it. Rule 11 demands per-action confirmation for
irreversible acts, ADR-0013 refuses confirmations that carry no new
information, and the module doc tiers `optimize_campaign` as `external` rather
than `high_risk` precisely so it can run unattended within already-authorised
caps.

There is also an ordering question with a recorded precedent pointing the other
way. ADR-0013 writes the intent row **before** the platform call, because a
crash after an unrecorded create leaves an object nothing points at. Does a
pause follow the same ordering?

## Decision

**The ceiling is the confirmation.** An owner typing a cost-per-conversion
ceiling on the panel is the authorisation for the automatic pause; no
confirmation is asked at pause time, and no other input can arm the optimizer.
The model never proposes the figure (ADR-0011's property, applied to the second
money number in the product), nothing else writes the column, and NULL means
the optimizer does not judge the campaign at all. This deliberately inverts the
budget columns' NULL: an unset spend authorisation blocks, an unset judgement
threshold abstains.

**The platform is called before the database is written**, inverting ADR-0013.
A pause creates nothing, so there is no unrecorded-object failure mode; and the
decision to pause is re-derivable from durable rows (the outcomes table and the
ceiling), so a crash at any point re-derives the same breach and converges. The
row order after the call is entity, then campaign (with `pause_reason =
'cpa_breach'`, the trigger auditing the transition), then the decision event
and the room message. Writing our rows first would open the one unacceptable
window: a database claiming `paused` about a campaign the platform is still
spending against.

**The idempotency keys carry an epoch.** `pause:<campaignId>:cpa:<epoch>`,
where the epoch counts prior `paused → live` transitions in `events`; the
resume key mirrors it over `live → paused`. A key derived from the campaign id
alone (the ADR-0013 shape) is wrong here: after an owner resumes, a second
breach under the same key would let a record-replay platform answer with the
first pause's recorded success while the money kept moving. The epoch is
durable, monotonic, and cannot change mid-sequence, because resume only acts on
campaigns that are `paused` in our database and a mid-pause row still reads
`live`.

**Resume ships in the same slice, and resume does not clear the breach.** A
pause with no resume surface is a product-irreversible act at `external` tier
and the dead-end shape this repository has recorded three times. The owner
resumes from the panel; if the rollup still breaches the ceiling, the next
sweep pauses again under a new epoch, and the button says so before it is
pressed. Raising or clearing the ceiling is the act that changes the verdict.

## Why

**A pause-time confirmation would be ADR-0013's weak confirmation, one step
later.** The owner already named the number a conversion may cost. Asking
"really pause?" when that number is crossed either adds no information, or it
trains people to click through it, and the guardrail line the module has
carried from Phase 0 ("auto-pause on CPA/ROAS ceiling breach") describes an
automatic act, not a notification with a button.

**Failing to pause never closes anything.** `live → failed` is not a legal arc,
so no failure map here can end a campaign; every failure is retry-quietly or
tell-the-owner-once, and a campaign we could not pause stays visibly live. The
pgTAP suite pins the arc so the doctrine is machine-enforced.

**A ceiling of zero is refused** at the contract and the table, because it
pauses on the first recorded cent whatever the conversions say, which is a kill
switch wearing the shape of a threshold. The kill switch remains its own,
unbuilt, differently-authorised act.

## Consequences

- `OPTIMIZE_ENABLED` defaults on, as a kill switch: the sweep is doubly inert
  until someone types a ceiling, and off-by-default would make a typed ceiling
  an unenforced promise on a money surface.
- The decision is logged (`campaign.auto_paused`, with the arithmetic) beside
  the trigger-written transition, which gives analytics its "auto-pause events"
  and the flywheel its first optimization decision as data.
- Only the pause exists. Scale-winners, reallocate and creative iteration stay
  named-not-built; a budget change beyond an authorised cap remains a
  `high_risk` act (`set_budget`) that asks a person.
- Anyone adding a second pause writer (the kill switch) must use a different
  key namespace and decide whether owner resume is refused for it; this ADR
  deliberately does not.
