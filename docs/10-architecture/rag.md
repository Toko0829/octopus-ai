# RAG System

> The complete Retrieval-Augmented Generation spec: ingestion, hybrid retrieval + rerank, contextual enrichment, jurisdiction packs, freshness, evaluation, and risk mitigations. Source of truth for anyone touching knowledge or retrieval. Update on any change to ingestion, retrieval, models, or eval gates.
>
> **Implemented in `services/ai` (Python), not `packages/rag`.** [ADR-0006](../40-adr/0006-python-ai-service-node-backend.md) moved the AI layer to Python after this doc was written; the `packages/rag` path referenced in older text does not exist.
>
> **Implementation status (Phase 1).** Live: the schema (`20260728210000_rag_schema.sql`), hybrid retrieval with RRF fusion in SQL (`public.hybrid_search`), Cohere rerank with a calibrated drop-threshold, structure-first chunking, batched embedding, and content-hash supersession. A four-document internally-authored seed corpus covers paid acquisition, advertising disclosure, lifecycle email and early-stage SEO for US.
>
> **Steps 1 to 3 are now live, and step 4 is why the corpus is smaller than the registry.** A checked-in source registry, a guarded fetcher, content-hash change detection and a scheduled re-crawl sweep all exist; the corpus holds four externally-sourced, dated, openable documents alongside the ten internally-authored ones. The scheduling is **not** `pg_cron` as specified below: pg_cron runs SQL, SQL cannot make an outbound HTTP request, so it could only ever have signalled something that could. That something is the ticker `apps/api` already runs for the DAG ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)), and the sweep rides its pass. See [rag-knowledge.md](../30-modules/rag-knowledge.md) for the registry, what each page produced, and the two source families that remain uncovered.
>
> **Not built yet, in this doc's order:** layout-aware parsing and OCR (ingestion step 4), **LLM-generated contextual prefixes** (ingestion step 7 uses a metadata-derived prefix instead), structured supplier/cost-benchmark rows (ingestion step 10), and the remaining query transformations (self-query, multi-query/HyDE, routing). **Decomposition, deterministic vocabulary normalisation and the groundedness gate are live.** Of the evaluation section, the **retrieval** gate is live and runs in CI; the Ragas/DeepEval **generation** metrics are not, and `eval_golden_set` remains an empty table (the golden set is a file). Treat the rest of this document as specification, not description.
>
> Step 4 is the one whose absence is now load-bearing rather than merely outstanding. `htmlToText` is a hand-rolled tag stripper, so it returns a page's navigation along with its prose, and on a page that is _only_ navigation it returns navigation and nothing else. Three of the first nine registered sources were dropped for exactly that, and a fourth was dropped later on retrieval quality rather than on parsing. A registry entry is therefore verified by reading what it stored, not by its status code.

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
2. **Crawl** — one guarded fetcher in `apps/api`, driven by the ticker's sweep rather than by `pg_cron`, over a checked-in registry of sources. Outbound HTTP stays in Node so `services/ai` keeps reaching Postgres and providers and nothing else.
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

Heavy ingestion runs as background jobs (the `apps/api` ticker today, pg-boss when a job is genuinely a job), **never in the request path**.

## Retrieval (hybrid + rerank)

1. **Query transformation** (pre-retrieval LLM step):
   - _Self-query_ → extract hard filters (`jurisdiction=US/TX/Austin`, `business_type=food_service`, `effective_date>=now`) → SQL `WHERE` **and** HNSW pre-filters (the single biggest correctness lever).
   - _Multi-query + HyDE_ → cover vocabulary gaps between casual phrasing and statutory language.
   - _Decomposition_ → split compound asks ("permits + suppliers + hiring") into sub-retrievals.
   - _Routing_ → send each sub-query to the right corpus (permits vs suppliers vs cost benchmarks).

2. **Vocabulary normalisation (live, and deterministic rather than an LLM step).** `vocabulary.normalise_query` rewrites the metric words a founder uses into the ones the corpus is written in, on the goal and on every sub-query, at the top of `Retriever.retrieve`. Measured cause: "marketing plan to get **registrations**" returned nothing above threshold while the same request saying "**signups**" returned a full plan, because at the local reranker's 1.76x margin a synonym the corpus lacks is the whole distance.

   Three properties are load-bearing. It **replaces** terms and never adds them, because query length is measured-fatal at a cross-encoder ([ADR-0009](../40-adr/0009-local-reranker.md), and `MAX_REFINED_GOAL_WORDS = 7`), so this is not the "multi-query" expansion listed above. It is a **small curated domain table**, not a dictionary or a second embedding space: dense retrieval is already the semantic synonym layer and is not the stage that fails, and a general dictionary would pull business-formation vocabulary ("company registration", "vehicle registration") into marketing queries, which is the direction the golden negatives defend. And the **corpus is the primary fix**, with the table covering only what prose cannot carry naturally. Full reasoning in the module docstring; coverage and negatives in [rag-knowledge.md](../30-modules/rag-knowledge.md).

3. **Dense** — `halfvec` HNSW cosine over pre-filtered chunks (OpenAI embeddings, 1024 dims).
4. **Sparse** — Postgres FTS (`websearch_to_tsquery`, GIN), per-language configs. Catches exact tokens (statute numbers, license codes, form IDs) that dense blurs. Upgrade path: ParadeDB `pg_search` for true BM25.
5. **Fusion** — **RRF (k=60)** merging dense + sparse in one SQL query (two CTEs + fused rank). Rank-based → no score normalization.
6. **Rerank** — in-process **`bge-reranker-v2-m3`** cross-encoder over the fused **top-25** → return **top 6–8** ([ADR-0009](../40-adr/0009-local-reranker.md), which amends ADR-0007's rerank pin; Cohere `rerank-v3.5` is retained as a fallback). Apply a relevance-score **threshold to DROP** weak chunks rather than pad context. Optional MMR dedup before rerank when sources are redundant.

   Two properties of this step are measured rather than assumed, and both are easy to get wrong. **Candidate depth is tied to corpus size**, not fixed at 40: when ADR-0009 measured it against a 43-chunk corpus, RRF already placed the expected document at rank 1-3, so depth beyond ~25 bought nothing and cost linear cross-encoder time. The corpus has since roughly doubled, so this is due a re-measurement rather than an assumption. And **the threshold is per provider**, because the two score distributions are not comparable: 0.05 for Cohere, 0.0013 for bge. Applying one to the other measured recall 0.45.

   **The threshold is not a scope gate**, and cannot be made into one. It ranks chunks within the corpus; it does not decide whether the corpus covers the question. An in-vocabulary but uncovered question ("how do I run a webinar funnel") therefore clears it on **both** providers. See the measured bands in [rag-knowledge.md](../30-modules/rag-knowledge.md). That question is answered by step 7 instead.

7. **Groundedness gate** — one cheap-tier model call asking whether the surviving sources actually **answer** the goal, rather than how well they rank. Fails closed, judges the same sources block the planner receives, and runs before generation. This is the check the "Guarded generation" section below has always specified; until it existed, the drop-threshold was standing in for it and could not do the job. Spec and measurement in [rag-knowledge.md](../30-modules/rag-knowledge.md).

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

- **Re-crawls run on the `apps/api` ticker, not `pg_cron`.** Each `knowledge_sources` row carries a `crawl_cadence`, and a sweep inside the ticker's pass re-reads whatever is past it. The original `pg_cron` design could not have worked as written: pg_cron executes SQL and SQL cannot fetch a URL, so the schedule and the fetcher have to live where outbound HTTP is allowed, which is Node ([ADR-0010](../40-adr/0010-postgres-durable-runner.md) put the scheduler there for the DAG already).
- **Two hashes, two questions.** `knowledge_sources.content_hash` is a hash of the fetched page text and answers "did the page change", cheaply, before any embedding is paid for. `documents.content_hash` folds in the chunker version and the embedding model and answers "would we index this differently now". Keeping both is what makes an unchanged page nearly free while still re-embedding when our own pipeline moves. Known gap, recorded rather than discovered later: a page that is unchanged while the _embedder_ changes is skipped by the first hash and never reaches the second, and the remedy is to null out `knowledge_sources.content_hash` and let every source look new.
- **`last_crawled` is the last ATTEMPT, not the last success.** A page that is blocked or gone is retried on its cadence rather than on every pass, because a 404 retried every thirty seconds is a small denial of service aimed at somebody who has done nothing wrong.
- Content-hash **supersession**; `valid_from`/`valid_to` effective-dating so retrieval filters to **in-force** rules.
- Surface **"last verified"** dates to the user; route **high-stakes stale data** to a human node for re-verification. A crawled document's `effective_date` is **the day we read the page**, which is the only date we can vouch for: it is not the publisher's own revision date, which is usually absent from the HTML and which we will not infer.
- **The crawler identifies itself and asks for English.** Both are ordinary politeness with a measured consequence. Asking for English is not cosmetic: the first run stored a Meta page as a menu in Georgian, because a large site picks a language from the requesting IP when nothing says otherwise, and the row would still have claimed `lang: english` and built its sparse index with the English configuration on top of it.

## Guarded generation

- **Mandatory citations** on legal/tax/permit output, each with an **effective date**.
- **Groundedness gate (live):** claims not supported by retrieved, in-date sources are flagged `unverified` and **cannot gate a legal action** — they escalate to a human node. Note the parenthetical this line used to carry, "or below similarity threshold", was wrong as a definition of the gate rather than merely incomplete: a similarity threshold ranks within the corpus and cannot tell you the corpus does not cover the question. That conflation is what let an in-vocabulary uncovered question through. Retrieval step 7 is the real check.
- **Injection quarantine:** all retrieved content is untrusted **data**, never instructions.
- **Multi-tenant isolation:** retrieval respects RLS; no cross-tenant leakage.

## Evaluation & observability

- **Offline:** Ragas on a golden set — context precision/recall, faithfulness, answer relevancy — to tune chunking/embeddings.
- **CI gate:** DeepEval blocks regressions against the golden set. **Thresholds:** faithfulness ≥ 0.75, answer relevancy ≥ 0.8, context precision ≥ 0.7, context recall ≥ 0.8. Changes to ingestion/retrieval/prompts must pass before merge.
- **Production:** Langfuse traces every retrieval+generation; online scoring + thumbs-up/down captured from the group chat; single trace sink Ragas and DeepEval publish to.

## Where RAG runs (Python service)

RAG — ingestion **and** query-time retrieval — is implemented in the **Python AI service** (`services/ai`, LlamaIndex-Python), not in TypeScript ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)). The Node durable backbone calls the service's typed endpoints (e.g. `/retrieve`, `/plan`); ingestion + eval run as Python jobs. Both sides share the same Supabase Postgres (pgvector), so retrieval is still just SQL over the one source of truth. Eval gates (Ragas/DeepEval) are Python-native and run in CI.

## Risk register

| Risk                                    | Mitigation                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Hallucination on legal/financial claims | Groundedness gate + mandatory citations + escalate-on-unverified                                              |
| Stale regulations/fees                  | cadence re-crawl on the ticker, content-hash supersession, effective-dating, "last verified", human re-verify |
| Jurisdiction bleed                      | Unambiguous pack keys, hard filters via self-query, never generalize across borders                           |
| OCR/parse errors                        | Layout-aware parsing, validation step, parse-failure alerting                                                 |
| Multilingual gaps                       | One strong multilingual embedder; per-language `tsvector` configs                                             |
| Prompt injection via sources            | Quarantine retrieved content as data; separate instruction channel                                            |
| Tenant leakage                          | RLS on `doc_chunks`; retrieval scoped by policy                                                               |

## Libraries

`pgvector` · Supabase (Edge Functions, Storage, Realtime) · LlamaIndex (TS + Python) · LlamaParse/Unstructured/Docling · OpenAI SDK (embeddings, contextualization, query transform, grounded generation) · Cohere SDK (rerank) · Ragas · DeepEval · Langfuse · tiktoken. Optional in-Postgres upgrades: ParadeDB `pg_search`, `pgvectorscale`.
