-- 20260904124000_offer_accept_arc.sql — `open -> accepted` gains a producer, so
-- the map gains the arc.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0019-claimed-to-matching-stays-dropped.md
--
-- `20260903120000` declared `accepted` and refused every path to it, in the
-- wording it chose deliberately: "nothing reaches `accepted` and pgTAP pins every
-- path to it as refused", "slice 5 adds the arc and the funding together." This
-- is that. **The producer ships in the same push**, `public.accept_offer` in
-- `20260904125000`, which is slice 4's ordering applied a second time: a
-- lifecycle only widens when something can walk the new edge.
--
-- **There is no task-map migration in this slice at all**, and that absence is
-- worth stating because a reader working down the file list will look for one.
-- `offered -> claimed` and `claimed -> escrow_funded` have both been in
-- `private.task_transition_allowed` since `20260813120000` and have simply had no
-- producer for the whole of that time. `accept_offer` walks both, in one
-- transaction, and nothing about the map changes.
--
-- **`claimed -> matching` stays dropped**, which reverses a booking the slice
-- table in human-nodes-marketplace.md carried and is argued in
-- [ADR-0019](../../docs/40-adr/0019-claimed-to-matching-stays-dropped.md).
-- Briefly: acceptance and funding are one transaction, so `claimed` is
-- transit-only and exists for no observable instant outside it. An arc out of a
-- state nothing can be sitting in is a map permitting an unmakeable transition,
-- which is the defect this repository has recorded five times. The no-show and
-- reassignment producer leaves from `escrow_funded` or later and lands in slice 6,
-- which is where the question reopens. The ADR names the trigger that would
-- falsify its own premise: if accept ever splits into two transactions, `claimed`
-- gains a crash window and the arc is needed.
--
-- ---------- The three settlements are untouched ----------
--
-- `declined`, `expired` and `withdrawn` remain terminal and remain the only other
-- destinations. What this adds is a fourth settlement of `open`, not a fourth way
-- out of a settled offer: `declined -> accepted` and `expired -> accepted` stay
-- refused, and `marketplace_offers.sql` keeps asserting both. A cascade still
-- cannot reopen what it closed.

create or replace function private.offer_transition_allowed(
  p_from public.offer_status,
  p_to   public.offer_status
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when private.offer_status_is_terminal(p_from) then false
    -- Four settlements now. The node said no; the node said nothing; the offer
    -- stopped mattering; **the node said yes and escrow was funded in the same
    -- transaction** (`public.accept_offer`, 20260904125000).
    when p_from = 'open' then p_to in ('declined', 'expired', 'withdrawn', 'accepted')
    else false
  end;
$$;

revoke all on function private.offer_transition_allowed(public.offer_status, public.offer_status) from public;

comment on function private.offer_transition_allowed(public.offer_status, public.offer_status) is
  'The offer lifecycle as data. open settles four ways since 20260904124000, when accept_offer '
  'became the producer of the accepted arc. All four settlements are terminal, so a cascade '
  'cannot reopen what it closed.';
