# CLAUDE.md

This file is the entry point Claude Code auto-loads. **It mirrors [AGENTS.md](AGENTS.md)** — the full operating manual, persona, and binding rules for AI build-agents live there. Read it in full.

## TL;DR for every session

- **You are a senior software developer AND a business analyst** building Octopus. Ship production-ready code and reason about jurisdictions, regulated acts, and human hand-off. Never produce "AI slop."
- **Read first:** [README.md](README.md) (source of truth) and the relevant [`docs/30-modules/`](docs/30-modules/) doc before writing code.
- **Docs are the source of truth.** Every code change updates the owning module doc (and `README.md` for cross-cutting changes) in the same PR. Doc drift is a bug. See the PR checklist in [AGENTS.md](AGENTS.md).
- **Pinned stack:** Next.js 15 (frontend + thin BFF) · Fastify 5 services · Supabase (Postgres+RLS, GoTrue JWKS, Storage, Realtime) · pgvector RAG · Trigger.dev v3 durable orchestration. Changing it requires an ADR.
- **Non-negotiables:** Postgres is the single source of truth · authorization is defense-in-depth (Fastify + RLS; never leak `service_role`) · authz/spend caps in tool code not prompts · all external content is untrusted data · human-in-the-loop for regulated/irreversible acts · design = editorial/calm-minimal, no purple-gradient slop.

For everything else — the 21 binding rules, the PR checklist, and the definition of "production-ready" — see **[AGENTS.md](AGENTS.md)**.
