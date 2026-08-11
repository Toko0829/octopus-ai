# ADR-0008 — Local BGE-M3 embeddings, selectable per environment

- **Status:** Accepted
- **Date:** Phase 1
- **Context docs:** [rag.md](../10-architecture/rag.md), [rag-knowledge.md](../30-modules/rag-knowledge.md), [tech-stack.md](../10-architecture/tech-stack.md), [integrations.md](../30-modules/integrations.md), [learning-flywheel.md](../10-architecture/learning-flywheel.md)
- **Amends:** [ADR-0007](0007-openai-generation-embeddings-cohere-rerank.md) — its embedding pin only. Generation stays OpenAI and rerank stays Cohere, both unchanged.

## Context

[ADR-0007](0007-openai-generation-embeddings-cohere-rerank.md) pinned embeddings to OpenAI `text-embedding-3-large` at `dimensions: 1024`, and recorded two things that this decision now acts on:

1. **An open multilingual risk.** It noted `text-embedding-3-large` is weaker than the Voyage model it replaced on lower-resource languages, and that the deferred Georgian/Russian pack's retrieval quality was therefore "an open question to measure, not an assumption."
2. **A closing window.** "Decide before ingesting. Once the corpus is embedded, changing the embedding model means re-embedding all of it."

The corpus is currently four internally-authored seed documents, so that window is still effectively open and the re-embed cost is negligible. It will not stay that way: [learning-flywheel.md](../10-architecture/learning-flywheel.md) has Phase 2 ingesting real customer campaigns and outcomes, at which point re-embedding is expensive **and** the corpus contains customer business data.

That second point is the substantive driver. Embedding through a hosted API means every ingested chunk of a customer's performance data crosses a sub-processor boundary. [docs/80-legal/README.md](../80-legal/README.md) already lists a DPA as a blocking gate for EU launch, and [security-compliance.md](../10-architecture/security-compliance.md) commits to GDPR compliance and to keeping the RAG index free of PII.

## Decision

**Support BAAI/bge-m3 as an in-process embedder, selected by `EMBED_PROVIDER`, defaulting to `openai`.**

- `EMBED_PROVIDER=openai` (default) — unchanged ADR-0007 behaviour.
- `EMBED_PROVIDER=local` — `BAAI/bge-m3` runs inside `services/ai` via FlagEmbedding. No embedding text leaves the process.

Supporting commitments:

- **The schema does not change.** bge-m3's `hidden_size` is **1024**, verified against the published model config rather than recalled. `doc_chunks.embedding halfvec(1024)` and the HNSW cosine index are untouched, exactly as they were under ADR-0007's `dimensions: 1024`.
- **torch is an optional extra** (`local-embed`), not a base dependency, and the local module is imported lazily. CI, and any OpenAI-backed deployment, never installs it.
- **The ingestion content hash now covers the embedding model.** See Consequences; this is the load-bearing part.
- **The two providers are never mixed within one corpus.** One model covers the whole corpus, per [rag.md](../10-architecture/rag.md).

## Rationale

- **It answers a risk ADR-0007 recorded rather than introducing a new one.** bge-m3 is XLM-RoBERTa based and multilingual by construction, which is the exact gap ADR-0007 flagged for the deferred Georgian/Russian pack.
- **The compliance argument stands on its own.** Removing a sub-processor from the path that ingests customer outcome data simplifies the DPA position, the subprocessor disclosure, and the breach-notification chain. This holds whether or not bge-m3 also scores better.
- **Now is the cheapest possible moment.** Four documents. The same change after Phase 2 means re-embedding a live corpus of customer data.
- **Keeping both is nearly free** given [integrations.md](../30-modules/integrations.md) already mandates the adapter pattern, and it is the only way to A/B the two once an eval gate exists.

## Consequences

- **The content hash had to change, and this is the important part.** `content_hash()` previously covered `CHUNKER_VERSION` and the document text. Switching embedder leaves the source bytes identical, so **every document would have been skipped as unchanged**: the corpus would keep OpenAI vectors while new rows claimed bge-m3, and query vectors from one model would be compared against stored vectors from the other inside the same HNSW index. Nothing would error and nothing would be logged; retrieval would simply degrade. The hash now folds in the active embedding model, so a provider switch self-invalidates and forces a full re-ingest. One consequence for existing corpora: adding the model to the hash invalidates them once, on any provider.

- **Model identity and model location are separate settings.** `EMBED_LOCAL_MODEL` is the identity (`BAAI/bge-m3`), written to `doc_chunks.embed_model` and folded into the ingestion hash. `EMBED_LOCAL_PATH` is only where the weights sit on a given host. Collapsing the two, which the first cut of this change did, means a machine-specific cache path becomes a row's recorded provenance, and deploying the identical model from a different directory rewrites every row and forces a full re-embed for no reason. Caught before the first local ingest, so no corpus carries a path.

- **This is not yet measured, and that is a real gap.** [AGENTS.md](../../AGENTS.md) rule 17 requires retrieval changes to clear eval thresholds, and no eval gate exists yet ([roadmap.md](../10-architecture/roadmap.md) records the Phase 1 gate as unmet). The decision is therefore taken on **data-residency and timing** grounds, which are sound independent of retrieval quality, **not** on a measured claim that bge-m3 retrieves better on this corpus. Building the golden set and comparing the two providers on it is outstanding work, and the default stays `openai` until it exists.

- **The deployment footprint grows materially where it is enabled.** FlagEmbedding pulls torch and transformers, taking `services/ai` from a light FastAPI container to a multi-GB ML image needing roughly 2.2 GB of resident weights, on the Fly.io instance [infra-devops.md](../30-modules/infra-devops.md) co-locates with Postgres. Self-hosting trades API spend for infrastructure spend, and at current corpus size the API spend it replaces is close to zero.

- **Query-time embedding moves in-process.** It runs in a worker thread so it cannot stall the event loop, but model load and memory pressure become failure modes this service now owns.

- **`rerank_min_score` must be re-calibrated.** The `0.05` threshold in `config.py` was calibrated against measured Cohere score bands on OpenAI-embedded chunks. Changing what is retrieved changes what is reranked, so the threshold cannot be assumed to carry over.

- **This does not make the system offline.** Rerank still calls Cohere on every query and generation still calls OpenAI. On a pure data-exposure reading rerank is in fact the larger exposure, since it sends the user's live query text plus the top-40 chunks on every search, where embedding sends curated corpus text once per document. `bge-reranker-v2-m3` is the natural follow-on and is **not** a one-way decision, since rerank sits after retrieval.

- **bge-m3's sparse and ColBERT heads are deliberately disabled.** Sparse retrieval already lives in Postgres as a generated `tsvector` fused by RRF inside `hybrid_search`. Enabling m3's own sparse output would mean two competing sparse implementations, which is a separate retrieval-design decision.

## Alternatives considered

- **Stay on OpenAI.** Zero work and a measured baseline, but leaves a sub-processor on the customer-data ingestion path and lets the cheap-switch window close.
- **Replace OpenAI outright rather than making it selectable.** Simpler, but forfeits the baseline needed to evaluate the change and makes reverting another full re-embed.
- **Self-host the reranker first.** Lower risk, reversible, and arguably the larger exposure. Deferred, not rejected; recorded above as the natural follow-on.
- **Fully local, including generation.** Would make the system genuinely offline, but requires hosting a generation model and grounded citation quality is the hardest thing to match locally. Out of scope here.
