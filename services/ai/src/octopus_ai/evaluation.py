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

**Two passes live here, and only the first is a CI gate.**

`--shard`/`--merge` (the default) is the retrieval gate above: deterministic
given a fixed corpus, which is what makes it usable to block a merge.

`--gate` measures the **groundedness gate** over `scope_negatives`: marketing
questions, in marketing vocabulary, that this corpus does not answer. Retrieval
leaks on those by design and no threshold can fix it, so they cannot be filed as
ordinary negatives without failing the retrieval gate forever for a property
retrieval does not have. That pass calls a model, so it bills per run and is not
deterministic, and it is deliberately kept out of CI for exactly the reason the
Ragas faithfulness metrics are.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from .retrieval import RetrievalResult, Retriever
from .runtime import configure_torch_threads

GOLDEN_PATH = Path(__file__).resolve().parents[2] / "eval" / "golden.json"

# Positives: the share of cases where an expected document was retrieved at all.
# Below this, the corpus or the retriever is failing questions it should answer.
MIN_POSITIVE_RECALL = 0.8

# Negatives: no tolerance. One out-of-scope query returning chunks is one class
# of question the agent will answer when it should refuse.
MAX_NEGATIVE_LEAKS = 0

# --- The groundedness gate's thresholds (`--gate`, not the CI gate) ------------
#
# Every in-vocabulary uncovered question must be refused. Same reasoning as
# MAX_NEGATIVE_LEAKS and the same zero tolerance: one that gets through is one
# class of question the agent answers from sources that do not support it.
MIN_GATE_BLOCK_RATE = 1.0

# ...and the gate must not buy that by refusing everything. A gate that blocks
# every legitimate goal scores a perfect 1.00 above and destroys the product, so
# the false-refusal side is measured in the same pass and cannot be skipped.
#
# 0.8 rather than 1.0, mirroring MIN_POSITIVE_RECALL and for the same reason: a
# refusal of an answerable question is unhelpful but safe, where a leak is not.
MIN_GATE_PASS_RATE = 0.8


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


def split_cases(cases: list[GoldenCase], shard: int, shards: int) -> list[GoldenCase]:
    """Select shard `shard` of `shards`, 1-indexed.

    Round-robin rather than contiguous slicing, so every shard gets a mix of
    positives and negatives. A contiguous split would hand one shard only
    negatives, and a shard that measures no positives cannot fail for the reason
    the gate exists.

    This is a **partition**: every case appears in exactly one shard, and a test
    asserts that for every shard count the golden set is likely to use. If it
    ever stopped being one, the merge step's completeness check would fail loudly
    rather than the gate quietly measuring fewer cases.
    """
    if shards < 1 or not (1 <= shard <= shards):
        raise ValueError(f"shard {shard}/{shards} is out of range")
    return [c for i, c in enumerate(cases) if i % shards == shard - 1]


def result_to_dict(r: CaseResult) -> dict:
    return {
        "id": r.case.id,
        "query": r.case.query,
        "expect_docs": list(r.case.expect_docs),
        "notes": r.case.notes,
        "retrieved_titles": list(r.retrieved_titles),
        "top_score": r.top_score,
        "candidates": r.candidates,
        "dropped": r.dropped,
    }


def result_from_dict(d: dict) -> CaseResult:
    return CaseResult(
        case=GoldenCase(
            id=d["id"], query=d["query"], expect_docs=list(d["expect_docs"]), notes=d.get("notes")
        ),
        retrieved_titles=list(d["retrieved_titles"]),
        top_score=d["top_score"],
        candidates=d["candidates"],
        dropped=d["dropped"],
    )


class IncompleteShardsError(RuntimeError):
    """Merged shard results do not cover the golden set exactly."""


def merge_shards(paths: list[Path], cases: list[GoldenCase] | None = None) -> EvalReport:
    """Rebuild one report from shard files, refusing anything but full coverage.

    **This check is the whole reason sharding is safe.** Thresholds are applied
    once, here, over the complete set: computing recall inside a shard would be a
    different statistic on a handful of cases, and 0.80 over five is not 0.80
    over fifteen.

    The dangerous failure is not a shard that errors, it is a shard that never
    reports. Without this check a crashed or skipped shard would simply shrink
    the denominator and the gate would pass, green, having measured less than it
    claimed. So a missing case, a duplicate, or an unexpected id all raise.
    """
    expected = {c.id for c in (cases if cases is not None else load_golden())}

    results: list[CaseResult] = []
    seen: set[str] = set()
    for p in paths:
        payload = json.loads(Path(p).read_text(encoding="utf-8"))
        for item in payload["results"]:
            r = result_from_dict(item)
            if r.case.id in seen:
                raise IncompleteShardsError(
                    f"case {r.case.id!r} appears in more than one shard; "
                    "the split is not a partition"
                )
            seen.add(r.case.id)
            results.append(r)

    missing = expected - seen
    unexpected = seen - expected
    if missing or unexpected:
        raise IncompleteShardsError(
            f"shard results do not cover the golden set. "
            f"missing={sorted(missing)} unexpected={sorted(unexpected)}. "
            "Refusing to report a gate result over a partial set."
        )

    # Restore golden-set order so the rendered report is stable across runs.
    order = {c.id: i for i, c in enumerate(cases if cases is not None else load_golden())}
    results.sort(key=lambda r: order[r.case.id])
    return EvalReport(results=results)


@dataclass(frozen=True)
class ScopeCase:
    """An in-vocabulary but uncovered question, for the groundedness gate.

    Kept apart from `GoldenCase` because it asserts something retrieval cannot
    deliver. Retrieval leaks on these by design: a rerank score ranks chunks
    within the corpus and cannot say whether the corpus covers the question, and
    the measured bands overlap by 12x, so no threshold separates them. Filing
    these as ordinary negatives would fail the retrieval gate forever for a
    property retrieval does not have.
    """

    id: str
    query: str
    notes: str | None = None


@dataclass
class GateCaseResult:
    """One case through retrieval and then the gate.

    `blocked_by` matters as much as `blocked`. A scope negative stopped at
    retrieval and one stopped at the gate are both correct outcomes, but they say
    different things about where the safety is actually coming from, and the
    honest reading of this pass depends on not confusing them.
    """

    case_id: str
    query: str
    expect_block: bool
    retrieved: int
    outcome: str  # "supported" | "unsupported" | "unverified" | "not-retrieved"
    reason: str

    @property
    def blocked(self) -> bool:
        return self.outcome != "supported"

    @property
    def blocked_by(self) -> str:
        if self.retrieved == 0:
            return "retrieval"
        return "gate" if self.blocked else "-"

    @property
    def correct(self) -> bool:
        return self.blocked == self.expect_block


@dataclass
class GateReport:
    results: list[GateCaseResult] = field(default_factory=list)

    @property
    def scope(self) -> list[GateCaseResult]:
        return [r for r in self.results if r.expect_block]

    @property
    def legitimate(self) -> list[GateCaseResult]:
        return [r for r in self.results if not r.expect_block]

    @property
    def block_rate(self) -> float:
        if not self.scope:
            return 0.0
        return sum(1 for r in self.scope if r.blocked) / len(self.scope)

    @property
    def pass_rate(self) -> float:
        """Share of legitimate goals the gate let through. The false-refusal side."""
        if not self.legitimate:
            return 0.0
        return sum(1 for r in self.legitimate if not r.blocked) / len(self.legitimate)

    @property
    def unverified(self) -> list[GateCaseResult]:
        """Cases where the check could not run.

        Reported separately because they are an operational fault, not a
        measurement. They count as blocks (the gate fails closed) but a run with
        several of them has measured the provider, not the prompt.
        """
        return [r for r in self.results if r.outcome == "unverified"]

    @property
    def passed(self) -> bool:
        return self.block_rate >= MIN_GATE_BLOCK_RATE and self.pass_rate >= MIN_GATE_PASS_RATE

    def render(self) -> str:
        lines: list[str] = []
        lines.append("SCOPE NEGATIVES (in-vocabulary, uncovered: the gate must refuse)")
        for r in self.scope:
            mark = "BLOCK" if r.blocked else "LEAK"
            lines.append(
                f"  [{mark:5}] {r.case_id:24} by={r.blocked_by:9} "
                f"chunks={r.retrieved:2} {r.reason[:60]}"
            )

        lines.append("")
        lines.append("LEGITIMATE GOALS (the gate must NOT refuse)")
        for r in self.legitimate:
            mark = "PASS" if not r.blocked else "REFUSE"
            lines.append(
                f"  [{mark:5}] {r.case_id:24} by={r.blocked_by:9} "
                f"chunks={r.retrieved:2} {r.reason[:60]}"
            )

        lines.append("")
        if self.unverified:
            # Loud, because a run full of these looks like a strict gate and is
            # actually a broken provider.
            lines.append(
                f"WARNING: {len(self.unverified)} case(s) could not be checked "
                f"({', '.join(r.case_id for r in self.unverified)}). "
                "These count as blocks because the gate fails closed, but this run "
                "measured availability rather than judgement."
            )
            lines.append("")

        # ASCII only: this renders in a Windows console, where a middot arrives as
        # a replacement character and makes the summary look corrupted.
        lines.append(
            f"gate blocked {self.block_rate:.2f} of scope negatives "
            f"(min {MIN_GATE_BLOCK_RATE:.2f}) | "
            f"passed {self.pass_rate:.2f} of legitimate goals "
            f"(min {MIN_GATE_PASS_RATE:.2f})"
        )
        lines.append("PASS" if self.passed else "FAIL")
        return "\n".join(lines)


def load_scope_negatives(path: Path | None = None) -> list[ScopeCase]:
    raw = json.loads((path or GOLDEN_PATH).read_text(encoding="utf-8"))
    return [
        ScopeCase(id=c["id"], query=c["query"], notes=c.get("notes"))
        for c in raw.get("scope_negatives", [])
    ]


async def run_gate_eval(
    retriever: Retriever,
    gate: Callable[[str, RetrievalResult], Awaitable[tuple[str, str]]],
    *,
    scope_cases: list[ScopeCase],
    positive_cases: list[GoldenCase],
    decomposer: Callable[[str], Awaitable[list[str]]] | None = None,
    on_case: Callable[[GateCaseResult], None] | None = None,
) -> GateReport:
    """Run retrieval then the gate over both halves.

    `gate` is injected as `(query, retrieval) -> (outcome, reason)` so this
    function is testable without providers, and so the caller owns how the
    sources block is built. It must be the same block production builds, or this
    measures a pipeline nobody runs, which is a mistake this eval has made before.

    Both halves run in one pass on purpose. Measuring only the scope negatives
    would reward a gate that refuses everything, and that gate would pass.

    `on_case` fires as each case lands. It exists because this pass is minutes of
    CPU per case and the report only renders at the end, so a run that dies part
    way through leaves nothing at all behind. That is not hypothetical: a network
    drop killed a full run and every completed case went with it, since the only
    evidence they had happened was buffered in a report that never printed.
    """
    report = GateReport()

    async def one(case_id: str, query: str, expect_block: bool) -> None:
        subqueries = await decomposer(query) if decomposer else None
        retrieval = await retriever.retrieve(query, subqueries=subqueries)

        if not retrieval.chunks:
            # Retrieval already refused, so the gate never runs in production
            # either. Recording it as "not-retrieved" keeps the two mechanisms
            # distinguishable instead of crediting the gate for retrieval's work.
            result = GateCaseResult(
                case_id=case_id,
                query=query,
                expect_block=expect_block,
                retrieved=0,
                outcome="not-retrieved",
                reason="nothing cleared the rerank threshold",
            )
        else:
            outcome, reason = await gate(query, retrieval)
            result = GateCaseResult(
                case_id=case_id,
                query=query,
                expect_block=expect_block,
                retrieved=len(retrieval.chunks),
                outcome=outcome,
                reason=reason,
            )

        report.results.append(result)
        if on_case:
            on_case(result)

    for sc in scope_cases:
        await one(sc.id, sc.query, expect_block=True)
    for pc in positive_cases:
        await one(pc.id, pc.query, expect_block=False)

    return report


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
    """Score every case. `delay_s` adds an optional pause between cases.

    An eval run is the densest burst of provider traffic this service ever
    produces, so it is where a rate limit bites first. Rate limiting itself now
    lives in `providers` (`COHERE_RERANK_RPM`), NOT here.

    That moved because the assumption this docstring used to state, "one case is
    one rerank call", stopped being true the day query decomposition landed. A
    positive case became one rerank for the goal plus one per sub-query, so a
    harness pausing 10s between cases was still emitting bursts of up to seven
    calls into a 10-per-minute quota, and CI failed. The harness could not pace
    what it could not count; a limiter at the call site counts exactly.

    `delay_s` is kept for coarse manual throttling, and defaults to 0 because the
    limiter is now the real control.
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


async def _run(shard: int = 1, shards: int = 1, out: Path | None = None) -> int:
    # Imported here so the module stays importable (and unit-testable) without a
    # database or provider credentials present.
    from .config import get_settings
    from .db import Database
    from .providers import Providers

    settings = get_settings()
    # The eval is the most CPU-bound thing in this repository: reranking is N
    # forward passes per query and a run is dozens of queries. This used to be
    # called only from the FastAPI lifespan, so every eval run ignored
    # TORCH_NUM_THREADS and took torch's own default, including in CI, where the
    # job runs this module directly rather than the container that sets it.
    configure_torch_threads(settings)
    db = Database(settings)
    providers = Providers(settings)
    retriever = Retriever(settings, db, providers)

    # Defaults to 0: rate limiting is `COHERE_RERANK_RPM`'s job now, and a
    # per-case pause cannot express a per-call quota once one case makes several
    # calls. Kept as an escape hatch, not as the mechanism.
    delay_s = float(os.environ.get("EVAL_CASE_DELAY_S", "0"))

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
        # The ACTIVE threshold, not the Cohere one. Printing the wrong number
        # here already cost one misread run: the banner said 0.05 while the local
        # model's scores live on a different scale entirely.
        print(f"reranker:           {settings.rerank_provider} ({settings.active_rerank_model})")
        print(f"rerank_min_score:   {settings.active_rerank_min_score}")
        print(f"decomposition:      {'on' if settings.query_decomposition else 'off'}")
        rpm = settings.rerank_rpm
        print(f"rerank limit:       {f'{rpm}/min' if rpm else 'unlimited'}")
        print(f"pacing:             {delay_s}s between cases")

        all_cases = load_golden()
        cases = split_cases(all_cases, shard, shards)
        if shards > 1:
            print(f"shard:              {shard}/{shards} ({len(cases)} of {len(all_cases)} cases)")
        print()

        report = await run_eval(retriever, cases=cases, delay_s=delay_s, decomposer=decomposer)

        if out is not None:
            # A shard reports raw per-case results and NEVER a verdict. Recall
            # over a handful of cases is a different statistic from recall over
            # the set, so the thresholds belong to the merge step alone.
            out.write_text(
                json.dumps({"results": [result_to_dict(r) for r in report.results]}, indent=2),
                encoding="utf-8",
            )
            print(f"wrote {len(report.results)} case results to {out}")
            print("no verdict from a shard; the merge step applies the thresholds")
            return 0

        print(report.render())
        return 0 if report.passed else 1
    finally:
        await db.aclose()
        await providers.aclose()


async def _run_gate() -> int:
    """Measure the groundedness gate. Credentialed and LLM-dependent, by nature.

    Deliberately NOT part of the CI gate, and for the same reason the Ragas
    faithfulness metrics are not: it calls a model, so it bills per run and
    returns a different answer sometimes. That is the honest place for it, and
    stapling it to the deterministic gate would make every merge depend on a
    provider being up and on a judgement being stable.

    What it is for: catching a regression in the gate's prompt, and knowing the
    false-refusal rate before that rate is discovered by a user.
    """
    from .config import get_settings
    from .db import Database
    from .groundedness import assess
    from .planner import build_sources_block
    from .providers import Providers

    settings = get_settings()
    # The eval is the most CPU-bound thing in this repository: reranking is N
    # forward passes per query and a run is dozens of queries. This used to be
    # called only from the FastAPI lifespan, so every eval run ignored
    # TORCH_NUM_THREADS and took torch's own default, including in CI, where the
    # job runs this module directly rather than the container that sets it.
    configure_torch_threads(settings)
    db = Database(settings)
    providers = Providers(settings)
    retriever = Retriever(settings, db, providers)

    decomposer = None
    if settings.query_decomposition:
        from .decompose import decompose

        async def run_decompose(q: str) -> list[str]:
            return await decompose(q, providers, settings.generation_model_cheap)

        decomposer = run_decompose

    async def gate(query: str, retrieval: RetrievalResult) -> tuple[str, str]:
        # The same block the planner receives. Building a different one here
        # would measure a pipeline nobody runs.
        verdict = await assess(
            query,
            build_sources_block(retrieval),
            providers,
            settings.active_groundedness_model,
        )
        return verdict.outcome, verdict.reason

    try:
        print(f"corpus embedded by: {settings.active_embed_model}")
        print(f"reranker:           {settings.rerank_provider} ({settings.active_rerank_model})")
        print(f"rerank_min_score:   {settings.active_rerank_min_score}")
        print(f"gate model:         {settings.active_groundedness_model}")
        if not settings.groundedness_check:
            # The gate is measured here regardless of the flag, since the point is
            # to measure it. Saying so avoids reading a pass as evidence that the
            # running service is protected, when the flag says it is not.
            print("NOTE:               GROUNDEDNESS_CHECK is OFF in this environment.")
            print("                    This pass measures the gate; the service is not using it.")
        print()

        def progress(r: GateCaseResult) -> None:
            # Printed as it happens rather than collected. Each case is minutes of
            # cross-encoder CPU, so a silent run is indistinguishable from a hung
            # one, and a run that dies leaves the finished cases visible instead of
            # taking them with it.
            mark = "BLOCK" if r.blocked else "PASS"
            want = "block" if r.expect_block else "pass"
            flag = " " if r.correct else "!"
            print(
                f"{flag} [{mark:5}] {r.case_id:24} want={want:5} "
                f"by={r.blocked_by:9} {r.reason[:60]}"
            )
            sys.stdout.flush()

        report = await run_gate_eval(
            retriever,
            gate,
            scope_cases=load_scope_negatives(),
            positive_cases=[c for c in load_golden() if not c.is_negative],
            decomposer=decomposer,
            on_case=progress,
        )
        print()
        print(report.render())
        return 0 if report.passed else 1
    finally:
        await db.aclose()
        await providers.aclose()


def _plan_eval_target(provider: str | None, model: str | None, key_env: str | None):
    """Build the `GenerationTarget` for a `--plan` run, or `None` for the house key.

    All three flags or none. A provider without a model would silently pick one,
    and a model without a key would silently run on the house key while the banner
    said otherwise, which is the exact failure this whole eval exists to catch one
    level up.

    The key is read from the NAMED environment variable rather than accepted on
    the command line, so it never reaches a shell history, a process listing or a
    CI log.
    """
    import os

    from .schemas import GenerationTarget

    given = [f for f in (provider, model, key_env) if f]
    if not given:
        return None
    if len(given) != 3:
        raise SystemExit("--provider, --model and --key-env are used together or not at all")

    key = os.environ.get(key_env or "")
    if not key:
        raise SystemExit(f"{key_env} is empty or unset")

    # The registry that decides a provider's dialect lives in packages/contracts
    # and is Node's. This is the eval's own small copy, deliberately: adding a
    # provider is a contracts change plus one line here, and the alternative is
    # this harness reading TypeScript.
    vendors = {
        "openai": "openai_compatible",
        "anthropic": "anthropic",
        "google": "google",
        "fake": "fake",
    }
    vendor = vendors.get(provider or "")
    if vendor is None:
        raise SystemExit(f"unknown provider {provider!r}; one of {', '.join(sorted(vendors))}")

    return GenerationTarget(vendor=vendor, provider=provider, model=model, api_key=key)


async def _run_plan_eval(target=None) -> int:
    """Score the STRUCTURE of the plans the planner produces (`plan_eval.py`).

    Credentialed and LLM-dependent like `--gate`, and kept out of CI for the same
    reason: it calls a model, so it bills per run. What it checks is nonetheless
    deterministic given a response, which is why the scoring lives in a module
    with its own hermetic tests and only the running of it is credentialed.

    Runs the golden POSITIVES only. Negatives and scope negatives are refusals by
    design, and a harness that counted them would reward a planner for answering
    everything.

    **With `--provider` this is the admission gate for a registry entry**
    (ADR-0032). A model that cannot return a parseable plan is a model whose users
    would silently get cited prose instead of a card, which is precisely the defect
    `generation_max_tokens_long` was raised to fix and which nothing else detects.
    The bar is `card_rate` 1.0 and `clean_rate` at or above 0.8 on the positives.
    Retrieval is unchanged by the flag: the same corpus, the same reranker and the
    same thresholds run whoever is asked to plan from them.
    """
    from .config import get_settings
    from .db import Database
    from .plan_eval import PlanReport, score_plan
    from .planner import plan_grounded, refuse
    from .providers import Providers
    from .schemas import PlanRequest, TraceContext

    settings = get_settings()
    # The eval is the most CPU-bound thing in this repository: reranking is N
    # forward passes per query and a run is dozens of queries. This used to be
    # called only from the FastAPI lifespan, so every eval run ignored
    # TORCH_NUM_THREADS and took torch's own default, including in CI, where the
    # job runs this module directly rather than the container that sets it.
    configure_torch_threads(settings)
    db = Database(settings)
    providers = Providers(settings)
    retriever = Retriever(settings, db, providers)

    decomposer = None
    if settings.query_decomposition:
        from .decompose import decompose

        async def run_decompose(q: str) -> list[str]:
            return await decompose(q, providers, settings.generation_model_cheap)

        decomposer = run_decompose

    try:
        if target is None:
            print("generation:         house default (the server key)")
            print(f"provider / model:   openai / {settings.generation_model}")
        else:
            print(f"generation:         workspace target ({target.vendor})")
            print(f"provider / model:   {target.provider} / {target.model}")
        print(f"long token budget:  {settings.generation_max_tokens_long}")
        print()

        report = PlanReport()
        for case in [c for c in load_golden() if not c.is_negative]:
            request = PlanRequest(
                room_id="eval", goal=case.query, trace=TraceContext(agent_run_id="plan-eval")
            )
            subqueries = await decomposer(case.query) if decomposer else None
            retrieval = await retriever.retrieve(case.query, subqueries=subqueries)

            if not retrieval.grounded:
                response = refuse(request, retrieval)
            else:
                response = await plan_grounded(
                    request, retrieval, providers, settings, target
                )

            findings = score_plan(response)
            report.results.append((case.id, findings))
            # Printed as each lands: a run is minutes of CPU per case, and a run
            # that dies part way through must not take the finished cases with it.
            mark = "ok  " if findings.clean or findings.refused else "FAIL"
            print(f"  [{mark}] {case.id:24} {findings.render()}")
            sys.stdout.flush()

        print()
        print(report.render())
        return 0 if report.passed else 1
    finally:
        await db.aclose()
        await providers.aclose()


def main() -> None:
    import argparse
    import asyncio

    parser = argparse.ArgumentParser(prog="octopus_ai.evaluation")
    parser.add_argument(
        "--gate",
        action="store_true",
        help="measure the groundedness gate against the scope negatives and the "
        "positives, instead of running the retrieval gate. Calls a model, so this "
        "is a credentialed pass rather than a CI gate.",
    )
    parser.add_argument(
        "--plan",
        action="store_true",
        help="score the STRUCTURE of produced plans (did a card come back at all, "
        "are citations in range, do AI-owned steps carry one). Calls a model, so "
        "this is a credentialed pass rather than a CI gate.",
    )
    parser.add_argument(
        "--provider",
        help="run --plan against a connected provider instead of the house key: "
        "one of openai, anthropic, google, fake. Used with --model and --key-env.",
    )
    parser.add_argument(
        "--model",
        help="the model id to run --plan on. Verify it against the provider before "
        "trusting a result: an unknown id is a provider error, not a low score.",
    )
    parser.add_argument(
        "--key-env",
        metavar="NAME",
        help="the environment variable holding the key for --provider. Named rather "
        "than passed, so the key stays out of shell history and process listings.",
    )
    parser.add_argument(
        "--shard",
        default="1/1",
        help="run only part of the golden set, as i/n. Requires --out, because a "
        "shard reports results rather than a verdict.",
    )
    parser.add_argument("--out", type=Path, help="write this shard's per-case results here")
    parser.add_argument(
        "--merge",
        nargs="+",
        type=Path,
        metavar="FILE",
        help="combine shard result files, apply the thresholds once over the whole "
        "set, and exit non-zero on failure",
    )
    args = parser.parse_args()

    if (args.provider or args.model or args.key_env) and not args.plan:
        # Only --plan takes a target. The retrieval gate and --gate measure
        # retrieval and the groundedness gate, neither of which a connector
        # touches, and accepting the flag there would imply otherwise.
        parser.error("--provider, --model and --key-env apply to --plan only")

    if args.plan:
        if args.gate or args.merge or args.out or args.shard != "1/1":
            parser.error("--plan measures a different thing and does not shard or merge")
        target = _plan_eval_target(args.provider, args.model, args.key_env)
        raise SystemExit(asyncio.run(_run_plan_eval(target)))

    if args.gate:
        if args.merge or args.out or args.shard != "1/1":
            parser.error("--gate measures a different thing and does not shard or merge")
        raise SystemExit(asyncio.run(_run_gate()))

    if args.merge:
        report = merge_shards(args.merge)
        print(report.render())
        raise SystemExit(0 if report.passed else 1)

    try:
        shard_s, shards_s = args.shard.split("/", 1)
        shard, shards = int(shard_s), int(shards_s)
    except ValueError:
        parser.error(f"--shard must look like i/n, got {args.shard!r}")

    # Refusing this combination is deliberate. A sharded run that printed a
    # verdict would be reporting a gate result over part of the set, which is
    # exactly the silent weakening sharding has to avoid.
    if shards > 1 and args.out is None:
        parser.error("--shard with n > 1 requires --out; a shard must not report a verdict")

    raise SystemExit(asyncio.run(_run(shard=shard, shards=shards, out=args.out)))


if __name__ == "__main__":
    main()
