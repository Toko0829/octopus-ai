-- 20260905120000_retrieval_gaps.sql — the questions the corpus could not answer, kept.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/rag-knowledge.md, docs/10-architecture/rag.md
--
-- **The gap this closes is that nothing knows which gaps matter.** The system
-- refuses well: `planner.py` already splits a refusal three ways, and the split is
-- load-bearing, because "nothing retrieved" and "retrieved but off-target" are
-- corpus signals that should drive what gets ingested next while "could not
-- verify" is an operational signal that should page someone. All three then go to
-- stdout and nowhere else. So the corpus has been grown by author's intuition
-- against a golden set the same author wrote, and the one artefact that would say
-- what people actually ask and do not get has never existed.
--
-- Measured motivation rather than a hunch. The shared corpus is 17 documents and
-- 99 chunks, about 17,000 words, of which the internally-authored half is 7,443.
-- `--gate` reports "blocked 1.00 of scope negatives" as a PASS, and those scope
-- negatives are webinar funnels, GA4 conversion tracking, app-store ranking,
-- Facebook ad specs, influencer platforms and affiliate networks. Every one is a
-- reasonable thing for a founder to ask. The metric reading PASS is the gap list,
-- and it is a gap list of six entries written by hand.
--
-- **Why not `events`.** That table is the DAG's audit trail: it requires a
-- `subject_id uuid not null` and hangs off `project_id`. A refusal has neither. It
-- happens before any project exists, and its subject is a sentence somebody typed.
-- Forcing it in would mean a synthetic subject id that points at nothing, which is
-- how an audit trail stops being readable.
--
-- **Append-only, including for `service_role`**, following `campaign_outcomes` and
-- `events` rather than `feedback_events`, which states the intent in a comment and
-- then grants everything anyway. TRUNCATE is revoked alongside UPDATE and DELETE
-- because `grant all` includes it, it is not row-level, and it ignores RLS.
--
-- **There is deliberately no `resolved` column.** A gap is closed when the same
-- question stops being refused, which is a thing to measure rather than a thing to
-- assert. A boolean somebody ticks after ingesting a document would record the
-- intention to fix it, not the fix.

-- ------------------------------------------------------------- the table ----

create table public.retrieval_gaps (
  id           uuid primary key default gen_random_uuid(),

  -- Which of the three refusals this was. Constrained to the cores `planner.py`
  -- defines, so a fourth core cannot start writing rows nobody can interpret: a
  -- new core is a schema change here, which is the point at which somebody has
  -- to decide what the new value means for the corpus.
  core         text not null check (core in (
                 'refusing-v0', 'refusing-ungrounded-v1', 'refusing-unverified-v1'
               )),

  -- Where the refusal happened. A whole-goal refusal at `/plan` and a single-step
  -- refusal at `/execute` are different signals: the first says the corpus cannot
  -- start the work, the second says it cannot finish a step it already planned,
  -- which is the sharper of the two because the planner had already judged the
  -- ground covered.
  surface      text not null check (surface in ('plan', 'execute')),

  -- The question, redacted. `redact.scrub` removes emails, URLs, phone numbers
  -- and long digit runs before this is written, because rule 8 keeps PII out of
  -- logs and the index and a new store does not get a new posture. It is NOT
  -- stripped of the person's audience or product noun: those are exactly what
  -- makes one refusal distinguishable from another when reading a hundred of them.
  goal         text not null,

  -- The groundedness gate's own sentence naming what the sources lack. The gate
  -- prompt requires it ("if you answer false, `reason` must name the specific
  -- thing the sources lack, and if you cannot name it the answer is true"), which
  -- makes this column the single most useful thing in the table: it is a model
  -- that has read the sources saying what was missing from them.
  -- NULL for `refusing-v0`, where nothing was retrieved and there is nothing to say.
  reason       text,

  -- What retrieval saw. `chunks_retrieved` is zero exactly when the core is
  -- `refusing-v0`, and the pair separates "the corpus is silent here" from "the
  -- corpus talked and missed", which is the distinction the whole table exists for.
  candidates_considered int not null default 0,
  chunks_retrieved      int not null default 0,

  -- The nearest misses: `[{"title": ..., "score": ..., "kept": ...}]`, best first.
  -- A count cannot distinguish a survivor that missed by 1.76x from one that was
  -- nowhere near, and that distinction is the whole difference between a corpus
  -- that cannot answer a question and a synonym that refused an answerable one.
  -- Titles rather than chunk ids: chunk ids are regenerated on every re-ingest, so
  -- a ledger keyed on them would stop resolving after the next corpus change, for
  -- the same reason `golden.json` is keyed on titles.
  top_sources  jsonb not null default '[]',

  -- Correlation, not identity. `room_id` carries no foreign key, matching
  -- `documents.owner_room_id`: a gap outliving its room is still a true statement
  -- about the corpus, where a cascade would delete the evidence when somebody
  -- tidies up a workspace.
  room_id       uuid,
  project_id    uuid,
  agent_run_id  text,

  created_at   timestamptz not null default now(),

  -- `refusing-v0` retrieves nothing by definition, and anything else retrieved
  -- something. Enforced rather than trusted because the two counts are what every
  -- query against this table will group by, and a writer that gets it wrong makes
  -- the table quietly lie rather than error.
  constraint retrieval_gaps_no_sources_is_empty check (
    (core = 'refusing-v0') = (chunks_retrieved = 0)
  )
);

-- The two readings this table is for: "what is being refused lately" and "what is
-- this workspace repeatedly not getting".
create index retrieval_gaps_core_idx on public.retrieval_gaps (core, created_at desc);
create index retrieval_gaps_room_idx on public.retrieval_gaps (room_id, created_at desc)
  where room_id is not null;

-- ---------------------------------------------------------- RLS and grants ----

alter table public.retrieval_gaps enable row level security;

-- **No policy for `authenticated`, deliberately.** RLS with no permissive policy
-- denies everything, so this is closed rather than merely unmapped, and the
-- absence is stated here so a later reader does not read it as an oversight and
-- "fix" it. This is an operator artefact for deciding what to ingest next. A user
-- has already been told, in the refusal itself, that their question was not
-- covered; there is nothing further here for them, and one room's phrasing of a
-- question is not another room's business.
grant select, insert on public.retrieval_gaps to service_role;
revoke update, delete, truncate on public.retrieval_gaps from authenticated, anon, service_role;

comment on table public.retrieval_gaps is
  'Every refusal, with the reason the groundedness gate gave and the nearest misses. '
  'The ranked queue for what to ingest next. Append-only including for service_role; '
  'no client access at all. A gap is closed by the question ceasing to be refused, '
  'which is why there is no resolved column.';

comment on column public.retrieval_gaps.goal is
  'The question as asked, scrubbed of emails, URLs, phone numbers and long digit runs. '
  'Not stripped of audience or product nouns: those are what make one refusal legible '
  'against a hundred others.';

comment on column public.retrieval_gaps.reason is
  'The groundedness gate naming what the sources lacked. NULL when nothing was retrieved.';

comment on column public.retrieval_gaps.top_sources is
  'Nearest misses, best first: [{title, score, kept}]. Keyed on title rather than chunk id '
  'because chunk ids are regenerated on every re-ingest.';
