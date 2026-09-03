"""The diff a replan proposes, and the ops it refuses to propose.

`sanitise_ops` is where a model's suggestion becomes something that may be shown
to an owner as an approvable change, so almost everything here is about what it
declines to pass on. The governing rule, inherited from `plan_graph`: a diff is
several independent changes on one card, so one unusable op is dropped and the
rest still ship, because refusing the whole diff leaves a running project
unchanged over one bad string.

The exception is deliberate and pinned below: an op naming work that is already
done is dropped rather than repaired, because there is no smaller version of
"cancel finished work" that is still what was asked.
"""

import pytest
from pydantic import ValidationError

from octopus_ai.replan import _MUTABLE_STATES, _with_project, build_steps_block, sanitise_ops
from octopus_ai.schemas import (
    AddStepOp,
    CancelTaskOp,
    ModifyTaskOp,
    ProposeReplanProposal,
    ReplanTask,
)

TASK_A = "11111111-1111-4111-8111-111111111111"
TASK_B = "22222222-2222-4222-8222-222222222222"
TASK_DONE = "33333333-3333-4333-8333-333333333333"


def _tasks(**over) -> list[ReplanTask]:
    tasks = [
        ReplanTask(task_id=TASK_A, title="Sharpen positioning", state="pending", owner="AI"),
        ReplanTask(
            task_id=TASK_B,
            title="Draft the ad copy",
            state="pending",
            owner="AI",
            depends_on=[TASK_A],
        ),
        ReplanTask(task_id=TASK_DONE, title="Pick the price", state="approved", owner="YOU"),
    ]
    for task in tasks:
        for key, value in over.get(task.task_id, {}).items():
            setattr(task, key, value)
    return tasks


def _proposal(*ops) -> ProposeReplanProposal:
    return ProposeReplanProposal(project_id="p", summary="A change.", ops=list(ops))


def _add(**over) -> AddStepOp:
    base = {
        "stage": "channels",
        "id": "run-ads",
        "title": "Run the first paid test",
        "detail": "One audience, one angle.",
        "owner": "AI",
        "citations": [1],
    }
    base.update(over)
    return AddStepOp(**base)


# ------------------------------------------------------------------ the basics


def test_a_clean_diff_passes_through_untouched():
    ops, problems = sanitise_ops(
        _proposal(
            _add(),
            CancelTaskOp(task_id=TASK_B, reason="not doing paid ads this quarter"),
            ModifyTaskOp(task_id=TASK_A, detail="Narrow to one situation."),
        ),
        _tasks(),
        source_count=3,
    )
    assert problems == []
    assert [op.op for op in ops] == ["add_step", "cancel_task", "modify_task"]


def test_an_added_step_may_depend_on_an_existing_task():
    ops, problems = sanitise_ops(_proposal(_add(depends_on=[TASK_A])), _tasks(), source_count=3)
    assert problems == []
    assert ops[0].depends_on == [TASK_A]


def test_an_added_step_may_depend_on_another_step_in_the_same_diff():
    """Both reference kinds resolve, which is what makes a diff self-contained.

    A new step whose prerequisite is also new could otherwise only be expressed
    across two separate replans.
    """
    ops, problems = sanitise_ops(
        _proposal(_add(id="brief", title="Write the brief"), _add(id="ads", depends_on=["brief"])),
        _tasks(),
        source_count=3,
    )
    assert problems == []
    assert ops[1].depends_on == ["brief"]


# ------------------------------------- work that is already done is not editable


def test_cancelling_a_finished_step_is_dropped():
    """The one thing not repaired into something smaller.

    An approved step is what the project has achieved. Cancelling it is not a
    replan, it is a rewrite of the record, and `apply_plan_diff` refuses it too.
    """
    ops, problems = sanitise_ops(
        _proposal(CancelTaskOp(task_id=TASK_DONE, reason="changed my mind")),
        _tasks(),
        source_count=3,
    )
    assert ops == []
    assert "approved" in problems[0]


def test_modifying_a_finished_step_is_dropped():
    ops, problems = sanitise_ops(
        _proposal(ModifyTaskOp(task_id=TASK_DONE, detail="something else")),
        _tasks(),
        source_count=3,
    )
    assert ops == []
    assert len(problems) == 1


def test_an_op_naming_a_task_from_another_project_is_dropped():
    ops, problems = sanitise_ops(
        _proposal(CancelTaskOp(task_id="99999999-9999-4999-8999-999999999999", reason="x")),
        _tasks(),
        source_count=3,
    )
    assert ops == []
    assert "not a step of this project" in problems[0]


def test_one_bad_op_does_not_take_the_good_ones_with_it():
    """The whole reason this drops rather than raises."""
    ops, problems = sanitise_ops(
        _proposal(
            _add(),
            CancelTaskOp(task_id=TASK_DONE, reason="already done"),
            ModifyTaskOp(task_id=TASK_A, detail="Narrow it."),
        ),
        _tasks(),
        source_count=3,
    )
    assert [op.op for op in ops] == ["add_step", "modify_task"]
    assert len(problems) == 1


def test_every_state_a_task_can_still_be_worked_in_is_editable():
    """`escalated` and `needs_user` are the states an owner most often replans out
    of, so a set that excluded either would make the feature useless exactly when
    it is wanted."""
    assert "escalated" in _MUTABLE_STATES
    assert "needs_user" in _MUTABLE_STATES
    assert "blocked" in _MUTABLE_STATES
    for finished in ("approved", "payout_pending", "paid", "done", "failed", "cancelled"):
        assert finished not in _MUTABLE_STATES


# ---------------------------------------------------------------- added steps


def test_a_citation_beyond_the_supplied_sources_is_dropped_and_the_step_kept():
    """Unlike the planner, which raises. The trade differs because the unit does:
    a plan is one object and a bad citation invalidates it, while a diff is a list
    and the other ops are still good."""
    ops, problems = sanitise_ops(_proposal(_add(citations=[1, 9])), _tasks(), source_count=3)
    assert ops[0].citations == [1]
    assert "cites [9]" in problems[0]


def test_a_step_that_commits_is_clamped_even_when_the_model_says_reversible():
    """The clamp is not the planner's private business: an added step reaches the
    router exactly like a planned one, so a diff is a second door into the same
    authorisation decision."""
    ops, _ = sanitise_ops(
        _proposal(
            _add(
                title="Set the daily budget",
                detail="Set the budget to the band the founder gave.",
                risk_tier="reversible",
            )
        ),
        _tasks(),
        source_count=3,
    )
    assert ops[0].risk_tier == "high_risk"


def test_acceptance_criteria_are_normalised():
    ops, _ = sanitise_ops(
        _proposal(_add(acceptance_criteria=["  names the angle ", "", "states the budget"])),
        _tasks(),
        source_count=3,
    )
    assert ops[0].acceptance_criteria == ["names the angle", "states the budget"]


def test_two_added_steps_sharing_an_id_drop_the_second():
    ops, problems = sanitise_ops(
        _proposal(_add(id="dup", title="First"), _add(id="dup", title="Second")),
        _tasks(),
        source_count=3,
    )
    assert len(ops) == 1
    assert ops[0].title == "First"
    assert "share the id" in problems[0]


def test_a_task_uuid_cannot_be_used_as_an_added_step_id_at_all():
    """The stronger version of the collision guard, and it is structural.

    A step id is at most 32 characters of lowercase, digits and hyphens; a task
    UUID is 36. So the two reference spaces cannot overlap, and `depends_on`
    resolving a string to "a new step" or "an existing task" is unambiguous by
    construction rather than by a check somebody has to remember.
    """
    with pytest.raises(ValidationError):
        _add(id=TASK_A)


def test_an_added_id_colliding_with_an_existing_task_is_still_dropped():
    """Defence in depth, for a caller whose task ids are not UUIDs.

    `ReplanTask.task_id` is a plain string on the wire, so the impossibility above
    is a property of what Node sends rather than of the schema. The guard costs
    nothing and is the difference between an unambiguous reference and one that
    binds to whichever thing was created last.
    """
    tasks = [ReplanTask(task_id="run-ads", title="Existing", state="pending", owner="AI")]
    ops, problems = sanitise_ops(_proposal(_add(id="run-ads")), tasks, source_count=3)
    assert ops == []
    assert "collides" in problems[0]


# --------------------------------------------------------------------- edges


def test_a_dependency_naming_nothing_is_dropped_and_the_step_survives():
    ops, problems = sanitise_ops(_proposal(_add(depends_on=["ghost"])), _tasks(), source_count=3)
    assert ops[0].depends_on == []
    assert "names no step" in problems[0]


def test_a_self_dependency_is_dropped():
    ops, problems = sanitise_ops(
        _proposal(_add(id="a", depends_on=["a"])), _tasks(), source_count=3
    )
    assert ops[0].depends_on == []
    assert "depends on itself" in problems[0]


def test_an_edge_naming_a_step_whose_own_op_was_dropped_is_dropped_too():
    """Edges resolve AFTER the ops are filtered, which is the ordering that matters.

    The second add here is dropped for sharing an id it does not own, so a third
    step depending on that id would otherwise carry an edge to something the diff
    never creates. Resolving edges first would have let it through.
    """
    ops, problems = sanitise_ops(
        _proposal(
            _add(id="brief", title="First"),
            _add(id="brief", title="Second"),
            _add(id="ads", depends_on=["brief"]),
        ),
        _tasks(),
        source_count=3,
    )
    # The surviving `brief` still owns the id, so the edge is legitimate.
    assert [op.id for op in ops] == ["brief", "ads"]
    assert ops[1].depends_on == ["brief"]
    assert any("share the id" in p for p in problems)


def test_depending_on_a_finished_task_is_allowed():
    """A step may consume the output of work that is already approved. That is the
    normal case for a diff, since the project has been running."""
    ops, problems = sanitise_ops(_proposal(_add(depends_on=[TASK_DONE])), _tasks(), source_count=3)
    assert problems == []
    assert ops[0].depends_on == [TASK_DONE]


def test_a_modify_can_add_an_edge():
    ops, problems = sanitise_ops(
        _proposal(_add(id="brief"), ModifyTaskOp(task_id=TASK_A, add_depends_on=["brief"])),
        _tasks(),
        source_count=3,
    )
    assert problems == []
    assert ops[1].add_depends_on == ["brief"]


def test_a_diff_that_would_close_a_cycle_keeps_its_steps_and_loses_its_edges():
    """B already waits on A. Making A wait on B closes the loop.

    Caught here rather than left to the acyclicity trigger, which fires under the
    owner's approval click: they would be shown an applicable-looking card and get
    an error. The trigger is still the authority and still defends every other
    writer.
    """
    ops, problems = sanitise_ops(
        _proposal(ModifyTaskOp(task_id=TASK_A, add_depends_on=[TASK_B])),
        _tasks(),
        source_count=3,
    )
    assert ops[0].add_depends_on == []
    assert "cycle" in problems[0]


def test_a_cycle_through_an_added_step_is_caught_too():
    ops, problems = sanitise_ops(
        _proposal(
            _add(id="new", depends_on=[TASK_B]),
            ModifyTaskOp(task_id=TASK_A, add_depends_on=["new"]),
        ),
        _tasks(),
        source_count=3,
    )
    assert any("cycle" in p for p in problems)
    assert ops[0].depends_on == []
    assert ops[1].add_depends_on == []


# ----------------------------------------------------------------- the prompt


def test_the_steps_block_marks_what_may_not_be_touched():
    """The permission and the id are read from one line, so they cannot drift."""
    block = build_steps_block(_tasks())
    assert TASK_A in block
    assert "changeable" in block
    assert "done, do not touch" in block
    assert "untrusted input" in block


def test_the_steps_block_shows_existing_edges():
    """So the model can see that adding the reverse edge would close a loop, rather
    than proposing it and having the sanitiser silently undo the work."""
    block = build_steps_block(_tasks())
    assert f"waits on {TASK_A}" in block


# ------------------------------------------------------------------ step ids


def test_an_added_step_with_a_long_id_is_shortened_and_its_dependant_follows():
    """Same repair as parse_plan, at the point the diff is read off the wire."""
    import json

    long = "launch-a-retargeting-campaign-for-students"
    # Dicts rather than `_add`, which builds an AddStepOp and would refuse the id
    # before the wire path under test ever saw it.
    step = _add().model_dump()
    raw = json.dumps(
        {
            "summary": "Add retargeting.",
            "ops": [
                {**step, "op": "add_step", "id": long},
                {**step, "op": "add_step", "id": "measure", "depends_on": [long]},
                {"op": "cancel_task", "task_id": TASK_A, "reason": "No longer needed."},
            ],
        }
    )
    parsed = ProposeReplanProposal.model_validate_json(_with_project(raw, "p"))

    added = [op for op in parsed.ops if op.op == "add_step"]
    assert added[0].id == long[:32]
    assert added[1].depends_on == [long[:32]]
    assert parsed.ops[2].task_id == TASK_A, "cancel and modify ops pass through untouched"
