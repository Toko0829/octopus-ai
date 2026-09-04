-- 20260913123000_retrieval_gaps_provider.sql — which model answered the gap.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/rag-knowledge.md, docs/10-architecture/learning-flywheel.md,
--       docs/40-adr/0021-a-labelled-ungrounded-tier.md,
--       docs/40-adr/0032-reasoning-providers-are-workspace-connectors.md
--
-- ---------- What this adds, and why the queue needs it ----------
--
-- `20260905130000` let `ungrounded-general-v1` into this table on the argument
-- that an answered gap is still a gap: retrieval returned chunks, the gate said
-- the corpus does not cover the goal, and the only difference from a refusal is
-- what the product then did about it. That argument still holds, and this column
-- pair is the fact it was missing.
--
-- Until `20260913121000` there was one model behind every row and naming it would
-- have been noise. Now a workspace routes each voice to its own connector, so two
-- rows with the identical `core`, the identical `reason` and the identical
-- `top_sources` can be **two different products**: one where Claude wrote six
-- paragraphs of general practice and one where a cheap model wrote three. Reading
-- the queue without knowing which is reading an average of things that did not
-- happen.
--
-- Three readings this makes possible that were not:
--
--   * **Per-provider approval rate**, joined through `feedback_events` to the
--     message the answer became (`20260913124000`). A tier whose answers the
--     owner keeps labelling "not helpful" on one provider and keeps accepting on
--     another is a routing problem, not a corpus problem, and the two currently
--     look identical.
--   * **Whether a connector changed the rate at all.** The ungrounded share is a
--     corpus-health number that should fall as documents are added. A workspace
--     switching provider on the same corpus must not move it, and nothing could
--     check that.
--   * **Which rows to ignore when reading the ingest queue for ingest.** A gap
--     answered well by a strong model is still a gap; a gap answered badly is
--     both a gap and evidence. The pair separates them.
--
-- ---------- What this deliberately is not ----------
--
-- **Not a training signal, in either direction.** ADR-0032 decision 3: a
-- provider's output is a lead, never a source. Nothing in this table is ingested
-- into the corpus, no answer recorded here is distilled or fine-tuned on, and
-- that holds for the house default exactly as it holds for a customer's own
-- connector (OpenAI, Anthropic and Google all forbid the latter, verified
-- 2026-09-04, and the former would launder unverified claims into citations,
-- which is the leak the retrieval stack exists to prevent). What this column
-- buys is a human reading a queue with one more fact in it.
--
-- **No closed vocabulary**, for the reason `messages.model` has none: model ids
-- are a vendor's word, they move, and a value we do not recognise is still the
-- true answer to which model answered. A length bound is the whole check. A gap
-- row that fails to write because a vendor shipped a name after we last edited a
-- CHECK would lose the signal to protect the tidiness of the column.
--
-- **Null is the normal case and stays legal.** Every refusal row carries none,
-- because a refusal calls no model at all: `refusing-v0` never reached
-- generation, `refusing-ungrounded-v1` is the gate declining, and
-- `refusing-unverified-v1` is the gate itself being unavailable. Recording the
-- house model on those would put an attribution on a sentence no model wrote,
-- which is the same mistake `messages_model_agent_only` exists to make
-- impossible one table over. Only `ungrounded-general-v1` carries the pair, and
-- only because that is the one core whose answer rests on the model rather than
-- on the corpus.
--
-- **The regulated refusal is the sharpest case of that.** `ungrounded.is_regulated`
-- runs before any provider is called, so a tax question declines the tier without
-- a customer's key ever being used. That row must name no provider, and it does
-- not, because it is written on the refusal path.
--
-- Grants are untouched: still `select, insert` for `service_role` and no client
-- policy at all. Adding a column to an append-only operator artefact does not
-- change who may read it, and a queue of one workspace's phrasing is still not
-- another workspace's business.

alter table public.retrieval_gaps
  add column provider text,
  add column model    text;

-- The same bound `messages_model_length` uses, and for the same reason: the set
-- is open, the length is not. 120 characters is past every id any of the three
-- vendors has shipped and well short of anything that could be smuggled in here.
alter table public.retrieval_gaps
  add constraint retrieval_gaps_provider_length check (
    provider is null or char_length(provider) between 1 and 120
  ),
  add constraint retrieval_gaps_model_length check (
    model is null or char_length(model) between 1 and 120
  );

comment on column public.retrieval_gaps.provider is
  'Which connector answered, when one did: a registry provider id (openai, anthropic, '
  'google, fake) or the house default that produced the answer. NULL on every refusal '
  'row, because a refusal calls no model. Open vocabulary with a length bound only.';

comment on column public.retrieval_gaps.model is
  'The model id that actually answered, as the service reported it rather than as we '
  'asked for it. Set only on ungrounded-general-v1. Read the queue per provider: the '
  'answer is a lead for what to ingest, never a source, and is never trained on.';
