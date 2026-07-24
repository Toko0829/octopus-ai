# ADR-0004 — API contract: ts-rest + OpenAPI over tRPC

- **Status:** Accepted
- **Date:** Phase 0
- **Context doc:** [tech-stack.md](../10-architecture/tech-stack.md), [architecture.md](../10-architecture/architecture.md)

## Context

`apps/web` (Next.js) calls `apps/api` (Fastify). We want end-to-end type safety **and** a language-agnostic contract for webhooks, external consumers, and generated docs.

## Decision

Define **Zod schemas once in `packages/contracts`** and use **ts-rest** to derive the Fastify route validation, an **OpenAPI** document (`@fastify/swagger`), and the typed client used by Next.js. Fastify uses `fastify-type-provider-zod`.

## Rationale

- **OpenAPI is the boundary we actually need** — Stripe/IDV/crawler webhooks, potential non-TS consumers, and published docs all speak OpenAPI.
- ts-rest gives near-tRPC DX (typed client/server) **without** coupling the wire format to a TS-only RPC scheme.
- One source of truth (Zod) → validation + OpenAPI + client all derived, no drift.

## Alternatives considered

- **tRPC** — excellent TS-to-TS DX, but its wire format is TS-centric; harder to expose an OpenAPI contract for webhooks/external/other-language consumers. Rejected for a system with a real REST surface and webhooks.

## Consequences

- Every boundary is typed; the client is generated; the OpenAPI doc is always current.
- New endpoints must be added to `packages/contracts` first (it's a `readme_trigger` in `.docmeta.yml`).
