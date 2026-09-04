# ADR-0032 — The reasoning provider is a workspace connector, and the house key is its default

**Status:** Accepted · **Date:** 2026-09-04 · **Slice:** model connectors (slice 0 of seven; this slice is the record and no code)

## Context

Everything this system reasons with has been loaded onto its own core. `services/ai` carries a hand-written marketing corpus, an in-process embedder and an in-process cross-encoder ([ADR-0008](0008-local-bge-m3-embeddings.md), [ADR-0009](0009-local-reranker.md)), which is 4.6 GB of weights, an 8 GB deployment floor and a planning turn measured end to end at 121 s on a 16-thread box. Generation is pinned to one server-side OpenAI key ([ADR-0007](0007-openai-generation-embeddings-cohere-rerank.md)). [learning-flywheel.md](../10-architecture/learning-flywheel.md) ends at a fourth mechanism that fine-tunes a proprietary model once the dataset is large enough, and [roadmap.md](../10-architecture/roadmap.md) puts that in Phase 4.

The owner has decided that for the first MVP the product should work the way Cursor works: **the harness is the product and the model is a pluggable connector.** A workspace owner connects their own key for Anthropic, OpenAI or Google, chooses which model powers each of the four voices ([ADR-0031](0031-an-agent-persona-is-a-voice-not-a-writer.md)), and every guardrail this system has stays exactly where it is.

Two things were assessed before the decision rather than after it, because both of them could have made it wrong.

**The harness is already provider-agnostic, and that is a fact about the code rather than a hope.** `routeTask` decides who may run a step. `checkSpendCap` composes one project ceiling against every sibling campaign and every held escrow, in the four places [ADR-0020](0020-the-ceiling-has-two-committer-classes.md) records. The plan card is the authorisation boundary and `materialise_plan` is what crosses it. Offers, escrow, the ledger, payouts and disputes are SQL functions. Thread admission is RLS. Notifications derive from `events` ([ADR-0028](0028-a-notification-is-derived-from-the-event.md)). Not one of those reads which model wrote the proposal it is checking, so a connector changes **who proposes** and never **who acts**, and [ADR-0006](0006-python-ai-service-node-backend.md) holds for any provider as written.

**"Learning from other models' answers" is only safe as data, and the three vendors say so in three different documents.** OpenAI's terms forbid using output to develop models that compete with OpenAI; Anthropic's Commercial Terms D.4 forbids the same; Google's Gemini API Additional Terms carry a use restriction of the same shape. All three were read on 2026-09-04. Two further arguments point the same way and would hold even if the terms did not. There is no proprietary generator to train, so there is nothing for a distillation set to be a distillation set **for**. And auto-ingesting a model's prose into the corpus would launder an unverified claim into a citation, which is the exact failure the whole retrieval stack exists to prevent and which [ADR-0021](0021-a-labelled-ungrounded-tier.md) already refuses one layer up.

## Decision 1: the reasoning provider is a workspace connector, and the server's key is the house default

A workspace connects its own API key for a provider and picks a model per role. A workspace that connects nothing keeps running on the server's `OPENAI_API_KEY` exactly as it does today, byte for byte, and that is what the word **Auto** means on the surface: no route row for this role, so the house default answers.

This **amends [ADR-0007](0007-openai-generation-embeddings-cohere-rerank.md)** in one clause and leaves the rest standing. ADR-0007's generation pin becomes the house default among connectors rather than the only option. Its embedding decision is untouched, and so are [ADR-0008](0008-local-bge-m3-embeddings.md) and [ADR-0009](0009-local-reranker.md): embedding and rerank stay in-process, one embedding model still covers the whole corpus, and **no corpus text leaves the process for retrieval** regardless of which reasoning provider a workspace connects. A connector is a generation decision and nothing else.

The loosening that would follow naturally from this one, running with the reranker off and retrieval as enrichment rather than as a gate, is **deliberately not taken here.** It needs the router's fourth rule rethought (`uncited_cannot_auto_run`, which escalates any non-read-only step the corpus did not support), a threshold recalibration and the 65-minute retrieval eval, and it changes what the product asserts about its own answers. It gets its own ADR or it does not happen.

## Decision 2: a connector changes who proposes, never who acts

The Python service proposes; Node executes; that is [ADR-0006](0006-python-ai-service-node-backend.md) and it does not move. What a connector changes is which vendor's endpoint composes the proposal that Node then checks against the same rules.

The specific thing being refused here is provider-native tool use as a second execution path. Every vendor now ships server-side tools, and the shape they invite is an agent that publishes, spends and connects from inside the model call. In this system those acts sit behind `routeTask`, `checkSpendCap`, an owner-approved card and a `carriesReal*` flag, so a provider tool that reached one of them would be a side effect that never passed any of them. **Provider-native tools are admissible only where they are read-only or artifact-producing**, which is why image generation in slice 6 is a proposal executed by Node with the workspace's key and its bytes land in the existing private artifacts bucket, and why vendor web search is in the named-not-built table rather than in this decision.

## Decision 3: a provider's output is a lead, never a source

Nothing a model writes is ingested. Not into `documents`, not into `doc_chunks`, not into the golden set, and not into a training or distillation set of any kind, **house provider or connector**. The corpus grows from documents a person reviewed, which is what makes a citation mean something.

What a provider's output is allowed to do is point at a gap. `retrieval_gaps` already records every refusal and every labelled ungrounded answer with the question that produced it; slice 4 adds the provider and model that answered, so the queue says which model was asked as well as what was missing. `feedback_events` already records a verdict on a card; slice 4 adds a helpful / not helpful label on a model-written message with no card. The crawl registry already takes candidate sources that a person reviews in a diff. Per-provider approval and label rates are a **join across those tables**, not a new payload: `feedback_events.embed_id → action_embeds.message_id → messages.model`, and `feedback_events.message_id → messages.model` for the direct case.

This **amends mechanism 4 in [learning-flywheel.md](../10-architecture/learning-flywheel.md)**, which reads as though the accumulated dataset would train a model of ours. It will not train on provider output. What survives of that mechanism is human corrections and measured outcomes, which are ours, and any future fine-tune stays inside a provider's own fine-tuning product on that data alone.

## Decision 4: attribution is Node's, and only text a model wrote carries it

`messages.model` is stamped by `apps/api` from the route it resolved. It is never accepted from a client and never chosen by a model, which is the same stance `persona` takes for the same reason ([ADR-0031](0031-an-agent-persona-is-a-voice-not-a-writer.md) decision 2): a field a client could set is a field somebody can put a false name in, beside a real audit trail, where a guess and a fact look identical.

The column is **raw model id with a length check, not an enum and not a foreign key.** Model ids are an open vocabulary that vendors change without asking, and this system has already recorded what an unremovable enum value costs ([ADR-0022](0022-proof-is-an-artifact.md)). Display resolves an id through the registry and renders an unknown id as itself, because a model id we do not recognise is still the true answer to "what wrote this".

**Only text a model wrote gets a model.** A run notice, a sweep notice, a waiting digest and an answer recorded from a person are written by TypeScript, and stamping them would say a model composed words it did not. They stay null, exactly as they stay `system` under ADR-0031's rule. `task_runs` gains provider and model so a re-delivered artifact is attributed to whatever produced it, and `events.payload` carries both beside `persona`.

## Decision 5: the fallback tier may run on the workspace's route, and classification may not

[ADR-0021](0021-a-labelled-ungrounded-tier.md)'s labelled ungrounded tier is the half of this product a connector most obviously improves: it is the answer given when the corpus does not cover the question, so the model's own knowledge is the whole of what is left. It may run on the workspace's Fallback route.

**Every constraint in ADR-0021 is unchanged and none of them was a prompt.** It still returns `post_message` only, so ungrounded prose cannot become a task DAG. It is still `grounded=False` with `citations=[]`. Regulated topics are still refused by `ungrounded.is_regulated` **before any provider is called**, which matters more here than it did: a customer's own key is not a licence to answer a tax question. The label is still written by `ungrounded.frame` in code rather than asked of the model, and that constraint's original argument gets stronger with every additional vendor, because a disposition instruction that four models each interpret slightly differently is four different disclaimers.

**Classification-shaped calls stay on the house model.** Query decomposition, the groundedness gate and intake are pinned at temperature 0 and their thresholds were measured on `gpt-5.4`. The gate in particular is scored two-sided by `--gate`, block rate and false-refusal rate together, on that model, so routing it to whatever a workspace happened to connect would move a safety threshold by configuration and invalidate the only measurement standing behind it.

**The residency cost of that is stated rather than discovered.** On a workspace that has connected its own key, the goal sentence, the intake answers and the retrieved sources block still reach the house provider for those three calls, and the sources block can include the room's own documents. The customer's plan prose goes to the vendor they chose under their own account; the classification calls do not. **Trigger to revisit: the first customer whose data-processing agreement forbids it**, at which point the options are a per-workspace classification route with a recalibration, or refusing the workspace. Neither is cheap, which is why the trigger is written down now.

## Decision 6: six roles, an unset role is Auto, and a route grants nothing

The roles are `strategist`, `content`, `ads` and `analyst`, which are ADR-0031's four voices, plus `fallback` for the ungrounded tier and `creative` for image generation. Per workspace, owner-only to write. An unset role is Auto.

**Per voice rather than per workspace** because the roles genuinely differ in what they need: a campaign draft and a landing-page draft reward different models, and the picker is the place a person expresses that. **Not per message**, because a per-message picker makes the model a thing the reader has to think about on every turn, and there is no evidence yet about which model is better at what here. It is in the named-not-built table with the owner's own use as its trigger.

A route is a **preference, not a grant**. It names which endpoint composes a proposal. `routeTask`, `checkSpendCap` and `apply_plan_diff` do not read it, and a role with a strong model connected has exactly the authority it had with none, which is none. This is decision 2 restated at the level of the data, and it is restated because the picker is the surface that will most tempt a later change to treat a route as a capability.

## Decision 7: keys are encrypted at rest, and Postgres is not where they are opened

A customer's model key is stored AES-256-GCM encrypted with a master key held in `MODEL_KEY_SECRET`, with the additional authenticated data bound to the row (`model_connections:{roomId}:{provider}:v{key_version}`), so a ciphertext copied from one row to another fails to open rather than decrypting under the wrong owner. `key_version` is on the row from the first migration; rotation tooling is named-not-built with the first rotation as its trigger.

**Supabase Vault was considered and rejected**, and the reason is specific to this system rather than general. Vault decrypts inside Postgres for any role that can read `vault.decrypted_secrets`, and `services/ai` holds `service_role`. Storing model keys there would mean the Python container could read every customer's key by selecting a view, which defeats the property this decision exists to buy: **decryption is confined to the Node code that builds the outbound request.** The master key is provisioned to the API app alone and the compose file sets `MODEL_KEY_SECRET: ''` on the AI service so it cannot inherit one through `env_file`.

Node decrypts per request and passes the key in the request body to Python over the private network, where it is held as a `SecretStr`, never logged and never stored. The one non-obvious leak on that path is pydantic v2, which echoes the failing parent object in a 422 body, so the validation-error handler strips `input` and `ctx`.

**A missing master key fails loudly and never silently.** A workspace with routes configured and no `MODEL_KEY_SECRET` fails the run with a notice naming the variable, rather than quietly falling back to the house key, because a silent fallback would send a customer's work to a provider they did not choose and bill it to us.

The customer is the party to their provider's terms for everything routed through their own key. The house default remains an OpenAI sub-processor of ours, which is what [security-compliance.md](../10-architecture/security-compliance.md) already says and what decision 5's residency paragraph qualifies.

## Rejected

**Octopus as an MCP connector inside ChatGPT or Claude.** The obvious cheap version of "work with any model": expose the tools and let somebody else's chat client drive them. It is refused because the money boundary must live in Octopus. `checkSpendCap`, the plan card and escrow are only guarantees while the surface that authorises them is ours; behind somebody else's client they become tools that a foreign agent loop calls, and the approval a person clicked was rendered by a product we do not control.

**Pooled billing and metering now.** It is the model most of this category uses and it is a different business: quota accounting, per-token metering, a margin, and our key funding somebody else's usage. BYOK plus a house default answers the MVP question without any of that. Trigger: the first paying customer with no key of their own.

**A per-message model picker**, covered in decision 6.

**Auto chosen from per-provider label rates.** Attractive and premature. It needs enough helpful / not helpful labels per provider to rank them, and slice 4 is the first thing that collects any.

## Consequences

- **The product's claim changes shape.** It is no longer "Octopus reasons on its own core"; it is "Octopus is a harness with guardrails, and you bring the reasoning". [vision.md](../00-overview/vision.md)'s moat is restated accordingly: the defensibility is the harness plus the dataset, not the generator.
- **One capability leaves and one arrives.** Nothing this system does today loses a guardrail, and generation gains a dimension nobody can audit from the code alone, which is why decision 4 exists: the model that wrote a thing is now part of the record, in the message, in `task_runs`, in `events` and in `retrieval_gaps`.
- **The registry is data and the code never branches on a model id.** Vendors, their dialects and their model lists live in `packages/contracts`; a key is validated against the provider's own models endpoint at connect time, so a wrong key fails on the settings surface rather than four minutes into an agent run.
- **`carriesRealCredentials` gains a second meaning.** Model keys are the second customer-held credential in this system after channel OAuth tokens, and unlike the first they arrive **encrypted from the start**, which is the trigger [security-compliance.md](../10-architecture/security-compliance.md) wrote for the channel tokens finally being met on a different table.
- **The Phase 4 fine-tune is narrowed rather than cancelled.** It stays in the roadmap, on our own outcome and correction data, inside a provider's own fine-tuning product. What is now excluded permanently is training on any model's output.
- **This slice touches no Current shape section**, because nothing exists yet. Slices 1 to 6 each update the owning module doc, and three docs gain a Current shape section for the first time on the way: [ai-orchestrator.md](../30-modules/ai-orchestrator.md) in slice 1, [design-system-frontend.md](../30-modules/design-system-frontend.md) in slice 5 and [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) in slice 6.
- **Vendor facts in this record were verified on 2026-09-04 and are not a pin.** Rule 21 applies to the code that follows: request shapes, model ids, parameter support and the list-models endpoint are re-verified with a live call in the slice that first depends on them.
