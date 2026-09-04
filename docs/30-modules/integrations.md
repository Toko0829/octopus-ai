# Module: External Integrations

> Owns all outbound third-party connectivity behind **typed, injection-guarded adapters**: payment rails, KYC/IDV, embedding/rerank/parsing providers, source crawlers, maps/geo, and email/push. One place to manage credentials, rate limits, retries, and provider-swap seams.
>
> **Owner paths:** `supabase/functions/**` (crawlers/webhooks) + provider adapters in `packages/*` · **Depends on:** infra-devops (secrets, deployment) · **Depended on by:** payments-billing, human-nodes-marketplace (KYC), rag-knowledge (embeddings/rerank/parsing/crawlers), notifications (delivery providers).
>
> Update on any provider add/change/version-pin.

## Adapter pattern

Every provider sits behind a **typed adapter** with Zod-validated I/O. Callers depend on the adapter interface, never the provider SDK directly, so a provider swap (or a fallback behind a version flag) is non-breaking.

## Provider surfaces

| Surface                 | Provider(s)                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments                | **Stripe Connect (Express)**                                                          | escrow-equivalent + payouts ([payments-billing.md](payments-billing.md))                                                                                                                                                                                                                                                                                                                                          |
| KYC / IDV               | **Persona** / Stripe Identity                                                         | liveness, Face Match 1:1, Face Search 1:N                                                                                                                                                                                                                                                                                                                                                                         |
| Embeddings              | **OpenAI** (`text-embedding-3-large`) · **local BAAI `bge-m3`**                       | `dimensions: 1024`; bge-m3 is natively 1024. One model across the corpus; `EMBED_PROVIDER` selects, and switching re-embeds ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md))                                                                                                                                                                                                                               |
| Rerank                  | **local BAAI `bge-reranker-v2-m3`** · Cohere (rerank-v3.5)                            | cross-encoder, in-process by default ([ADR-0009](../40-adr/0009-local-reranker.md)). No provider call and no quota. Cohere is retained as a fallback and is rate-limited client-side by `COHERE_RERANK_RPM` where the key is metered; `COHERE_API_KEY` is required only when it is selected                                                                                                                       |
| Generation              | **Workspace connector** (Anthropic / OpenAI / Google) over a house-default OpenAI key | **the house default is live; the connectors are decided and arrive over slices 1 to 6.** Model ids live in the registry as data and a key is verified against the provider before it is stored ([ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md))                                                                                                                                       |
| **Ad platforms**        | **Meta Ads**, Google Ads                                                              | create/manage campaigns; **spend-capped, approval-gated** ([marketing-growth-engine.md](marketing-growth-engine.md))                                                                                                                                                                                                                                                                                              |
| **Social publishing**   | platform APIs                                                                         | schedule/publish organic content (post-approval)                                                                                                                                                                                                                                                                                                                                                                  |
| **Creative generation** | **Google Gemini image** on the workspace's own key                                    | **decided, not built** (slice 6): campaign assets generated on the workspace's `creative` route and stored as artifacts in the existing private bucket, with **Node executing the proposal** so the bytes never depend on a provider-native tool ([ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md)). `generate_creative` returns a brief as text today. Video and audio are not planned |
| **Web analytics**       | GA4 · Microsoft Clarity                                                               | performance, attribution, the auto-optimize loop                                                                                                                                                                                                                                                                                                                                                                  |
| Doc parsing / OCR       | **LlamaParse** / Unstructured / Docling                                               | layout-aware                                                                                                                                                                                                                                                                                                                                                                                                      |
| Source crawlers         | one guarded fetcher in `apps/api`, on a checked-in registry                           | regulator and ad-platform pages. NOT an Edge Function: the sweep rides the ticker's pass, and outbound HTTP stays where the SSRF guard is                                                                                                                                                                                                                                                                         |
| Maps / geo              | maps provider                                                                         | location scouting, service-geo checks                                                                                                                                                                                                                                                                                                                                                                             |
| Email / push / SMS      | Resend/Postmark · Expo · Twilio                                                       | behind the notifications abstraction                                                                                                                                                                                                                                                                                                                                                                              |

## Connecting a customer's own account

Everything above is a provider **we** hold credentials for. Channel connections
are the other kind: the credential belongs to the customer, arrives through a
three-legged OAuth round trip, and authorises action on their account rather than
ours. That difference is why it has its own seam, `ChannelAuthProvider` in
`packages/marketing`, rather than sitting behind `AdChannelAdapter`: an ad
adapter acts **with** a credential that exists, and this is how one comes to
exist. A platform can rewrite its campaign API without touching its OAuth
endpoints, and the reverse.

Two registries, both checked in rather than stored, on the stance this document's
adapter pattern already takes: which implementation may touch somebody's ad
account is an editorial and security judgement, and a file gets reviewed in a
diff while a row does not. `AUTH_PROVIDER_REGISTRY` carries one field its sibling
does not, `carriesRealCredentials`, which `writeConnection` refuses on until
envelope encryption exists (see the accepted risk in
[security-compliance.md](../10-architecture/security-compliance.md)).

Only the in-repo `fake` is registered. Its consent screen is a page in our own
web app, which is what makes the whole round trip, including a person clicking
Cancel, exercisable without an account anywhere. **Meta Ads and Google Ads are
named in the table above as intent, not as integrations that exist.** The
redirect URI every real provider will register is fixed by
[ADR-0012](../40-adr/0012-oauth-callback-on-the-web-origin.md).

**Model keys are the second customer-held credential in this system, and they are
decided rather than built.** [ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md)
makes the reasoning provider a workspace connector: an owner pastes their own
Anthropic, OpenAI or Google key and picks which model powers each of the four
voices, and a workspace that connects nothing keeps running on the server's
OpenAI key. Three things separate that credential from a channel token and each
is a decision rather than a detail. It arrives **by paste rather than by OAuth**,
because an API key has no three-legged round trip and no consent screen to click
Cancel on, so the equivalent of the consent screen is a **free list-models call
made before anything is stored**: a mistyped key fails on the settings surface
rather than four minutes into an agent run. It is **encrypted at rest in the same
change that creates its table** (AES-256-GCM, additional authenticated data bound
to the row so a ciphertext moved between rows will not open), which is precisely
what the channel tokens above are still waiting for and what
`carriesRealCredentials` refuses on until they get it. And **decryption is
confined to the Node code that builds the outbound request**, which is why
Supabase Vault was rejected rather than adopted: Vault decrypts inside Postgres
for any role that can read `vault.decrypted_secrets`, and `services/ai` holds
`service_role`. The key reaches the Python service on the request that needs it
and is never stored there.

None of that exists yet. This section will say what is built when slice 2 lands
its table, its routes and its encryption together.

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
