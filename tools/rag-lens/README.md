# rag-lens

One self-contained HTML page showing what the corpus covers, where retrieval sits
against its own drop threshold, and what a change actually moved.

```bash
python tools/rag-lens/rag_lens.py
python tools/rag-lens/rag_lens.py --current services/ai/shards/*.json
python tools/rag-lens/rag_lens.py --baseline main-shards/*.json --current pr-shards/*.json
```

No install, no dependencies, no database, no model weights. Two of the three
views read files that are already in the repo or already produced by CI, which is
what makes running it routine.

## Why this exists

Every expensive surprise this corpus has produced was a **disagreement between
two things that were each individually fine**:

- the corpus says "signups" throughout and a founder says "registrations", and at
  a 1.76x threshold margin that is the whole distance between a plan and a refusal
- Meta Advertising Standards fetched perfectly, was substantive, and was removed
  because it crowded an unrelated document out of its own results
- three of nine registered sources answered `200` and stored site navigation
- UK is covered and EU is not, and PECR is not ePrivacy as a member state applies it

None of those is visible in any single artefact. Each was found by being bitten.

## The three views

| View         | Answers                                                                                      | Needs                                   |
| ------------ | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Coverage** | which funnel stage × market cells hold documents, and which a golden case proves retrievable | nothing beyond the repo                 |
| **Margins**  | where every candidate's rerank score sits relative to the drop threshold                     | a trace from `probe.py` (live pipeline) |
| **Run diff** | what a threshold, embedder or decomposition change moved, case by case                       | shard JSON from `octopus_ai.evaluation` |

Plus a **findings** list, which is the actual payoff. A finding is always either a
disagreement between two files that both already exist, or a result measured by a
run. Nothing is inferred from judgement.

## Margins

The margin view needs real rerank scores, so it comes from a live pipeline rather
than from the repo. Run the probe from the AI service's environment:

```bash
uv run --directory services/ai python ../../tools/rag-lens/probe.py \
  --out ../../rag-trace.json --from-golden scope
```

then

```bash
python tools/rag-lens/rag_lens.py --trace rag-trace.json
```

`probe.py` calls `Retriever.retrieve`, the same decomposer the service uses, and
`build_sources_block` for the optional `--gate` pass. It re-implements nothing: a
picture of a pipeline nobody runs is worse than no picture, and this repo's eval
has made that mistake before.

`--from-golden scope` is the sharpest default. Those are in-vocabulary questions
the corpus does not cover, where retrieval leaks by design and the margin is the
whole story.

## What it deliberately is not

**Not a gate.** Thresholds and the pass/fail verdict live in
`octopus_ai.evaluation --merge`. A second implementation of the same arithmetic is
a second thing that can disagree with CI.

**Not a production trace viewer.** `docs/10-architecture/observability.md` pins
Langfuse as the single sink Ragas and DeepEval publish to. This is the editorial
instrument for corpus quality, which a trace of one request cannot give you.

**Not a copy of the stage map.** The funnel-stage table is parsed out of
`docs/30-modules/rag-knowledge.md`, so a document dropped from the corpus cannot
keep showing as covered. Anything the tool and the doc disagree about is reported
rather than reconciled silently.

## Tests

```bash
uv run --directory services/ai python -m pytest ../../tools/rag-lens/test_rag_lens.py -q
```

Run from the `services/ai` environment only because that is where a `pytest` lives;
the tool itself imports nothing outside the standard library.

## Files

| File               | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `rag_lens.py`      | CLI and HTML rendering                                          |
| `lens_data.py`     | readers for the corpus, stage map, golden set, shards, traces   |
| `lens_analyze.py`  | the coverage grid, the findings, the run diff                   |
| `probe.py`         | runs the real pipeline to produce a trace (needs `services/ai`) |
| `test_rag_lens.py` | tests                                                           |
