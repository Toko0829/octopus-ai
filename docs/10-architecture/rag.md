# RAG System

> The complete Retrieval-Augmented Generation spec: ingestion, hybrid retrieval + rerank, contextual enrichment, jurisdiction packs, freshness, evaluation, and risk mitigations. Source of truth for anyone touching knowledge or retrieval. Update on any change to ingestion, retrieval, models, or eval gates.
>
> **Implemented in `services/ai` (Python), not `packages/rag`.** [ADR-0006](../40-adr/0006-python-ai-service-node-backend.md) moved the AI layer to Python after this doc was written; the `packages/rag` path referenced in older text does not exist.
>
> **Implementation status (Phase 1).** Live: the schema (`20260728210000_rag_schema.sql`), hybrid retrieval with RRF fusion in SQL (`public.hybrid_search`), Cohere rerank with a calibrated drop-threshold, structure-first chunking, batched embedding, and content-hash supersession. A four-document internally-authored seed corpus covers paid acquisition, advertising disclosure, lifecycle email and early-stage SEO for US.
>
> **Not built yet, in this doc's order:** crawlers and the freshness pipeline (steps 1 to 3 and the `pg_cron` re-crawl), layout-aware parsing and OCR (step 4), **LLM-generated contextual prefixes** (step 7 uses a metadata-derived prefix instead), structured supplier/cost-benchmark rows (step 10), the query-transformation stage (self-query, multi-query/HyDE, decomposition, routing), and the whole **evaluation section** — `eval_golden_set` exists as an empty table and no Ragas/DeepEval gate runs. Treat the rest of this document as specification, not description.

## Why RAG is load-bearing here

RAG grounds Octopus's recommendations in reality instead of generic advice. For the **first vertical (marketing)** it retrieves _what actually worked for comparable creators/products_ — real campaigns, outcomes, and channel best-practices — **with citations**. For later **regulated verticals** (business formation) it grounds legal/tax/permit output so a wrong answer is **refused and escalated**, not hallucinated. Either way: **grounded, cited, current — or refused.** RAG is also the substrate of the [learning flywheel](learning-flywheel.md): real outcomes and human-node corrections flow back into the corpus so retrieval keeps improving.

## Design principle: stay in Postgres

`pgvector` on Supabase Postgres, **not** a dedicated vector DB. See [ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md). Rationale:

1. **Relational + permissioned** — chunks join to jurisdictions, playbooks, suppliers, cost benchmarks, and tenant scoping enforced by RLS.
2. **Transactional consistency** — a document and its chunks commit/roll back atomically; no dual-write drift.
3. **One system** to operate, back up, secure — no ETL sync.
4. **Fast enough** well beyond our scale with `halfvec` + parallel HNSW builds + iterative scans.

Reassess (Qdrant / pgvectorscale StreamingDiskANN) only past tens of millions of chunks or sustained high QPS.

## Schema (see [data-model.md](data-model.md) for full DDL)

- `documents` — source metadata: `jurisdiction`, `business_type`, `doc_type`, `effective_date`/`valid_from`/`valid_to`, `content_hash`, `version`, `lang`.
- `doc_chunks` — `chunk_text`, `context_prefix`, `embedding halfvec(1024)`, generated `fts tsvector`, `metadata` JSONB, `parent_id`, `embed_model`.
- Indexes: HNSW (`vector_cosine_ops`, `m=16`, `ef_construction=200`) + GIN (`fts`) + btree/GIN filters. Iterative index scans on.

## Embedding model

- **Primary: OpenAI `text-embedding-3-large`, requested at `dimensions: 1024`** ([ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)). Matryoshka-trained, so it emits 1024 dims directly; stored as `halfvec(1024)`, cosine. **No schema change from the original pin.**
- **Local option: BAAI `bge-m3`, in-process** ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)), selected with `EMBED_PROVIDER=local`. Natively 1024-dim (`hidden_size: 1024`, verified against the model config), so the schema is again unchanged. XLM-RoBERTa based and multilingual by construction, which speaks directly to the lower-resource-language risk ADR-0007 left open. Chosen for **data residency**: it keeps customer outcome data off a sub-processor once the flywheel starts ingesting it. Retrieval quality relative to OpenAI on this corpus is **not yet measured** and is the eval gate's job; the default stays `openai` until it is.
- **Multilingual by construction** — EU languages now; Georgian/Russian for the founding pack. An English-first model is disqualifying. `text-embedding-3-large` clears that bar for **US + EU** (MIRACL ~54.9%), but is weaker on lower-resource languages than the Voyage model it replaced: **treat the Georgian/Russian pack's retrieval quality as something to measure at the eval gate, not assume.**
- **One model across the whole corpus** — different models yield incompatible vector spaces and cannot share an HNSW index. Changing it after ingestion means re-embedding everything. Version `embed_model` on every row for traceable re-embeds and A/B.
- **Embed the _contextualized_ chunk** (chunk + generated situating context), not the raw chunk.
- Alternatives: Voyage-3-large (stronger multilingual; the prior pin), Cohere embed-v4 (multimodal for scanned permit PDFs), BGE-M3 / Qwen3-Embedding (self-host for data residency).

## Ingestion pipeline (12 steps)

1. **Registry** — `knowledge_sources` declares each source, authority, and crawl cadence.
2. **Crawl** — per-source crawlers (Supabase Edge Functions / Fastify workers) via `pg_cron`.
3. **Change-detect** — content hash; skip unchanged docs; supersede changed ones.
4. **Parse** — layout-aware (LlamaParse / Unstructured / Docling), OCR for scanned PDFs.
5. **Normalize** — clean, language-tag, extract structured fields.
6. **Chunk** — structure-first, ~512 tokens, small-to-big / parent-doc.
7. **Contextualize** — Anthropic-style: prepend a 1–2 sentence LLM-generated situating blurb (cache the parent doc to bound cost).
8. **Embed** — `text-embedding-3-large` at `dimensions: 1024` on the contextualized text.
9. **Index** — write `doc_chunks` (embedding + generated `tsvector`), HNSW/GIN.
10. **Structured-load** — suppliers/cost benchmarks go into **typed rows**, not prose chunks.
11. **Validate** — schema + citation-coverage + eval spot-checks.
12. **Observe** — emit ingestion metrics/traces (parse-failure spikes, drift).

Heavy ingestion runs as background jobs (pg-boss / Trigger.dev), **never in the request path**.

## Retrieval (hybrid + rerank)

1. **Query transformation** (pre-retrieval LLM step):
   - _Self-query_ → extract hard filters (`jurisdiction=US/TX/Austin`, `business_type=food_service`, `effective_date>=now`) → SQL `WHERE` **and** HNSW pre-filters (the single biggest correctness lever).
   - _Multi-query + HyDE_ → cover vocabulary gaps between casual phrasing and statutory language.
   - _Decomposition_ → split compound asks ("permits + suppliers + hiring") into sub-retrievals.
   - _Routing_ → send each sub-query to the right corpus (permits vs suppliers vs cost benchmarks).
2. **Dense** — `halfvec` HNSW cosine over pre-filtered chunks (OpenAI embeddings, 1024 dims).
3. **Sparse** — Postgres FTS (`websearch_to_tsquery`, GIN), per-language configs. Catches exact tokens (statute numbers, license codes, form IDs) that dense blurs. Upgrade path: ParadeDB `pg_search` for true BM25.
4. **Fusion** — **RRF (k=60)** merging dense + sparse in one SQL query (two CTEs + fused rank). Rank-based → no score normalization.
5. **Rerank** — **Cohere Rerank v3.5** cross-encoder over the fused **top-40** → return **top 6–8**. Apply a relevance-score **threshold to DROP** weak chunks rather than pad context. Optional MMR dedup before rerank when sources are redundant.

## Two corpora: reference knowledge + real outcomes

The knowledge base has two layers on the same pgvector infrastructure:

1. **Reference knowledge** (curated) — for the marketing vertical: marketing playbooks, channel/ad best-practices, platform ad-policies, format specs. For later verticals: legal/permit jurisdiction packs. Dated, cited, freshness-checked.
2. **Real outcomes** (the flywheel) — executed campaigns + measured results and human-node corrections, ingested as typed rows (`campaign_outcomes`, `creative_performance`) + contextualized chunks. Retrieval **prefers real outcomes** for "what worked for customers like this" as coverage grows. Consent, anonymization, and tenant isolation for this layer are governed by [learning-flywheel.md](learning-flywheel.md) — a customer's raw private data is never retrievable by another tenant; only anonymized, aggregated learnings enter the shared corpus.

## Market / jurisdiction packs

- For **marketing**, "packs" are market-scoped: ad-policy + disclosure rules (FTC in US, GDPR/ePrivacy in EU), language, and channel norms. For **business formation** (later), they are legal `country → region → city` packs.
- Versioned, **dated, cited** knowledge bundles.
- **US + EU first** (e.g. `US/TX/Austin`, `US/DE/Wilmington`, `EU/DE`, `EU/EE`); **Georgia/Tbilisi** documented as the founding pack.
- **Disambiguation guard:** the _country of Georgia_ vs the _US state of Georgia_ — packs carry unambiguous keys; the agent never generalizes one jurisdiction's rules to another.
- The **archetype × jurisdiction compiler** turns a pack + business archetype into a concrete, ordered, cost-estimated task DAG (see [rag-knowledge.md](../30-modules/rag-knowledge.md)).

## Freshness (a first-order feature)

- `pg_cron` re-crawls per source (daily for fee/registry pages; weekly/monthly for statutes).
- Content-hash **supersession**; `valid_from`/`valid_to` effective-dating so retrieval filters to **in-force** rules.
- Surface **"last verified"** dates to the user; route **high-stakes stale data** to a human node for re-verification.

## Guarded generation

- **Mandatory citations** on legal/tax/permit output, each with an **effective date**.
- **Groundedness gate:** claims not supported by retrieved, in-date sources (or below similarity threshold) are flagged `unverified` and **cannot gate a legal action** — they escalate to a human node.
- **Injection quarantine:** all retrieved content is untrusted **data**, never instructions.
- **Multi-tenant isolation:** retrieval respects RLS; no cross-tenant leakage.

## Evaluation & observability

- **Offline:** Ragas on a golden set — context precision/recall, faithfulness, answer relevancy — to tune chunking/embeddings.
- **CI gate:** DeepEval blocks regressions against the golden set. **Thresholds:** faithfulness ≥ 0.75, answer relevancy ≥ 0.8, context precision ≥ 0.7, context recall ≥ 0.8. Changes to ingestion/retrieval/prompts must pass before merge.
- **Production:** Langfuse traces every retrieval+generation; online scoring + thumbs-up/down captured from the group chat; single trace sink Ragas and DeepEval publish to.

## Where RAG runs (Python service)

RAG — ingestion **and** query-time retrieval — is implemented in the **Python AI service** (`services/ai`, LlamaIndex-Python), not in TypeScript ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)). The Node durable backbone calls the service's typed endpoints (e.g. `/retrieve`, `/plan`); ingestion + eval run as Python jobs. Both sides share the same Supabase Postgres (pgvector), so retrieval is still just SQL over the one source of truth. Eval gates (Ragas/DeepEval) are Python-native and run in CI.

## Risk register

| Risk                                    | Mitigation                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Hallucination on legal/financial claims | Groundedness gate + mandatory citations + escalate-on-unverified                                  |
| Stale regulations/fees                  | `pg_cron` re-crawl, content-hash supersession, effective-dating, "last verified", human re-verify |
| Jurisdiction bleed                      | Unambiguous pack keys, hard filters via self-query, never generalize across borders               |
| OCR/parse errors                        | Layout-aware parsing, validation step, parse-failure alerting                                     |
| Multilingual gaps                       | One strong multilingual embedder; per-language `tsvector` configs                                 |
| Prompt injection via sources            | Quarantine retrieved content as data; separate instruction channel                                |
| Tenant leakage                          | RLS on `doc_chunks`; retrieval scoped by policy                                                   |

## Libraries

`pgvector` · Supabase (`pg_cron`, Edge Functions, Storage, Realtime) · LlamaIndex (TS + Python) · LlamaParse/Unstructured/Docling · OpenAI SDK (embeddings, contextualization, query transform, grounded generation) · Cohere SDK (rerank) · Ragas · DeepEval · Langfuse · tiktoken. Optional in-Postgres upgrades: ParadeDB `pg_search`, `pgvectorscale`.
