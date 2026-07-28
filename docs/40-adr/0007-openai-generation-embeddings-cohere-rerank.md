# ADR-0007 — OpenAI for generation + embeddings, Cohere retained for rerank

- **Status:** Accepted
- **Date:** Phase 1
- **Context docs:** [tech-stack.md](../10-architecture/tech-stack.md), [rag.md](../10-architecture/rag.md), [rag-knowledge.md](../30-modules/rag-knowledge.md), [integrations.md](../30-modules/integrations.md)
- **Supersedes (in part):** the Voyage/Anthropic provider pins in [tech-stack.md](../10-architecture/tech-stack.md). [ADR-0002](0002-stay-in-postgres-pgvector.md) (pgvector) and [ADR-0006](0006-python-ai-service-node-backend.md) (Python AI service) are unaffected.

## Context

The pinned stack chose **Voyage** `voyage-3-large` for embeddings, **Cohere** `rerank-v3.5` for reranking, and **Anthropic Claude** for generation. The project owner has elected to standardise on the **OpenAI API**.

"Use OpenAI" covers three distinct jobs, and OpenAI covers them unevenly:

| Job        | OpenAI offers it?                                                            |
| ---------- | ---------------------------------------------------------------------------- |
| Generation | Yes, directly.                                                               |
| Embeddings | Yes — `text-embedding-3-*`.                                                  |
| **Rerank** | **No.** There is no reranking endpoint; their cookbook prompts a chat model. |

Two constraints from [rag.md](../10-architecture/rag.md) bound the decision:

1. **One embedding model across the whole corpus.** Different models produce incompatible vector spaces and cannot share an HNSW index. The choice is therefore effectively one-way once ingestion starts.
2. **Rerank is where precision is won** — a cross-encoder rescoring the fused top-40 down to 6–8, with a threshold that _drops_ weak chunks rather than padding context.

The decision is being taken while **the corpus is empty**, so it costs nothing now and would cost a full re-embed later.

## Decision

- **Generation → OpenAI.** Model tiering (strong for planning/critic, fast for executor steps, cheap for classification) is preserved; only the provider changes. Model IDs are resolved from configuration and **verified against the provider**, never hardcoded from memory (AGENTS.md rule 21).
- **Embeddings → OpenAI `text-embedding-3-large`, requested at `dimensions: 1024`.** The model is trained with Matryoshka Representation Learning and accepts a `dimensions` parameter, so it emits 1024-dim vectors directly. **`doc_chunks.embedding halfvec(1024)` and the HNSW index are unchanged.**
- **Rerank → Cohere `rerank-v3.5`, retained.** This is the one stage OpenAI cannot serve. Rerank is billed per search rather than per token, so the marginal cost of keeping one extra provider for it is small relative to the retrieval quality it buys.
- `embed_model` continues to be versioned on every `doc_chunks` row, so a future re-embed stays traceable.

## Rationale

- **No schema change.** The `dimensions` parameter means the `halfvec(1024)` decision in [ADR-0002](0002-stay-in-postgres-pgvector.md) survives intact.
- **Multilingual coverage is adequate for the launch markets.** `text-embedding-3-large` scores ~54.9% on MIRACL (vs ~31.4% for `ada-002`). That is sufficient for **US + EU**, the first markets. It is weaker than Voyage on lower-resource languages, which matters for the deferred Georgian/Russian pack — see Consequences.
- **Not reranking would be the expensive saving.** Dropping the cross-encoder to achieve single-provider purity trades a core quality lever for a second API key. LLM-as-reranker was the alternative and costs more per query, adds latency to every retrieval, and is still not a cross-encoder.
- **Provider swaps are already cheap by design.** [integrations.md](../30-modules/integrations.md) puts every provider behind a typed adapter, so this change lands at the adapter layer rather than through the codebase.

## Alternatives considered

- **OpenAI only, LLM-as-reranker** — one provider and one bill, but a full model call per retrieval: more cost, more latency, lower ceiling than a cross-encoder. Rejected as a false economy.
- **OpenAI only, no rerank** — simplest to build; directly contradicts rag.md's precision strategy. Rejected. (Rerank sits _after_ retrieval, so it can be added later without re-embedding, which is the one thing here that is not one-way.)
- **Self-hosted cross-encoder** (`bge-reranker`) — no per-query cost and no third provider, at the price of model weights, memory and inference time in the `services/ai` container. Reasonable later if rerank spend ever becomes material; premature now.
- **Keeping Voyage/Anthropic** — the prior pin. Rejected per the owner's decision to standardise on OpenAI.

## Consequences

- **Two AI providers remain** (OpenAI + Cohere), not one. Both sit behind adapters; both keys are server-side only and never reach a client.
- **The Georgian/Russian founding pack needs re-validation before it ships.** rag.md calls an English-first embedder "disqualifying", and while `text-embedding-3-large` is genuinely multilingual, it is weaker there than the model it replaces. Treat retrieval quality for that pack as an open question to measure, not an assumption — the eval gate is the place it surfaces.
- **Decide before ingesting.** Once the corpus is embedded, changing the embedding model means re-embedding all of it.
- Env keys become `OPENAI_API_KEY` and `COHERE_API_KEY`; `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` are no longer required.
