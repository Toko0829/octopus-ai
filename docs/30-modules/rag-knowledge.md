# Module: RAG & Knowledge Base

> The jurisdiction-aware knowledge system: ingest, contextualize, index, and retrieve legal, permit, tax, supplier, and cost-benchmark knowledge with citations, freshness, and hybrid retrieval + rerank. Exposed to the agent as the `rag_retrieve` tool.
>
> **Owner paths:** `packages/rag/**` · **Depends on:** infra-devops (pgvector, `pg_cron`, storage), integrations (embedding/rerank/parser providers, crawlers) · **Depended on by:** ai-orchestrator, business-projects-workflow.
>
> The full engineering spec lives in [rag.md](../10-architecture/rag.md); this module doc is the operational/domain view. Update both on any ingestion/retrieval/model/eval change.

## Responsibilities

- Own the knowledge corpus — **reference knowledge + real outcomes** — and its freshness.
- Compile **playbooks** (archetype × market/jurisdiction pack) for the workflow engine — first the [full-funnel marketing playbook](../60-playbooks/full-funnel-creator.md).
- Serve grounded, cited retrieval to the agent, **preferring real outcomes** ("what worked for customers like this") as they accrue.
- Run the outcome-ingestion side of the [learning flywheel](../10-architecture/learning-flywheel.md).

> **Implementation status (Phase 1):** ingestion and hybrid retrieval are live in `services/ai`. Schema in `20260728210000_rag_schema.sql`, RRF fusion in `public.hybrid_search`. A four-document seed corpus lives in `services/ai/corpus/` covering paid acquisition, advertising disclosure, lifecycle email and early-stage SEO for the US market. Seed or re-seed with `uv run --directory services/ai python -m octopus_ai.seed`; re-running is a no-op unless a document or the chunker changed.
>
> **The seed corpus is internally authored and labelled `internal`.** It is deliberately not attributed to regulators or ad platforms: a fabricated citation is worse than none, because the entire value of a citation is that the reader can check it. Real external sources arrive with the crawlers.
>
> **Not built yet:** crawlers and the freshness pipeline (`pg_cron` re-crawl, content-hash re-check against live sources), LLM-generated contextual prefixes (a metadata-derived prefix is used instead), query transformation (self-query, HyDE, decomposition), and the Ragas/DeepEval gate. `eval_golden_set` exists as a table but is empty.

## In-Postgres pgvector (rationale)

Vectors live in the same Postgres as everything else — relational, RLS-permissioned, transactionally consistent, one system to run. See [ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md). Schema: `documents` + `doc_chunks` (`halfvec(1024)` HNSW cosine + generated `tsvector`), plus typed `suppliers` / `cost_benchmarks` rows.

## Ingestion pipeline

`registry → crawl → change-detect → parse → normalize → chunk → contextualize → embed → index → structured-load → validate → observe`. Heavy work runs as background jobs (pg-boss / Trigger.dev), never in the request path. Details + the 12 steps in [rag.md](../10-architecture/rag.md).

## Retrieval

Query transformation (self-query filters, multi-query/HyDE, decomposition, routing) → dense (OpenAI `text-embedding-3-large`, 1024 dims) + sparse (`tsvector`/BM25) → **RRF (k=60)** → **Cohere Rerank v3.5** over top-40 → top 6–8, with a relevance threshold that **drops** weak chunks.

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

- **Offline:** Ragas on a golden set (context precision/recall, faithfulness, answer relevancy).
- **CI gate:** DeepEval thresholds — faithfulness ≥ 0.75, answer relevancy ≥ 0.8, context precision ≥ 0.7, context recall ≥ 0.8. **Retrieval/ingestion/prompt changes must pass before merge.**
- **Production:** Langfuse tracing + online scoring + citation-coverage checks + thumbs-up/down from chat.

## Multilingual handling

One strong multilingual embedder (OpenAI `text-embedding-3-large`) across the corpus; per-language `tsvector` configs for sparse. Retrieval quality for the later Georgian/Russian pack must be **measured at the eval gate**, not assumed ([ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)). EU languages now; Georgian/Russian for the founding pack.

## Implementation (Python service)

This module is implemented in the **Python AI service** (`services/ai`, LlamaIndex-Python) — ingestion, retrieval, and eval — exposed to the Node agent over a typed HTTP seam ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)). It shares the same Supabase Postgres (pgvector), so retrieval stays SQL over the single source of truth.

## Key entities

`knowledge_sources` · `documents` (jurisdiction/market, business_type, doc_type, effective/valid dates, content_hash, version, lang) · `doc_chunks` (embedding `halfvec(1024)`, `fts tsvector`, context_prefix, parent_id, embed_model) · **`campaign_outcomes` · `creative_performance` (flywheel)** · `suppliers` · `cost_benchmarks` · `eval_golden_set`.

## Risk mitigations

Hallucination (groundedness gate + citations) · staleness (freshness pipeline) · jurisdiction bleed (hard filters, unambiguous keys) · OCR errors (layout-aware parsing + validation) · injection (quarantine) · tenant leakage (RLS on chunks). Full register in [rag.md](../10-architecture/rag.md).
