"""The labelled ungrounded tier: what it will answer, and the larger half, what it will not.

Every test here is about a constraint from ADR-0021, because the tier's whole
safety argument is that those constraints are structural rather than instructed.
The order below is the order they matter in:

1. It cannot propose a plan. This is what keeps an ungrounded answer from becoming
   a task DAG that spends money.
2. It declines regulated topics, in code.
3. The label is written by us, not requested from the model.
4. It degrades to the caller's refusal on any failure.
"""

import pytest

from octopus_ai.ungrounded import (
    UNGROUNDED_CORE,
    answer_ungrounded,
    frame,
    is_regulated,
)


class StubProviders:
    """Returns a fixed body, or raises. Records what it was asked."""

    def __init__(self, body: str = "Do the thing, then measure it.", fail: bool = False):
        self.body = body
        self.fail = fail
        self.calls: list[dict] = []

    async def complete(self, *, system: str, user: str) -> str:
        if self.fail:
            raise RuntimeError("provider is down")
        self.calls.append({"system": system, "user": user})
        return self.body


# --- 1. it cannot propose a plan ---------------------------------------------


@pytest.mark.asyncio
async def test_it_returns_a_message_and_never_a_plan():
    """The enforcement, not a convention.

    A `propose_plan` proposal is what Node materialises into a project and a task
    DAG, and a task DAG is what spends money and publishes things. Prose in a room
    cannot become a step.
    """
    response = await answer_ungrounded("how do I build a webinar funnel", StubProviders())

    assert response is not None
    assert len(response.proposals) == 1
    assert response.proposals[0].kind == "post_message"
    assert {p.kind for p in response.proposals} == {"post_message"}


@pytest.mark.asyncio
async def test_it_is_never_marked_grounded_and_never_carries_a_citation():
    """Both are what every downstream consumer reads to refuse it (rule 10)."""
    response = await answer_ungrounded("how do I build a webinar funnel", StubProviders())

    assert response is not None
    assert response.grounded is False
    assert response.citations == []
    assert response.core == UNGROUNDED_CORE


# --- 2. regulated topics are declined in code --------------------------------


@pytest.mark.parametrize(
    "goal,rule",
    [
        # Rules 10, 11 and 19 directly.
        ("do I need to register for VAT when I start selling", "tax"),
        ("how do I run payroll for my first employee", "tax"),
        ("should I incorporate my company in Delaware", "incorporation"),
        ("what permit do I need to run this", "permit"),
        ("can my lawyer review the terms of service", "legal"),
        ("what visa do I need to work here", "immigration"),
        ("can I make a health claim about this supplement", "medical"),
        ("how do I talk to investors about this", "financial_advice"),
        # The regulated corners inside marketing, which is the half most easily
        # missed: these are in-domain marketing questions and are still forbidden.
        ("how should creators disclose a paid post", "disclosure"),
        ("do I need cookie consent for this campaign", "privacy_law"),
        ("how do I substantiate a comparative advertising claim", "claims_substantiation"),
        ("how do I market an alcohol brand", "regulated_sector"),
    ],
)
def test_regulated_goals_are_recognised(goal, rule):
    assert is_regulated(goal) == rule


@pytest.mark.asyncio
async def test_a_regulated_goal_returns_none_so_the_caller_refuses():
    """None rather than a refusal of its own.

    The caller already has a correct, well-tested refusal for every reason this
    can decline, and that copy has been wrong once before. A second refusal path
    here would be a second place for it to drift.
    """
    providers = StubProviders()
    assert await answer_ungrounded("do I need to register for VAT", providers) is None
    # And it declined before spending a generation call.
    assert providers.calls == []


@pytest.mark.parametrize(
    "goal",
    [
        # The exclusions that matter, pinned. "Invest" and "equity" are ordinary
        # marketing words and matching them would refuse legitimate questions all
        # day, which is the direction this list is not allowed to be careless in.
        "should I invest in SEO or paid ads first",
        "how do I build brand equity with a small budget",
        "how do I build a webinar funnel that converts",
        "how do I rank higher in the app store",
        "which influencer platform should I use to find creators",
        "what should my posting cadence be",
        "how do I get my first 100 customers",
    ],
)
def test_ordinary_marketing_goals_are_not_regulated(goal):
    assert is_regulated(goal) is None


# --- 3. the label is ours, not the model's -----------------------------------


def test_the_frame_is_added_around_whatever_came_back():
    """A disclaimer the model is asked to include is a disposition.

    This project has measured four times what happens to those, so the model
    writes the body and the code writes the frame. A missing label is impossible
    rather than unlikely.
    """
    framed = frame("Run three concepts against one audience.")

    assert framed.startswith("I do not have sources for this one")
    assert "Run three concepts against one audience." in framed
    assert "Nothing has been spent, published, or connected to your accounts." in framed


@pytest.mark.asyncio
async def test_a_model_that_omits_everything_still_produces_a_labelled_answer():
    """The point of framing in code: the label does not depend on the model."""
    response = await answer_ungrounded("how do I build a webinar funnel", StubProviders("x"))

    assert response is not None
    body = response.proposals[0].body
    assert "I do not have sources for this one" in body
    assert "cite" in body


def test_the_copy_carries_no_em_dash():
    """AGENTS.md rule 22. This text is user-facing."""
    assert "—" not in frame("body")


# --- 4. it degrades to the caller's refusal ----------------------------------


@pytest.mark.asyncio
async def test_a_provider_failure_returns_none_rather_than_raising():
    """Same posture as the gate: a failure becomes a refusal, not a 500."""
    providers = StubProviders(fail=True)
    assert await answer_ungrounded("how do I build a webinar funnel", providers) is None


@pytest.mark.asyncio
async def test_an_empty_body_returns_none():
    """A framed empty answer is a label with nothing inside it, which is worse
    than the refusal it replaced."""
    assert await answer_ungrounded("how do I build a webinar funnel", StubProviders("   ")) is None


# --- the prompt's own guardrails ---------------------------------------------


@pytest.mark.asyncio
async def test_the_goal_travels_as_data_and_the_rules_travel_as_instruction():
    """Rule 8. No retrieved content reaches this call at all, which is the one
    thing that makes it simpler than the grounded path rather than harder."""
    providers = StubProviders()
    await answer_ungrounded("how do I  build\na webinar funnel", providers)

    [call] = providers.calls
    # Flattened, and in the user message rather than the system one.
    assert "how do I build a webinar funnel" in call["user"]
    assert "how do I build a webinar funnel" not in call["system"]
    # The instructions that stop it fabricating are in the system channel.
    assert "Do NOT cite" in call["system"]
    assert "Do NOT invent statistics" in call["system"]
