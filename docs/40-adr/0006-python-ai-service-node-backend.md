# ADR-0006 — Python AI service + Node/Fastify backend (Python proposes, Node executes)

- **Status:** Accepted
- **Date:** Phase 1
- **Context docs:** [architecture.md](../10-architecture/architecture.md), [rag.md](../10-architecture/rag.md), [ai-orchestrator.md](../30-modules/ai-orchestrator.md), [tech-stack.md](../10-architecture/tech-stack.md)
- **Relates to:** [ADR-0001](0001-durable-orchestration-trigger-vs-temporal.md) (durable orchestration stays TS), [ADR-0004](0004-tsrest-over-trpc.md) (OpenAPI-typed seams)

## Context

The RAG and LLM/agent-reasoning work benefits strongly from Python's ecosystem: LlamaIndex (ingestion + retrieval), layout-aware parsing (Unstructured/Docling/LlamaParse), **Ragas/DeepEval eval gates (Python-only)**, `sentence-transformers`/`FlagEmbedding` for any self-hosted embedder/reranker, and PyTorch/transformers for the Phase-4 fine-tuned flywheel model. The rest of the backend — chat, realtime, auth, projects/tasks, marketplace, payments — is well-served by the pinned **Node/Fastify + Supabase** stack and needs tight Postgres/RLS/Stripe integration.

Question: should the AI/RAG layer be Python while the rest stays Node/Fastify?

## Decision

**Yes — two backend services, one narrow seam.**

- **Python AI service** (`services/ai`, FastAPI + Pydantic) owns:
  - **RAG**: ingestion (parse → chunk → contextualize → embed → index), hybrid retrieval + RRF + rerank, query transformation.
  - **Agent reasoning core**: planning the task DAG, drafting, and **tool selection** (deciding _what_ to do), grounded + cited.
  - **Evaluation**: Ragas / DeepEval gates.
  - **Provider calls**: embeddings (Voyage), rerank (Cohere), generation (Anthropic); and any **self-hosted or fine-tuned models** later.
  - Stateless behind HTTP; ingestion/eval run as **jobs**. Reads/writes the same Supabase Postgres (pgvector, outcomes) via `service_role`, **server-side only**.

- **Node/Fastify + Next** (unchanged) owns:
  - Chat write path, Realtime, auth (JWKS), projects/tasks CRUD, marketplace/matcher, payments/escrow, notifications.
  - The **durable orchestration backbone** (Trigger.dev v3) that drives the Python reasoning core per step and holds the human-in-the-loop **waitpoints**.
  - All **side-effecting tools** — `post_message`, `write_artifact`, `fund_escrow`/`release_escrow`, `request_human_node` — because they must run in the Postgres/RLS/Stripe world with **authz + spend caps enforced in tool code**.

### Division of labor: **Python proposes, Node executes**

The Python core decides _what_ to do (retrieve, plan, draft, choose a tool). Node performs the _side effects_ (write rows, move money, page a human) with guardrails. This directly reinforces our rule "authz/spend live in tool code, not prompts" — a jailbroken prompt in the Python core still cannot move money, because money lives behind Node tool code + Postgres.

### The seam

- **Transport:** OpenAPI-typed HTTP. FastAPI auto-generates OpenAPI → a typed TS client on the Node side (consistent with [ADR-0004](0004-tsrest-over-trpc.md)). Pydantic and Zod both derive from the same OpenAPI contract.
- **Shared state:** the same Supabase Postgres (pgvector, `campaign_outcomes`, docs). The Python service uses `service_role` server-side only; it never reaches a client.
- **Ingestion:** job-driven (queue / pg-boss trigger), never in the request path.
- **Observability:** `projectId` + `agentRunId` propagate across the seam; LLM traces (Langfuse) emitted from the Python side.

### Durable orchestration stays in TS

We keep the durable backbone in **Trigger.dev v3** ([ADR-0001](0001-durable-orchestration-trigger-vs-temporal.md)); it invokes the Python reasoning core per step and owns the multi-day human waitpoints. We do **not** move the durable loop into Python. If the agent loop itself ever needs to be Python-native, the escape hatch is **Temporal's Python SDK** — heavier ops, revisited only if forced.

## Consequences

- **+** All AI in one language + ecosystem; eval gates and (later) trained models are first-class; easy to bring in Python-native AI engineers.
- **+** Money, side effects, RLS, and durability stay in the proven TS/Postgres path — the risky parts don't move.
- **+** Clean, narrow, OpenAPI-typed boundary; the Python service is stateless behind it.
- **−** A second runtime + toolchain (uv, ruff, pytest) and an HTTP hop (latency + a contract to keep in sync). Mitigated: the seam is small and typed; heavy work is async/job-driven, not on the chat request path.
- **Requires:** Python CI (uv, ruff, pytest, Ragas/DeepEval eval gate); a container deploy (Fly.io) co-located with Postgres; shared-Postgres access rules (service_role server-only); `.docmeta.yml` mapping for `services/ai/**`.

## Alternatives considered

- **Retriever in TS, only ingestion/eval in Python** (a narrower boundary) — rejected: it splits RAG itself across two languages and duplicates retrieval logic. One AI home is cleaner.
- **All-TS (managed APIs only)** — fine for a bare MVP, but blocks the Python-only eval gates and any self-hosted/trained model; we'd hit that wall exactly when the corpus + flywheel start to matter.
- **Python-primary including the durable agent loop (Temporal Python)** — heavier operational cost; revisits [ADR-0001](0001-durable-orchestration-trigger-vs-temporal.md); deferred as an escape hatch.
