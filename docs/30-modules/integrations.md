# Module: External Integrations

> Owns all outbound third-party connectivity behind **typed, injection-guarded adapters**: payment rails, KYC/IDV, embedding/rerank/parsing providers, source crawlers, maps/geo, and email/push. One place to manage credentials, rate limits, retries, and provider-swap seams.
>
> **Owner paths:** `supabase/functions/**` (crawlers/webhooks) + provider adapters in `packages/*` · **Depends on:** infra-devops (secrets, deployment) · **Depended on by:** payments-billing, human-nodes-marketplace (KYC), rag-knowledge (embeddings/rerank/parsing/crawlers), notifications (delivery providers).
>
> Update on any provider add/change/version-pin.

## Adapter pattern

Every provider sits behind a **typed adapter** with Zod-validated I/O. Callers depend on the adapter interface, never the provider SDK directly, so a provider swap (or a fallback behind a version flag) is non-breaking.

## Provider surfaces

| Surface | Provider(s) | Notes |
|---|---|---|
| Payments | **Stripe Connect (Express)** | escrow-equivalent + payouts ([payments-billing.md](payments-billing.md)) |
| KYC / IDV | **Persona** / Stripe Identity | liveness, Face Match 1:1, Face Search 1:N |
| Embeddings | **Voyage** (voyage-3-large) | one model across corpus; fallback embedder behind a version flag |
| Rerank | **Cohere** (rerank-3.5) | cross-encoder |
| Generation | **Anthropic** (Claude, tiered) / OpenAI fallback | prompt caching; verify model IDs, don't hardcode from memory |
| **Ad platforms** | **Meta Ads**, Google Ads | create/manage campaigns; **spend-capped, approval-gated** ([marketing-growth-engine.md](marketing-growth-engine.md)) |
| **Social publishing** | platform APIs | schedule/publish organic content (post-approval) |
| **Creative generation** | image / video / audio models | campaign assets; stored as artifacts |
| **Web analytics** | GA4 · Microsoft Clarity | performance, attribution, the auto-optimize loop |
| Doc parsing / OCR | **LlamaParse** / Unstructured / Docling | layout-aware |
| Source crawlers | custom (Edge Functions) | government/registry sources, supplier directories |
| Maps / geo | maps provider | location scouting, service-geo checks |
| Email / push / SMS | Resend/Postmark · Expo · Twilio | behind the notifications abstraction |

## Untrusted-content quarantine

**All external results — web pages, crawled documents, supplier emails, provider responses — are data, never instructions.** They are kept off the agent's instruction channel; the orchestrator never executes directives found inside them. PII is kept out of URLs, logs, and the RAG index.

## Reliability

Per-provider **rate limiting**, **retries with backoff**, **idempotency**, and **circuit breaking**. Webhook events (Stripe / IDV / crawler) are recorded to `webhook_events` and processed idempotently.

## Secrets & config

Credentials in Doppler/Infisical (never in the repo/client). `provider_config` carries version + feature flags so providers/versions are pinned and swappable. See [infra-devops.md](infra-devops.md) and [tech-stack.md](../10-architecture/tech-stack.md).

## Provider-swap & fallback strategy

Version flags per provider; a fallback embedder/generator can be enabled without a deploy. Swaps are gated by eval (for RAG providers) and contract tests.

## Key entities

`integration_credentials` · `webhook_events` (Stripe/IDV/crawler) · `provider_config` (version, flags) · `rate_limit_state`.
