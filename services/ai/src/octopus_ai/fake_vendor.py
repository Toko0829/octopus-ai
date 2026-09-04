"""A generation vendor that answers without a network or a bill.

It exists so the connector seam can be exercised end to end on the live stack:
connect a key, set a route, post a goal, watch a card arrive stamped with the
model that made it. Every one of those steps is real except the reasoning. That
is worth having because the parts most likely to be wrong on the way to a
customer are the routing, the encryption, the attribution and the rendering, and
none of them can be tested by a unit test that stubs the provider out.

**It is not a mock and it is not useful output.** The prose says what it is, in
the room, so nobody mistakes a fake answer for a cheap one. `--plan` is the
admission gate for a real registry entry and this vendor cannot pass it.

`FAKE_JSON` is deliberately ONE object that validates as four different things:
a six-stage plan, a written artifact, a campaign decline and a replan diff.
Nothing about the seam depends on which endpoint is being exercised, so one
canned answer covers all of them, and pydantic ignoring unknown keys is what
lets the union live in a single object. `kind` is absent on purpose: each
proposal model defaults it correctly, and a literal value would satisfy exactly
one of the four and break the other three.
"""

from __future__ import annotations

import json

_STEP = {
    "title": "Fake step from the fake vendor",
    "detail": (
        "This step was produced by the fake generation vendor, which answers without "
        "calling a provider. It exists to exercise routing, attribution and rendering. "
        "Do not act on it."
    ),
    "owner": "YOU",
    "citations": [],
    "risk_tier": "read_only",
    "acceptance_criteria": [],
    "depends_on": [],
}

_FAKE_OBJECT = {
    # ProposePlanProposal, and WriteArtifactProposal, share `title`.
    "title": "Fake plan from the fake vendor",
    # ProposePlanProposal, and ProposeReplanProposal, share `summary`.
    "summary": (
        "Produced by the fake generation vendor. Nothing here was reasoned about and "
        "nothing here should be acted on."
    ),
    "stages": [
        {"stage": stage, "steps": [{"id": f"fake-{stage}", **_STEP}]}
        for stage in (
            "strategy",
            "content",
            "creative",
            "channels",
            "conversion",
            "measurement",
        )
    ],
    # WriteArtifactProposal. Uncited, which is honest: the fake vendor read no
    # sources, and the checker treats an uncited artifact as unverified rather
    # than as a fabrication.
    "body": (
        "Fake deliverable from the fake generation vendor. It calls no provider and "
        "reads no sources, so there is nothing here to use."
    ),
    "citations": [],
    # The campaign drafter's own decline path, honoured before validation. A fake
    # vendor proposing a campaign would be a fake vendor proposing to spend money.
    "decline": True,
    "why": "The fake vendor does not propose campaigns.",
    # ProposeReplanProposal. `project_id` is injected by `replan._with_project`,
    # and `ops` has a minimum of one, so the diff carries a single harmless add.
    "ops": [
        {
            "op": "add_step",
            "stage": "strategy",
            "id": "fake-added-step",
            **_STEP,
        }
    ],
}

FAKE_JSON = json.dumps(_FAKE_OBJECT)


def fake_prose(model: str, user: str) -> str:
    """A deterministic reply that names the model and proves the prompt arrived.

    Echoing the first line of the user turn is what makes this a seam test rather
    than a constant: a route that reached the wrong prompt shows up here instead
    of looking identical to a route that worked.
    """
    first_line = next((line.strip() for line in user.splitlines() if line.strip()), "")
    return (
        f"Fake reply from {model}. This is the fake generation vendor, which answers "
        "without calling a provider, so nothing here was reasoned about and nothing "
        f"here should be acted on. The prompt began: {first_line[:160]}"
    )


def fake_completion(model: str, user: str, *, json_mode: bool) -> str:
    """What the `fake` dialect returns. Never touches the network."""
    return FAKE_JSON if json_mode else fake_prose(model, user)
