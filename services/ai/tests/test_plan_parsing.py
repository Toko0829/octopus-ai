"""Validation of the model's structured plan.

The model is asked for six stages with cited steps. It will sometimes return
four, or reorder them, or cite a source number that does not exist. Every one of
those failures renders as a plausible-looking card, so they are caught here
rather than shown to someone who is about to act on the plan.
"""

import json

import pytest
from pydantic import ValidationError

from octopus_ai.planner import parse_plan
from octopus_ai.schemas import FUNNEL_STAGES


def _plan(stages, title="Growth plan", summary="A short summary.") -> str:
    return json.dumps({"title": title, "summary": summary, "stages": stages})


def _step(title="Do the thing", citations=None):
    return {
        "title": title,
        "detail": "Some concrete detail about what happens.",
        "owner": "AI",
        "citations": citations if citations is not None else [1],
    }


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
