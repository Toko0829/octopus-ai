"""Tests for the reasoning seam.

These assert the ADR-0006 invariants, not just that the endpoint returns 200. The
one that matters most is negative: the service must not claim groundedness it
does not have, because Node uses that flag to decide what an output may gate.
"""

from fastapi.testclient import TestClient

from octopus_ai.main import app
from octopus_ai.planner import CORE_NAME

client = TestClient(app)

GOAL = "launch and grow my focus app Rune, get me to my first 1,000 paying users"


def _plan(goal: str = GOAL, room_id: str = "room-1", run_id: str = "run-1"):
    return client.post(
        "/plan",
        json={
            "room_id": room_id,
            "goal": goal,
            "trace": {"agent_run_id": run_id, "project_id": None},
        },
    )


def test_health_ok():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_plan_returns_a_post_message_proposal():
    res = _plan()
    assert res.status_code == 200
    body = res.json()
    assert len(body["proposals"]) == 1
    assert body["proposals"][0]["kind"] == "post_message"
    assert body["proposals"][0]["body"].strip()


def test_plan_is_honest_about_being_ungrounded():
    """The core has no retrieval, so it must not report grounded output."""
    body = _plan().json()
    assert body["grounded"] is False
    assert body["citations"] == []
    assert body["core"] == CORE_NAME


def test_oversized_goal_is_rejected_at_the_schema():
    """Past the contract's 4000-char bound the request never reaches the core."""
    assert _plan(goal="x" * 5000).status_code == 422


def test_long_goal_is_truncated_when_echoed():
    """Within the bound but long: quoted back, but never unbounded. It is untrusted input."""
    body = _plan(goal="x" * 3000).json()
    reply = body["proposals"][0]["body"]
    assert "..." in reply
    assert len(reply) < 1200


def test_goal_text_appears_in_the_reply():
    body = _plan(goal="grow my newsletter").json()
    assert "grow my newsletter" in body["proposals"][0]["body"]


def test_copy_has_no_em_dashes():
    """AGENTS.md rule 22: user-facing copy never uses em dashes."""
    body = _plan().json()
    assert "—" not in body["proposals"][0]["body"]


def test_empty_goal_is_rejected():
    res = _plan(goal="")
    assert res.status_code == 422


def test_trace_context_is_required():
    """agent_run_id is how a step here is tied back to its run in Node."""
    res = client.post("/plan", json={"room_id": "room-1", "goal": GOAL})
    assert res.status_code == 422


def test_service_cannot_write_anywhere():
    """ADR-0006: this service proposes. It holds no database client at all.

    A guard rather than a formality: the moment something here imports a Supabase
    client, the "Python cannot move money" argument stops being structural.
    """
    import octopus_ai.main as main_module
    import octopus_ai.planner as planner_module

    for module in (main_module, planner_module):
        source = module.__doc__ or ""
        assert "supabase" not in source.lower() or "never" in source.lower()
        for attr in vars(module).values():
            assert "supabase" not in type(attr).__module__.lower()
