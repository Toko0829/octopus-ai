# The Core Loop (canonical, 10-step trace)

> The single canonical description of how one goal flows end-to-end through Octopus. Every architecture and module doc must stay consistent with this. Update this doc if the flow, the boundaries (sync vs durable), the escalation mechanic, or the feedback/flywheel capture changes.

**Worked example (first vertical — full-funnel digital marketing):** a solo founder types _"launch and grow my app — get me to my first 1,000 paying customers."_ The founding-story variant _"open a cafe in Austin"_ (business formation) runs on the same loop with a different playbook, later.

## Actors

- **User** — the solo founder / creator, minimally engaged.
- **AI agent** — a first-class member of the chat; the "growth operator."
- **Human node(s)** — vetted expert marketers / creative directors / editors / strategists, matched for judgment-, taste-, relationship-, or access-restricted tasks. Their corrections feed the [learning flywheel](../10-architecture/learning-flywheel.md).
- **Services** — `apps/web` (Next.js BFF), `apps/api` (Fastify), `apps/matcher`, `apps/agent` (durable tasks), Supabase (Postgres/RLS/Realtime/Storage), Trigger.dev (durability), channel integrations (ad platforms, social, analytics, creative-gen), Stripe Connect (escrow/payouts).

## The 10 steps

1. **Goal posted.** User types the growth goal in the Discord-style chat (`apps/web`). Client `POST`s to the Next BFF → forwards to Fastify `POST /rooms/:id/messages` with the user's Supabase JWT.
2. **Persist → broadcast.** Fastify verifies the JWT (JWKS), inserts the message **under RLS**; a Postgres trigger calls `realtime.broadcast_changes()` → topic `chat:room:{id}`. The user sees it instantly.
3. **Durable run starts.** Fastify recognizes a new growth goal (or an explicit `POST /projects`), creates a `project` row, and triggers `tasks.trigger('agent.run', { projectId, roomId })`. **Returns `202 + runId`.** No long work in the request thread.
4. **Ground in RAG (incl. real outcomes).** The agent calls `rag_retrieve` → hybrid pgvector search over the marketing knowledge base **and the growing corpus of real campaign outcomes** — _"what worked for comparable creators/products."_ Recommendations cite what actually performed.
5. **Full-funnel plan streamed inline.** The agent writes its plan as assistant messages (it's a room member); tokens broadcast live. It persists a **task DAG** across the funnel: positioning/ICP, offer, content plan, channels (paid ads, social, SEO, email), creative, landing/conversion, launch, measurement — with dependencies.
6. **Execute AI-capable tasks.** As durable, retryable steps: audience/keyword research, competitor teardown, copywriting, **creative generation** (image/video), landing-page copy, ad-set drafting, email sequences, scheduling. Artifacts to Storage; rows to Postgres. Nothing goes live yet.
7. **Approval / connect / escalate.** Actions with real-world impact gate: **connecting the user's ad/social accounts**, **spending ad budget**, **publishing** public content, or a task needing **human judgment/taste/relationships** (brand direction, high-end video edit, influencer outreach, account verification). The agent posts an **approval embed** to the user and/or calls `request_human_node`; on a human task, **escrow is held**, the matcher finds an eligible expert node, and the run **suspends on a waitpoint**.
8. **Node joins & works.** The matched marketer accepts; the matcher `INSERT`s them into `room_members` (RLS admits them to the task thread with the user + AI). They do the expert work (creative direction, edit, outreach) with the AI as co-pilot, and upload deliverables/approval to Storage.
9. **Verify → pay → resume → LAUNCH.** AI critic + the user approve; Fastify **completes the waitpoint** and **releases escrow** → Stripe Connect payout + double-entry ledger. The run **resumes**, and approved campaigns **go live** on the connected channels (within spend caps).
10. **Measure, auto-optimize & learn.** Octopus pulls live performance (CTR, CPA, ROAS, conversions), **auto-optimizes** within guardrails (pause losers, scale winners, reallocate budget), reports a digest to chat, and **writes the outcome back to the flywheel**: the campaign + its result + any human correction become labeled data for the next customer. The whole path is traced (`projectId` + `agentRunId`).

## Boundaries that must hold

- **Sync vs durable:** the request thread only _persists a message_ and _starts a run_. Everything long is a durable task; clients follow via Realtime.
- **AI-as-member:** the AI has no ambient power. It acts through scoped Fastify endpoints and typed tools; it appears in chat by `INSERT`ing rows.
- **Money/accounts gated in code:** ad spend can never exceed the pre-authorized budget; connecting accounts, spending, and publishing require explicit authorization. Prompts cannot move money or go live on their own.
- **Everything is event-sourced:** each transition (plan diff, tool call, publish, spend, escalation, approval, payout, optimization) is immutable for audit — and is the raw material for the flywheel.

## Feedback & flywheel capture (what makes step 10 compound)

- **Outcomes** (impressions → clicks → conversions → revenue) are attributed to the campaign/asset that produced them and ingested into RAG.
- **Human-node corrections** (what the expert changed and why) are captured as labeled examples.
- **User signals** (approve/reject/edit, thumbs) are captured inline from chat.
- These feed [learning-flywheel.md](../10-architecture/learning-flywheel.md); over time the AI needs fewer human corrections for the same quality.

## Failure branches (must be handled)

- **Node no-show / offer expiry** → auto-cascade to the next ranked marketer.
- **Waitpoint expiry** → escalate to ops; never hang.
- **Deliverable/proof rejected** → back to `IN_PROGRESS` with structured feedback + bounded re-do.
- **Ad-policy rejection / brand-safety flag** → pause, revise, re-submit; never silently keep spending.
- **Underperforming campaign** → auto-pause on guardrail breach (CPA ceiling), escalate for human review.
- **Crash/deploy mid-run** → durable replay from the last completed step; idempotency prevents double-publish/double-spend.
- **User pause/kill-switch** → honored at the next safe checkpoint (also pauses live spend).

See [ai-orchestrator.md](../30-modules/ai-orchestrator.md) for the state model, [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) for channel execution, [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) for the node lifecycle, and [architecture.md](../10-architecture/architecture.md) for the topology.
