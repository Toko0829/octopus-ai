# Glossary

> Shared vocabulary for Octopus. Keep terms here consistent with how they are used across the docs and code. Add a term when it first appears in a module doc.

## Domain

- **Node / Human node** — a vetted human worker who executes legally- or physically-reserved tasks (notary, licensed accountant/lawyer, real-estate agent, contractor, inspector prep, banking liaison). Nodes are KYC'd, skill-tagged, matched, and paid via escrow. The "tentacles" of the octopus.
- **Verified Pro** — a node with a _verified professional license_ (lawyer/accountant/notary), eligible for regulated tasks. License is a **hard filter**, not a ranking weight.
- **Playbook** — a composable venture template = **Business Archetype × Jurisdiction Pack**, compiled into a task DAG. See [rag-knowledge.md](../30-modules/rag-knowledge.md).
- **Business archetype** — a node in the business-type taxonomy (e.g. `food-service > cafe`) carrying type-specific requirements as reusable capability modules.
- **Jurisdiction pack** — a versioned, dated, cited knowledge bundle keyed by `country → region → city` (e.g. `US > TX > Austin`, `EU > DE`) that maps abstract requirements to concrete local agencies, fees, thresholds, documents, and languages.
- **Escalation** — the router handing a task to a human node (or the user) because of a legal restriction, physical-world requirement, high-risk/irreversible action, low AI confidence, tacit-knowledge gap, missing user-only fact, policy flag, or SLA breach.
- **Escrow** — task funds captured from the user's authorized budget and **held on-platform** (Stripe separate charges & transfers), released to the node only on verified completion.
- **Take-rate** — the platform's commission on a node payout (~15–25%).

## Marketing & flywheel (first vertical)

- **Wedge / beachhead** — the single vertical Octopus ships first (full-funnel digital marketing for creators) to get real users and start the flywheel, before expanding toward the north star.
- **North star** — the long-term vision (Octopus runs _entire_ businesses); a direction, not the first ship.
- **ICP** — Ideal Customer Profile; the first ICP is **solo founders / creators**.
- **Full-funnel** — coordinating the whole marketing funnel (strategy → content → creative → channels → conversion → measurement), not one channel.
- **Channel** — a marketing surface (paid ads, organic social, SEO, email); connected via scoped OAuth (`channel_connections`).
- **Creative** — generated assets (image/video/audio/copy) for campaigns.
- **ROAS / CPA / CTR** — return on ad spend / cost per acquisition / click-through rate; the measurable outcomes that feed the flywheel.
- **Auto-optimize loop** — pulling live metrics and adjusting campaigns (pause/scale/reallocate) within guardrails.
- **Learning flywheel** — the compounding data loop that improves Octopus from real usage: ingest outcomes → human corrections as labeled data → auto-optimize → fine-tune later. The moat. See [[../10-architecture/learning-flywheel]].
- **Correction rate** — how often a human node must fix the AI's work; a key flywheel metric that should trend **down** over time.

## Agent / orchestration

- **Orchestrator / supervisor** — the reasoning core that plans the task DAG and is the **single writer** to it. Ephemeral read-only sub-agents are used as tools.
- **Durable execution backbone** — the layer (Trigger.dev v3) that makes runs survive crashes/deploys and sleep for days on waitpoints.
- **Waitpoint** — a durable suspension point (`wait.forToken()`) where the agent run pauses (at zero compute) awaiting a human node's verified completion, then resumes deterministically.
- **Task DAG** — the directed acyclic graph of typed tasks for a project, with hard/soft/resource dependencies.
- **Replan-by-diff** — reconciling the DAG after each task by applying add/cancel/modify **diffs**, never regenerating from scratch (preserves completed work + audit history).
- **Maker-checker** — a critic pass (AI, then user for higher-risk) that validates an artifact/proof against its `acceptance_criteria` before it counts as done.
- **Tool risk tier** — every tool is tagged `read-only | reversible | external | high-risk/irreversible`; read-only auto-runs, irreversible always needs approval.

## Platform / infra

- **BFF** — backend-for-frontend; here the _thin_ Next.js layer that proxies mutations to Fastify and never runs long work.
- **RLS** — Postgres Row-Level Security; the real authorization backstop (membership-based access, tenant isolation).
- **`service_role`** — the Supabase key that bypasses RLS; **server-only**, never reaches the client; a leak breaks all security.
- **Broadcast-from-Postgres** — the chat transport: a Postgres trigger broadcasts new message rows to a Realtime topic (chosen over Postgres Changes; see [ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)).
- **Presence** — Supabase Realtime feature powering online/idle/dnd, typing, and activity states.

## RAG

- **Chunk** — a retrievable unit of a document; embedded as a _contextualized_ chunk (chunk text + generated situating context).
- **`halfvec`** — pgvector float16 vector type; halves storage/memory with negligible recall loss.
- **HNSW** — the pgvector approximate-nearest-neighbor index (Hierarchical Navigable Small World).
- **RRF** — Reciprocal Rank Fusion (k=60); rank-based merge of dense + sparse result lists in one SQL query.
- **Reranker** — a cross-encoder (Cohere Rerank 3.5) that re-scores fused candidates jointly with the query; where RAG precision is won.
- **Contextual retrieval** — Anthropic-style technique of prepending an LLM-generated situating blurb to each chunk before embedding/indexing.
- **Effective-dating** — `valid_from`/`valid_to` on knowledge so retrieval filters to currently-in-force rules and can show "last verified."
- **Groundedness gate** — the check that a regulated claim is supported by retrieved, in-date, cited sources; failing it → `unverified` → escalate.

## Design

- **"Ink & Bioluminescence"** — the house style. Primary aesthetic is **editorial / calm minimal**; the ink neutral ramp + a single bioluminescent teal signal accent + coral for human/CTA.
- **Command Deck** — the dark, dense power-user work surface (Linear/Superhuman energy) used for boards, ledgers, run logs.
- **Chromatophore theming** — adaptive skins (Light Editorial / Dark Command Deck / Warm chat) + per-business accent, named after the octopus's color-changing cells.
- **Action embed** — an interactive, permission-gated card in chat (Approve / Pay / Sign / Assign / Accept).
- **AI slop** — the generic AI-generated look Octopus explicitly avoids (purple gradients, sparkles, default shadcn+Inter+zinc, glassmorphism-everywhere). See [ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md).
