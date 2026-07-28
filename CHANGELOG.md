# Changelog

All notable changes to Project Octopus. Every PR appends a one-line entry here (see the doc-maintenance rule in [AGENTS.md](AGENTS.md)). Newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Documentation foundation (Phase 0).** Authored the full source-of-truth documentation set: master `README.md`, `AGENTS.md`/`CLAUDE.md` build-agent persona + rules, 13 module docs, architecture/tech-stack/data-model/RAG/security-compliance/observability/roadmap supporting docs, "Ink & Bioluminescence" design system + Discord chat spec + brand, 5 ADRs, doc registry `.docmeta.yml`, and the runbooks/playbooks/diagrams/legal scaffolds.
- **Phase 0 monorepo scaffold** (branch `phase-0-scaffold`). Turborepo + pnpm workspaces; `apps/web` (Next.js 15 editorial landing), `apps/api` (Fastify 5 `/api/health` + JWKS auth util), `packages/config` (Zod env + constants), `packages/contracts` (ts-rest health contract); `supabase/` config + initial `profiles` migration (RLS + new-user trigger); `scripts/check-docs.mjs` + GitHub Actions CI enforcing the `.docmeta.yml` doc-drift gate; `DEVELOPMENT.md`. Verified green: install, typecheck (4/4), build, lint.
- Decisions: Product name **Octopus**; first markets **US + EU**; design direction **editorial / calm minimal**.

### Phase 1 (in progress)

- **Chat shell runs on live data; all mock and demo content removed.** Deleted `apps/web/lib/mock.ts` (the seeded "Maya / Rune" conversation, fabricated plan, fake agent auto-reply, hardcoded budget and unread counts). Added Supabase sign-in/sign-up at `/sign-in` with middleware session refresh and route gating, a thin BFF at `/api/bff/*` that attaches the token server-side, and `GET|POST /api/rooms` + `GET /api/rooms/:roomId/{channels,members}`. The stream, composer, member panel and ⌘K palette now read real rooms, channels, profiles, message history, Realtime delivery and Realtime Presence; sends are optimistic and reconciled on the server copy, keyed by a client `idempotencyKey`. Surfaces with no backend (plan card, agent replies, budget) are **not rendered** rather than faked; `PlanCard.tsx` is kept unwired for Phase 2. Two migrations were needed and both were found by testing in a browser: `20260728190000` (own-row-only profile RLS made the member list impossible) and `20260728200000` (`channel.track()` needs an INSERT policy on `realtime.messages`, without which every member silently shows offline). Also corrected a doc-vs-reality error: the session cookies are **not** `httpOnly`, since `@supabase/ssr`'s browser client must read them to authenticate Realtime.

- **Server-authoritative chat write path** (`apps/api`). `POST /api/rooms/:roomId/messages` (JWKS preHandler → RLS membership → insert → Postgres trigger broadcasts) and `GET /api/rooms/:roomId/messages` (since-cursor catch-up), typed from `packages/contracts`. Routes act on Postgres as the _caller_ (publishable key + the caller's token) so RLS is the real backstop; the secret key stays reserved for trusted no-user-context writes. `authorId`/`authorKind` come from the JWT, never the body; `idempotencyKey` replay returns the original message. Verified end-to-end against Supabase, 24 assertions plus confirmed Realtime delivery to a live subscriber. Two bugs found by that verification and fixed: `20260728170000_grant_table_privileges.sql` (both prior migrations shipped RLS policies with **no** table grants, making every table unreachable) and `--env-file-if-exists` in the api scripts (nothing was loading `apps/api/.env`).

- **Chat schema live on Supabase.** Applied `20260728120000_chat.sql` (rooms/channels/room_members/messages, membership RLS via a `SECURITY DEFINER` helper, `realtime.broadcast_changes()` insert trigger, Realtime subscribe policy) and `20260728160000_harden_security_definer.sql`, which moves the policy helper into a non-exposed `private` schema and drops the default PUBLIC execute grant on the trigger functions — clearing all 8 Supabase security-advisor lints. Updated `data-model.md`.

- **Discord-style chat shell** (branch `phase-1-chat-shell`). Mock-driven `/app` workspace: 5-region layout (guild rail · channels · stream · context panel), roles/badges/presence, inline agent messages with the bioluminescent working pulse, the marquee **plan card** (funnel stages, owner chips, citations with verified dates, approve/request-changes → flywheel-signal capture), composer, and a ⌘K command palette. "Ink & Bioluminescence" tokens (`globals.css` + `chat.css`), distinctive type via `next/font` (Fraunces · Hanken Grotesk · JetBrains Mono), light + dark skins, accessible. Verified: typecheck, build, lint green; renders + interactions confirmed in-browser; no console errors.

### Changed

- **Decision: Python AI service + Node/Fastify backend** ([ADR-0006](docs/40-adr/0006-python-ai-service-node-backend.md)). The AI/RAG layer (ingestion, retrieval, agent reasoning, eval, models) runs as a separate Python service (FastAPI + LlamaIndex); Node/Fastify keeps chat/auth/marketplace/payments + the durable backbone + all side-effecting tools. _Python proposes, Node executes._ Updated `README.md`, `architecture.md`, `rag.md`, `tech-stack.md`, `ai-orchestrator.md`, `rag-knowledge.md`, `infra-devops.md`, `.docmeta.yml`.
- **Strategy: wedge-first go-to-market.** First shipped vertical is now **full-funnel digital marketing for solo founders/creators**; business-formation (the cafe story, incl. Georgia/Tbilisi) becomes a later expansion vertical (north star unchanged). Introduced the **learning flywheel** as the moat — ingest campaigns+outcomes · human-node feedback as labeled data · auto-optimize on live metrics · fine-tune a proprietary model later.
- New docs: `docs/10-architecture/learning-flywheel.md`, `docs/30-modules/marketing-growth-engine.md`, `docs/60-playbooks/full-funnel-creator.md`.
- Updated to reflect the pivot: `README.md`, `docs/00-overview/vision.md`, `core-loop.md`, `personas.md`, `glossary.md`, `docs/10-architecture/roadmap.md`, `rag.md`, `docs/30-modules/{rag-knowledge,analytics,integrations,ai-orchestrator}.md`, `docs/60-playbooks/README.md`, `.docmeta.yml`.

---

> Once code lands, entries look like: `- feat(chat): server-authoritative message write path with Realtime broadcast (#12) — updated chat-discord.md`.
