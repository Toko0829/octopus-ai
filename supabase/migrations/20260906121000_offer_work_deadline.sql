-- 20260906121000_offer_work_deadline.sql — how long the work gets, decided before it is taken.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md
--
-- Marketplace slice 6, second migration. One column, and its writer ships in the
-- same push.
--
-- `engagements.deadline_at` has existed since `20260904120000` with **no writer
-- and no reader**. Slice 5 recorded it as a fact with no recorder rather than a
-- rule with no producer, which is the right distinction and the reason it was
-- allowed to land empty. Slice 6 gives it both, because the no-show path needs a
-- moment to compare against and inventing one at acceptance would be guessing at
-- when somebody loses work they are in the middle of.
--
-- ---------- Why the number lives on the offer ----------
--
-- **`accept_offer` writes `deadline_at` from this column, never from an
-- argument.** `20260904125000:22-24` is binding: "the payload is read from the
-- rows, never taken as arguments … a caller cannot name either". The caller of
-- the accept route **is the node**, so a node naming their own deadline is the
-- same refusal as a node naming their own price.
--
-- Putting it on `offers` rather than inlining an interval in `accept_offer` buys
-- three things:
--
--   * **one representation of a policy number.** The value comes from a constant
--     in `packages/marketplace` beside `OFFER_TTL_MS`; the arithmetic happens in
--     SQL. An interval literal inside the function plus a TypeScript constant for
--     display would be two copies of a number that decides when somebody loses
--     work and money, which is the shape ADR-0011 permits only when both halves
--     are pinned by paired suites.
--   * **the node sees it before they accept.** `readNodeOffers` can project it, so
--     the deadline is part of what is being agreed rather than something that
--     appears afterwards. The module doc's offer flow already promises an offer
--     carries "scope, acceptance_criteria, escrowed price, deadline, expiry".
--   * **it is frozen per offer.** Changing the constant later cannot retroactively
--     shorten a deadline on work already taken, for the same reason
--     `engagements.agreed_price` is frozen rather than re-read from the profile.
--
-- ---------- What this is not ----------
--
-- **Not `expires_at`.** That is how long the node has to *answer* the offer, and
-- it is compared at read time so a node is never shown a live offer a sweep has
-- not settled. This is how long they have to *do the work* once they have said
-- yes. Two clocks, two questions, and conflating them would make a slow reply
-- eat into the time to deliver.
--
-- **Not a hard cut-off for a node who is delivering.** The sweep that reads it
-- looks only at `escrow_funded` and `in_progress`; a step already handed over is
-- never reassigned, because a deadline that passes after delivery is the owner's
-- failure to review rather than the node's failure to work.

alter table public.offers
  add column work_deadline_hours integer not null default 168
    check (work_deadline_hours > 0);

comment on column public.offers.work_deadline_hours is
  'How long the node gets to do the work after accepting, frozen onto the offer so a later '
  'change to the policy constant cannot shorten a deadline on work already taken. Written by '
  'the matcher sweep from WORK_TTL_MS in packages/marketplace; read by accept_offer, which '
  'stamps engagements.deadline_at. Distinct from expires_at, which is how long they have to '
  'answer the offer at all.';

-- The default is the same 168 hours (seven days) the matcher writes, and it is
-- here for the rows that already exist: eleven settled offers on the live
-- database, none of which will ever be accepted, plus any open one mid-cascade.
-- A nullable column would have been the alternative and is worse: the writer
-- would then have to decide what a null deadline means, and "no deadline" is a
-- state this domain deliberately does not have, since it is the one that produced
-- `escrow_funded` with no exit in the first place.
