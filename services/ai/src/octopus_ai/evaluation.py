"""Retrieval evaluation against the golden set (rag.md).

Measures the retrieval stage only: does the right document surface, and does an
out-of-scope query surface nothing. Deliberately *not* an LLM-judged metric.
Faithfulness and answer relevancy need a judge model, which costs money per run
and returns a different number each time; those belong in a separate, credentialed
pass. What is here is deterministic given a fixed corpus, which is what makes it
usable as a gate.

Two asymmetric halves, scored separately on purpose:

**Positives** ask whether the expected document was retrieved. Missing one makes
the agent refuse a question it could have answered. That is a bad product, but a
safe failure.

**Negatives** ask whether an out-of-scope query returned nothing at all. A leak
here is the dangerous failure: retrieval hands the planner loosely-related text,
the planner grounds an answer in it, and the user gets a confident cited plan
built on sources that do not support it. `rag.md` calls weak chunks something to
drop rather than pad with; this is the check that the drop actually happens.

Because of that asymmetry the gate treats a single negative leak as failure,
while positives are scored as a rate.
"""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from .retrieval import RetrievalResult, Retriever

GOLDEN_PATH = Path(__file__).resolve().parents[2] / "eval" / "golden.json"

# Positives: the share of cases where an expected document was retrieved at all.
# Below this, the corpus or the retriever is failing questions it should answer.
MIN_POSITIVE_RECALL = 0.8

# Negatives: no tolerance. One out-of-scope query returning chunks is one class
# of question the agent will answer when it should refuse.
MAX_NEGATIVE_LEAKS = 0


@dataclass(frozen=True)
class GoldenCase:
    id: str
    query: str
    expect_docs: list[str]
    notes: str | None = None

    @property
    def is_negative(self) -> bool:
        return not self.expect_docs


@dataclass
class CaseResult:
    case: GoldenCase
    retrieved_titles: list[str]
    top_score: float | None
    candidates: int
    dropped: int

    @property
    def hit(self) -> bool:
        """A positive case passes if any expected document surfaced."""
        return any(t in self.case.expect_docs for t in self.retrieved_titles)

    @property
    def leaked(self) -> bool:
        """A negative case fails if anything at all survived the threshold."""
        return self.case.is_negative and len(self.retrieved_titles) > 0

    @property
    def rank_of_first_hit(self) -> int | None:
        for i, title in enumerate(self.retrieved_titles, 1):
            if title in self.case.expect_docs:
                return i
        return None

    @property
    def coverage(self) -> float:
        """Share of the expected documents that surfaced.

        `hit` only asks whether *one* expected document appeared, which is the
        right question for a narrow query and far too lenient for a broad one: a
        goal spanning three funnel stages would score a pass on retrieving one of
        them, which is exactly the failure decomposition exists to fix. Coverage
        is the number that moves when retrieval genuinely widens.
        """
        if not self.case.expect_docs:
            return 1.0
        found = {t for t in self.retrieved_titles if t in self.case.expect_docs}
        return len(found) / len(self.case.expect_docs)


@dataclass
class EvalReport:
    results: list[CaseResult] = field(default_factory=list)

    @property
    def positives(self) -> list[CaseResult]:
        return [r for r in self.results if not r.case.is_negative]

    @property
    def negatives(self) -> list[CaseResult]:
        return [r for r in self.results if r.case.is_negative]

    @property
    def positive_recall(self) -> float:
        if not self.positives:
            return 0.0
        return sum(1 for r in self.positives if r.hit) / len(self.positives)

    @property
    def leaks(self) -> list[CaseResult]:
        return [r for r in self.negatives if r.leaked]

    @property
    def mrr(self) -> float:
        """Mean reciprocal rank over positives. Rewards ranking the right doc first."""
        if not self.positives:
            return 0.0
        total = 0.0
        for r in self.positives:
            rank = r.rank_of_first_hit
            if rank:
                total += 1.0 / rank
        return total / len(self.positives)

    @property
    def mean_coverage(self) -> float:
        """Average share of expected documents found, over positives.

        Distinct from recall: recall asks how many cases found *something*,
        coverage asks how much of what was expected actually surfaced. A broad
        goal spanning several funnel stages moves this number and not the other.
        """
        if not self.positives:
            return 0.0
        return sum(r.coverage for r in self.positives) / len(self.positives)

    @property
    def passed(self) -> bool:
        return self.positive_recall >= MIN_POSITIVE_RECALL and len(self.leaks) <= MAX_NEGATIVE_LEAKS

    def render(self) -> str:
        lines: list[str] = []
        lines.append("POSITIVES (expected document must surface)")
        for r in self.positives:
            mark = "PASS" if r.hit else "MISS"
            rank = f"rank {r.rank_of_first_hit}" if r.rank_of_first_hit else "not retrieved"
            score = f"{r.top_score:.3f}" if r.top_score is not None else "-"
            cover = (
                f" cover={r.coverage:.2f} ({len(r.case.expect_docs)} expected)"
                if len(r.case.expect_docs) > 1
                else ""
            )
            lines.append(f"  [{mark}] {r.case.id:22} {rank:16} top={score}{cover}")

        lines.append("")
        lines.append("NEGATIVES (must retrieve nothing)")
        for r in self.negatives:
            mark = "LEAK" if r.leaked else "PASS"
            got = ", ".join(r.retrieved_titles[:2]) if r.retrieved_titles else "nothing"
            score = f"{r.top_score:.3f}" if r.top_score is not None else "-"
            lines.append(f"  [{mark}] {r.case.id:22} returned {got} (top={score})")

        lines.append("")
        # ASCII only: this renders in CI logs and in a Windows console, where a
        # middot arrives as a replacement character and makes the summary line
        # look corrupted.
        lines.append(
            f"positive recall {self.positive_recall:.2f} (min {MIN_POSITIVE_RECALL:.2f}) | "
            f"coverage {self.mean_coverage:.2f} | "
            f"MRR {self.mrr:.2f} | negative leaks {len(self.leaks)} (max {MAX_NEGATIVE_LEAKS})"
        )
        lines.append("PASS" if self.passed else "FAIL")
        return "\n".join(lines)


def load_golden(path: Path | None = None) -> list[GoldenCase]:
    raw = json.loads((path or GOLDEN_PATH).read_text(encoding="utf-8"))
    return [
        GoldenCase(
            id=c["id"],
            query=c["query"],
            expect_docs=list(c.get("expect_docs", [])),
            notes=c.get("notes"),
        )
        for c in raw["cases"]
    ]


def score_case(case: GoldenCase, retrieval: RetrievalResult) -> CaseResult:
    """Turn one retrieval into a scored result. Pure, so it is unit-testable."""
    titles = [c.title for c in retrieval.chunks]
    top = retrieval.chunks[0].rerank_score if retrieval.chunks else None
    return CaseResult(
        case=case,
        retrieved_titles=titles,
        top_score=top,
        candidates=retrieval.candidates_considered,
        dropped=retrieval.dropped_below_threshold,
    )


async def run_eval(
    retriever: Retriever,
    cases: list[GoldenCase] | None = None,
    *,
    delay_s: float = 0.0,
    decomposer: Callable[[str], Awaitable[list[str]]] | None = None,
) -> EvalReport:
    """Score every case. `delay_s` paces the run against provider rate limits.

    One case is one rerank call, and the whole set fires back to back, so an eval
    run is the densest burst of provider traffic this service ever produces. A
    Cohere trial key allows 10 calls a minute, which the set exceeds outright; the
    retry in `providers` cannot absorb that because its backoff is measured in
    seconds and the window is a minute. Pacing here rather than in `providers`
    keeps the rate limit an eval-harness concern instead of slowing every
    production retrieval down to trial speed.
    """
    import asyncio

    report = EvalReport()
    selected = cases if cases is not None else load_golden()

    for i, case in enumerate(selected):
        if delay_s and i:
            await asyncio.sleep(delay_s)
        # Mirror the production path exactly. An eval that skips decomposition
        # measures a pipeline nobody runs, and would then pass while the real one
        # regressed.
        subqueries = await decomposer(case.query) if decomposer else None
        retrieval = await retriever.retrieve(case.query, subqueries=subqueries)
        report.results.append(score_case(case, retrieval))
    return report


async def _run() -> int:
    # Imported here so the module stays importable (and unit-testable) without a
    # database or provider credentials present.
    from .config import get_settings
    from .db import Database
    from .providers import Providers

    settings = get_settings()
    db = Database(settings)
    providers = Providers(settings)
    retriever = Retriever(settings, db, providers)

    # Default paces below a Cohere trial key's 10 calls/minute. Set to 0 on a
    # production key, where the whole set runs in seconds.
    delay_s = float(os.environ.get("EVAL_CASE_DELAY_S", "7"))

    # The eval must exercise the production path. One that skipped decomposition
    # would measure a pipeline nobody runs, and would keep passing while the real
    # one regressed.
    decomposer = None
    if settings.query_decomposition:
        from .decompose import decompose

        async def run_decompose(q: str) -> list[str]:
            return await decompose(q, providers, settings.generation_model_cheap)

        decomposer = run_decompose

    try:
        print(f"corpus embedded by: {settings.active_embed_model}")
        print(f"rerank_min_score:   {settings.rerank_min_score}")
        print(f"decomposition:      {'on' if settings.query_decomposition else 'off'}")
        print(f"pacing:             {delay_s}s between cases\n")
        report = await run_eval(retriever, delay_s=delay_s, decomposer=decomposer)
        print(report.render())
        return 0 if report.passed else 1
    finally:
        await db.aclose()
        await providers.aclose()


def main() -> None:
    import asyncio

    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
