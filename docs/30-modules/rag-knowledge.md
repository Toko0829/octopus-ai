# Module: RAG & Knowledge Base

> The jurisdiction-aware knowledge system: ingest, contextualize, index, and retrieve legal, permit, tax, supplier, and cost-benchmark knowledge with citations, freshness, and hybrid retrieval + rerank. Exposed to the agent as the `rag_retrieve` tool.
>
> **Owner paths:** `services/ai/**` (Python; `packages/rag` never existed and predates [ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) · **Depends on:** infra-devops (pgvector, storage, the ticker that schedules re-crawls), integrations (embedding/rerank/parser providers) · **Depended on by:** ai-orchestrator, business-projects-workflow.
>
> The full engineering spec lives in [rag.md](../10-architecture/rag.md); this module doc is the operational/domain view. Update both on any ingestion/retrieval/model/eval change.

## The corpus decides which words work, and that is now fixed from both ends

Retrieval is sensitive to the exact metric word, and the margin is what makes it so. Two phrasings of one intent against the same corpus, measured before the fix:

| goal                                    | result                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| marketing plan to get **registrations** | `refusing-v0`, 25 candidates, none above threshold      |
| marketing plan to get **signups**       | `grounded-plan-v1`, 150 candidates, full six-stage plan |

The corpus said "signups" throughout and never said "registrations". At a 1.76x threshold margin a synonym the corpus does not contain simply falls through, so a person who says "register on my website" was refused where one who says "sign up" was served, for the same request.

**The primary fix was the corpus, because that is where the gap was.** The ten pre-existing internal documents now use the words people actually use, woven into prose where they genuinely fit rather than listed: the conversion event in `landing-conversion` is named as "a signup, a registration, a booked call, an enquiry, an app install, a completed purchase, a place on a waiting list", `paid-ads-cpa-control` gained the principle that a CPA quoted without naming its event is not comparable to anything, and `lifecycle-email`, `offer-design`, `positioning-icp`, `content-strategy`, `organic-social` and `seo-early-stage` each carry one or two variants where the sentence wanted them anyway.

Keyword-stuffing was the failure mode to avoid, and the constraint is measured rather than stylistic: a large document written in general marketing vocabulary is what made Meta's advertising standards a magnet, and a synonym list reads exactly like one.

**`vocabulary.py` is the second half**, for the variants prose cannot carry naturally. A curated table of about twenty rules rewrites founder vocabulary into corpus vocabulary (registrations, enrolments, installs, enquiries, demos, clients, buyers, members, MRR), applied once at the top of `Retriever.retrieve` so it covers the goal, every sub-query, the executor's per-step re-retrieval, the seed probe, both eval harnesses, and the goals that skip intake's questions through `_passthrough`.

Four properties, each of which is a way it could have been done wrong:

- **It replaces terms and never adds them.** Query expansion is measured-fatal here: `MAX_REFINED_GOAL_WORDS` is 7 because a nine-word query refused where a five-word phrasing of the same intent grounded. A test asserts no rule grows a query by more than one word.
- **It is a curated domain table, not a dictionary and not a second embedding space.** Dense retrieval is already the semantic synonym layer and is not the stage that fails; the cross-encoder score against the threshold is, and another embedding space does not move it. A general dictionary has no domain, and "registration" neighbours company, vehicle and event registration, which would pull business-formation vocabulary into marketing queries: the exact direction `neg-incorporation` and `neg-car-licence` exist to defend.
- **The guards are the larger half.** "register" maps only when it takes a preposition, so "register my company", "register a trademark" and "register for VAT" are untouched; "clients" is guarded against "email clients"; "members" against "team members". They are pinned per rule in `tests/test_vocabulary.py`, which is the level a pre-retrieval code rule belongs at: a dry run over every query in the golden file confirms all eight negatives and all six scope negatives pass through this module **unchanged**, so a golden case cannot test it. `neg-vat-registration` is the one that also earns its place at the retrieval gate. See "Growing the corpus again spent the margin" for the three that were drafted, measured to leak for unrelated reasons, and deliberately not filed.
- **It does not overlap `strip_particulars`.** That module removes the person's own particulars (their audience, numbers and domain); this one replaces practitioner vocabulary. ICP nouns are deliberately absent here, because mapping domain nouns is unbounded and already solved one layer up.

A prompt instruction telling intake to normalise the metric was considered and rejected: this project has now measured four times what happens to a prompt-level disposition, most recently in `risk.py`. The rule lives in code.

## Crawled sources, and what each page actually produced

The corpus is no longer only ours. A checked-in registry
(`apps/api/src/lib/crawl-registry.ts`) names public pages at regulators and ad
platforms; the ticker's sweep re-reads them on a cadence, hashes the text, and
calls `POST /ingest` only when the page changed. Citations from these documents
carry a URL and the date we read it, so a reader can open the thing being cited.
That was the point: until this existed, every citation the product rendered
pointed at a document only we hold.

**Four documents are live**, 35 chunks against the internal corpus's 64:

| Document                                              | Publisher         | Market | Cadence | Chunks |
| ----------------------------------------------------- | ----------------- | ------ | ------: | -----: |
| Google Ads policies overview                          | Google Ads policy | US     |  weekly |     14 |
| Google Ads personalized advertising policy            | Google Ads policy | US     |  weekly |      7 |
| Google responsive search ad format spec               | Google Ads help   | US     |   daily |      9 |
| ICO guide to PECR: electronic and telephone marketing | ICO               | UK     | monthly |      5 |

Each is smaller than it was, because all four were carrying site chrome that has since been trimmed. See below.

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
chunks of navigation apiece is not a small problem, because navigation is
retrievable and will eventually be cited as though it were guidance.

### The four kept pages were carrying chrome too, and it was masking a leak

That warning was written about the three pages that were **only** navigation, and
it turned out to understate the problem. The four documents that were kept are
real guidance wrapped in a header and a footer, and the tag-stripping fetcher
ingested both. The evidence was a golden negative: "how do I register my company
in the UK" retrieved the ICO document, and the only occurrence of "registration"
anywhere in it was the footer, `Download registration certificate / Who we are /
Careers / Modern slavery statement`. Google's ad-format spec carried a `Register
now` conference banner the same way.

The boilerplate was trimmed from all four checked-in snapshots, front matter and
body preserved: **42 chunks became 35**, so roughly a sixth of the external
corpus was site furniture. Every one now begins and ends on real content, and no
chrome marker survives.

**The useful half is what the removal exposed.** `neg-car-licence` had been
passing, and immediately began leaking: with seven junk chunks gone, real content
had more room in the candidate pool and a weak match surfaced that had been
crowded out. **The negative had been passing because of garbage, which is not a
safety property.** Restoring the chrome would have made the gate green again and
the corpus worse, so the leak was fixed at its source instead, by making the
referral document's fraud section speak about affiliates specifically rather than
about incentives in general.

Layout-aware parsing (rag.md ingestion step 4) is still the real fix and is still
unbuilt. Until it exists, a new registry entry needs its chrome trimmed by hand,
and this is now a checklist item rather than a discovery.

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

> **Implementation status (Phase 1):** ingestion and hybrid retrieval are live in `services/ai`. Schema in `20260728210000_rag_schema.sql`, RRF fusion in `public.hybrid_search`. A **thirteen-document** seed corpus lives in `services/ai/corpus/` for the US market, covering all six funnel stages. Seed or re-seed with `uv run --directory services/ai python -m octopus_ai.seed`; re-running is a no-op unless a document, the chunker, or the embedding model changed, so a vocabulary edit re-embeds only the documents that changed.
>
> Corpus coverage against the six funnel stages in [marketing-growth-engine.md](marketing-growth-engine.md). **All six are now covered**; measurement was the standing gap and is closed:
>
> | Stage       | Documents                                                                                                                                       |
> | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
> | Strategy    | `positioning-icp`, `offer-design`                                                                                                               |
> | Content     | `content-strategy`                                                                                                                              |
> | Creative    | `creative-direction`                                                                                                                            |
> | Channels    | `paid-ads-cpa-control`, `seo-early-stage`, `lifecycle-email`, `organic-social`, `influencer-partnership-outreach`, `referral-affiliate-program` |
> | Conversion  | `landing-conversion`                                                                                                                            |
> | Measurement | `measurement-attribution` **(new)**, with acting on a CPA still in `paid-ads-cpa-control`                                                       |
> | Compliance  | `ftc-disclosure-basics`                                                                                                                         |
>
> `measurement-attribution` deliberately **names no analytics platform**. That is what keeps `scope-ga4-tracking` a valid scope negative: the corpus covers measurement principles, and stretching them into a platform setup question is the failure the gate exists to catch. It is also the standing corpus rule, since platform specifics go stale between crawls and belong in crawled sources with effective dates.
>
> `influencer-partnership-outreach` and `referral-affiliate-program` each converted a scope negative into covered ground, so `scope-influencer-rates` and `scope-affiliate-program` were **promoted to positives** (`infl-pricing`, `aff-structure`) and replaced with sharper near-misses about vendor choice. A scope negative that has become covered does not merely stop testing anything, it fails `--gate` on block rate for being answered correctly.
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

Final state at the time, measured on the live corpus: **four external documents, 42 chunks** beside the internal corpus's 43. Both numbers moved again with the vocabulary change below.

|                            |          |
| -------------------------- | -------: |
| positive recall (min 0.80) | **1.00** |
| coverage                   |     0.98 |
| MRR                        |     0.91 |
| negative leaks (max 0)     |    **0** |

Fifteen positives pass, including all four new externally-sourced ones, and every negative returns nothing. Coverage at 0.98 is one expected document out of roughly seventeen on the broad goal, inside the 0.97 to 1.00 range this eval has always moved through between identical runs, and it is not a gate threshold.

### Growing the corpus again spent the margin, exactly as ADR-0009 predicted

The vocabulary change added three documents and removed seven chunks of crawled chrome, taking the corpus to **99 chunks (64 internal, 35 external)**. Two things were measured on the way, and both are worth keeping because each contradicts an intuitive reading.

**Candidate depth was re-validated and must not be raised.** ADR-0009 left `retrieval_candidates = 25` as a setting tied to corpus size, due for re-measurement as the corpus grew. Swept at 25, 40, 60 and 100 against the grown corpus: the expected document's rank and score were **identical at every depth**, so the pool was never the constraint, while raising it caused `neg-car-licence` to start leaking. The obvious lever was the wrong one in both directions, and 25 stands.

**Three drafted negatives were measured to leak and are deliberately not filed as cases**, recorded in `golden.json`'s own comment with their scores: "register my company in the UK" (ICO, 0.0032), "register a trademark for my brand name" (Google Ads, 0.0017), "what should I pay my first team members" (influencer, 0.0017). Each leaks on genuinely related-ish material rather than on nonsense, which is the "right field-ish, wrong question" shape the **groundedness gate** answers and a ranking threshold cannot. Filing them under `cases` would fail the retrieval gate permanently for something retrieval cannot be asked to do, which is the same argument that created `scope_negatives`.

They also did not test what they were drafted to test. `vocabulary.py` runs **before** retrieval, and a dry run over every query in the golden file confirms all eight negatives and all six scope negatives pass through it unchanged, so the guards are pinned per rule in `tests/test_vocabulary.py` instead, which is the level a code rule belongs at.

**The lesson is the one ADR-0009 already wrote down**, now with a second measurement behind it: the 1.76x margin is not headroom to spend, and each corpus addition consumes some of it. The response is not to raise `RERANK_LOCAL_MIN_SCORE`, which trades a leak for refusals of legitimate goals at random. It is to keep new documents specific, since every leak fixed in this change was fixed by making a document speak about its own subject rather than about a general principle.

### Verification status of this change, stated rather than implied

**The full 35-case gate has NOT been run to completion on the grown corpus.** What was measured is listed below, and the gap is named because a doc that implies a gate ran is worse than one that admits it did not.

| Measured                                                                                               | Result                                                                 |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Full gate, 19-case set, after the vocabulary weave and `vocabulary.py`, before the three new documents | recall **1.00**, coverage **1.00**, MRR **0.97**, **0 leaks**          |
| First 14 of 35 cases on the grown corpus (shards 1 and 2 of 5)                                         | **12/12** positive hits, **0 leaks**, no misses                        |
| All 8 golden negatives, probed directly with decomposition                                             | 5 pass, 3 leak and are recorded above rather than filed                |
| Candidate depth 25 / 40 / 60 / 100                                                                     | identical positive ranks; raising it causes leaks                      |
| Vocabulary rewrite over every golden query                                                             | 6 positives rewritten, **every negative and scope negative untouched** |

Two things are outstanding and neither should be assumed: the **remaining 21 cases**, and the **`--gate` credentialed pass**, which is the only thing that can confirm the two new scope negatives block and that promoting `scope-influencer-rates` and `scope-affiliate-program` did not move the false-refusal rate.

**Why it stopped:** an eval run costs far more wall clock than it used to. Two full runs died on transient Supabase connection drops, `db.py` retries three times which is not enough for a multi-second blip inside a 40-minute job, and the sharded path then measured **~43 minutes per 7-case shard** on a developer machine. Part of that is this change: `measurement` joining `COVERED_STAGES` gives a broad goal a sixth sub-query, and every sub-query is another cross-encoder pass. That is the CPU cost ADR-0009 accepted, arriving in the eval harness rather than in a user's plan.

To finish it:

```bash
uv run --directory services/ai python -m octopus_ai.evaluation --shard 3/5 --out shard-3.json
uv run --directory services/ai python -m octopus_ai.evaluation --merge shard-*.json
uv run --directory services/ai python -m octopus_ai.evaluation --gate
```

`--merge` refuses to report unless every case is present, so a partial set cannot produce a green check by accident.

### And the fix that did not reach the running system

Worth recording because it wasted a full twenty-five minute run and because the shape recurs. `config.py` writes every default **twice**, once on the dataclass field and once again in `get_settings()`. So changing the field moved the number the unit test reads and left the number the service uses. The guard test went green, the eval banner printed the **old** threshold, and the run reported a leak that had supposedly just been fixed.

A guard that passes while production disagrees with it is worse than no guard, and nothing else would have caught this: a type check cannot see it, the test was green, and the only visible symptom was a gate failure that looked like the recalibration having been the wrong call. It was the wrong call, but not for that reason, and the two failures were indistinguishable until the banner was read.

The threshold is now a single module constant referenced from both places, and a test asserts that `get_settings()`, the path the service actually takes, yields it. The other sixteen settings keep the duplicated pattern deliberately: it is survivable for a model name, and rewriting them all is a different change from this one.

## Looking at it: `tools/rag-lens`

Everything above is a number in a table or a paragraph in this file, and the
failures this module has actually had were all the same shape: a **disagreement
between two things that were each individually fine**. The corpus said "signups"
and the founder said "registrations". Meta fetched perfectly and crowded out an
unrelated document. UK is covered and EU is not, and both facts are true. None of
those is visible in any single artefact, which is why each was discovered by
being bitten rather than by being seen.

`tools/rag-lens` renders one self-contained HTML page from files that already
exist:

| View         | Question                                                                           | Input                                                         |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Coverage** | which funnel stage × market cells hold documents, and which are proven retrievable | the corpus front matter, the stage table below, `golden.json` |
| **Margins**  | where every candidate's rerank score sits relative to the drop threshold           | `probe.py`, which runs the real pipeline                      |
| **Run diff** | what a change to the threshold, embedder or decomposition actually moved           | the shard JSON the eval already writes                        |

```bash
python tools/rag-lens/rag_lens.py --current services/ai/shards/*.json
```

**It reports and does not gate.** The thresholds and the pass/fail verdict stay
in `octopus_ai.evaluation --merge`, because a second implementation of the same
arithmetic is a second thing that can disagree with CI. Two views need no
database, no model weights and no virtualenv, which is what makes running it
routine rather than an occasion.

**It is not a production trace viewer, and must not become one.**
[observability.md](../10-architecture/observability.md) pins Langfuse as the
single sink that Ragas and DeepEval publish to. This is the editorial instrument
for corpus quality, which Langfuse does not do and which a trace of one request
cannot answer.

**Its stage map is parsed from the coverage table in this document rather than
copied into the tool**, so a document dropped from the corpus cannot keep showing
as covered. Anything the two disagree about is reported as a finding: a document
no stage claims, a stage naming a document that is gone, a golden case expecting a
title no file carries, a document no golden case asks for. On the run that
introduced the tool, that last check was clean and the first fired four times, on
all four crawled documents: the table below describes the internal playbooks only,
so it under-reports the corpus by the exact set of documents whose provenance is
real.

Retrieval records `RetrievalResult.scored` for this: every candidate with the
rerank score that decided it, kept or dropped. `dropped_below_threshold` counts,
and a count cannot distinguish a survivor that missed by 1.76x from one that was
nowhere near, which is the entire distinction between a corpus that cannot answer
a question and a synonym that refused an answerable one.

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
