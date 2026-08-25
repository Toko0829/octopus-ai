"""Scoring a produced plan.

Every property here failed silently in production at some point, or would have.
The harness itself has to be trustworthy before its numbers mean anything, so
these tests are mostly about the scorer NOT being fooled: a refusal must not read
as a defect, a prose fallback must not read as a pass, and an empty findings
object must mean clean rather than unexamined.
"""

import pytest

from octopus_ai.plan_eval import (
    MIN_CARD_RATE,
    PlanFindings,
    PlanReport,
    score_plan,
)
from octopus_ai.schemas import (
    Citation,
    PlanResponse,
    PlanStage,
    PlanStep,
    PostMessageProposal,
    ProposePlanProposal,
)

ALL_STAGES = ("strategy", "content", "creative", "channels", "conversion", "measurement")


def _step(**kwargs) -> PlanStep:
    return PlanStep(
        **{
            "title": "Sharpen the positioning",
            "detail": "State who it is for and what changes.",
            "owner": "AI",
            "citations": [1],
            **kwargs,
        }
    )


def _plan(steps_in: str = "strategy", **step_kwargs) -> ProposePlanProposal:
    return ProposePlanProposal(
        title="Growth plan",
        summary="A short, calm summary.",
        stages=[
            PlanStage(stage=s, steps=[_step(**step_kwargs)] if s == steps_in else [])
            for s in ALL_STAGES
        ],
    )


def _response(proposal, *, core="grounded-plan-v1", sources=3) -> PlanResponse:
    return PlanResponse(
        proposals=[proposal],
        grounded=True,
        citations=[Citation(source_id=f"c{i}", label=f"Doc {i}") for i in range(1, sources + 1)],
        reasoning_summary="",
        core=core,
    )


def test_a_clean_plan_scores_clean():
    findings = score_plan(_response(_plan()))
    assert findings.clean
    assert findings.render() == "clean"


def test_a_refusal_is_not_counted_as_a_defective_plan():
    """A refusal may be the correct answer, and it is judged elsewhere.

    Counting one as a failure here would make the harness reward a planner that
    answers everything, which is the exact opposite of what rule 10 wants.
    """
    response = _response(
        PostMessageProposal(body="I am not going to plan this."), core="refusing-v0"
    )
    findings = score_plan(response)

    assert findings.refused
    assert not findings.fell_back


def test_a_prose_fallback_is_caught_rather_than_passing_quietly():
    """The defect that hid for weeks.

    Sources were good, the gate passed, and the model could not produce valid
    JSON, so the core degraded to cited prose. That degradation is deliberate and
    correct, which is precisely why nothing complains when a token limit makes it
    the normal outcome and the plan card stops existing.
    """
    response = _response(PostMessageProposal(body="Here is some cited prose."))
    findings = score_plan(response)

    assert findings.fell_back
    assert not findings.clean
    assert "FELL BACK" in findings.render()


def test_an_ai_step_with_no_citation_is_flagged():
    """Rule 10 applied to work, and it has a concrete downstream cost.

    `packages/core`'s router escalates an uncited AI-owned step instead of running
    it, so each of these is a task that stops and waits for a person.
    """
    findings = score_plan(_response(_plan(citations=[])))

    assert findings.uncited_ai_steps == ["Sharpen the positioning"]
    assert not findings.clean


def test_an_uncited_step_owned_by_a_person_is_not_flagged():
    # A step the person has to decide does not rest on a source, and demanding one
    # would push the model to attach a citation that does not support anything.
    findings = score_plan(_response(_plan(owner="YOU", citations=[])))
    assert findings.uncited_ai_steps == []
    assert findings.clean


def test_a_citation_pointing_past_the_supplied_sources_is_caught():
    findings = score_plan(_response(_plan(citations=[7]), sources=3))
    assert findings.out_of_range_citations == [7]


def test_em_dashes_are_caught_in_every_user_facing_field():
    """Rule 22, enforced nowhere else in this pipeline.

    A formatter does not read prose and a type checker cannot see a character.
    """
    plan = _plan(title="Sharpen positioning — properly")
    assert score_plan(_response(plan)).em_dashes_in

    plan = ProposePlanProposal(
        title="Growth plan — v2",
        summary="Fine.",
        stages=[PlanStage(stage="strategy", steps=[_step()])],
    )
    assert "title" in score_plan(_response(plan)).em_dashes_in

    plan = ProposePlanProposal(
        title="Growth plan",
        summary="Fine — mostly.",
        stages=[PlanStage(stage="strategy", steps=[_step()])],
    )
    assert "summary" in score_plan(_response(plan)).em_dashes_in


def test_a_missing_stage_is_caught():
    plan = ProposePlanProposal(
        title="Growth plan",
        summary="Fine.",
        stages=[PlanStage(stage="strategy", steps=[_step()])],
    )
    findings = score_plan(_response(plan))

    # `parse_plan` normalises to six on the production path, so this firing means
    # something bypassed it. A card silently showing one stage reads as "the plan
    # has one part" rather than "five stages had no sources".
    assert len(findings.missing_stages) == 5


def test_an_overlong_summary_is_measured_rather_than_trusted():
    long_summary = " ".join(["word"] * 75)
    plan = ProposePlanProposal(
        title="Growth plan",
        summary=long_summary,
        stages=[PlanStage(stage="strategy", steps=[_step()])],
    )
    assert score_plan(_response(plan)).overlong_summary_words == 75


def test_empty_findings_mean_clean_rather_than_unexamined():
    # The scorer's fields are defects, so a default instance is a clean plan. If
    # they were successes, a bug that left them empty would read as passing.
    assert PlanFindings().clean


class TestReport:
    def test_a_refused_case_is_excluded_from_the_card_rate(self):
        """Otherwise a corpus gap would look like a planner regression.

        Refusals are the groundedness gate's business, and mixing them in here
        would mean adding a scope negative to the golden set silently lowers this
        gate.
        """
        report = PlanReport(
            results=[
                ("a", PlanFindings()),
                ("b", PlanFindings(refused=True)),
            ]
        )
        assert report.card_rate == 1.0
        assert report.passed

    def test_one_fallback_fails_the_run(self):
        report = PlanReport(results=[("a", PlanFindings()), ("b", PlanFindings(fell_back=True))])

        assert report.card_rate == 0.5
        assert report.card_rate < MIN_CARD_RATE
        assert not report.passed

    def test_a_flawed_card_lowers_the_clean_rate_without_failing_outright(self):
        # A card with an uncited step is a worse card, not an absent one, so it is
        # scored as a rate on the same asymmetry the retrieval gate uses.
        report = PlanReport(
            results=[
                ("a", PlanFindings()),
                ("b", PlanFindings()),
                ("c", PlanFindings()),
                ("d", PlanFindings()),
                ("e", PlanFindings(uncited_ai_steps=["x"])),
            ]
        )
        assert report.card_rate == 1.0
        assert report.clean_rate == 0.8
        assert report.passed

    def test_a_report_with_nothing_answerable_does_not_pass_vacuously(self):
        # Zero over zero must not be 1.00. A run where everything refused has
        # measured the corpus, not the planner.
        report = PlanReport(results=[("a", PlanFindings(refused=True))])
        assert report.card_rate == 0.0
        assert not report.passed


@pytest.mark.parametrize(
    "core", ["refusing-v0", "refusing-ungrounded-v1", "refusing-unverified-v1"]
)
def test_every_refusal_core_is_recognised(core):
    # Matched on the prefix rather than listed, so a fourth refusal core added
    # later is not silently scored as a planner failure.
    response = _response(PostMessageProposal(body="no"), core=core)
    assert score_plan(response).refused
