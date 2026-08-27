# ADR-0009 — Local cross-encoder reranking, and the pipeline fixes that made it possible

- **Status:** Accepted
- **Date:** Phase 1
- **Context docs:** [rag.md](../10-architecture/rag.md), [rag-knowledge.md](../30-modules/rag-knowledge.md), [ai-orchestrator.md](../30-modules/ai-orchestrator.md), [infra-devops.md](../30-modules/infra-devops.md)
- **Amends:** [ADR-0007](0007-openai-generation-embeddings-cohere-rerank.md) — its **rerank pin only**. Generation stays OpenAI. Embeddings remain as [ADR-0008](0008-local-bge-m3-embeddings.md) left them.

## Context

The Cohere key is a **trial** key capped at **10 rerank calls per minute**, with no budget to upgrade it. Query decomposition made that cap bite: one goal cost one rerank for the goal plus one per sub-query, so a developer got roughly 1.5 goals a minute and CI went red twice.

The obvious move was [ADR-0008](0008-local-bge-m3-embeddings.md)'s: run the model in-process. Measured first, that looked hopeless. `bge-reranker-v2-m3` took **30s per rerank of 40 candidates**, so a seven-sub-query goal cost **265s** against a 90s budget, and **768s on the single vCPU** a container gets. The conclusion drafted at that point was "development only, never deployable."

**That conclusion was wrong, and it was wrong because it measured a broken pipeline.** Asked why two widely-used standard models should be unusable, the pipeline was examined instead of the models. Four defects, all ours:

1. **Decomposition always emitted the maximum.** The prompt said "At most 5 queries. Fewer is fine when the goal is narrow." The model ignored it on **all 15 golden cases**, including out-of-scope negatives. A narrow question cost six reranks where one would do.
2. **Sub-queries were 20 to 30 words long.** A cross-encoder concatenates (query, passage) into one sequence and is trained on short queries; MS MARCO averages about six words. Long queries eat the budget and dilute the signal, which is a quality defect as much as a cost one.
3. **Every goal generated a `measurement` sub-query**, for a stage the corpus has no document for. A rerank call spent searching for something already known to be absent.
4. **40 candidates against a 43-chunk corpus.** 93% of everything went to the cross-encoder on every query. Measured: **RRF already places the expected document at rank 1-3 before any reranking.** The depth bought nothing and cost linear cross-encoder time.

## Decision

**Rerank in-process with `BAAI/bge-reranker-v2-m3` by default, and fix the pipeline that made it look impossible.**

- `RERANK_PROVIDER=local` (default) — `bge-reranker-v2-m3` inside `services/ai`. No new dependency; the `local-embed` extra is already installed for the embedder, and the model loads through `transformers` directly.
- `RERANK_PROVIDER=cohere` — retained as a working fallback. The adapter costs nothing to keep, and it is the reference the local path is measured against.
- `COHERE_API_KEY` becomes **required only when Cohere is selected**, so a fully-local deployment is not blocked on a credential it never uses.
- Decomposition asks for a **per-stage `relevant` boolean** and short queries, and stages the corpus does not cover are filtered **in code**.
- `retrieval_candidates` drops 40 → **25**, as a measured setting tied to corpus size.
- The **CI eval gate runs the local reranker**, because the gate must run what production runs.

## Rationale

### What the pipeline fixes bought

Measured on the golden set with Cohere held constant, so the change is attributable to the pipeline alone:

| Pipeline            | Rerank calls | Recall | Coverage |  MRR | Leaks |
| ------------------- | -----------: | -----: | -------: | ---: | ----: |
| Before              |       **87** |   1.00 |     1.00 | 0.86 |     0 |
| Decomposition fixed |       **49** |   1.00 |     1.00 | 0.86 |     0 |
| + 25 candidates     |       **49** |   1.00 |     0.97 | 0.95 |     0 |

**44% fewer rerank calls at identical gate outcomes.** Sub-query length fell from 20-30 words to a **7.1-word mean**.

One correction along the way is worth recording, because it was caught by measurement and not by review: the first rewrite over-tightened, telling the model "most goals need one or two stages". That took `broad-first-customers` — the README's own north-star example — from coverage 1.00 to 0.33. Breadth has to be judged from the goal's wording (a specific problem versus a bare outcome), not asserted as a global prior.

### The reranker comparison, on the fixed pipeline

| Reranker               | Recall | Coverage |  MRR | Leaks |
| ---------------------- | -----: | -------: | ---: | ----: |
| Cohere `rerank-v3.5`   |   1.00 |     0.97 | 0.95 |     0 |
| **bge-reranker-v2-m3** |   1.00 | **1.00** | 0.91 |     0 |

Local is no longer the compromise it was. It matches on recall, is ahead on coverage, behind on MRR, and leaks nothing.

Earlier candidates, measured and rejected on the **old** pipeline, kept so they are not re-litigated: `ms-marco-MiniLM-L6` (23M) scored recall 1.00 and was 22× faster but is **English-only**, which contradicts [rag.md](../10-architecture/rag.md)'s multilingual commitment; `mmarco-mMiniLMv2-L12` (118M) could not reach the 0.80 floor at all (0.73); `jina-reranker-v2-base-multilingual` is **CC-BY-NC**, non-commercial. `bge-reranker-v2-m3` is apache-2.0, multilingual, and shares a backbone family with the bge-m3 embedder.

### Latency, which is the real cost

Fixed pipeline, 25 candidates, short queries, ~3.3 rerank calls per goal:

| torch threads          | Per rerank | Per goal | Against a 90s step budget |
| ---------------------- | ---------: | -------: | ------------------------- |
| 12 (a 16-core machine) |      21.4s |  **71s** | fits, using 78% of it     |
| 8                      |      27.5s |      91s | over                      |
| 4                      |      33.7s |     111s | over                      |
| 1 (a small container)  |      69.8s |     230s | over                      |

The pipeline fixes took a goal from 265s to 71s, a **3.8× improvement**, but the shape of the curve is unchanged: **a server with fewer cores is slower than the development laptop, not faster.** Only a GPU reverses that, and a GPU costs more than the key it would be avoiding.

This is survivable because **agent runs are already asynchronous**: `POST /agent-runs` returns `202 + runId` and progress arrives over Realtime ([architecture.md](../10-architecture/architecture.md), rule 4). Nothing holds an HTTP request open for the duration. The 90s figure bounds one Node→Python step, not a user's patience, so the deployment question is "how long may a plan take?" rather than "does it fit 90s?". A four-core instance produces a full-funnel plan in roughly two and a half minutes.

## Consequences

- **The narrowest safety margin in the system is now this threshold.** `RERANK_LOCAL_MIN_SCORE` originally sat at 0.0013, between the broadest legitimate goal (0.001772) and the strongest negative (0.001007): a **1.76× margin**, against roughly **9×** on Cohere. A leak is the failure this system least tolerates (rule 10). Consequently the golden set's **negative half is now load-bearing** and must grow with the corpus; adding positives alone leaves this margin undefended. A unit test pins the threshold between its two measured bounds so retuning it requires changing a test that explains why.

  **This consequence came true, and the fix was not the obvious one.** Crawled sources took the corpus from 43 chunks to 110 and the gate failed on the first run: a car-licence negative retrieved Meta's advertising standards at 0.008, on a clause about not requesting driver's license numbers. A lexical collision rather than an adjacency, which matters, because **a larger corpus raises the ceiling on what an off-topic query can score** and nothing about being off-topic keeps its best match low.

  Raising the threshold to 0.013, which sits between that 0.008 and the weakest positive's 0.022, was tried and **reverted**. The bands are 2.75x apart on a signal that moves 3x between identical runs, since decomposition is a model call and different sub-queries score differently; one case measured 0.116 and 0.035 on two runs of the same commit. A threshold needing a 2x margin cannot be set against that, and at 0.013 a full run scored recall 0.75 with four misses. **The margin recorded above is therefore not headroom to spend.** It is the distance between a leak and a random refusal, and the corpus can consume it without the threshold being able to buy it back.

  What fixed it was removing the one document responsible: with Meta's standards gone the same query's top score falls to 0.001 and every other crawled document sits at or below that. The prediction that held exactly is the one about the golden set: it was a negative written months earlier for an unrelated reason, not any of the positives added alongside the new documents, that caught it. See [rag-knowledge.md](../30-modules/rag-knowledge.md).

- **The threshold follows the provider, and that was learned the hard way.** The first wiring left `retrieval.py` applying Cohere's 0.05 to bge's scores, and the golden set came back at **recall 0.45** while the eval banner printed a threshold that was not in use. `active_rerank_min_score` selects by provider and the banner prints the active number.

- **Flipping the default silently redefined "weak" in unrelated tests.** Two `test_retrieval.py` cases that never mentioned a provider began failing, because a 0.01 chunk is below Cohere's threshold and above bge's. They now pin the provider explicitly. Any fixture inheriting a tuning default is measuring the default.

- **`retrieval_candidates = 25` is a corpus-size-dependent setting, not a constant.** It is justified today by RRF placing the answer at rank 1-3 across a 43-chunk corpus. **It must be re-measured as the corpus grows**, since RRF precision falls with scale, and the golden set is where that should be caught. Coverage at 25 measured 0.97 against 1.00 at 40 on Cohere; the golden set is too small at 15 cases to resolve one document confidently, and that is recorded rather than smoothed over.

- **The CI eval job changes character.** It no longer waits on a rate limit; it does real CPU work on a small runner, so it gets slower (roughly 6 minutes on Cohere against tens of minutes locally) while ceasing to consume any quota. Its cache key now names both models, so changing either invalidates it rather than silently scoring with the previous one. It no longer needs a Cohere secret.

- **Deployment now carries ~4.6GB of weights** (bge-m3 plus bge-reranker-v2-m3) and needs the `local-embed` extra. Unlike the embedder, whose default stays `openai` precisely so a plain `uv sync` never needs torch, **the reranker default requires it**. A deployment that skips it fails at the first rerank.

- **FlagEmbedding's `FlagReranker` is unusable on transformers 5.x.** It calls `tokenizer.prepare_for_model`, a v4 API removed in v5 when the slow/fast tokenizer split was collapsed, raising `XLMRobertaTokenizer has no attribute prepare_for_model`. The embedder path is unaffected, so it only appears when reranking is attempted. Worked around by loading through `transformers` directly, avoiding a backwards pin for the whole service.

- **A smoke test on hand-written queries inverted the model ranking.** Ten author-phrased queries gave every candidate 6/6 top-1 and made the 118M model look like the winner, until the golden set put it at 0.73. Calibrate on the set; never on phrasings it does not contain.
