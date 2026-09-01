-- 20260905130000_retrieval_gaps_ungrounded.sql — an answered gap is still a gap.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/40-adr/0021-a-labelled-ungrounded-tier.md, docs/30-modules/rag-knowledge.md
--
-- `20260905120000` constrained `core` to the three refusal cores, and said so
-- deliberately: a new core is a schema change here, which is the point at which
-- somebody has to decide what the new value means for the corpus. This is that
-- decision, made once, for `ungrounded-general-v1` ([ADR-0021](../../docs/40-adr/
-- 0021-a-labelled-ungrounded-tier.md)).
--
-- **It belongs in this table rather than in a new one**, because it is the same
-- signal wearing a different outcome. `refusing-ungrounded-v1` and
-- `ungrounded-general-v1` are produced by the identical condition: retrieval
-- returned chunks and the groundedness gate judged they do not answer the goal.
-- The only difference is what the product then did about it, which is a policy
-- decision that can change and has. Splitting them across two tables would mean
-- that turning `UNGROUNDED_FALLBACK` off silently moved the corpus's own backlog
-- somewhere else, and the queue would appear to empty because the answer changed
-- rather than because the gap closed.
--
-- **The rate is a corpus-health number and it should fall.** Read the ingest
-- queue as `core in ('refusing-v0', 'refusing-ungrounded-v1', 'ungrounded-general-v1')`,
-- which is every core except the operational one. A rising share of
-- `ungrounded-general-v1` means the product is answering more questions from
-- general practice, which is the tier working and the corpus not keeping up. It is
-- not an achievement to be reported as one.
--
-- The existing `retrieval_gaps_no_sources_is_empty` check is untouched and still
-- holds: this core is only ever reached on a retrieval that returned chunks, so
-- `chunks_retrieved` is never zero for it.

alter table public.retrieval_gaps
  drop constraint retrieval_gaps_core_check;

alter table public.retrieval_gaps
  add constraint retrieval_gaps_core_check check (core in (
    'refusing-v0',
    'refusing-ungrounded-v1',
    'refusing-unverified-v1',
    -- Not a refusal. The corpus could not support the goal and the product
    -- answered from general practice anyway, labelled and uncited, with no plan
    -- proposed. The gap is identical; only the response differs.
    'ungrounded-general-v1'
  ));

comment on column public.retrieval_gaps.core is
  'Which reasoning core produced this row. Three refusals plus ungrounded-general-v1, '
  'which is the same coverage gap answered from general practice rather than refused. '
  'The ingest queue is every value except refusing-unverified-v1, which is operational.';
