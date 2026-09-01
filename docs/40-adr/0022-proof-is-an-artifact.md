# ADR-0022 — A node's proof is an `artifacts` row, not a `proof_artifacts` table

- **Status:** Accepted
- **Date:** 2026-09-06
- **Context:** Marketplace slice 6 (the engagement loop to `approved`)
- **Supersedes:** the `proof_artifacts` bookings in
  [data-model.md](../10-architecture/data-model.md) and
  [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md), both of
  which said "slice 6 decides table vs. columns"

## The decision

A human node's evidence of completion is a row in `public.artifacts` with
`kind = 'proof'`. There is no `proof_artifacts` table, and **no EXIF, geo or
timestamp columns are added anywhere in this slice**.

## Why this was open

`20260813160000` declared `artifact_kind` with four values, of which `'proof'`
was documented in the migration itself as "a human node's evidence of completion
(storage_path)". It then sat unreachable for a year, because nothing could create
a proof.

Meanwhile [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md)
§ Anti-fraud specifies "proof authenticity + EXIF/geo/timestamp checks", and both
this doc set's entity tables listed `proof_artifacts` as a pending entity. The
open question was whether proof deserves its own table because it wants columns
an AI draft would never fill.

## Why a second table loses

**The enum cannot be walked back.** `alter type ... add value` is not reversible,
which this repository already treats as a rule (`20260904121000` chose checked
text over an enum for exactly this reason). Shipping `proof_artifacts` would
strand `'proof'` as a permanently unremovable enum value with no writer, which is
the `room_members.scope` defect — a declared control with not one reader —
reproduced somewhere it cannot be deleted from.

**The second reader is not one reader, it is six.** A second table needs its own
`is_project_member` policy, its own `storage.objects` policy, its own
`<project_id>/<artifact_id>/<filename>` convention (stated in three places, two
of which are not code), its own signed-URL route beside the one in
`projects.ts`, its own `artifacts_have_content` equivalent, and its own arm in
`ProjectPanel` beside `task.artifacts`. `20260829124000` names the price of
exactly this shape: a read path and a policy that answer the same question
differently "cost this project 47 tasks and 28 of 58 artifacts".

**It strands a tested writer.** `apps/api/src/lib/artifact-files.ts` already
accepts `kind: 'proof'`, writes the object and the row together, and removes the
object if the row fails. It had no production caller at all; slice 6 is its
first. A second table would leave it stranded a second time.

**The checker would need a second adapter.** `packages/core/src/critic.ts` reads
`body` and `citations`. A proof in `artifacts` is reviewable by the same shapes.

**The owner needs no new read.** The owner is a project member, so
`artifacts_select_member` returns the proof and the existing signed-URL route
downloads it. The review control in the project panel sits directly above the
deliverables disclosure that was already rendering artifacts.

## Why EXIF and geo are not the counter-argument

The anti-fraud line asks for **checks**, and a check produces a **verdict**, not
a deliverable. Slice 6 ships no extractor, so any such column would be a rule
enforced over an empty set: the `task_deps` defect, which this repository has now
recorded five times.

When an extractor lands it is one of two things, and neither is a second
deliverable table:

- a nullable `metadata jsonb` on `artifacts` — null on an AI draft is the honest
  answer rather than a wart, because an AI draft has no camera; or
- a `proof_checks` table keyed on `artifact_id`, recording verdicts and scores,
  which is the `node_verifications` shape and stays out of the "where is the
  deliverable" question entirely.

## What this costs

`artifacts` now holds rows of two quite different kinds: what the AI produced and
what a person did in the world. They are told apart by `kind` alone, and every
reader that must not mix them has to say so. There are two today and both do:
`readNodeProof` filters `kind = 'proof'` (without it, a thread-scoped member
would read the AI's drafts and the owner's own write-up), and
`readProofStoragePath` filters on it as well as on the task.

**The falsifier is named:** if a third kind of reader appears that has to
distinguish them and cannot express it as a `kind` filter, or if proof grows
columns that are meaningless for every other kind and non-null for this one, this
decision should be revisited. A nullable `metadata jsonb` is not that trigger; a
second set of foreign keys would be.

## Consequences

- `proof_artifacts` is marked **not built, deliberately** in both entity tables
  rather than left as a pending row, so nobody schedules it again.
- `WriteFileArtifactInput` gains `createdBy`, fixing a hardcoded
  `created_by: 'agent'` that would have made every proof lie about its author.
- One submission writes **one note row plus zero or more file rows**. The note is
  not folded into a file row, because `writeFileArtifact` writes `body: null` on
  purpose so a file artifact does not render as an empty paragraph in the panel.
