"""The planner's stated dependencies, and what happens to the ones it gets wrong.

The governing asymmetry, which every test here is an instance of: a plan is worth
far more than its edges. An edge we cannot resolve is dropped, a graph we cannot
trust is flattened, and in both cases the card still ships, because a flat plan is
exactly what this system produced before dependencies existed. The reasoning is in
`plan_graph.py`; these pin it so nobody "fixes" a drop into a refusal.
"""

import json

import pytest
from pydantic import ValidationError

from octopus_ai.plan_graph import sanitise_dependencies
from octopus_ai.planner import parse_plan
from octopus_ai.schemas import PlanStage, PlanStep


def _plan(stages, title="Growth plan", summary="A short summary.") -> str:
    return json.dumps({"title": title, "summary": summary, "stages": stages})


def _step(title="Do the thing", citations=None, **over):
    step = {
        "title": title,
        "detail": "Some concrete detail about what happens.",
        "owner": "AI",
        "citations": citations if citations is not None else [1],
    }
    step.update(over)
    return step


def _steps_of(plan):
    return [step for stage in plan.stages for step in stage.steps]


def _by_id(plan):
    return {step.id: step for step in _steps_of(plan) if step.id}


# ---------------------------------------------------------------- the happy path


def test_a_stated_dependency_survives_parsing():
    plan = parse_plan(
        _plan(
            [
                {
                    "stage": "strategy",
                    "steps": [_step(title="Positioning", id="positioning")],
                },
                {
                    "stage": "content",
                    "steps": [_step(title="Ad copy", id="ad-copy", depends_on=["positioning"])],
                },
            ]
        ),
        source_count=3,
    )
    assert _by_id(plan)["ad-copy"].depends_on == ["positioning"]


def test_dependencies_cross_stages_which_is_the_normal_case():
    """Creative consuming strategy is the shape this feature exists for.

    Stage order is presentation; execution order is the graph. A cross-stage edge
    must not be treated as suspicious.
    """
    plan = parse_plan(
        _plan(
            [
                {"stage": "strategy", "steps": [_step(id="positioning")]},
                {
                    "stage": "creative",
                    "steps": [_step(id="hero-image", depends_on=["positioning"])],
                },
            ]
        ),
        source_count=3,
    )
    assert _by_id(plan)["hero-image"].depends_on == ["positioning"]


def test_a_step_may_depend_on_more_than_one_other_step():
    plan = parse_plan(
        _plan(
            [
                {
                    "stage": "strategy",
                    "steps": [_step(id="positioning"), _step(id="offer")],
                },
                {
                    "stage": "content",
                    "steps": [_step(id="ad-copy", depends_on=["positioning", "offer"])],
                },
            ]
        ),
        source_count=3,
    )
    assert _by_id(plan)["ad-copy"].depends_on == ["positioning", "offer"]


def test_a_plan_with_no_dependencies_is_unchanged():
    """The pre-existing behaviour, still available and still correct.

    Most plans will state few edges, and a flat one is a legitimate plan rather
    than a degraded one.
    """
    plan = parse_plan(
        _plan([{"stage": "strategy", "steps": [_step(id="positioning"), _step(id="offer")]}]),
        source_count=3,
    )
    assert all(step.depends_on == [] for step in _steps_of(plan))


def test_a_card_from_before_this_feature_still_parses():
    """No ids, no depends_on. Absent must never cost the card."""
    plan = parse_plan(_plan([{"stage": "strategy", "steps": [_step()]}]), source_count=3)
    step = _steps_of(plan)[0]
    assert step.id is None
    assert step.depends_on == []


# ------------------------------------------------------- repaired, never refused


def test_a_dependency_naming_no_step_is_dropped_and_the_plan_survives():
    """The central trade. Compare `test_a_citation_beyond_the_supplied_sources_is_rejected`.

    A citation the reader cannot follow must not ship. A dependency that resolves
    to nothing is safest simply absent, and refusing the plan over it would cost
    somebody fifteen good steps for one bad string.
    """
    plan = parse_plan(
        _plan(
            [
                {"stage": "strategy", "steps": [_step(id="positioning")]},
                {"stage": "content", "steps": [_step(id="ad-copy", depends_on=["nonexistent"])]},
            ]
        ),
        source_count=3,
    )
    assert _by_id(plan)["ad-copy"].depends_on == []
    assert _by_id(plan)["positioning"] is not None


def test_a_self_dependency_is_dropped():
    step = _step(id="positioning", depends_on=["positioning"])
    plan = parse_plan(_plan([{"stage": "strategy", "steps": [step]}]), source_count=3)
    assert _by_id(plan)["positioning"].depends_on == []


def test_a_repeated_dependency_is_deduplicated():
    plan = parse_plan(
        _plan(
            [
                {"stage": "strategy", "steps": [_step(id="positioning")]},
                {
                    "stage": "content",
                    "steps": [_step(id="ad-copy", depends_on=["positioning", "positioning"])],
                },
            ]
        ),
        source_count=3,
    )
    assert _by_id(plan)["ad-copy"].depends_on == ["positioning"]


def test_a_cycle_flattens_the_graph_rather_than_failing_the_plan():
    """Every edge goes, and the steps stay.

    Breaking the cycle by cutting one edge would mean choosing arbitrarily which of
    the model's statements to believe, and the survivors would then assert an order
    it never coherently stated.
    """
    plan = parse_plan(
        _plan(
            [
                {
                    "stage": "strategy",
                    "steps": [
                        _step(title="A", id="a", depends_on=["b"]),
                        _step(title="B", id="b", depends_on=["a"]),
                    ],
                }
            ]
        ),
        source_count=3,
    )
    assert [s.title for s in _steps_of(plan)] == ["A", "B"]
    assert all(step.depends_on == [] for step in _steps_of(plan))


def test_a_longer_cycle_is_caught_too():
    stages, problems = sanitise_dependencies(
        [
            PlanStage(
                stage="strategy",
                steps=[
                    PlanStep(id="a", depends_on=["c"], title="A", detail="d", owner="AI"),
                    PlanStep(id="b", depends_on=["a"], title="B", detail="d", owner="AI"),
                    PlanStep(id="c", depends_on=["b"], title="C", detail="d", owner="AI"),
                ],
            )
        ]
    )
    assert all(step.depends_on == [] for step in stages[0].steps)
    assert any("cycle" in p for p in problems)


def test_duplicate_ids_flatten_the_graph():
    """An id naming two steps cannot resolve to one task.

    An edge pointing at it would bind to whichever row was written last, which is
    an edge pointing somewhere nobody chose.
    """
    plan = parse_plan(
        _plan(
            [
                {
                    "stage": "strategy",
                    "steps": [_step(title="A", id="dup"), _step(title="B", id="dup")],
                },
                {"stage": "content", "steps": [_step(title="C", id="c", depends_on=["dup"])]},
            ]
        ),
        source_count=3,
    )
    assert all(step.depends_on == [] for step in _steps_of(plan))
    assert len(_steps_of(plan)) == 3


def test_a_diamond_is_not_a_cycle():
    """Two steps depending on one, and a fourth depending on both. Perfectly legal.

    Worth pinning because a naive visited-set cycle check reports this as one.
    """
    stages, problems = sanitise_dependencies(
        [
            PlanStage(
                stage="strategy",
                steps=[
                    PlanStep(id="root", title="R", detail="d", owner="AI"),
                    PlanStep(id="left", depends_on=["root"], title="L", detail="d", owner="AI"),
                    PlanStep(id="right", depends_on=["root"], title="R2", detail="d", owner="AI"),
                ],
            ),
            PlanStage(
                stage="content",
                steps=[
                    PlanStep(
                        id="join", depends_on=["left", "right"], title="J", detail="d", owner="AI"
                    )
                ],
            ),
        ]
    )
    assert problems == []
    assert stages[1].steps[0].depends_on == ["left", "right"]


# ----------------------------------------------------------- shape, at the schema


def test_an_id_with_illegal_characters_is_rejected_by_the_schema():
    """The id is a join key on the other side of the seam, so its shape is checked.

    This one does raise, and the plan degrades to prose. That is acceptable where
    dropping is not, because the model producing "Positioning Step!" as an id means
    it ignored the format entirely rather than slipped on one reference.
    """
    with pytest.raises(ValidationError):
        parse_plan(
            _plan([{"stage": "strategy", "steps": [_step(id="Positioning Step!")]}]),
            source_count=3,
        )


def test_an_unresolvable_reference_shape_is_dropped_not_raised():
    """A malformed *reference* is only a dropped edge, unlike a malformed id.

    Nothing validates the strings inside `depends_on`, on purpose: they are matched
    against known ids, and anything that does not match is dropped by the same rule
    that handles a typo. Raising here would hand the harsher outcome to the milder
    mistake.
    """
    plan = parse_plan(
        _plan([{"stage": "strategy", "steps": [_step(id="a", depends_on=["Not An Id!"])]}]),
        source_count=3,
    )
    assert _by_id(plan)["a"].depends_on == []


def test_dependencies_survive_the_risk_clamp_rebuilding_the_step():
    """`parse_plan` rebuilds every step through `model_copy` to clamp its tier.

    A rebuild that dropped the new fields would leave the graph flat with nothing
    logged, which is precisely the silent-drop failure this repository keeps
    finding. Pinned because the clamp is where it would happen.
    """
    spending = _step(
        title="Set the daily budget",
        id="set-budget",
        depends_on=["positioning"],
        risk_tier="reversible",
    )
    spending["detail"] = "Set the budget to the band the founder gave at intake."
    plan = parse_plan(
        _plan(
            [
                {"stage": "strategy", "steps": [_step(id="positioning")]},
                {"stage": "channels", "steps": [spending]},
            ]
        ),
        source_count=3,
    )
    step = _by_id(plan)["set-budget"]
    assert step.risk_tier == "high_risk"
    assert step.depends_on == ["positioning"]


def test_every_repair_is_reported_so_the_caller_can_log_it():
    """Dropping is fine. Dropping silently is the defect."""
    _, problems = sanitise_dependencies(
        [
            PlanStage(
                stage="strategy",
                steps=[PlanStep(id="a", depends_on=["ghost"], title="A", detail="d", owner="AI")],
            )
        ]
    )
    assert len(problems) == 1
    assert "ghost" in problems[0]
