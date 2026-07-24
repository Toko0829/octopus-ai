# ADR-0002 — Stay in Postgres with pgvector (no dedicated vector DB)

- **Status:** Accepted
- **Date:** Phase 0
- **Context doc:** [rag.md](../10-architecture/rag.md), [rag-knowledge.md](../30-modules/rag-knowledge.md)

## Context

RAG needs vector search over a legal/permit/supplier corpus that is fundamentally **relational and permissioned** (chunks join to jurisdictions, playbooks, suppliers, cost benchmarks, and tenant scoping via RLS).

## Decision

Keep vectors in **Supabase Postgres via `pgvector` 0.8.x**: `documents` + `doc_chunks` with `embedding halfvec(1024)`, HNSW (`vector_cosine_ops`, `m=16`, `ef_construction=200`), iterative index scans, plus a generated `tsvector` + GIN for sparse. Hybrid retrieval (dense + sparse) fused with RRF, then Cohere rerank.

## Rationale

1. **Relational + permissioned** — RLS multi-tenant isolation for free; chunks join to structured rows.
2. **Transactional consistency** — a document and its chunks commit/roll back atomically; no dual-write drift.
3. **One system** to operate, back up, secure — no separate store + ETL.
4. **Fast enough** far beyond our scale: `halfvec` (float16) halves storage with negligible recall loss and builds faster; parallel HNSW builds + iterative scans keep filtered queries (the norm here) accurate.

## Alternatives considered

- **Dedicated vector DB (Pinecone/Qdrant/Weaviate)** — loses transactional consistency and RLS-for-free; only earns its keep past tens of millions of chunks or sustained high QPS.

## Consequences

- Simpler ops, stronger consistency, and permissioned retrieval by default.
- Upgrade-in-place path stays in Postgres first: **ParadeDB `pg_search`** (BM25) and **`pgvectorscale`** (StreamingDiskANN). Reassess a dedicated store (Qdrant first) only if scale forces it — trigger recorded in [infra-devops.md](../30-modules/infra-devops.md).
