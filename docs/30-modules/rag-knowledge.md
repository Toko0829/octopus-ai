# Module: RAG & Knowledge Base

> The jurisdiction-aware knowledge system: ingest, contextualize, index, and retrieve legal, permit, tax, supplier, and cost-benchmark knowledge with citations, freshness, and hybrid retrieval + rerank. Exposed to the agent as the `rag_retrieve` tool.
>
> **Owner paths:** `services/ai/**` (Python; `packages/rag` never existed and predates [ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) · **Depends on:** infra-devops (pgvector, storage, the ticker that schedules re-crawls), integrations (embedding/rerank/parser providers) · **Depended on by:** ai-orchestrator, business-projects-workflow.
>
> The full engineering spec lives in [rag.md](../10-architecture/rag.md); this module doc is the operational/domain view. Update both on any ingestion/retrieval/model/eval change.

## The corpus decides which words work, and that is now measured

Retrieval is sensitive to the exact metric word, and the margin is what makes it so. Two phrasings of one intent against the same corpus:

| goal                                    | result                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| marketing plan to get **registrations** | `refusing-v0`, 25 candidates, none above threshold      |
| marketing plan to get **signups**       | `grounded-plan-v1`, 150 candidates, full six-stage plan |

The corpus says "signups" throughout and never says "registrations". At a 1.76x threshold margin a synonym the corpus does not contain simply falls through, so a person who says "register on my website" is refused where one who says "sign up" is served, for the same request.

**This is a corpus gap, not a retrieval defect.** The fix is vocabulary coverage: the documents should use the words people actually use, including registration, subscriber, enquiry and booking alongside signup. A prompt instruction telling intake to normalise the metric is the wrong lever, and this project has measured three times what happens to prompt-level dispositions. Add a golden case with each vocabulary the corpus takes on, per the standing rule that the negative half is load-bearing.

Until then the failure is at least legible: `refusing-v0` names it as nothing retrieved rather than as a gate refusal, which is the distinction those separate cores exist to preserve.

## Crawled sources, and what each page actually produced

The corpus is no longer only ours. A checked-in registry
(`apps/api/src/lib/crawl-registry.ts`) names public pages at regulators and ad
platforms; the ticker's sweep re-reads them on a cadence, hashes the text, and
calls `POST /ingest` only when the page changed. Citations from these documents
carry a URL and the date we read it, so a reader can open the thing being cited.
That was the point: until this existed, every citation the product rendered
pointed at a document only we hold.

**Four documents are live**, 42 chunks against the internal corpus's 43:

| Document                                              | Publisher         | Market | Cadence | Chunks |
| ----------------------------------------------------- | ----------------- | ------ | ------: | -----: |
| Google Ads policies overview                          | Google Ads policy | US     |  weekly |     16 |
| Google Ads personalized advertising policy            | Google Ads policy | US     |  weekly |      9 |
| Google responsive search ad format spec               | Google Ads help   | US     |   daily |     11 |
| ICO guide to PECR: electronic and telephone marketing | ICO               | UK     | monthly |      6 |

### What the first run measured, including where it contradicted the plan

Nine sources were registered on reasonable-looking URLs. **Seven fetched, and
three of the seven were not documents.** Both directions of that were a surprise,
which is the argument for measuring rather than reasoning about which pages a
fetcher can read:

- **The two FTC pages were predicted to be the reliable ones and are blocked.**
  `403` from Akamai, and the diagnosis is specific: the same request without a
  `user-agent` returns `200`, so it is our declared crawler that is refused. We
  are **not** removing or disguising the identification to get around that. A
  crawler that will not say who it is is one an operator can only block, and
  going quiet to defeat a block is the same act as spoofing a browser. The
  entries are removed rather than left to log an error forever, because a known
  permanent failure reported monthly is how people learn to ignore crawl errors.
  If the block lifts, re-add them.
- **Meta Advertising Standards was predicted to fail, fetched perfectly, and was
  dropped anyway.** 25 chunks, server-rendered, substantive. The eval is what
  removed it: it caused the only leak and crowded the document that answers an
  unrelated question out of its own results. See "Adding crawled sources broke
  it" below. Fetchability and usefulness are separate questions, which is not
  obvious until they disagree.
- **Three pages returned navigation.** The ICO section landing page, the EDPB
  guidelines page and the Meta ads guide all answered `200` and stored between
  two and three chunks of site chrome. The first two are hubs: they list links to
  the guidance rather than containing it, and the EDPB's actual text is in a PDF,
  which the fetcher refuses by design. The Meta ads guide builds its spec tables
  in the browser.
- **One of them was in Georgian.** The Meta ads guide localises from the
  requesting IP, so the stored "source" was a Facebook menu in the language of
  wherever the crawler happened to be running, while the row claimed
  `lang: english` and built its sparse index with the English configuration on
  top of it. The fetcher now sends `accept-language: en`. A corpus whose language
  depends on where the crawler sits is one nobody can reason about.

**A registry entry is verified by reading what it stored, not by its status
code.** That is the rule the first run produced. A `200` means a server answered;
it says nothing about whether the answer is a document, and two or three
chunks of navigation apiece in a corpus of 110 is not a small problem, because navigation is
retrievable and will eventually be cited as though it were guidance.

The ICO entry was **repointed rather than dropped**: the section landing page
became `guide-to-pecr/electronic-and-telephone-marketing/`, which is the guidance
itself and yields real text on consent, opt-in versus opt-out, and the B2B rules.
The three junk documents were **deleted rather than superseded**, since
superseding claims a thing was true and has been replaced, and none of them was
ever a document.

### Families still uncovered, stated rather than implied

- **US disclosure guidance (FTC)** is blocked, as above. The internally-authored
  `ftc-disclosure-basics` remains the corpus's coverage of that topic, and it is
  still labelled `internal`, so nothing claims the FTC said it.
- **EU** has no entry at all. The EDPB publishes guidelines as PDFs; EUR-Lex's
  HTML view is built in the browser; the Commission URLs tried do not exist. The
  one page found that both worked and covered the topic was a private site, and
  labelling that `official` would be precisely the fabricated provenance this
  module refuses. **UK is covered and EU is not**, and those are different
  jurisdictions: PECR is not ePrivacy as a member state applies it, and this doc
  will not let one stand in for the other.
- **Meta is uncovered entirely**, not only its format specs: the ads guide builds
  its spec tables in the browser, and the Advertising Standards hub fetched fine
  and was removed on retrieval quality. Re-registering it is reasonable once
  parsing can extract a section rather than a whole hub.
- **Facebook ad format specs** are uncovered while Google's are covered, which is
  why `scope-ad-specs` stays a scope negative. It now guards something sharper
  than it did: not "we have no specs" but "we have Google's, and stretching them
  to answer a question about Meta is the failure".

Layout-aware parsing (rag.md step 4) is the fix for most of this and remains
unbuilt. Until it exists the registry stays short and hand-verified, which is the
honest trade rather than a temporary one.

## Sources a user supplies

The corpus is no longer only ours. `POST /sources` ingests a document about the user's own business, scoped to their room, and retrieval blends it with the shared corpus: shared rows always, that room's rows to that room, nobody else's ever.

**Why it exists is measurable rather than aspirational.** Before it, every artifact closed with a sentence naming what it could not ground, and ad copy came back written about advertising rather than about the product. The pipeline was correct and the knowledge was missing.

Stored as `authority: vendor`, `doc_type: user-source`. No new authority value: the business speaking about itself is the vendor case, and inventing an enum member to describe it would be the kind of invented provenance `corpus.py` already refuses.

**One `knowledge_sources` row per room**, labelled with the room id. Document identity is `(source_id, title)`, so a shared source row would make two workspaces that both title something "Our product" supersede each other's documents. Per-room labelling confines that collision to the room where superseding is the correct behaviour, which is also what makes re-submitting an edited description work.

**Measured after wiring it.** A product description ingests to one chunk, re-submitting identical text is `skipped_unchanged` with nothing re-embedded, and a different room retrieving the same goal sees none of it. It surfaces when the query is about the product ("what does this product do", "flashcards for students revising") and not when the query is about method ("promote website to get signups"). That is the cross-encoder behaving correctly rather than a scoping fault, and it means a source improves the steps that ask about the business while method steps still ground in the principles corpus. Making product knowledge reach every step regardless of query is a separate change, and it belongs with `context` rather than with retrieval, since a person's own description is not a source to be cited.

## Responsibilities

- Own the knowledge corpus — **reference knowledge + real outcomes** — and its freshness.
- Compile **playbooks** (archetype × market/jurisdiction pack) for the workflow engine — first the [full-funnel marketing playbook](../60-playbooks/full-funnel-creator.md).
- Serve grounded, cited retrieval to the agent, **preferring real outcomes** ("what worked for customers like this") as they accrue.
- Run the outcome-ingestion side of the [learning flywheel](../10-architecture/learning-flywheel.md).

> **Implementation status (Phase 1):** ingestion and hybrid retrieval are live in `services/ai`. Schema in `20260728210000_rag_schema.sql`, RRF fusion in `public.hybrid_search`. A **ten-document** seed corpus lives in `services/ai/corpus/` for the US market. Seed or re-seed with `uv run --directory services/ai python -m octopus_ai.seed`; re-running is a no-op unless a document, the chunker, or the embedding model changed.
>
> Corpus coverage against the six funnel stages in [marketing-growth-engine.md](marketing-growth-engine.md):
>
> | Stage       | Documents                                                                            |
> | ----------- | ------------------------------------------------------------------------------------ |
> | Strategy    | `positioning-icp`, `offer-design`                                                    |
> | Content     | `content-strategy`                                                                   |
> | Creative    | `creative-direction`                                                                 |
> | Channels    | `paid-ads-cpa-control`, `seo-early-stage`, `lifecycle-email`, `organic-social`       |
> | Conversion  | `landing-conversion`                                                                 |
> | Measurement | partial, inside `paid-ads-cpa-control` (attribution). **No dedicated document yet.** |
> | Compliance  | `ftc-disclosure-basics`                                                              |
>
> Written to be durable: they carry principles and diagnostics rather than platform specifics (character limits, ad formats, current fee levels), because those go stale between crawls and [rag.md](../10-architecture/rag.md) forbids quoting them from memory. Volatile specifics belong in crawled sources with effective dates, or as typed rows, not in hand-authored prose.
>
> **The seed corpus is internally authored and labelled `internal`.** It is deliberately not attributed to regulators or ad platforms: a fabricated citation is worse than none, because the entire value of a citation is that the reader can check it. Alongside it there are now **four externally-sourced documents** carrying a real publisher, a real URL and the date we read it. See "Crawled sources" below.
>
> **Not built yet:** LLM-generated contextual prefixes (a metadata-derived prefix is used instead), layout-aware parsing (the fetcher is a hand-rolled tag stripper, which is why the registry is shorter than it looks), the remaining query transformations (self-query, HyDE), and the Ragas/DeepEval gate. **Crawlers, the freshness pipeline, query decomposition and the groundedness gate are built** and are the production path. `eval_golden_set` exists as a table but is empty.

## In-Postgres pgvector (rationale)

Vectors live in the same Postgres as everything else — relational, RLS-permissioned, transactionally consistent, one system to run. See [ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md). Schema: `documents` + `doc_chunks` (`halfvec(1024)` HNSW cosine + generated `tsvector`), plus typed `suppliers` / `cost_benchmarks` rows.

## Ingestion pipeline

`registry → crawl → change-detect → parse → normalize → chunk → contextualize → embed → index → structured-load → validate → observe`. Heavy work runs as background jobs (pg-boss / Trigger.dev), never in the request path. Details + the 12 steps in [rag.md](../10-architecture/rag.md).

## Retrieval

**Query decomposition (live)** → dense (local BAAI `bge-m3`, or OpenAI `text-embedding-3-large`, 1024 dims either way — [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)) + sparse (`tsvector`/BM25) → **RRF (k=60)** → in-process **`bge-reranker-v2-m3`** cross-encoder ([ADR-0009](../40-adr/0009-local-reranker.md)) over **top-25** → top 6–8, with a relevance threshold that **drops** weak chunks → **groundedness gate** (live), which refuses when the survivors rank well but do not answer the question. Candidate depth is measured against corpus size rather than fixed; see ADR-0009.

> **Decomposition splits a goal into per-stage sub-queries, each reranked on its own.** A broad goal ("get me my first 100 customers") otherwise retrieves whichever funnel stage matches best, and the planner correctly leaves the rest empty rather than inventing steps. Measured on the golden set: coverage of a broad goal went **0.33 → 1.00**.
>
> The cheaper design was tried first and **measured as worthless**: searching every sub-query but running one rerank against the original goal changed nothing, because candidate breadth was never the bottleneck (40 candidates against a ~43-chunk corpus). The bottleneck is the rerank, where a vague goal scores uniformly low (0.066, against 0.474 for a focused query). So it costs one rerank per sub-query. That was a hard constraint while rerank was a metered API call; since [ADR-0009](../40-adr/0009-local-reranker.md) moved it in-process the cost is CPU rather than quota, and the count is bounded by judging breadth from the goal's wording (87 calls per eval run became 49).
>
> **It is additive to grounding, never a source of it.** The goal is searched first and the sub-queries are abandoned if it retrieves nothing. Without that gate the golden set caught a real leak: "how to get a car licence" decomposed into plausible marketing sub-queries, each legitimately retrieved marketing content and cleared the threshold, and the agent ended up holding cited sources for a question the corpus cannot answer. That is the exact failure the groundedness gate exists to prevent, and it is why the negative half of the golden set exists.
>
> **Cost recorded honestly:** MRR fell 0.95 → 0.76. Merging survivors from several sub-queries pushes the single best chunk further down the list, and the planner reads all of them, so this is an acceptable trade for coverage rather than a free win.

> **Switching embedder re-embeds the corpus, and the code enforces it.** The ingestion content hash covers the active embedding model, so a provider change supersedes every document instead of skipping it as unchanged. Without that, one corpus would hold two incompatible vector spaces and retrieval would degrade silently. Note also that `rerank_min_score` was calibrated against Cohere scores over OpenAI-embedded chunks, so it must be re-calibrated after a switch rather than assumed to carry over.

## Jurisdiction packs

- Versioned, **dated, cited, city-granular** bundles keyed `country → region → city`.
- **US + EU first** (e.g. `US/TX/Austin`, `EU/DE`); **Georgia/Tbilisi** documented as the founding pack.
- Guard against **jurisdiction bleed** (country of Georgia vs US state of Georgia); never generalize rules across borders.
- The **archetype × jurisdiction compiler** turns a pack + business archetype into a concrete, ordered, cost-estimated task DAG (handed to [business-projects-workflow.md](business-projects-workflow.md)).

## Structured sources

Suppliers and cost benchmarks are stored as **typed rows**, not prose chunks, so the agent can filter/sort/compare them precisely (price, geo, category) rather than retrieving fuzzy text.

## Freshness & scheduling

Cadence re-crawls per source, run by the `apps/api` ticker's sweep rather than by `pg_cron` · page-hash change detection before any embedding is paid for · content-hash supersession · `valid_from`/`valid_to` effective-dating · "last verified" surfaced to the user · high-stakes stale data routed to a human node for re-verification.

**Not `pg_cron`, and the reason is structural rather than preference.** pg_cron executes SQL, SQL cannot make an outbound HTTP request, so the schedule and the fetcher cannot both live in Postgres; the original spec would always have needed something else to do the fetching. That something is the ticker [ADR-0010](../40-adr/0010-postgres-durable-runner.md) already built, and the sweep rides its pass under the claim it already holds. The registry is a checked-in TypeScript module (`apps/api/src/lib/crawl-registry.ts`) rather than a table, because every entry is an editorial claim about provenance and a file gets reviewed in a diff by a person.

## Evaluation

**Built (retrieval).** `services/ai/eval/golden.json` + `python -m octopus_ai.evaluation` run the real pipeline over a versioned golden set and score two asymmetric halves:

| Half          | Asks                                         | Gate                     |
| ------------- | -------------------------------------------- | ------------------------ |
| **Positives** | did the expected document surface            | recall ≥ 0.80            |
| **Negatives** | did an out-of-scope query return **nothing** | zero leaks, no tolerance |

The asymmetry is deliberate. A miss makes the agent refuse something it could have answered: unhelpful, but safe. A leak on a negative hands the planner loosely-related text, which it then grounds a confident cited answer in. One leak fails the run.

The golden set is a **file, not `eval_golden_set` rows**, because document UUIDs are generated per ingest and differ between environments, so a set keyed on them cannot travel between a laptop, CI and production. It is keyed on document title, and its queries are phrased as a founder would ask rather than in the corpus's wording, since a set that echoes the corpus measures string matching and flatters every retriever. The table remains for online/production scoring, which does have stable ids.

Baseline on the ten-document corpus with bge-m3 was **positive recall 1.00, MRR 1.00, zero leaks**, and it survived the corpus tripling from four documents to ten without recalibration.

### Adding crawled sources broke it, and one document was the whole reason

Growing the corpus from 43 chunks to 110 **failed the gate on the first run**, and what the failure cost to diagnose is the most useful thing this section records.

Every positive passed, including all five new ones. The leak was `neg-car-licence`, "how to get a car licence", which came back holding **Meta Advertising Standards** at 0.008 against a 0.0013 threshold. The match is a **lexical collision, not a topical one**: Meta's standards contain a clause saying ads must not request government-issued identifiers including driver's license numbers, and the document does not answer the question in any sense.

**Raising the threshold was the obvious fix, and it is wrong.** 0.013 sits neatly between that 0.008 and the weakest positive's 0.022, and it fails for a reason that generalises: **those bands are 2.75x apart on a signal that moves 3x between identical runs.** `creative-brief` measured 0.116 on one run and 0.035 on the next of the same commit, because decomposition is a model call and different sub-queries score differently. A threshold needing a 2x margin cannot be set against that. Measured directly rather than argued: at 0.013 the bare goal "is it worth posting on social media myself or should I just run ads" retrieves **nothing at all**, and a full run scored recall 0.75 with four misses. Raising the threshold does not trade a leak for safety, it trades a leak for a gate that refuses legitimate goals at random. Reverted to 0.0013.

**Moving the negative into `scope_negatives` is also wrong, and a test says so.** That set is defined as marketing questions in marketing words, and `test_scope_negatives_are_marketing_vocabulary` asserts it. A car licence question shares no marketing vocabulary; it is lexically inside the corpus only because a policy page happens to contain the word "license". Filing it there would be putting an easy-direction negative into the hard-direction set to make a gate green, which is the move this document warns against two sections above.

**So the document went instead, and the measurement is unambiguous.** With `Meta Advertising Standards` removed, the same query's top score falls from 0.007 to 0.001, below the threshold, while every other crawled document sits at 0.001 or 0.000. One document, one leak.

It was not a marginal call once a second measurement landed beside it. Asked the legitimate question "is it worth posting on social media myself or should I just run ads", retrieval returned **five Meta chunks and two Google ad-policy chunks in its top eight, and not `Organic social for a founder-led product`**, which is the document that answers it. A 25-chunk policy hub written in general marketing vocabulary acts as a magnet for any marketing-adjacent query, so the leak and the crowding are the same property seen from two sides.

**What that costs, stated plainly:** Meta-specific ad-policy coverage. The ad-policy family survives on Google's two documents, and `rag-knowledge.md` already says the corpus carries principles while crawling is for volatile specifics and jurisdiction guidance, which is what the RSA format spec and the ICO guidance are. Re-registering Meta is reasonable once layout-aware parsing (rag.md step 4) can extract a section rather than a whole hub.

Final state, measured on the live corpus: **four external documents, 42 chunks** beside the internal corpus's 43.

|                            |          |
| -------------------------- | -------: |
| positive recall (min 0.80) | **1.00** |
| coverage                   |     0.98 |
| MRR                        |     0.91 |
| negative leaks (max 0)     |    **0** |

Fifteen positives pass, including all four new externally-sourced ones, and every negative returns nothing. Coverage at 0.98 is one expected document out of roughly seventeen on the broad goal, inside the 0.97 to 1.00 range this eval has always moved through between identical runs, and it is not a gate threshold.

### And the fix that did not reach the running system

Worth recording because it wasted a full twenty-five minute run and because the shape recurs. `config.py` writes every default **twice**, once on the dataclass field and once again in `get_settings()`. So changing the field moved the number the unit test reads and left the number the service uses. The guard test went green, the eval banner printed the **old** threshold, and the run reported a leak that had supposedly just been fixed.

A guard that passes while production disagrees with it is worse than no guard, and nothing else would have caught this: a type check cannot see it, the test was green, and the only visible symptom was a gate failure that looked like the recalibration having been the wrong call. It was the wrong call, but not for that reason, and the two failures were indistinguishable until the banner was read.

The threshold is now a single module constant referenced from both places, and a test asserts that `get_settings()`, the path the service actually takes, yields it. The other sixteen settings keep the duplicated pattern deliberately: it is survivable for a model name, and rewriting them all is a different change from this one.

## The groundedness gate

Between retrieval and generation, `groundedness.assess` asks one question of the retrieved sources: **do these answer the goal, or do they merely rank against it?** Live, on by default (`GROUNDEDNESS_CHECK`), and the reason Phase 2 can begin: while Phase 1 was read-only the leak above produced a bad answer, and the moment a plan can spend money or publish, it produces a bad action.

Five properties it depends on, each of which is a way it could quietly stop working:

- **It judges the exact sources block the planner will receive.** Building a separate one would let the gate approve one set of material while the planner grounds in another.
- **It fails closed.** A provider failure, malformed JSON, or a non-boolean `supported` all return `unverified`, and the caller refuses. Same asymmetry the eval already applies: a miss is unhelpful but safe, a leak is not. `bool("false")` is `True`, so the boolean is type-checked rather than coerced; one implicit coercion there would turn the gate into a no-op that still logs as though it ran.
- **A refusal names its own reason.** `refusing-v0` (nothing retrieved), `refusing-ungrounded-v1` (retrieved, judged not to answer) and `refusing-unverified-v1` (check could not run) are separate cores because they mean different things: the first two are corpus signals that should drive what gets ingested next, the third is an operational signal that should page someone. Collapsing them would make a provider outage look like a coverage gap on the same dashboard. It also keeps the **copy honest**: a user whose question is covered must never be told it is out of scope because a call failed, which is the same class of defect this refusal copy already had once.
- **Partial coverage is still supported.** The gate asks whether the sources address what was asked, not whether they address all of it. The plan card is built to render empty stages, so demanding total coverage would refuse the product's own north-star goal.
- **It blocks before generation, not after.** A plan that is written and then discarded has already cost the call, and the discarded text is one refactor away from being shown.

### Measuring it

`scope_negatives` in `golden.json` is its set: marketing questions, in marketing vocabulary, that this corpus does not answer. They are **deliberately not** ordinary negatives, because retrieval leaks on them by design and filing them under `cases` would fail the retrieval gate forever for a property retrieval does not have.

```bash
uv run --directory services/ai python -m octopus_ai.evaluation --gate
```

Both halves run in one pass, and that is the point: a gate measured only against questions it should refuse scores 1.00 by refusing everything, and that version would ship. So it also scores the **false-refusal** rate over the positives. Thresholds mirror the retrieval gate's asymmetry: block rate 1.00 (zero tolerance), pass rate ≥ 0.80.

**Measured, on `gpt-5.4-nano` over 6 scope negatives and 11 positives:**

| Run              | Blocked |   Passed |      |
| ---------------- | ------: | -------: | ---- |
| First            |    1.00 | **0.64** | FAIL |
| After prompt fix |    1.00 | **1.00** | PASS |

**The first run is the more useful of the two.** It blocked every uncovered question and refused four legitimate goals: `cpa-too-high` and `creative-brief`, both of which have a dedicated corpus document, and `broad-first-customers`, which is the product's own north-star example. The refusal reasons gave the diagnosis away, because each one asserted that the sources _did_ cover the goal and then answered false anyway ("The sources discuss CPA control and testing/scaling principles").

That is the **same failure ADR-0009 already records**, where an over-tightened decomposition prompt took that same north-star case from coverage 1.00 to 0.33. Second occurrence, different component. The shared cause is asking a model for a disposition ("be strict", "when unsure, answer false") instead of a test it can apply.

The fix was to make the question operational: **"could you write concrete steps for this goal quoting only these sources?"** Plus a self-check that removes the cheap refusal: **if the answer is false, `reason` must name the specific thing the sources lack, and if it cannot be named the answer is true.** The "when unsure, answer false" instruction was deleted, along with the list of ways adjacency shows up, which was priming the model to go looking for it.

**Recorded rather than smoothed over: three of the six scope negatives never reached the gate.** Retrieval refused them outright (`chunks=0`), so the 1.00 block rate is true of the system and the gate itself was exercised on three cases, not six. The `blocked_by` column exists to make that visible rather than to let a system-level number stand in for a component-level one. It is an argument for adding scope negatives that demonstrably leak, not for trusting the headline.

**This pass is credentialed and LLM-dependent, and is deliberately not in CI**, for exactly the reason the Ragas faithfulness metrics are not: it calls a model, so it bills per run and does not return the same answer every time. Stapling it to the deterministic gate would make every merge depend on a provider being up. What is gated in CI is the _logic_: that the verdict parser rejects a non-boolean, that every failure path returns `unverified`, and that the gate is called before generation.

**Partly built (generation), and the split is between what needs a judge and what does not.** `--plan` (`plan_eval.py`) scores the **structure** of the plans the planner produces: did a card come back at all or did it fall back to prose, do all six stages exist, does every citation point at a supplied source, does an AI-owned step carry one (rule 10, and the router escalates it if not), is the copy inside the brand's rules. Each is a yes or no about a structure, computed from the response alone, so the scoring is deterministic and has hermetic tests even though running it needs credentials.

That gap had a cost. Retrieval was gated and the gate had its own two-sided pass, and **nothing checked what the planner then did with the sources**, so a token limit that truncated the plan JSON went unnoticed: `parse_plan` rejected it, the core degraded to cited prose exactly as designed, and every whole-funnel goal quietly produced no plan card while no number moved. `card_rate` is held at **zero tolerance** for that reason, since a fallback means the feature did not happen; structural defects inside a card are scored as a rate on the same asymmetry as retrieval, because a flawed card is still something a person can read and correct.

**Still not built.** Ragas/DeepEval faithfulness and answer relevancy (≥ 0.75 and ≥ 0.8, with context precision ≥ 0.7 and context recall ≥ 0.8) need an LLM judge, which costs money per run and returns a different number each time. Whether the plan is any _good_ is exactly the part that needs one, and it belongs in a separate credentialed pass rather than in the deterministic gate above.

**There is no rerank quota any more.** Reranking is in-process ([ADR-0009](../40-adr/0009-local-reranker.md)), so an eval run costs CPU rather than provider calls. What was previously the dominant constraint — a trial key's 10 calls a minute against ~81 calls per run — is gone. OpenAI is still needed for decomposition and generation.

- **CI:** wired as its own job, but **it cannot gate until repository secrets exist**, since retrieval needs the Supabase corpus. Until then it emits a warning saying it measured nothing, rather than reporting a green check that proves nothing.
- **CI scope:** the job runs only when a **retrieval-affecting** file changes, which is narrower than all of `services/ai/**` and deliberately wider than the obvious list (it includes `db.py`, `pyproject.toml`, `uv.lock` and `supabase/migrations/`). A docs-only pull request cannot regress retrieval, and running the gate anyway once spent ~81 rerank calls to prove nothing and then failed on the quota it had just consumed. A skipped run says so in the job summary.
- **Residual variance is expected and is not tuned away.** Shard wall clock differs for two reasons that no split can remove: runner hardware varies about two-fold per call, and a case's cost depends on how many sub-queries decomposition returns, which is decided by a model at run time and cannot be known before the split. One shard may draw three expensive positives and another three cheap ones. The gate is unaffected; only the wall clock moves.
- **CI runs the production reranker**, which is the whole point of a gate. It is now minutes of real CPU on a small runner rather than minutes of waiting on a rate limiter. Its cache key names **both** models, so changing either invalidates it instead of silently scoring with the previous one.
- **The run is sharded five ways, and a shard never returns a verdict.** `--shard i/n --out` writes raw per-case results; `--merge` applies the thresholds once over the whole set. Recall over five cases is a different statistic from recall over fifteen, and 0.80 of five is not 0.80 of the set, so scoring inside a shard would quietly change what the gate means. The merge **refuses to report unless every golden case is present**, because the dangerous failure is a shard that never reports rather than one that errors: the denominator would shrink and a green check would cover a set nobody ran in full.

> **The eval is not deterministic, and two of its four numbers move between identical runs.** Decomposition calls an LLM, so the sub-queries differ each time and both the survivor ordering and which of several expected documents surface move with them. Observed across five runs of the same commit:
>
> | Metric   | Range           | Stable? |
> | -------- | --------------- | ------- |
> | recall   | 1.00            | yes     |
> | leaks    | 0               | yes     |
> | coverage | **0.97 – 1.00** | **no**  |
> | MRR      | **0.83 – 0.95** | **no**  |
>
> Only **recall** and **leaks** are gate thresholds, and both held in every run. A coverage dip of 0.03 is one expected document out of roughly fifteen and is within this noise, not a regression: judge it across several runs or against a deliberately changed variable, never on a single run. The honest reading is that the golden set is small enough at 15 cases that its two derived metrics are indicative rather than precise, which is an argument for growing the set.

**What the pipeline fixes were worth**, measured with the reranker held constant so the change is attributable to the pipeline alone:

| Pipeline            | Rerank calls | Recall | Coverage |  MRR | Leaks |
| ------------------- | -----------: | -----: | -------: | ---: | ----: |
| Before              |       **87** |   1.00 |     1.00 | 0.86 |     0 |
| Decomposition fixed |       **49** |   1.00 |     1.00 | 0.86 |     0 |
| + 25 candidates     |       **49** |   1.00 |     0.97 | 0.95 |     0 |

**Reranker candidates, measured on this golden set.** "Recall @ zero leaks" is the best recall any threshold can reach while still refusing every negative, which is what the gate actually requires. The first two rows are on the **fixed** pipeline; the rest were measured on the old one and are kept so they are not re-litigated:

| Model                                | Params | Recall @ zero leaks | Note                                         |
| ------------------------------------ | -----: | ------------------: | -------------------------------------------- |
| **`BAAI/bge-reranker-v2-m3`** (live) |   568M |            **1.00** | coverage 1.00, MRR 0.91, ~71s/goal @12 cores |
| Cohere `rerank-v3.5` (fallback)      |      — |            **1.00** | coverage 0.97, MRR 0.95                      |
| `cross-encoder/ms-marco-MiniLM-L6`   |    23M |                1.00 | 22x faster, but **English-only**             |
| `cross-encoder/mmarco-mMiniLMv2-L12` |   118M |                0.73 | below the 0.80 floor                         |
| `jina-reranker-v2-base-multilingual` |   278M |             not run | **CC-BY-NC**, non-commercial                 |

Three findings worth keeping, because each contradicts an intuitive reading:

- **Parameter count did not predict quality.** The 23M English model separated the bands perfectly while the 118M multilingual one could not reach the floor at all.
- **A smoke test on hand-written queries inverted the ranking.** Ten author-phrased queries gave every model 6/6 top-1 and made the 118M model look like the winner, until the golden set, whose queries are phrased as a founder would ask, put it at 0.73. Calibrate on the set, never on phrasings it does not contain.
- **The model was blamed before the pipeline was checked.** bge measured 0.82 recall and 265s per goal and was written off as undeployable. The same model on the fixed pipeline reaches 1.00 at 71s. Four defects, all ours: decomposition always emitting the maximum, 20-30 word sub-queries against a cross-encoder trained on six, a sub-query generated every time for a stage with no documents, and 40 candidates reranked against a 43-chunk corpus where **RRF already places the answer at rank 1-3**.

- **Production:** Langfuse tracing + online scoring + citation-coverage checks + thumbs-up/down from chat.

## Multilingual handling

One strong multilingual embedder (OpenAI `text-embedding-3-large`) across the corpus; per-language `tsvector` configs for sparse. Retrieval quality for the later Georgian/Russian pack must be **measured at the eval gate**, not assumed ([ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)). EU languages now; Georgian/Russian for the founding pack.

## Implementation (Python service)

This module is implemented in the **Python AI service** (`services/ai`, LlamaIndex-Python) — ingestion, retrieval, and eval — exposed to the Node agent over a typed HTTP seam ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)). It shares the same Supabase Postgres (pgvector), so retrieval stays SQL over the single source of truth.

## Key entities

`knowledge_sources` · `documents` (jurisdiction/market, business_type, doc_type, effective/valid dates, content_hash, version, lang) · `doc_chunks` (embedding `halfvec(1024)`, `fts tsvector`, context_prefix, parent_id, embed_model) · **`campaign_outcomes` · `creative_performance` (flywheel)** · `suppliers` · `cost_benchmarks` · `eval_golden_set`.

## Risk mitigations

Hallucination (groundedness gate + citations) · staleness (freshness pipeline) · jurisdiction bleed (hard filters, unambiguous keys) · OCR errors (layout-aware parsing + validation) · injection (quarantine) · tenant leakage (RLS on chunks). Full register in [rag.md](../10-architecture/rag.md).
