# Changelog

All notable changes to Project Octopus. Every PR appends a one-line entry here (see the doc-maintenance rule in [AGENTS.md](AGENTS.md)). Newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Documentation foundation (Phase 0).** Authored the full source-of-truth documentation set: master `README.md`, `AGENTS.md`/`CLAUDE.md` build-agent persona + rules, 13 module docs, architecture/tech-stack/data-model/RAG/security-compliance/observability/roadmap supporting docs, "Ink & Bioluminescence" design system + Discord chat spec + brand, 5 ADRs, doc registry `.docmeta.yml`, and the runbooks/playbooks/diagrams/legal scaffolds.
- **Phase 0 monorepo scaffold** (branch `phase-0-scaffold`). Turborepo + pnpm workspaces; `apps/web` (Next.js 15 editorial landing), `apps/api` (Fastify 5 `/api/health` + JWKS auth util), `packages/config` (Zod env + constants), `packages/contracts` (ts-rest health contract); `supabase/` config + initial `profiles` migration (RLS + new-user trigger); `scripts/check-docs.mjs` + GitHub Actions CI enforcing the `.docmeta.yml` doc-drift gate; `DEVELOPMENT.md`. Verified green: install, typecheck (4/4), build, lint.
- Decisions: Product name **Octopus**; first markets **US + EU**; design direction **editorial / calm minimal**.

### Phase 1 (in progress)

- **Discord-style chat shell** (branch `phase-1-chat-shell`). Mock-driven `/app` workspace: 5-region layout (guild rail · channels · stream · context panel), roles/badges/presence, inline agent messages with the bioluminescent working pulse, the marquee **plan card** (funnel stages, owner chips, citations with verified dates, approve/request-changes → flywheel-signal capture), composer, and a ⌘K command palette. "Ink & Bioluminescence" tokens (`globals.css` + `chat.css`), distinctive type via `next/font` (Fraunces · Hanken Grotesk · JetBrains Mono), light + dark skins, accessible. Verified: typecheck, build, lint green; renders + interactions confirmed in-browser; no console errors.

### Changed

- **Strategy: wedge-first go-to-market.** First shipped vertical is now **full-funnel digital marketing for solo founders/creators**; business-formation (the cafe story, incl. Georgia/Tbilisi) becomes a later expansion vertical (north star unchanged). Introduced the **learning flywheel** as the moat — ingest campaigns+outcomes · human-node feedback as labeled data · auto-optimize on live metrics · fine-tune a proprietary model later.
- New docs: `docs/10-architecture/learning-flywheel.md`, `docs/30-modules/marketing-growth-engine.md`, `docs/60-playbooks/full-funnel-creator.md`.
- Updated to reflect the pivot: `README.md`, `docs/00-overview/vision.md`, `core-loop.md`, `personas.md`, `glossary.md`, `docs/10-architecture/roadmap.md`, `rag.md`, `docs/30-modules/{rag-knowledge,analytics,integrations,ai-orchestrator}.md`, `docs/60-playbooks/README.md`, `.docmeta.yml`.

---

> Once code lands, entries look like: `- feat(chat): server-authoritative message write path with Realtime broadcast (#12) — updated chat-discord.md`.
