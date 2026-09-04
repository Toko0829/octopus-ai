"""The one canned object has to validate as four different proposals.

`FAKE_JSON` exists so the connector seam can be walked end to end on the live
stack without spending anything: connect a key, set a route, post a goal, watch a
card arrive stamped with the model that made it. That only works if the same
answer satisfies whichever endpoint the walk happens to reach, and the way it
breaks is subtle: adding `kind` would satisfy exactly one of the four models and
turn the other three into refusals, which on the stack reads as "the seam is
broken" rather than "the fixture is wrong".
"""

import json

from octopus_ai.fake_vendor import FAKE_JSON, fake_completion, fake_prose
from octopus_ai.planner import parse_plan
from octopus_ai.schemas import (
    ProposeReplanProposal,
    WriteArtifactProposal,
)


def test_it_validates_as_a_six_stage_plan():
    plan = parse_plan(FAKE_JSON, source_count=0)
    assert len(plan.stages) == 6
    assert all(stage.steps for stage in plan.stages)
    # Uncited, because the fake vendor read no sources. A fabricated citation
    # would be the one thing this fixture must never teach the checker to accept.
    assert all(step.citations == [] for stage in plan.stages for step in stage.steps)


def test_it_validates_as_a_written_artifact():
    artifact = WriteArtifactProposal.model_validate_json(FAKE_JSON)
    assert artifact.kind == "write_artifact"
    assert artifact.citations == []


def test_it_declines_a_campaign():
    """The drafter honours `decline` before validating, so this is what it reads."""
    payload = json.loads(FAKE_JSON)
    assert payload["decline"] is True
    assert payload["why"]


def test_it_validates_as_a_replan_diff():
    payload = json.loads(FAKE_JSON)
    payload["project_id"] = "project-1"
    diff = ProposeReplanProposal.model_validate(payload)
    assert diff.kind == "propose_replan"
    assert len(diff.ops) >= 1


def test_it_names_no_kind_of_its_own():
    """A literal `kind` satisfies one model and breaks the other three."""
    assert "kind" not in json.loads(FAKE_JSON)


def test_the_prose_says_what_it_is_and_names_the_model():
    """Nobody should be able to mistake a fake answer for a cheap one."""
    out = fake_prose("fake-strong", "get my first 100 customers\nwith no budget")
    assert "fake-strong" in out
    assert "fake generation vendor" in out
    # The head of the prompt, echoed: a route that reached the wrong prompt shows
    # up here instead of looking identical to a route that worked.
    assert "get my first 100 customers" in out


def test_json_mode_decides_which_of_the_two_comes_back():
    assert fake_completion("fake-strong", "u", json_mode=True) == FAKE_JSON
    assert fake_completion("fake-strong", "u", json_mode=False).startswith("Fake reply")
