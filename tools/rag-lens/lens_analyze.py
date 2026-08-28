"""Turn the loaded files into a coverage grid and a list of findings.

The grid is the picture. The findings are the point.

A finding here is always a statement about a **disagreement between two files
that both already exist** (a document nobody mapped to a stage, a stage naming a
document that is gone, a document no golden case ever asks for), or about a
**measured result** from a shard run. Nothing is inferred from judgement, and
nothing is scored against a threshold this tool invented: `octopus_ai.evaluation`
owns the gate and this owns the picture of it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from lens_data import CaseResult, Document, GoldenCase, TraceFile

# Below this multiple of the rerank threshold, the top survivor is close enough
# to the floor that a phrasing change can push it under. Not a gate, a flag:
# ADR-0009's registrations/signups pair measured 1.76x and was served, while the
# synonym of the same intent was refused.
THIN_MARGIN_RATIO = 2.0

# A hit this far down means the expected document surfaced but the planner reads
# several better-ranked chunks first. Chosen to match the eval's own reporting
# convention rather than to assert a quality bar.
DEEP_RANK = 4

# The grid row that holds documents no funnel stage claims. Not a stage: a
# holding pen, so that "every document is somewhere on the picture" stays true.
UNSTAGED = "(no stage)"


@dataclass(frozen=True)
class Finding:
    severity: str  # "high" | "medium" | "low"
    kind: str
    subject: str
    detail: str


@dataclass(frozen=True)
class Cell:
    stage: str
    market: str
    docs: list[Document]
    cases: list[GoldenCase]
    # None when there is no shard run to say. True/False when there is.
    proven: bool | None


@dataclass
class Analysis:
    documents: list[Document]
    stages: list[str]
    markets: list[str]
    cells: dict[tuple[str, str], Cell]
    golden: list[GoldenCase]
    current: dict[str, CaseResult] = field(default_factory=dict)
    baseline: dict[str, CaseResult] = field(default_factory=dict)
    trace: TraceFile | None = None
    findings: list[Finding] = field(default_factory=list)

    def cell(self, stage: str, market: str) -> Cell | None:
        return self.cells.get((stage, market))


_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def analyse(
    *,
    documents: list[Document],
    stage_map: dict[str, list[str]],
    golden: list[GoldenCase],
    current: dict[str, CaseResult],
    baseline: dict[str, CaseResult],
    trace: TraceFile | None,
) -> Analysis:
    by_slug = {d.slug: d for d in documents}
    by_title = {d.title: d for d in documents}
    stages = list(stage_map)
    markets = sorted({d.market for d in documents if d.market})

    positives = [c for c in golden if c.kind == "positive"]
    cases_by_title: dict[str, list[GoldenCase]] = {}
    for case in positives:
        for title in case.expect_docs:
            cases_by_title.setdefault(title, []).append(case)

    # Every document must appear somewhere on the grid. A crawled ad-policy page
    # belongs to no funnel stage and would otherwise be invisible here while
    # being fully retrievable in production, which is the worst kind of picture:
    # one that is wrong in the direction of looking tidier than the system is.
    mapped = {s for slugs in stage_map.values() for s in slugs}
    unstaged = [d.slug for d in documents if d.slug not in mapped]
    if unstaged:
        stage_map = {**stage_map, UNSTAGED: unstaged}
        stages = list(stage_map)

    cells: dict[tuple[str, str], Cell] = {}
    for stage, slugs in stage_map.items():
        for market in markets:
            docs = [by_slug[s] for s in slugs if s in by_slug and by_slug[s].market == market]
            cases = [c for d in docs for c in cases_by_title.get(d.title, [])]
            proven: bool | None = None
            if current and cases:
                # Proven means: some golden case pointing into this cell actually
                # retrieved one of its documents in the run being displayed.
                proven = any(
                    current[c.id].hit
                    for c in cases
                    if c.id in current
                )
            cells[(stage, market)] = Cell(
                stage=stage, market=market, docs=docs, cases=cases, proven=proven
            )

    findings: list[Finding] = []

    # --- disagreements between files ----------------------------------------

    # `mapped` deliberately, not a fresh scan of stage_map: the holding pen was
    # added to it above, and counting that as a mapping would silence exactly the
    # finding the pen exists to make visible.
    mapped_slugs = mapped

    for stage, slugs in stage_map.items():
        if stage == UNSTAGED:
            continue
        present = [s for s in slugs if s in by_slug]
        if not present:
            findings.append(
                Finding(
                    "medium",
                    "uncovered stage",
                    stage,
                    "the stage map names no document that exists on disk, so a goal "
                    "landing on this stage has nothing to ground in",
                )
            )
        for slug in slugs:
            if slug not in by_slug:
                findings.append(
                    Finding(
                        "high",
                        "stage map names a missing document",
                        slug,
                        f"rag-knowledge.md lists it under {stage}, but no file with that "
                        "name is in corpus/ or eval/external/. The doc claims coverage "
                        "the corpus does not have.",
                    )
                )

    for doc in documents:
        if doc.slug not in mapped_slugs:
            findings.append(
                Finding(
                    "low",
                    "document not mapped to a stage",
                    doc.slug,
                    "the document is seeded and retrievable, but rag-knowledge.md's "
                    "coverage table does not mention it, so the doc under-reports what "
                    "the corpus holds",
                )
            )
        if doc.title not in cases_by_title:
            findings.append(
                Finding(
                    "medium",
                    "document unproven by the golden set",
                    doc.slug,
                    "no positive case expects this document, so nothing asserts that "
                    "retrieval can find it and a regression that buried it would pass CI",
                )
            )

    for case in positives:
        for title in case.expect_docs:
            if title not in by_title:
                findings.append(
                    Finding(
                        "high",
                        "golden case expects a document that does not exist",
                        case.id,
                        f'expects "{title}", which no corpus file carries as its title. '
                        "The case can never pass; cases are keyed on title, so a rename "
                        "breaks them silently.",
                    )
                )

    # --- market asymmetry, stated per market rather than implied by blanks ---

    real_stages = [s for s in stages if s != UNSTAGED]
    for market in markets:
        blank = [s for s in real_stages if not cells[(s, market)].docs]
        if not blank:
            continue
        if len(blank) == len(real_stages):
            # A market present in the corpus that covers no funnel stage at all.
            # Worth saying loudly rather than suppressing as an empty row: it
            # means every funnel question asked of this market is answered out of
            # another market's documents, and PECR is not ePrivacy as a member
            # state applies it.
            findings.append(
                Finding(
                    "medium",
                    "market has documents but covers no funnel stage",
                    market,
                    f"{market} appears in the corpus, but every funnel stage for it is "
                    "empty, so a goal scoped to this market grounds entirely in another "
                    "market's documents",
                )
            )
        else:
            findings.append(
                Finding(
                    "low",
                    "market covers only part of the funnel",
                    market,
                    f"no document for {', '.join(blank)}. Retrieval will answer these "
                    f"stages for {market} out of another market's documents unless a "
                    "filter stops it.",
                )
            )

    # --- measured results, when a run was supplied ---------------------------

    threshold = None
    if trace and trace.settings.get("rerank_min_score"):
        threshold = float(trace.settings["rerank_min_score"])

    for result in current.values():
        if result.leaked:
            findings.append(
                Finding(
                    "high",
                    "negative case leaked",
                    result.id,
                    f"expected nothing, retrieved {len(result.retrieved_titles)}: "
                    + ", ".join(result.retrieved_titles[:3]),
                )
            )
            continue
        if result.is_negative:
            continue
        if not result.hit:
            findings.append(
                Finding(
                    "medium",
                    "positive case missed",
                    result.id,
                    "expected "
                    + ", ".join(result.expect_docs)
                    + "; retrieved "
                    + (", ".join(result.retrieved_titles[:3]) or "nothing"),
                )
            )
            continue
        if result.coverage < 1.0:
            findings.append(
                Finding(
                    "low",
                    "positive case partially covered",
                    result.id,
                    f"{result.coverage:.0%} of the expected documents surfaced; a broad "
                    "goal that retrieves one stage leaves the planner nothing for the rest",
                )
            )
        rank = result.rank_of_first_hit
        if rank is not None and rank >= DEEP_RANK:
            findings.append(
                Finding(
                    "low",
                    "expected document ranked deep",
                    result.id,
                    f"first hit at rank {rank}; it surfaced, but the planner reads "
                    f"{rank - 1} better-scored chunks before it",
                )
            )
        if (
            threshold
            and result.top_score is not None
            and result.top_score < threshold * THIN_MARGIN_RATIO
        ):
            findings.append(
                Finding(
                    "medium",
                    "thin margin over the threshold",
                    result.id,
                    f"top score {result.top_score:.4g} is {result.top_score / threshold:.2f}x "
                    "the drop threshold. A phrasing this corpus happens not to use can "
                    "push a working answer under the floor.",
                )
            )

    findings.sort(key=lambda f: (_SEVERITY_ORDER[f.severity], f.kind, f.subject))

    return Analysis(
        documents=documents,
        stages=stages,
        markets=markets,
        cells=cells,
        golden=golden,
        current=current,
        baseline=baseline,
        trace=trace,
        findings=findings,
    )


@dataclass(frozen=True)
class Delta:
    """One case, compared across two runs."""

    id: str
    query: str
    before: CaseResult | None
    after: CaseResult | None

    @property
    def status(self) -> str:
        if self.before is None:
            return "new"
        if self.after is None:
            return "gone"
        if self.before.hit != self.after.hit or self.before.leaked != self.after.leaked:
            regressed = (self.before.hit and not self.after.hit) or (
                self.after.leaked and not self.before.leaked
            )
            return "regressed" if regressed else "fixed"
        if self.before.coverage != self.after.coverage:
            return "regressed" if self.after.coverage < self.before.coverage else "fixed"
        before_rank = self.before.rank_of_first_hit
        after_rank = self.after.rank_of_first_hit
        if before_rank != after_rank:
            return "moved"
        return "same"


def diff(baseline: dict[str, CaseResult], current: dict[str, CaseResult]) -> list[Delta]:
    """Join two runs on case id.

    Ordered by how much attention the row deserves rather than alphabetically:
    a regression at the bottom of a 41-row table is a regression nobody reads.
    """
    order = {"regressed": 0, "gone": 1, "new": 2, "fixed": 3, "moved": 4, "same": 5}
    deltas = [
        Delta(
            id=case_id,
            query=(current.get(case_id) or baseline[case_id]).query,
            before=baseline.get(case_id),
            after=current.get(case_id),
        )
        for case_id in sorted(set(baseline) | set(current))
    ]
    deltas.sort(key=lambda d: (order[d.status], d.id))
    return deltas
