"""Query decomposition (rag.md, retrieval step 1).

A goal like "get my first 100 customers" is one query against a corpus organised
by funnel stage, so it retrieves whichever stage happens to match best and the
plan comes back covering two or three stages out of six. That is not the planner
being lazy: it is the planner correctly refusing to invent steps for stages
nothing was retrieved for. The fix belongs in retrieval, not in the prompt.

**Each sub-query is reranked on its own**, which costs one rerank call per
sub-query. That expense was not the first choice; it is what measurement forced.

The cheaper design ran every sub-query through search but a **single** rerank
against the original goal, to keep the rate-limited call count at one. Measured
against the golden set, it changed nothing at all: candidate breadth was never
the bottleneck, since `retrieval_candidates` was 40 at the time against a corpus
of ~43 chunks, so one search already returned nearly everything (ADR-0009 later
cut it to 25 on the same reasoning). The bottleneck is the
rerank, where a broad goal scores uniformly badly against specific chunks (0.066
top, against 0.474 for a focused query). Scoring "how do I price my offer"
against pricing chunks is a question a cross-encoder answers well; scoring "get
my first 100 customers" against them is not.

Per-sub-query reranking took coverage of a broad goal from 0.33 to 1.00.

**Decomposition is additive to an already-grounded answer, never a source of
grounding.** `Retriever.retrieve` searches the original goal first and abandons
the sub-queries if it retrieves nothing. Without that gate, "how to get a car
licence" decomposed into plausible marketing sub-queries, each of which
legitimately retrieved marketing content and cleared the threshold, leaving the
agent holding cited sources for a question the corpus cannot answer. The golden
set's negative half caught it; it is the reason that half exists.
"""

from __future__ import annotations

import json
import logging

from .providers import Providers

logger = logging.getLogger("octopus.ai.decompose")

MAX_SUBQUERIES = 6

# Stages the corpus actually has documents for. Asking for a sub-query about a
# stage nothing covers spends a rerank call to look for something already known
# to be absent (rag-knowledge.md carries the stage-by-stage map). Kept as data
# rather than prose in the prompt so it is enforced in code the model cannot talk
# its way past.
#
# `measurement` was the standing example of an absent stage and is no longer one:
# `measurement-attribution.md` covers it. This tuple and the corpus have to move
# together in both directions. Adding a stage here with no document spends rerank
# calls on nothing; adding a document without listing the stage here means broad
# goals never generate a sub-query that could reach it.
COVERED_STAGES = ("strategy", "content", "creative", "channels", "conversion", "measurement")

# A cross-encoder concatenates (query, passage) into one sequence, and it is
# trained on short queries: MS MARCO's average is around six words. A 25-word
# sub-query eats the token budget and dilutes the signal, which is how a
# genuinely relevant chunk ends up scoring near zero. Measured on this corpus:
# the model was emitting sub-queries of 20-30 words.
MAX_SUBQUERY_CHARS = 120

DECOMPOSE_PROMPT = """You split a marketing goal into short retrieval queries.

Return JSON: {"stages": [{"stage": str, "relevant": bool, "query": str}, ...]}

Include one object for EVERY stage in this list, in this order:
strategy (positioning, offer, pricing), content, creative,
channels (paid ads, SEO, email, organic social, partnerships, referrals),
conversion (landing pages, forms),
measurement (which metrics matter, attribution, tracking what converts).

For each stage, decide `relevant`: would someone pursuing this goal genuinely
need advice from that stage? Judge that by how the goal is written.

- A goal that names a SPECIFIC problem (a metric, a channel, an asset, a broken
  step) needs only the stages that problem lives in, usually one or two.
  "my CPA on paid social is too high" -> channels, maybe creative. Not conversion,
  not strategy, because the goal gives you no reason to go there.
- A goal that names only an OUTCOME, with no method ("get my first 100
  customers", "launch and grow my app"), is a whole-funnel request. Mark every
  stage relevant that could plausibly contribute to it, because the person is
  asking for the plan, not for one fix.

`query` rules, for the stages you marked relevant:
- SHORT. Six to ten words. A search query, not a sentence.
- Use a practitioner's words, do not repeat the goal.
- No stage prefix, no punctuation beyond a question mark.

Set `query` to "" for stages you marked not relevant.
No commentary, only the JSON object."""


def parse_subqueries(raw: str) -> list[str]:
    """Pull the relevant stages' queries out of the model's JSON.

    Asking for a per-stage `relevant` decision rather than "return fewer when the
    goal is narrow" is not a style preference. The previous prompt said exactly
    that, and the model ignored it on **every one of the 15 golden cases**,
    returning the maximum every time, including for out-of-scope negatives. A
    per-item boolean is a decision the model actually makes; an instruction to be
    brief is one it agrees with and then disregards.
    """
    data = json.loads(raw)

    stages = data.get("stages")
    if isinstance(stages, list):
        cleaned: list[str] = []
        for item in stages:
            if not isinstance(item, dict) or not item.get("relevant"):
                continue
            # Only stages the corpus can answer. Enforced here rather than in the
            # prompt because the corpus changes and prompts drift.
            if str(item.get("stage", "")).strip().lower() not in COVERED_STAGES:
                continue
            text = " ".join(str(item.get("query") or "").split())
            if 8 <= len(text) <= MAX_SUBQUERY_CHARS:
                cleaned.append(text)
        return cleaned

    # Older/looser shape: a bare list of queries. Kept so a model that ignores the
    # schema degrades to the previous behaviour rather than to no decomposition.
    queries = data.get("queries")
    if not isinstance(queries, list):
        raise ValueError("decomposition returned neither 'stages' nor 'queries'")

    cleaned = []
    for q in queries:
        if not isinstance(q, str):
            continue
        text = " ".join(q.split())
        # A one-word "query" retrieves noise, and an essay is just the goal again.
        if 8 <= len(text) <= MAX_SUBQUERY_CHARS:
            cleaned.append(text)
    return cleaned


async def decompose(goal: str, providers: Providers, model: str | None = None) -> list[str]:
    """Return the goal plus sub-queries, deduplicated and capped.

    Never raises. Decomposition is an optimisation, and a retrieval path that
    breaks when an optimisation fails is worse than one that quietly does what it
    did before, so any failure degrades to searching the goal alone.
    """
    flat_goal = " ".join(goal.split())

    try:
        raw = await providers.complete_json(
            system=DECOMPOSE_PROMPT,
            user=f"Goal: {flat_goal}",
            model=model,
        )
        subqueries = parse_subqueries(raw)
    except Exception as exc:
        # Deliberately broad. Enumerating exception types here would eventually
        # miss one (a transport error, a timeout, a provider shape nobody
        # anticipated), and the cost of missing one is that an *optional*
        # widening step takes down retrieval entirely. Degrading to the bare goal
        # reproduces the behaviour this feature replaced, which is a good outcome
        # rather than a broken one.
        #
        # Not silent: the type and message are logged, so a decomposition that
        # never works is visible rather than merely quiet (AGENTS.md rule 16).
        logger.warning(
            "decomposition failed, searching the goal alone: %s: %s",
            type(exc).__name__,
            str(exc)[:200],
        )
        return [flat_goal]

    # The goal leads: it is the only query guaranteed to reflect what was asked,
    # and putting it first keeps behaviour identical to the old path when
    # decomposition returns nothing useful.
    out = [flat_goal]
    seen = {flat_goal.lower()}
    for q in subqueries:
        if q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append(q)
        if len(out) >= MAX_SUBQUERIES:
            break

    logger.info("decomposed goal into %d queries", len(out))
    return out
