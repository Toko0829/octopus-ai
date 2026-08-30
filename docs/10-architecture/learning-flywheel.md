# Learning Flywheel

> How Octopus gets smarter from real usage — the compounding data loop that is the actual moat. This is cross-cutting: it spans RAG, the orchestrator, the human-node marketplace, and analytics. Update when a flywheel mechanism, the feedback capture, or the data governance changes.

## Why this exists

We are **not** building the everything-product on day one. We ship one vertical (full-funnel digital marketing for creators), run it for real customers, and let real usage make the system better. "The RAG trains on usage" — stated precisely — means **four compounding mechanisms** turn every job into data that improves the next job. More customers → more outcomes + corrections → smarter Octopus → better results → more customers.

> Precision note: **RAG retrieves, it does not learn by itself.** The flywheel is the machinery around it (ingestion, labeling, optimization, and eventual fine-tuning) that makes retrieval — and later the model — improve.

## The four mechanisms

### 1. Ingest campaigns + outcomes (RAG grows with reality)

- Every executed campaign/asset and its **measured outcome** (impressions → clicks → conversions → revenue/ROAS) is written back as structured rows **and** contextualized, retrievable knowledge.
- Retrieval can then answer _"what worked for creators/products like this one"_ with **citations to real results**, not generic best-practice.
- Structured outcomes live as typed rows (`campaign_outcomes`, `creative_performance`); narrative learnings become dated, cited chunks.
- **Cold-start:** seed with curated public marketing knowledge + ad-policy rules; real-outcome coverage grows over time and is preferred by retrieval as it accrues.

### 2. Human-node feedback as labeled data

- Expert marketers (human nodes) review, correct, and approve the AI's work. **Every diff — what they changed and why — is captured as a labeled example.**
- Approvals are positive labels; rejections + edits are correction pairs (AI output → expert output).
- This dataset powers eval, retrieval re-ranking signals, few-shot exemplars, and (later) fine-tuning.
- **Key metric: the human-correction rate must trend DOWN over time** — proof the AI is learning the vertical.

### 3. Auto-optimize on live metrics (close the loop)

- Live performance flows back into the running campaign: pause losers, scale winners, reallocate budget, iterate creative — **within guardrails** (spend caps, brand-safety, CPA/ROAS ceilings).
- Optimization decisions + their results are themselves logged as outcome data (mechanism 1) — the loop feeds itself.
- Bandit/experiment framing (A/B, budget reallocation) makes the optimization measurable and safe.

> **The first arc is live: pause losers on a CPA ceiling breach** ([ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)). The optimize sweep judges the measured whole days against the owner-typed `campaigns.cpa_ceiling` and pauses a breaching campaign, and **the decision is logged as data**: `campaign.auto_paused` carries the full arithmetic (spend, conversions, ceiling, allowance) beside the trigger-written transition, so this mechanism's first decisions are auditable and, later, learnable. Scale, reallocate, creative iteration and the bandit framing are still not built, and the decision _results_ (did pausing help) have no reader yet: the loop has begun deciding and has not begun learning from its decisions.

### 4. Fine-tune a proprietary model (later, deferred)

- Once the labeled dataset (mechanisms 1–2) is large and clean enough, **fine-tune a dedicated model** (or train adapters/reward models) on real outcomes + expert corrections.
- Deferred until Phase 3 data exists (see [roadmap.md](roadmap.md)); RAG + few-shot carry quality until then.
- Evaluated against the same golden set + online metrics before it can replace/augment the base model.

## Feedback capture (where the data comes from)

> **v0 is live (Phase 1).** `feedback_events` (`20260812130000`) records every approve / request-changes on a plan card: who decided, which verdict, the note explaining a rejection, and the judged payload captured at decision time. That last part is denormalised deliberately, since the embed's state changes after the verdict and a label has to describe what was actually judged. The table is **append-only by grant**, because a training signal that can be rewritten after the fact is not evidence. This is the first labelled data the system collects and the basis of the correction-rate metric below. Not yet built: node corrections (mechanism 2 proper), and any use of these labels in retrieval or eval.
>
> **Outcome _recording_ is live, and outcome _ingestion_ is not.** The metrics sweep writes `campaign_outcomes`, so mechanism 1 has its raw material for the first time: one append-only row per campaign per closed UTC day per source, carrying spend, impressions, clicks, conversions and revenue. Nothing yet turns those rows into retrievable knowledge, and nothing yet acts on them, so the flywheel has begun collecting and has not begun spinning. The two halves are named separately here because "outcomes are captured" and "retrieval prefers real outcomes" are very different claims and only the first is true today.
>
> Two properties of that table matter to this document specifically. It is **append-only including for `service_role`**, so a measurement cannot be rewritten after the fact, which is the same stance `feedback_events` states and this table actually enforces. And a correction is a **new row** with `source = 'manual'` rather than an edit, so the number we pulled and the number a person says is right both survive with their provenance attached, and anyone reading them can see that they differed.

| Source             | Signal                                        | Captured in                                            |
| ------------------ | --------------------------------------------- | ------------------------------------------------------ |
| User in chat       | approve / reject / edit, thumbs, comments     | `feedback_events` **(live)**                           |
| Human node         | corrections, approvals, deliverable diffs     | `node_feedback`, `engagements`                         |
| Channels/analytics | impressions, clicks, conversions, ROAS, spend | `campaign_outcomes` **(live)**, `creative_performance` |
| Agent itself       | plan diffs, tool results, confidence          | event-sourced `events`                                 |

All capture is **event-sourced and immutable**; the flywheel datasets are **projections** of that log, so nothing is lost and everything is auditable.

## Data pipeline

```
run/execute → measure outcomes ─┐
user + node feedback ───────────┼─▶ event log (immutable)
                                │
                                ▼
              projections: campaign_outcomes · creative_performance ·
                           correction_pairs · golden_set candidates
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
        RAG ingestion     eval / retrieval    fine-tune corpus
        (mechanism 1)     signals (2,3)        (mechanism 4, later)
```

## Governance, consent & safety

- **Consent + privacy:** customer data used to improve the system is governed by ToS + explicit consent; anonymized/aggregated where possible; **no PII in the training/RAG corpus** (see [security-compliance.md](security-compliance.md)). Per-customer opt-out honored.
- **Tenant isolation:** a customer's _raw_ private data is never retrievable by another tenant; only **anonymized, aggregated learnings** enter the shared corpus.
- **Quality gating:** ingested outcomes are validated (attribution sanity, outlier detection) before they can influence recommendations; poisoned/low-quality data is quarantined.
- **Injection safety:** all captured external content remains untrusted data, never instructions.
- **Eval gates:** flywheel changes must pass the RAG eval thresholds ([rag.md](rag.md)) before promotion.

## Metrics (flywheel health — see [analytics.md](../30-modules/analytics.md))

- Outcome-labeled data volume (and % of runs with attributed outcomes).
- **Human-correction rate over time** (target: down).
- Retrieval-of-real-outcomes coverage (share of recommendations backed by real results).
- Outcome lift: results for customer N vs. customer 1 (is the flywheel paying off?).
- Model eval scores over time (pre/post fine-tune).

## Related

Mechanisms are implemented across [rag-knowledge.md](../30-modules/rag-knowledge.md) (1), [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) (2), [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) (3), and [analytics.md](../30-modules/analytics.md) (metrics). RAG mechanics in [rag.md](rag.md).
