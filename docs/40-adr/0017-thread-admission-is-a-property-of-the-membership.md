# ADR-0017: thread admission is a property of the membership, not a second table

- **Status:** Accepted
- **Date:** 2026-09-01
- **Affects:** [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) · [chat-discord.md](../30-modules/chat-discord.md) · [data-model.md](../10-architecture/data-model.md) · [security-compliance.md](../10-architecture/security-compliance.md)

## Context

`public.room_members` has carried `scope text not null default 'room'` since
`20260728120000`, with **no check constraint and not one reader** anywhere in
44 migrations: no policy, no helper, no index, no trigger, no server code. Every
row on the live database is `'room'`.

[security-compliance.md](../10-architecture/security-compliance.md) requires a
human node to see **only its engaged task thread, time-boxed**, and two
migrations have recorded the gap as a KNOWN NARROWING landing "with threads"
(`20260813120000`, restated verbatim in `20260827110000`). Slice 2 of the
marketplace sequence is where that lands, and it lands **before** any writer
that could admit a node, so the narrowing is never actually taken.

Making `scope` mean something forces a shape decision that is expensive to
change afterwards, because it decides what every membership predicate joins on.
The constraint that makes it a real fork: **`room_members`' primary key is
`(room_id, user_id)`**, one membership row per person per room. "Member of
thread A and thread B in the same room" is not expressible on that key.

The decision is taken now rather than at slice 5, for the reason
[ADR-0016](0016-an-engagement-has-no-state-of-its-own.md) states about
`engagements`: the slice sequence after it is derived from the answer, and an
ADR written later would rationalise a decision already spent.

## Decision

**Thread admission is a nullable `thread_id` on the existing membership row,
bound to `scope` by a check constraint. The primary key does not change.**

```sql
alter table public.room_members add column thread_id uuid;
alter table public.room_members
  add constraint room_members_thread_in_same_room
  foreign key (thread_id, room_id) references public.threads (id, room_id)
  on delete cascade;
alter table public.room_members
  add constraint room_members_scope_known check (scope in ('room', 'thread'));
alter table public.room_members
  add constraint room_members_thread_iff_thread_id
  check ((scope = 'thread') = (thread_id is not null));
```

`scope` stays **checked text rather than an enum**, and one node holds **at most
one thread-scoped admission per room**.

## Why

**One membership table means one predicate family.** Every tenancy question in
this system terminates in a `room_members` row for `auth.uid()` with a time-box
check: `private.is_room_member`, `private.shares_room_with`,
`private.is_project_member`, `private.artifact_object_project` through the last
of those, and the two inlined copies inside the `realtime.messages` policies. A
separate `thread_members` table would make every one of them consult two tables,
forever, and would have to be kept in step by hand.

That is precisely the defect this repository has paid for most. It cost six
projects and forty-seven tasks their visibility when `is_project_member` and
`room-for-project` answered the same question two ways
(`20260827110000`), and it is the argument
[ADR-0015](0015-service-geo-is-a-jurisdiction-code.md) makes for refusing a
PostGIS geometry beside an all-text corpus. A thread scope **narrows** an
existing membership; it is not a second membership, and modelling it as one
would misdescribe it.

**Checked text rather than an enum, for reversibility.** `alter type ... add
value` cannot be rolled back (recorded in `supabase/README.md`), while a check
constraint is dropped and re-added in an ordinary migration. Converting the
existing column to an enum would also be a table rewrite bought for no
enforcement the check does not already provide. `channel_kind` is not a
counter-precedent: it was born an enum with its table, and retrofitting one is a
different cost.

**The one-thread ceiling is accepted rather than overlooked.** No writer can
produce a second concurrent admission today, and
[ADR-0016](0016-an-engagement-has-no-state-of-its-own.md) already makes the
engagement the thing that admits somebody, so the eventual answer is to derive
admission from live engagements rather than to widen this key.

## Consequences

- A node cannot hold two concurrent thread admissions in one room. **Trigger to
  revisit:** the first matcher decision that would offer one node a second
  concurrent task in a room they are already engaged in. **Expected road:**
  re-derive admission from live `engagements` rows, not a primary-key widening.
- `threads.task_id` is a plain unique, so a reassignment after a no-show
  continues in the **same** thread. The audit trail of a task does not fragment
  per engagement, which is the property that makes "what happened on this task"
  answerable at all.
- The three scope-aware helpers (`private.member_scope_covers`,
  `..._channel`, `..._message`) are the only new predicates, and each takes the
  row's own thread as an argument rather than deriving it, so the SECURITY
  DEFINER surface stays in `private` and off the PostgREST RPC surface.
- **`room_members` is the one table where the row is itself a scope**, so the
  predicate that is correct for `messages` is wrong for it. Reusing it verbatim
  let a thread-scoped member read every membership row pointing at their own
  thread rather than only their own; caught by `thread_scope.sql` and corrected
  in `20260901123000`.

## Alternatives rejected

- **A `thread_members` join table.** Expresses multi-thread membership directly,
  and creates a second definition of tenancy that six helpers and two inlined
  realtime predicates would each have to consult. Rejected on the
  two-representations record above.
- **Widening the primary key to `(room_id, user_id, scope)` now.** Pays a
  migration on a live table, changes the shape every helper joins on, and buys
  a case no writer can produce until slice 5. The revisit trigger above is
  cheaper and better informed.
- **A `scope` enum.** Irreversible value additions, and a table rewrite, for
  enforcement the check constraint already gives.
