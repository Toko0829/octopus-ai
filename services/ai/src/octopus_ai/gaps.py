"""The refusal ledger: every question the corpus could not answer, kept.

`planner.py` already splits a refusal three ways, and the split is load-bearing:
"nothing retrieved" and "retrieved but off-target" are corpus signals that should
drive what gets ingested next, while "could not verify" is an operational signal
that should page someone. Until this module existed all three went to stdout and
nowhere else, so the corpus was grown by the author's intuition against a golden
set the same author wrote.

That is the shape `rag-knowledge.md` keeps recording under a different name:
every failure this module has had was a **disagreement between two things that
were each individually fine**. The corpus said "signups" and the founder said
"registrations". The eval reports "blocked 1.00 of scope negatives" as a PASS, and
those scope negatives are six perfectly reasonable founder questions. None of it
is visible in any single artefact, which is why each was discovered by being
bitten. This table is where the biting gets written down.

## What is recorded, and what is not

Only the two **corpus** signals and the one operational one that shares their
shape. Deliberately NOT recorded: a retrieval call that raised, and a generation
that came back unusable. Both produce a refusal the user sees, neither says
anything about coverage, and a ledger that mixes them is one whose counts cannot
be read. Those already have logs and Sentry, which is where an exception belongs.

`refusing-unverified-v1` IS recorded, though it is not an ingest signal, because
the alternative is worse: when refusals spike, the first question is whether
coverage collapsed or the gate went down, and answering it from a table that only
holds one of the two means guessing. Read the queue with `core <> 'refusing-unverified-v1'`.

## Why it is fire-and-forget

The write must never be able to slow or break a refusal. `Database._request`
retries three times with backoff against a 60-second timeout, so a bad minute at
PostgREST could add minutes to a request whose entire content is "no". A lost gap
row costs nothing that matters: it is one sample of a signal that only means
anything in aggregate, and the next person asking the same thing writes another.

So it is scheduled, not awaited, and every failure is logged rather than raised
(rule 16: not silent, just not fatal). Records in flight at shutdown are lost,
which is stated here rather than defended against, because the alternative is
draining a task set on the way out for the sake of an ops table.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from .db import Database
from .redact import scrub
from .retrieval import RetrievalResult

logger = logging.getLogger("octopus.ai.gaps")

Surface = Literal["plan", "execute"]

# The nearest misses worth keeping. Enough to see whether the right document was
# in the room and lost, or was never a candidate at all, which is the distinction
# a count cannot make. More than this is the whole reranked page, and the ledger
# is for reading rather than for re-deriving the run.
_TOP_SOURCES = 5

# Held so the event loop does not garbage-collect a task nobody is awaiting.
# `create_task` keeps only a weak reference, and a scheduled write that vanishes
# mid-flight is exactly the silent failure rule 16 forbids.
_in_flight: set[asyncio.Task] = set()


def summarise_sources(retrieval: RetrievalResult | None) -> list[dict]:
    """The nearest misses, best first, as `[{title, score, kept}]`.

    Built from `RetrievalResult.scored`, which records every candidate with the
    rerank score that decided its fate. Titles rather than chunk ids: chunk ids
    are regenerated on every re-ingest, so a ledger keyed on them stops resolving
    after the next corpus change, which is the same reason `golden.json` is keyed
    on titles.

    De-duplicated by title, keeping the best score each document earned. Under
    decomposition one document is scored once per sub-query, and five rows for the
    same document is five slots spent saying one thing.
    """
    if retrieval is None:
        return []

    best: dict[str, tuple[float, bool]] = {}
    for candidate in retrieval.scored:
        current = best.get(candidate.title)
        if current is None or candidate.rerank_score > current[0]:
            best[candidate.title] = (candidate.rerank_score, candidate.kept)

    ranked = sorted(best.items(), key=lambda item: item[1][0], reverse=True)
    return [
        # Rounded because the stored value is read by a person deciding what to
        # write next, and a cross-encoder score that moves 3x between identical
        # runs does not have fifteen significant figures of meaning.
        {"title": title, "score": round(score, 6), "kept": kept}
        for title, (score, kept) in ranked[:_TOP_SOURCES]
    ]


class GapLedger:
    """Records refusals. Never raises, never blocks, never retries by itself."""

    def __init__(self, db: Database) -> None:
        self._db = db

    def record(
        self,
        *,
        core: str,
        surface: Surface,
        goal: str,
        retrieval: RetrievalResult | None = None,
        reason: str = "",
        room_id: str | None = None,
        project_id: str | None = None,
        agent_run_id: str | None = None,
    ) -> None:
        """Schedule one row. Returns immediately.

        `goal` is scrubbed here rather than at the call sites, so there is exactly
        one place that decides what reaches the table and no way to add a fourth
        caller that forgets. See `redact.scrub` for what it removes and, more
        importantly, what it deliberately leaves in.
        """
        row = {
            "core": core,
            "surface": surface,
            "goal": scrub(goal),
            # Empty string to NULL: the column means "the gate named what was
            # missing", and "" would be a row claiming it named nothing.
            "reason": reason or None,
            "candidates_considered": retrieval.candidates_considered if retrieval else 0,
            "chunks_retrieved": len(retrieval.chunks) if retrieval else 0,
            "top_sources": summarise_sources(retrieval),
            "room_id": room_id,
            "project_id": project_id,
            "agent_run_id": agent_run_id,
        }

        write = self._write(row)
        try:
            task = asyncio.create_task(write)
        except RuntimeError:
            # No running loop. Only reachable from a synchronous caller, which
            # today means a test, and dropping the row is the correct outcome
            # there rather than an error a test has to work around.
            #
            # Closed explicitly: a coroutine that is created and never awaited
            # emits a RuntimeWarning from wherever the garbage collector happens
            # to be, which is a warning about this module appearing in an
            # unrelated test's output.
            write.close()
            logger.debug("no event loop; gap not recorded")
            return

        _in_flight.add(task)
        task.add_done_callback(_in_flight.discard)

    async def _write(self, row: dict) -> None:
        try:
            await self._db.insert_retrieval_gap(row)
        except Exception as exc:
            # Broad on purpose, for the reason `groundedness.assess` states:
            # enumerating the types would eventually miss one, and here the cost
            # of missing one is an unhandled exception in a background task,
            # which surfaces as a warning nobody attached to a request.
            logger.warning(
                "gap not recorded (%s: %s)", type(exc).__name__, str(exc)[:200]
            )
