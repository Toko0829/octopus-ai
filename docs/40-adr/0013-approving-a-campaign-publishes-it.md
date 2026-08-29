# ADR-0013: approving a campaign publishes it, and the intent row is written first

- **Status:** Accepted
- **Date:** 2026-08-29
- **Affects:** [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) · [architecture.md](../10-architecture/architecture.md) · [data-model.md](../10-architecture/data-model.md) · [business-projects-workflow.md](../30-modules/business-projects-workflow.md)

## Context

`materialise_campaign` (`20260829140000`) commits an approved campaign at
`ready`, which means authorised and not yet sent, and stops. `ad_entities` has
carried its guards since `20260829122000` with no writer at all. So the product
could ask somebody to authorise a budget and then do nothing with the answer,
which is the same dead end the campaign card itself was built to close one step
earlier.

Closing it raises two questions that have to be answered together, because the
answer to the first is what makes the second hard.

**When does a campaign publish?** Either approving the card is the
authorisation, or approving records an intention and a second control sends it.

**What happens when the process dies mid-publish?** Postgres has no transaction
across a call to somebody else's API. Between "we asked the platform" and "we
recorded what it said" there is a gap that a deploy, a crash or a timeout can
land in, and on the other side of that gap is an object that may or may not exist
and may or may not be spending money.

## Decision

**Approving the campaign card is the publish authorisation.** The next ticker
pass picks up campaigns at `ready` and publishes them. There is no second button.

**The intent row is written before the platform is called**, into
`ad_entities` at `state = 'publishing'`, under a key derived from the campaign id
alone (`publish:<campaignId>:campaign`). `ad_entities.idempotency_key` is unique
across the table, so a retry collides in Postgres rather than creating a second
row, and the same key is passed to the adapter so it collides at the platform
too.

## Why

**A second button asks a question that was already answered.** The card names
the channel, states the objective, and requires the owner to type a budget cap
before it will commit anything. There is no fact a second control could add. A
confirmation that adds no information is a confirmation people learn to click
through, which makes every _other_ confirmation in the product weaker: rule 11's
per-action confirmation is worth something only while each one carries a distinct
decision.

**It also removes a state nobody could act on.** A campaign parked at `ready`
behind an unpressed button is indistinguishable, to the person who approved it,
from one that is broken. This module has now built that dead end twice
(`create_campaign` with no card, `connect_channel` with no surface), and both
times the fix was to give the owner somewhere to go rather than another thing to
click.

**What this costs is a copy obligation, and it is paid in the same commit.** The
card, the approval reply, the connect callback and the chat intro all promised
that nothing would be published. Those sentences were true and are not true now,
so they change here rather than being left to drift. That is also what makes this
decision effectively irreversible: a promise altered on a trust surface cannot be
quietly altered back.

**The intent row goes first because the alternative loses the only fact worth
having.** Call the platform first and a crash before the write leaves an object
somewhere with no row pointing at it: nothing knows its id, nothing can pause it,
and the next pass would create a second one. Writing the intent first means the
worst case is a row describing a request that may not have been made, which the
next pass resolves by asking again under the same key. **A record of an
uncertain request is recoverable; an unrecorded certain one is not.**

**The key is derived, not generated.** From the campaign id and nothing else: no
clock, no run id, no random component. That is the whole crash-safety story,
because a second attempt is only safe if it asks for exactly the same side effect
under exactly the same name.

## Consequences

- **A campaign found at `publishing` is re-driven, never rolled back.** The
  campaign machine has no `publishing -> ready` arc by design, so resume means
  asking again with the same key. When the entity already carries an
  `external_id`, the adapter is skipped entirely.
- **`failed` is terminal, so the mapping from platform answers to states is
  safety-critical.** A policy rejection closes the campaign, because retrying it
  unchanged asks the same reviewer the same question. A rate limit or a provider
  error does **not**: those retry at tick cadence, unbounded, because a bound
  tripping on a transient outage would destroy a campaign somebody authorised and
  the recovery costs them a new card and a re-typed budget.
- **Revise-and-resubmit means a new campaign.** There is no arc back from
  `failed`, so the room message says so in as many words rather than leaving the
  owner to discover it.
- **The publish sweep is the second thing on the tick that is not the DAG walk**,
  and it runs before the crawl: a person is waiting on a publish and nobody is
  waiting on a regulator's page being re-read.
- **`PUBLISH_ENABLED` defaults to on**, inverting `CRAWL_ENABLED`. Crawling is off
  by default to protect strangers' servers; publishing has no stranger to
  protect, and off-by-default would make the new card copy false on every
  unconfigured deployment.
- **No durable-orchestration dependency was added.** ADR-0010's reasoning holds:
  the state is rows, a crash loses a worker rather than a run, and the ticker is
  what walks it. Trigger.dev remains a named deferral rather than a prerequisite.

## Alternatives rejected

**A separate Publish control in the panel.** Two acts, authorising a cap and
sending it, which is defensible in the abstract and in practice asks the same
person the same question twice. It also adds a surface whose only state is "you
already said yes, say yes again".

**Publishing inline in the approval route.** Tempting because the person is right
there and the latency would be zero. Rejected because it has no re-drive path: a
crash between the route's platform call and its write leaves a campaign nothing
will ever look at again, since the route only runs when somebody clicks. The
sweep exists precisely to be the thing that looks again.

**An outbox table.** The textbook answer, and here it would be a table written by
one caller, read by one caller, and empty most of the time. `ad_entities` already
is the outbox: it holds the intended side effect, the key, and the result. Adding
a second table would be the schema-whose-only-reader-is-itself defect this
repository has paid for twice.

**A bounded retry counter with backoff.** Needs a column, and the only realistic
producer of the failures it would count is an error the sole registered provider
cannot emit. Deferred to the first real provider, where an actual failure
distribution exists to size it against.
