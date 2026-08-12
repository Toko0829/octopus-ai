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
the bottleneck, since `retrieval_candidates` is 40 against a corpus of ~43
chunks, so one search already returns nearly everything. The bottleneck is the
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

DECOMPOSE_PROMPT = """You split a marketing goal into retrieval queries.

Return JSON: {"queries": [str, ...]}

The corpus is organised by funnel stage: strategy (positioning, offer, pricing),
content, creative, channels (paid ads, SEO, email, organic social), conversion
(landing pages, forms), and measurement (attribution, metrics).

Write one short query per stage that is genuinely relevant to the goal. Each
query should read like a question someone would ask about that stage, using the
words a practitioner would use rather than repeating the goal.

Rules:
- At most 5 queries. Fewer is fine when the goal is narrow.
- Do not include a stage the goal gives you no reason to cover.
- Do not repeat the goal itself; it is searched separately.
- No commentary, only the JSON object."""


def parse_subqueries(raw: str) -> list[str]:
    """Pull the query list out of the model's JSON, tolerating the usual noise."""
    data = json.loads(raw)
    queries = data.get("queries")
    if not isinstance(queries, list):
        raise ValueError("decomposition returned no 'queries' list")

    cleaned: list[str] = []
    for q in queries:
        if not isinstance(q, str):
            continue
        text = " ".join(q.split())
        # A one-word "query" retrieves noise, and an essay is just the goal again.
        if 8 <= len(text) <= 300:
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
