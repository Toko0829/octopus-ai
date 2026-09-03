"""Validation of the model's structured plan.

The model is asked for six stages with cited steps. It will sometimes return
four, or reorder them, or cite a source number that does not exist. Every one of
those failures renders as a plausible-looking card, so they are caught here
rather than shown to someone who is about to act on the plan.
"""

import json

import pytest
from pydantic import ValidationError

from octopus_ai.plan_graph import STEP_ID_MAX_LENGTH
from octopus_ai.planner import parse_plan
from octopus_ai.schemas import FUNNEL_STAGES, STEP_ID_PATTERN, PlanStep


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


def _first_step(plan):
    return next(s.steps[0] for s in plan.stages if s.steps)


def test_missing_stages_are_filled_in_empty_and_ordered():
    """A four-stage plan must render as six, two of them visibly empty.

    Otherwise the card reads as "this plan has four parts" when the truth is
    "two stages had no sources", which is a different and much more useful thing
    for the reader to know.
    """
    plan = parse_plan(
        _plan(
            [
                {"stage": "channels", "steps": [_step()]},
                {"stage": "strategy", "steps": [_step()]},
            ]
        ),
        source_count=3,
    )

    assert [s.stage for s in plan.stages] == list(FUNNEL_STAGES)
    assert [s.stage for s in plan.stages if s.steps] == ["strategy", "channels"]
    assert all(s.steps == [] for s in plan.stages if s.stage not in {"strategy", "channels"})


def test_stage_order_is_normalised_not_trusted():
    plan = parse_plan(
        _plan(
            [
                {"stage": "measurement", "steps": [_step()]},
                {"stage": "strategy", "steps": [_step()]},
            ]
        ),
        source_count=2,
    )
    assert [s.stage for s in plan.stages] == list(FUNNEL_STAGES)


def test_a_citation_beyond_the_supplied_sources_is_rejected():
    """An index the reader cannot follow is worse than no citation at all."""
    with pytest.raises(ValueError, match="cites"):
        parse_plan(
            _plan([{"stage": "strategy", "steps": [_step(citations=[7])]}]),
            source_count=3,
        )


def test_a_zero_or_negative_citation_is_rejected():
    with pytest.raises(ValueError, match="cites"):
        parse_plan(
            _plan([{"stage": "strategy", "steps": [_step(citations=[0])]}]),
            source_count=3,
        )


def test_a_step_may_legitimately_cite_nothing():
    """Permitted, and surfaced as unverified rather than silently equal."""
    plan = parse_plan(
        _plan([{"stage": "strategy", "steps": [_step(citations=[])]}]),
        source_count=3,
    )
    assert plan.stages[0].steps[0].citations == []


def test_an_all_empty_plan_is_refused():
    """Six empty stages is a refusal wearing a card's clothing.

    The refusal path states the situation far more clearly than a card with
    nothing in it, so this must not be allowed to render as a plan.
    """
    with pytest.raises(ValueError, match="no steps"):
        parse_plan(_plan([{"stage": s, "steps": []} for s in FUNNEL_STAGES]), source_count=3)


def test_malformed_json_raises_rather_than_half_parsing():
    with pytest.raises(ValidationError):
        parse_plan("{not json", source_count=3)


def test_an_unknown_stage_name_is_rejected():
    """The six stages are the funnel; a seventh is the model inventing structure."""
    with pytest.raises(ValidationError):
        parse_plan(_plan([{"stage": "growth-hacking", "steps": [_step()]}]), source_count=3)


def test_owner_is_constrained_to_the_three_actors():
    with pytest.raises(ValidationError):
        bad = _step()
        bad["owner"] = "CONTRACTOR"
        parse_plan(_plan([{"stage": "strategy", "steps": [bad]}]), source_count=3)


def test_step_count_per_stage_is_bounded():
    """Three is the cap: more steps per stage is padding, not detail."""
    with pytest.raises(ValidationError):
        parse_plan(
            _plan([{"stage": "strategy", "steps": [_step(), _step(), _step(), _step()]}]),
            source_count=3,
        )


def test_the_risk_tier_the_model_proposed_survives_parsing():
    plan = parse_plan(
        _plan([{"stage": "strategy", "steps": [_step(risk_tier="read_only")]}]),
        source_count=3,
    )
    assert _first_step(plan).risk_tier == "read_only"


def test_a_step_missing_a_risk_tier_defaults_to_reversible():
    """Absent is not wrong, and must not cost the card.

    Cards written before this field existed, and a model that omits it, both land
    on the tier every task already had. Failing the plan instead would degrade a
    working card to prose over a field the clamp checks anyway.
    """
    plan = parse_plan(_plan([{"stage": "strategy", "steps": [_step()]}]), source_count=3)
    assert _first_step(plan).risk_tier == "reversible"


def test_an_unrecognised_risk_tier_is_rejected_rather_than_coerced():
    """A tier the enum does not hold is a shape error, not a missing value."""
    with pytest.raises(ValidationError):
        parse_plan(
            _plan([{"stage": "strategy", "steps": [_step(risk_tier="probably_fine")]}]),
            source_count=3,
        )


def test_a_step_that_commits_is_raised_even_when_the_model_says_reversible():
    """The whole reason this field exists: the planner is not the authority.

    The router refuses to auto-run `high_risk` whatever the owner says, so a
    planner that labels a spending step `reversible` with owner `AI` is the exact
    case rules 7 and 11 exist to catch.
    """
    step = _step(title="Set the daily budget", risk_tier="reversible")
    step["detail"] = "Set the budget to the band the founder gave at intake."
    plan = parse_plan(_plan([{"stage": "channels", "steps": [step]}]), source_count=3)
    assert _first_step(plan).risk_tier == "high_risk"


def test_acceptance_criteria_are_normalised_and_capped():
    step = _step(acceptance_criteria=["  names three gaps ", "", "lists a cadence"])
    plan = parse_plan(_plan([{"stage": "strategy", "steps": [step]}]), source_count=3)
    assert _first_step(plan).acceptance_criteria == ["names three gaps", "lists a cadence"]


def test_more_than_three_criteria_is_rejected_by_the_schema():
    with pytest.raises(ValidationError):
        parse_plan(
            _plan(
                [
                    {
                        "stage": "strategy",
                        "steps": [_step(acceptance_criteria=["a", "b", "c", "d"])],
                    }
                ]
            ),
            source_count=3,
        )


# ------------------------------------------------------------------ step ids
#
# The defect these pin, measured on a live container: the model was asked for a
# "readable" id and never told the length, wrote
# `define-signup-event-and-cpa-ceiling`, and the whole fifteen-step plan was
# thrown away over it. Twice. Ids are join keys, so they are repaired.


def _steps_of(plan):
    return [step for stage in plan.stages for step in stage.steps]


def test_the_length_constant_and_the_pattern_agree():
    assert f"{{0,{STEP_ID_MAX_LENGTH - 1}}}" in STEP_ID_PATTERN


def test_the_schema_itself_still_refuses_a_long_id():
    """The repair lives in parse_plan, not in a loosened schema."""
    with pytest.raises(ValidationError):
        PlanStep(
            id="define-signup-event-and-cpa-ceiling",
            title="t",
            detail="d",
            owner="AI",
        )


def test_a_long_id_is_shortened_rather_than_losing_the_plan():
    plan = parse_plan(
        _plan([{"stage": "strategy", "steps": [_step(id="define-signup-event-and-cpa-ceiling")]}]),
        source_count=3,
    )
    (step,) = _steps_of(plan)
    assert step.id == "define-signup-event-and-cpa-ceili"[:STEP_ID_MAX_LENGTH]
    assert len(step.id) == STEP_ID_MAX_LENGTH


def test_a_dependency_on_a_long_id_follows_it():
    plan = parse_plan(
        _plan(
            [
                {"stage": "strategy", "steps": [_step(id="define-signup-event-and-cpa-ceiling")]},
                {
                    "stage": "channels",
                    "steps": [_step(id="ads", depends_on=["define-signup-event-and-cpa-ceiling"])],
                },
            ]
        ),
        source_count=3,
    )
    by_id = {s.id: s for s in _steps_of(plan)}
    assert by_id["ads"].depends_on == ["define-signup-event-and-cpa-ceili"[:STEP_ID_MAX_LENGTH]]


def test_ids_that_collide_only_after_truncation_are_told_apart():
    a = "content-and-email-leading-metrics-a"
    b = "content-and-email-leading-metrics-b"
    plan = parse_plan(
        _plan(
            [
                {"stage": "content", "steps": [_step(id=a)]},
                {"stage": "measurement", "steps": [_step(id=b, depends_on=[a])]},
            ]
        ),
        source_count=3,
    )
    first, second = _steps_of(plan)
    assert first.id == a[:STEP_ID_MAX_LENGTH]
    assert second.id != first.id
    assert second.id.endswith("-2") and len(second.id) <= STEP_ID_MAX_LENGTH
    assert second.depends_on == [first.id], "the edge names the shortened id, not the suffixed one"


def test_a_shortened_id_never_steals_an_id_the_model_wrote_validly():
    valid = "content-and-email-leading-metric"  # exactly 32, already valid
    long = "content-and-email-leading-metrics"  # 33, truncates to `valid`
    plan = parse_plan(
        _plan(
            [
                {"stage": "content", "steps": [_step(id=long)]},
                {"stage": "measurement", "steps": [_step(id=valid, depends_on=[long])]},
            ]
        ),
        source_count=3,
    )
    first, second = _steps_of(plan)
    assert second.id == valid
    assert first.id != valid and first.id.endswith("-2")
    assert second.depends_on == [first.id]


def test_capitals_spaces_and_underscores_become_a_slug():
    plan = parse_plan(
        _plan([{"stage": "creative", "steps": [_step(id="Ad Copy_v1")]}]),
        source_count=3,
    )
    (step,) = _steps_of(plan)
    assert step.id == "ad-copy-v1"


def test_an_id_with_nothing_usable_is_dropped_not_invented():
    plan = parse_plan(
        _plan([{"stage": "creative", "steps": [_step(id="---")]}]),
        source_count=3,
    )
    (step,) = _steps_of(plan)
    assert step.id is None


def test_a_genuine_duplicate_stays_a_duplicate_for_the_graph_to_flatten():
    """Two steps with the same long id map to the same short id, so the duplicate
    rule in sanitise_dependencies still fires and drops every edge."""
    long = "define-signup-event-and-cpa-ceiling"
    plan = parse_plan(
        _plan(
            [
                {"stage": "strategy", "steps": [_step(id=long)]},
                {"stage": "content", "steps": [_step(id=long)]},
                {"stage": "channels", "steps": [_step(id="ads", depends_on=[long])]},
            ]
        ),
        source_count=3,
    )
    ids = [s.id for s in _steps_of(plan)]
    assert ids[0] == ids[1]
    assert all(s.depends_on == [] for s in _steps_of(plan)), "flattened, as before this change"
