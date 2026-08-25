"""Scoring a produced plan, deterministically.

The gap this fills is the one that cost the most time: **retrieval was measured
and generation was not.** `evaluation.py` gates whether the right documents
surface, and the groundedness gate has its own two-sided pass, but nothing at all
checked what the planner then did with the sources. So a defect that broke the
product's marquee feature survived for weeks without a single number moving: the
plan JSON was being truncated by a token limit, `parse_plan` rejected it, and the
core degraded to cited prose exactly as designed. Nothing errored. Nothing logged
a fault. Every whole-funnel goal simply returned no plan card.

`rag.md` excludes generation metrics on the grounds that faithfulness needs an LLM
judge, which bills per run and is not reproducible. That reasoning is sound and it
is **not a reason to measure nothing**. The properties here need no judge:

    did a card get produced at all, or did it fall back to prose
    do all six stages exist
    does every citation point at a source that was supplied
    does an AI-owned step carry a citation
    is the copy within the brand's rules

Each is a yes or no about a structure, computable from the response alone. What is
deliberately NOT here is whether the plan is any good, which is exactly the part
that needs a judge and belongs in a separate credentialed pass.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .schemas import FUNNEL_STAGES, PlanResponse, ProposePlanProposal

# Rule 22. Enforced nowhere else in the pipeline: a formatter does not read prose
# and a type checker cannot see a character. The plan card is user-facing copy on
# the surface whose whole purpose is to be trusted.
EM_DASH = "—"

# `PLAN_SYSTEM_PROMPT` asks for under 60 words. Checked rather than trusted,
# because an instruction about length is exactly the shape of instruction this
# codebase has repeatedly measured a model agreeing with and then ignoring.
MAX_SUMMARY_WORDS = 60


@dataclass(frozen=True)
class PlanFindings:
    """What is structurally wrong with one produced plan.

    Every field is a defect count or a defect list, so an empty instance is a
    clean plan. That direction matters: a scorer whose fields are "successes"
    reads as passing when a bug leaves it empty.
    """

    fell_back: bool = False
    refused: bool = False
    missing_stages: list[str] = field(default_factory=list)
    out_of_range_citations: list[int] = field(default_factory=list)
    uncited_ai_steps: list[str] = field(default_factory=list)
    em_dashes_in: list[str] = field(default_factory=list)
    overlong_summary_words: int = 0
    empty: bool = False

    @property
    def clean(self) -> bool:
        return not (
            self.fell_back
            or self.refused
            or self.missing_stages
            or self.out_of_range_citations
            or self.uncited_ai_steps
            or self.em_dashes_in
            or self.overlong_summary_words
            or self.empty
        )

    def render(self) -> str:
        if self.refused:
            return "refused"
        if self.fell_back:
            return "FELL BACK to prose (no card)"
        bits = []
        if self.empty:
            bits.append("no steps in any stage")
        if self.missing_stages:
            bits.append(f"missing stages: {','.join(self.missing_stages)}")
        if self.out_of_range_citations:
            bits.append(f"citations out of range: {self.out_of_range_citations}")
        if self.uncited_ai_steps:
            bits.append(f"{len(self.uncited_ai_steps)} uncited AI step(s)")
        if self.em_dashes_in:
            bits.append(f"em dash in {','.join(self.em_dashes_in)}")
        if self.overlong_summary_words:
            bits.append(f"summary {self.overlong_summary_words} words")
        return "; ".join(bits) if bits else "clean"


def find_plan(response: PlanResponse) -> ProposePlanProposal | None:
    for proposal in response.proposals:
        if isinstance(proposal, ProposePlanProposal):
            return proposal
    return None


def score_plan(response: PlanResponse, *, source_count: int | None = None) -> PlanFindings:
    """Check one response's structure. Pure, so it is testable without a provider.

    `source_count` defaults to the citations the response carries, which is what
    the planner was handed. Passing it explicitly is for testing the range check
    against a known number.
    """
    if response.core.startswith("refusing"):
        # A refusal is not a defective plan. It may be the correct answer, and the
        # groundedness gate's own pass is where refusals are judged. Counting one
        # as a failure here would make this harness reward answering everything.
        return PlanFindings(refused=True)

    plan = find_plan(response)
    if plan is None:
        # Grounded, sources were fine, and no card came back. This is the defect
        # that hid for weeks: the fallback to prose is deliberate and correct as a
        # degradation, which is precisely why nothing complains when it becomes
        # the normal outcome.
        return PlanFindings(fell_back=True)

    total = source_count if source_count is not None else len(response.citations)

    missing = [s for s in FUNNEL_STAGES if s not in {stage.stage for stage in plan.stages}]

    bad_citations: list[int] = []
    uncited_ai: list[str] = []
    em_dash_fields: list[str] = []

    for stage in plan.stages:
        for step in stage.steps:
            bad_citations.extend(n for n in step.citations if n < 1 or n > total)
            if step.owner == "AI" and not step.citations:
                # Rule 10 applied to work rather than prose, and it has a concrete
                # cost: `packages/core`'s router escalates an uncited AI step
                # rather than running it, so every one of these is a task that
                # stops and waits for a person.
                uncited_ai.append(step.title)
            if EM_DASH in step.title or EM_DASH in step.detail:
                em_dash_fields.append(f"step:{step.title[:24]}")

    if EM_DASH in plan.title:
        em_dash_fields.append("title")
    if EM_DASH in plan.summary:
        em_dash_fields.append("summary")

    words = len(re.findall(r"\S+", plan.summary))

    return PlanFindings(
        missing_stages=missing,
        out_of_range_citations=sorted(set(bad_citations)),
        uncited_ai_steps=uncited_ai,
        em_dashes_in=em_dash_fields,
        overlong_summary_words=words if words > MAX_SUMMARY_WORDS else 0,
        empty=not any(stage.steps for stage in plan.stages),
    )


@dataclass
class PlanReport:
    results: list[tuple[str, PlanFindings]] = field(default_factory=list)

    @property
    def planned(self) -> list[tuple[str, PlanFindings]]:
        """Cases that produced a card. The denominator for every structural rate."""
        return [(i, f) for i, f in self.results if not f.refused and not f.fell_back]

    @property
    def fallbacks(self) -> list[str]:
        return [i for i, f in self.results if f.fell_back]

    @property
    def refusals(self) -> list[str]:
        return [i for i, f in self.results if f.refused]

    @property
    def card_rate(self) -> float:
        """Share of non-refused cases that produced an actual card.

        The number that would have caught the truncation defect on the day it
        landed, and the reason this harness exists at all.
        """
        answerable = [f for _, f in self.results if not f.refused]
        if not answerable:
            return 0.0
        return sum(1 for f in answerable if not f.fell_back) / len(answerable)

    @property
    def clean_rate(self) -> float:
        if not self.planned:
            return 0.0
        return sum(1 for _, f in self.planned if f.clean) / len(self.planned)

    @property
    def passed(self) -> bool:
        # A fallback is a total failure of the feature, so it is held at zero
        # tolerance. Structural defects inside a card are scored as a rate, on the
        # same asymmetry the retrieval gate uses: a flawed card is still a card
        # somebody can read and correct, where no card is nothing at all.
        return self.card_rate >= MIN_CARD_RATE and self.clean_rate >= MIN_CLEAN_RATE

    def render(self) -> str:
        lines = ["PLAN STRUCTURE"]
        for case_id, findings in self.results:
            mark = "ok  " if findings.clean or findings.refused else "FAIL"
            lines.append(f"  [{mark}] {case_id:24} {findings.render()}")
        lines.append("")
        lines.append(
            f"card rate {self.card_rate:.2f} (min {MIN_CARD_RATE:.2f}) | "
            f"clean rate {self.clean_rate:.2f} (min {MIN_CLEAN_RATE:.2f}) | "
            f"{len(self.refusals)} refused"
        )
        lines.append("PASS" if self.passed else "FAIL")
        return "\n".join(lines)


# Zero tolerance, deliberately. A fallback means the feature did not happen, and
# the whole reason this file exists is that the fallback became the normal outcome
# without anything reporting it.
MIN_CARD_RATE = 1.0

# Scored as a rate rather than absolutely, mirroring the retrieval gate: a card
# with an uncited AI step is a worse card, not an absent one.
MIN_CLEAN_RATE = 0.8
