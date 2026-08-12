# Module: RAG & Knowledge Base

> The jurisdiction-aware knowledge system: ingest, contextualize, index, and retrieve legal, permit, tax, supplier, and cost-benchmark knowledge with citations, freshness, and hybrid retrieval + rerank. Exposed to the agent as the `rag_retrieve` tool.
>
> **Owner paths:** `services/ai/**` (Python; `packages/rag` never existed and predates [ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) · **Depends on:** infra-devops (pgvector, `pg_cron`, storage), integrations (embedding/rerank/parser providers, crawlers) · **Depended on by:** ai-orchestrator, business-projects-workflow.
>
> The full engineering spec lives in [rag.md](../10-architecture/rag.md); this module doc is the operational/domain view. Update both on any ingestion/retrieval/model/eval change.

## Responsibilities

- Own the knowledge corpus — **reference knowledge + real outcomes** — and its freshness.
- Compile **playbooks** (archetype × market/jurisdiction pack) for the workflow engine — first the [full-funnel marketing playbook](../60-playbooks/full-funnel-creator.md).
- Serve grounded, cited retrieval to the agent, **preferring real outcomes** ("what worked for customers like this") as they accrue.
- Run the outcome-ingestion side of the [learning flywheel](../10-architecture/learning-flywheel.md).

> **Implementation status (Phase 1):** ingestion and hybrid retrieval are live in `services/ai`. Schema in `20260728210000_rag_schema.sql`, RRF fusion in `public.hybrid_search`. A **ten-document** seed corpus lives in `services/ai/corpus/` for the US market. Seed or re-seed with `uv run --directory services/ai python -m octopus_ai.seed`; re-running is a no-op unless a document, the chunker, or the embedding model changed.
>
> Corpus coverage against the six funnel stages in [marketing-growth-engine.md](marketing-growth-engine.md):
>
> | Stage       | Documents                                                                            |
> | ----------- | ------------------------------------------------------------------------------------ |
> | Strategy    | `positioning-icp`, `offer-design`                                                    |
> | Content     | `content-strategy`                                                                   |
> | Creative    | `creative-direction`                                                                 |
> | Channels    | `paid-ads-cpa-control`, `seo-early-stage`, `lifecycle-email`, `organic-social`       |
> | Conversion  | `landing-conversion`                                                                 |
> | Measurement | partial, inside `paid-ads-cpa-control` (attribution). **No dedicated document yet.** |
> | Compliance  | `ftc-disclosure-basics`                                                              |
>
> Written to be durable: they carry principles and diagnostics rather than platform specifics (character limits, ad formats, current fee levels), because those go stale between crawls and [rag.md](../10-architecture/rag.md) forbids quoting them from memory. Volatile specifics belong in crawled sources with effective dates, or as typed rows, not in hand-authored prose.
>
> **The seed corpus is internally authored and labelled `internal`.** It is deliberately not attributed to regulators or ad platforms: a fabricated citation is worse than none, because the entire value of a citation is that the reader can check it. Real external sources arrive with the crawlers.
>
> **Not built yet:** crawlers and the freshness pipeline (`pg_cron` re-crawl, content-hash re-check against live sources), LLM-generated contextual prefixes (a metadata-derived prefix is used instead), query transformation (self-query, HyDE, decomposition), and the Ragas/DeepEval gate. `eval_golden_set` exists as a table but is empty.

## In-Postgres pgvector (rationale)

Vectors live in the same Postgres as everything else — relational, RLS-permissioned, transactionally consistent, one system to run. See [ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md). Schema: `documents` + `doc_chunks` (`halfvec(1024)` HNSW cosine + generated `tsvector`), plus typed `suppliers` / `cost_benchmarks` rows.

## Ingestion pipeline

`registry → crawl → change-detect → parse → normalize → chunk → contextualize → embed → index → structured-load → validate → observe`. Heavy work runs as background jobs (pg-boss / Trigger.dev), never in the request path. Details + the 12 steps in [rag.md](../10-architecture/rag.md).

## Retrieval

**Query decomposition (live)** → dense (OpenAI `text-embedding-3-large` or local BAAI `bge-m3`, 1024 dims either way — [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)) + sparse (`tsvector`/BM25) → **RRF (k=60)** → **Cohere Rerank v3.5** over top-40 → top 6–8, with a relevance threshold that **drops** weak chunks.

> **Decomposition splits a goal into per-stage sub-queries, each reranked on its own.** A broad goal ("get me my first 100 customers") otherwise retrieves whichever funnel stage matches best, and the planner correctly leaves the rest empty rather than inventing steps. Measured on the golden set: coverage of a broad goal went **0.33 → 1.00**.
>
> The cheaper design was tried first and **measured as worthless**: searching every sub-query but running one rerank against the original goal changed nothing, because candidate breadth was never the bottleneck (40 candidates against a ~43-chunk corpus). The bottleneck is the rerank, where a vague goal scores uniformly low (0.066, against 0.474 for a focused query). So it costs one rerank per sub-query, which makes a production Cohere key a prerequisite rather than a nicety.
>
> **It is additive to grounding, never a source of it.** The goal is searched first and the sub-queries are abandoned if it retrieves nothing. Without that gate the golden set caught a real leak: "how to get a car licence" decomposed into plausible marketing sub-queries, each legitimately retrieved marketing content and cleared the threshold, and the agent ended up holding cited sources for a question the corpus cannot answer. That is the exact failure the groundedness gate exists to prevent, and it is why the negative half of the golden set exists.
>
> **Cost recorded honestly:** MRR fell 0.95 → 0.76. Merging survivors from several sub-queries pushes the single best chunk further down the list, and the planner reads all of them, so this is an acceptable trade for coverage rather than a free win.

> **Switching embedder re-embeds the corpus, and the code enforces it.** The ingestion content hash covers the active embedding model, so a provider change supersedes every document instead of skipping it as unchanged. Without that, one corpus would hold two incompatible vector spaces and retrieval would degrade silently. Note also that `rerank_min_score` was calibrated against Cohere scores over OpenAI-embedded chunks, so it must be re-calibrated after a switch rather than assumed to carry over.

## Jurisdiction packs

- Versioned, **dated, cited, city-granular** bundles keyed `country → region → city`.
- **US + EU first** (e.g. `US/TX/Austin`, `EU/DE`); **Georgia/Tbilisi** documented as the founding pack.
- Guard against **jurisdiction bleed** (country of Georgia vs US state of Georgia); never generalize rules across borders.
- The **archetype × jurisdiction compiler** turns a pack + business archetype into a concrete, ordered, cost-estimated task DAG (handed to [business-projects-workflow.md](business-projects-workflow.md)).

## Structured sources

Suppliers and cost benchmarks are stored as **typed rows**, not prose chunks, so the agent can filter/sort/compare them precisely (price, geo, category) rather than retrieving fuzzy text.

## Freshness & scheduling

`pg_cron` re-crawls per source (daily fees/registry, weekly/monthly statutes) · content-hash supersession · `valid_from`/`valid_to` effective-dating · "last verified" surfaced to the user · high-stakes stale data routed to a human node for re-verification.

## Evaluation

**Built (retrieval).** `services/ai/eval/golden.json` + `python -m octopus_ai.evaluation` run the real pipeline over a versioned golden set and score two asymmetric halves:

| Half          | Asks                                         | Gate                     |
| ------------- | -------------------------------------------- | ------------------------ |
| **Positives** | did the expected document surface            | recall ≥ 0.80            |
| **Negatives** | did an out-of-scope query return **nothing** | zero leaks, no tolerance |

The asymmetry is deliberate. A miss makes the agent refuse something it could have answered: unhelpful, but safe. A leak on a negative hands the planner loosely-related text, which it then grounds a confident cited answer in. One leak fails the run.

The golden set is a **file, not `eval_golden_set` rows**, because document UUIDs are generated per ingest and differ between environments, so a set keyed on them cannot travel between a laptop, CI and production. It is keyed on document title, and its queries are phrased as a founder would ask rather than in the corpus's wording, since a set that echoes the corpus measures string matching and flatters every retriever. The table remains for online/production scoring, which does have stable ids.

Baseline on the ten-document corpus with bge-m3: **positive recall 1.00, MRR 1.00, zero leaks.** True-positive rerank scores land between 0.127 and 0.637 while out-of-scope queries clear the 0.05 threshold not at all, so the threshold has real margin and did **not** need recalibrating after the corpus tripled.

**Not built (generation).** Ragas/DeepEval faithfulness and answer relevancy (≥ 0.75 and ≥ 0.8, with context precision ≥ 0.7 and context recall ≥ 0.8) need an LLM judge, which costs money per run and returns a different number each time. Those belong in a separate credentialed pass, not in the deterministic gate above.

**Rate limit worth knowing:** one case is one rerank call, so an eval run is the densest provider burst this service produces. A Cohere trial key allows 10 calls a minute and the set exceeds it outright; `EVAL_CASE_DELAY_S` paces the run and drops to 0 on a production key.

- **CI:** wired as its own job, but **it cannot gate until repository secrets exist**, since retrieval needs the Supabase corpus and a rerank key. Until then it emits a warning saying it measured nothing, rather than reporting a green check that proves nothing.
- **Production:** Langfuse tracing + online scoring + citation-coverage checks + thumbs-up/down from chat.

## Multilingual handling

One strong multilingual embedder (OpenAI `text-embedding-3-large`) across the corpus; per-language `tsvector` configs for sparse. Retrieval quality for the later Georgian/Russian pack must be **measured at the eval gate**, not assumed ([ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)). EU languages now; Georgian/Russian for the founding pack.

## Implementation (Python service)

This module is implemented in the **Python AI service** (`services/ai`, LlamaIndex-Python) — ingestion, retrieval, and eval — exposed to the Node agent over a typed HTTP seam ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)). It shares the same Supabase Postgres (pgvector), so retrieval stays SQL over the single source of truth.

## Key entities

`knowledge_sources` · `documents` (jurisdiction/market, business_type, doc_type, effective/valid dates, content_hash, version, lang) · `doc_chunks` (embedding `halfvec(1024)`, `fts tsvector`, context_prefix, parent_id, embed_model) · **`campaign_outcomes` · `creative_performance` (flywheel)** · `suppliers` · `cost_benchmarks` · `eval_golden_set`.

## Risk mitigations

Hallucination (groundedness gate + citations) · staleness (freshness pipeline) · jurisdiction bleed (hard filters, unambiguous keys) · OCR errors (layout-aware parsing + validation) · injection (quarantine) · tenant leakage (RLS on chunks). Full register in [rag.md](../10-architecture/rag.md).
