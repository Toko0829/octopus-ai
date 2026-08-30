# ADR-0015: node service area is a hierarchical jurisdiction code, not a geometry

- **Status:** Accepted
- **Date:** 2026-08-31
- **Affects:** [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) · [data-model.md](../10-architecture/data-model.md) · [tech-stack.md](../10-architecture/tech-stack.md)

## Context

[human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) has
specified **PostGIS** for node service geo since Phase 0:

> Structured skill taxonomy … **service geo (PostGIS)**, availability, rate,
> languages, rating.

The marketplace domain (`20260831120000`) is the first migration that has to
give that column a type, so the decision can no longer be deferred by not
having a table.

Two facts frame it. PostGIS is **not installed** on this project — the only
extensions are `vector` and `pgtap` — so this is an addition rather than a
default. And rule 1 forbids diverging from a module doc silently: either the
doc is right and the migration follows it, or the migration is right and both
are reconciled in the same change.

## Decision

**`node_profiles.service_jurisdictions` is `text[]` holding hierarchical
jurisdiction codes** (`US`, `US-TX`, `US-TX-AUSTIN`), shape-checked by
`private.is_jurisdiction_code`, indexed with GIN. PostGIS is not enabled.

## Why

**The matching rule as written is not a geometry query.** The module doc says
the eligible pool requires that "service geo/jurisdiction **includes** the task
location", ranked by "jurisdiction **exactness** (Austin-local > Texas-state)".
That is a containment test over a hierarchy plus a specificity ordering.
`US-TX-AUSTIN` is inside `US-TX` is inside `US`, and exactness is the segment
count. A prefix test answers both, exactly, and an integer answers the ranking.
Neither needs a coordinate.

PostGIS answers a genuinely different question — radius, polygon, distance —
and the module needs it exactly once, for `on-site-inspection` within *n* km of
a point. **No task can ask that today.** `projects.market` is free text and
`documents.jurisdiction` is free text; there is no point anywhere in the schema
to measure from.

**The decisive argument is representation, not cost.** The RAG corpus is keyed
by text jurisdiction, the jurisdiction packs are text, and the task location is
text. Storing node service area as a geometry would give one question — *does
this person work where this work is?* — two representations that must be kept
in step by hand. That is precisely the defect `20260827110000` recorded and
paid for: `is_project_member` and `roomForProject` answered one question two
ways, and six projects, forty-seven tasks and twenty-eight artifacts went
invisible for two weeks, silently, as zero rows. A second representation of
jurisdiction would fail the same way and be equally quiet about it.

The cost argument is real but secondary: enabling PostGIS to store what is
currently a two-to-three segment string, in a product with no geographic query,
is capability we would have to defend rather than capability we would use.

## Consequences

- Containment is `code = any(...)` or a prefix test; exactness is the segment
  count. Both are ordinary SQL and both are indexable.
- The shape is enforced by a check constraint calling
  `private.is_jurisdiction_code`. **Postgres does not re-validate an existing
  check constraint when the function it calls changes**, so any migration that
  edits the code shape must `alter table … validate constraint` (or drop and
  re-add). Recorded in [data-model.md](../10-architecture/data-model.md)
  §Migration conventions, because it is the kind of thing that fails silently:
  old rows keep passing a rule they no longer satisfy.
- Codes are uppercase and hierarchical by construction; a country with no
  subdivision is one segment and still works.
- We cannot answer "within 25 km" and are not pretending to. A task whose
  acceptance criteria need that is a task this matcher will not rank correctly,
  and that is a stated limit rather than a hidden one.

## Trigger to revisit

**The first task that carries a point rather than a jurisdiction** — that is,
the first on-site vertical. At that moment the answer is a *nullable geometry
column beside the codes*, not a replacement for them: the codes stay because
the corpus, the packs and the plan all still speak in them, and the geometry
answers the one question they cannot. That migration gets its own ADR, because
running two representations deliberately is a different decision from running
one.

## Alternatives considered

- **Enable PostGIS now and store a geometry.** Rejected: it answers a question
  nothing asks, and it creates the two-representations trap above before there
  is any benefit to trade against it.
- **A `jurisdictions` reference table with a parent FK.** Rejected for now.
  It buys referential integrity over a vocabulary nobody has enumerated, and
  the containment test becomes a recursive CTE instead of a prefix. Worth
  revisiting if jurisdiction display names or localisation are ever needed,
  which is a presentation problem rather than a matching one.
- **A single `text` column instead of an array.** Rejected: a node who works in
  both Texas and Georgia is ordinary, and encoding that as delimited text
  inside one string is an array with worse ergonomics and no index.
