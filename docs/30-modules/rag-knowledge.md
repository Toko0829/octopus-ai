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
> **Not built yet:** crawlers and the freshness pipeline (`pg_cron` re-crawl, content-hash re-check against live sources), LLM-generated contextual prefixes (a metadata-derived prefix is used instead), the remaining query transformations (self-query, HyDE), and the Ragas/DeepEval gate. **Query decomposition is built** and is the production path. `eval_golden_set` exists as a table but is empty.

## In-Postgres pgvector (rationale)

Vectors live in the same Postgres as everything else — relational, RLS-permissioned, transactionally consistent, one system to run. See [ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md). Schema: `documents` + `doc_chunks` (`halfvec(1024)` HNSW cosine + generated `tsvector`), plus typed `suppliers` / `cost_benchmarks` rows.

## Ingestion pipeline

`registry → crawl → change-detect → parse → normalize → chunk → contextualize → embed → index → structured-load → validate → observe`. Heavy work runs as background jobs (pg-boss / Trigger.dev), never in the request path. Details + the 12 steps in [rag.md](../10-architecture/rag.md).

## Retrieval

**Query decomposition (live)** → dense (local BAAI `bge-m3`, or OpenAI `text-embedding-3-large`, 1024 dims either way — [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)) + sparse (`tsvector`/BM25) → **RRF (k=60)** → in-process **`bge-reranker-v2-m3`** cross-encoder ([ADR-0009](../40-adr/0009-local-reranker.md)) over **top-25** → top 6–8, with a relevance threshold that **drops** weak chunks. Candidate depth is measured against corpus size rather than fixed; see ADR-0009.

> **Decomposition splits a goal into per-stage sub-queries, each reranked on its own.** A broad goal ("get me my first 100 customers") otherwise retrieves whichever funnel stage matches best, and the planner correctly leaves the rest empty rather than inventing steps. Measured on the golden set: coverage of a broad goal went **0.33 → 1.00**.
>
> The cheaper design was tried first and **measured as worthless**: searching every sub-query but running one rerank against the original goal changed nothing, because candidate breadth was never the bottleneck (40 candidates against a ~43-chunk corpus). The bottleneck is the rerank, where a vague goal scores uniformly low (0.066, against 0.474 for a focused query). So it costs one rerank per sub-query. That was a hard constraint while rerank was a metered API call; since [ADR-0009](../40-adr/0009-local-reranker.md) moved it in-process the cost is CPU rather than quota, and the count is bounded by judging breadth from the goal's wording (87 calls per eval run became 49).
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

> **Known defect: the score threshold is not a scope gate, and cannot become one.** Measured, not suspected. A rerank score answers "which chunk ranks best for this query", which always has an answer when the query is marketing and the whole corpus is marketing. It does not answer "does the corpus cover this". So an **in-vocabulary but uncovered** question retrieves loosely-related chunks and clears the threshold, and the agent returns a confident cited plan for something no source supports, which is exactly what rule 10 forbids.
>
> | Query                                    |  local bge |    Cohere |
> | ---------------------------------------- | ---------: | --------: |
> | NEG "webinar funnel that converts"       |     0.0067 | **0.318** |
> | NEG "conversion tracking in GA4"         | **0.0211** |     0.281 |
> | NEG "rank higher in the app store"       |     0.0053 |     0.082 |
> | POS "launch my app, first 100 customers" |     0.0018 |     0.066 |
> | _threshold_                              |   _0.0013_ |    _0.05_ |
>
> **The bands overlap on both providers**, so no threshold separates them: the strongest uncovered question outscores the weakest legitimate goal by 12x locally and 4.8x on Cohere. Raising the threshold kills the README's own north-star example first. This is **not** a regression from [ADR-0009](../40-adr/0009-local-reranker.md); Cohere behaves the same way and is worse in relative terms. It went unnoticed because all four golden negatives are business-formation topics, far from the corpus in vocabulary as well as subject (the liquor-licence case scores exactly 0.000000 on Cohere).
>
> The fix is a real groundedness check between retrieval and generation, asking whether the retrieved sources actually answer the question, rather than how well they rank. One cheap-tier call per goal, the tier decomposition already uses. **Not built.** Deferred deliberately while Phase 1 is read-only with no users and no side effects; it must land before the agent can act on a plan.

**Not built (generation).** Ragas/DeepEval faithfulness and answer relevancy (≥ 0.75 and ≥ 0.8, with context precision ≥ 0.7 and context recall ≥ 0.8) need an LLM judge, which costs money per run and returns a different number each time. Those belong in a separate credentialed pass, not in the deterministic gate above.

**There is no rerank quota any more.** Reranking is in-process ([ADR-0009](../40-adr/0009-local-reranker.md)), so an eval run costs CPU rather than provider calls. What was previously the dominant constraint — a trial key's 10 calls a minute against ~81 calls per run — is gone. OpenAI is still needed for decomposition and generation.

- **CI:** wired as its own job, but **it cannot gate until repository secrets exist**, since retrieval needs the Supabase corpus. Until then it emits a warning saying it measured nothing, rather than reporting a green check that proves nothing.
- **CI scope:** the job runs only when `services/ai/**` or the workflow changes. A docs-only pull request cannot regress retrieval, and running the gate anyway once spent ~81 rerank calls to prove nothing and then failed on the quota it had just consumed. A skipped run says so in the job summary.
- **CI runs the production reranker**, which is the whole point of a gate. It is now minutes of real CPU on a small runner rather than minutes of waiting on a rate limiter. Its cache key names **both** models, so changing either invalidates it instead of silently scoring with the previous one.

> **The eval is not deterministic, and two of its four numbers move between identical runs.** Decomposition calls an LLM, so the sub-queries differ each time and both the survivor ordering and which of several expected documents surface move with them. Observed across five runs of the same commit:
>
> | Metric   | Range           | Stable? |
> | -------- | --------------- | ------- |
> | recall   | 1.00            | yes     |
> | leaks    | 0               | yes     |
> | coverage | **0.97 – 1.00** | **no**  |
> | MRR      | **0.83 – 0.95** | **no**  |
>
> Only **recall** and **leaks** are gate thresholds, and both held in every run. A coverage dip of 0.03 is one expected document out of roughly fifteen and is within this noise, not a regression: judge it across several runs or against a deliberately changed variable, never on a single run. The honest reading is that the golden set is small enough at 15 cases that its two derived metrics are indicative rather than precise, which is an argument for growing the set.

**What the pipeline fixes were worth**, measured with the reranker held constant so the change is attributable to the pipeline alone:

| Pipeline            | Rerank calls | Recall | Coverage |  MRR | Leaks |
| ------------------- | -----------: | -----: | -------: | ---: | ----: |
| Before              |       **87** |   1.00 |     1.00 | 0.86 |     0 |
| Decomposition fixed |       **49** |   1.00 |     1.00 | 0.86 |     0 |
| + 25 candidates     |       **49** |   1.00 |     0.97 | 0.95 |     0 |

**Reranker candidates, measured on this golden set.** "Recall @ zero leaks" is the best recall any threshold can reach while still refusing every negative, which is what the gate actually requires. The first two rows are on the **fixed** pipeline; the rest were measured on the old one and are kept so they are not re-litigated:

| Model                                | Params | Recall @ zero leaks | Note                                         |
| ------------------------------------ | -----: | ------------------: | -------------------------------------------- |
| **`BAAI/bge-reranker-v2-m3`** (live) |   568M |            **1.00** | coverage 1.00, MRR 0.91, ~71s/goal @12 cores |
| Cohere `rerank-v3.5` (fallback)      |      — |            **1.00** | coverage 0.97, MRR 0.95                      |
| `cross-encoder/ms-marco-MiniLM-L6`   |    23M |                1.00 | 22x faster, but **English-only**             |
| `cross-encoder/mmarco-mMiniLMv2-L12` |   118M |                0.73 | below the 0.80 floor                         |
| `jina-reranker-v2-base-multilingual` |   278M |             not run | **CC-BY-NC**, non-commercial                 |

Three findings worth keeping, because each contradicts an intuitive reading:

- **Parameter count did not predict quality.** The 23M English model separated the bands perfectly while the 118M multilingual one could not reach the floor at all.
- **A smoke test on hand-written queries inverted the ranking.** Ten author-phrased queries gave every model 6/6 top-1 and made the 118M model look like the winner, until the golden set, whose queries are phrased as a founder would ask, put it at 0.73. Calibrate on the set, never on phrasings it does not contain.
- **The model was blamed before the pipeline was checked.** bge measured 0.82 recall and 265s per goal and was written off as undeployable. The same model on the fixed pipeline reaches 1.00 at 71s. Four defects, all ours: decomposition always emitting the maximum, 20-30 word sub-queries against a cross-encoder trained on six, a sub-query generated every time for a stage with no documents, and 40 candidates reranked against a 43-chunk corpus where **RRF already places the answer at rank 1-3**.

- **Production:** Langfuse tracing + online scoring + citation-coverage checks + thumbs-up/down from chat.

## Multilingual handling

One strong multilingual embedder (OpenAI `text-embedding-3-large`) across the corpus; per-language `tsvector` configs for sparse. Retrieval quality for the later Georgian/Russian pack must be **measured at the eval gate**, not assumed ([ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)). EU languages now; Georgian/Russian for the founding pack.

## Implementation (Python service)

This module is implemented in the **Python AI service** (`services/ai`, LlamaIndex-Python) — ingestion, retrieval, and eval — exposed to the Node agent over a typed HTTP seam ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)). It shares the same Supabase Postgres (pgvector), so retrieval stays SQL over the single source of truth.

## Key entities

`knowledge_sources` · `documents` (jurisdiction/market, business_type, doc_type, effective/valid dates, content_hash, version, lang) · `doc_chunks` (embedding `halfvec(1024)`, `fts tsvector`, context_prefix, parent_id, embed_model) · **`campaign_outcomes` · `creative_performance` (flywheel)** · `suppliers` · `cost_benchmarks` · `eval_golden_set`.

## Risk mitigations

Hallucination (groundedness gate + citations) · staleness (freshness pipeline) · jurisdiction bleed (hard filters, unambiguous keys) · OCR errors (layout-aware parsing + validation) · injection (quarantine) · tenant leakage (RLS on chunks). Full register in [rag.md](../10-architecture/rag.md).
