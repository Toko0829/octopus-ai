"""A visual step asks for pictures only when somebody can draw them.

The first proposal whose execution produces bytes, and the whole of its Python
half is a decision: this service says WHAT to draw and never draws it, because it
holds no storage key and no Supabase write path (ADR-0006, ADR-0033).

Four properties are pinned here and each of them is a way the slice could have
gone quietly wrong:

* An image request is emitted only when the step is visual AND the workspace has
  routed a model that can actually make one.
* The **brief is always there**. An image beside a brief is a deliverable; an
  image instead of one is an asset with no record of what was asked for.
* The prompt is built from the brief's own sections, so what a person approved and
  what the generator is handed are the same words.
* The count comes from the step, because the plan is what was approved.

No network: the retriever and providers are stubs, so this asserts what is
proposed rather than what a vendor returns.
"""

import json

import pytest

from octopus_ai.config import Settings
from octopus_ai.deliverable import IMAGE_PROMPT_MAX, image_prompt_from_brief
from octopus_ai.executor import build_execute_prompt, execute_task
from octopus_ai.retrieval import RetrievalResult
from octopus_ai.schemas import CreativeCapability, ExecuteRequest, TraceContext

BRIEF_BODY = """Images will be generated from this brief.

## Concept
One lamp burning in an empty open-plan office at two in the morning.

## Shot list
The lamp from the doorway. The desk from above. The window from outside.

## Art direction
Amber against near-black, heavy film grain, no faces, no stock-photo smiles.

## Specs
1:1 for the feed and 4:5 for stories.
"""


class Chunk:
    chunk_id = "chunk-1"
    citation_label = "Creative testing for paid social"
    source_url = None
    effective_date = None
    heading = "Creative"
    text = "Creative is the main lever once targeting is automated."
    contextual_text = "Creative is the main lever once targeting is automated."


class StubRetriever:
    async def retrieve(
        self, query: str, subqueries=None, room_id=None, project_id=None, agent_run_id=None
    ) -> RetrievalResult:
        return RetrievalResult(
            chunks=[Chunk()], candidates_considered=12, dropped_below_threshold=0
        )


class StubProviders:
    """Returns the brief above, and records the system prompt it was given."""

    house_model = "gpt-5.4"

    def __init__(self, body: str = BRIEF_BODY) -> None:
        self.body = body
        self.system_prompts: list[str] = []

    async def complete_json(
        self, *, system: str, user: str, model=None, max_tokens=None, **_kwargs
    ) -> str:
        self.system_prompts.append(system)
        return json.dumps(
            {
                "title": "Creative brief, cold paid social",
                "body": self.body,
                "citations": ["Creative testing for paid social"],
            }
        )


def make_settings() -> Settings:
    return Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="sb_secret_test",
        openai_api_key="sk-test",
        cohere_api_key="co-test",
        groundedness_check=False,
    )


def request_with(
    creative: CreativeCapability | None,
    title: str = "Create a brief for 3 distinct paid hooks",
    detail: str = "Cold traffic, people who have not heard of the product.",
) -> ExecuteRequest:
    return ExecuteRequest(
        task_id="task-1",
        title=title,
        detail=detail,
        stage="creative",
        creative=creative,
        trace=TraceContext(agent_run_id="run-1", project_id="project-1", room_id="room-1"),
    )


CAN_DRAW = CreativeCapability(provider="google", model="gemini-3.1-flash-image", images=True)
CANNOT_DRAW = CreativeCapability(provider="anthropic", model="claude-opus-5", images=False)


async def run(request: ExecuteRequest, providers: StubProviders | None = None):
    providers = providers or StubProviders()
    result = await execute_task(request, StubRetriever(), providers, make_settings())
    return result, providers


@pytest.mark.asyncio
async def test_a_brief_step_with_a_creative_route_also_asks_for_images():
    result, _ = await run(request_with(CAN_DRAW))

    kinds = [p.kind for p in result.proposals]
    assert kinds == ["write_artifact", "generate_image"]


@pytest.mark.asyncio
async def test_the_brief_survives_whatever_happens_to_the_images():
    """The record is the brief. An image beside it is an enhancement."""
    result, _ = await run(request_with(CAN_DRAW))

    artifact = next(p for p in result.proposals if p.kind == "write_artifact")
    assert "## Concept" in artifact.body
    assert artifact.citations == ["Creative testing for paid social"]


@pytest.mark.asyncio
async def test_no_creative_route_means_no_image_request():
    """The ordinary workspace, and the behaviour that shipped before this slice."""
    result, _ = await run(request_with(None))
    assert [p.kind for p in result.proposals] == ["write_artifact"]


@pytest.mark.asyncio
async def test_a_creative_route_that_cannot_draw_asks_for_nothing():
    """A workspace can route Creative at a text model, and then there is no producer.

    Read off `images` on the registry entry rather than guessed from the provider,
    because Google ships both kinds under one key.
    """
    result, _ = await run(request_with(CANNOT_DRAW))
    assert [p.kind for p in result.proposals] == ["write_artifact"]


@pytest.mark.asyncio
async def test_a_copy_step_is_not_a_visual_step():
    """The capability is not a licence to draw on every step."""
    result, _ = await run(
        request_with(CAN_DRAW, title="Draft ad copy for cold paid social", detail="Five variants.")
    )
    assert [p.kind for p in result.proposals] == ["write_artifact"]


@pytest.mark.asyncio
async def test_the_count_comes_from_the_step():
    """A step asking for 3 distinct hooks gets three, because that is what was approved."""
    result, _ = await run(request_with(CAN_DRAW))
    image = next(p for p in result.proposals if p.kind == "generate_image")
    assert image.count == 3


@pytest.mark.asyncio
async def test_a_step_that_names_no_count_asks_for_one():
    """Each image is a separate billed call on the customer's own key."""
    result, _ = await run(
        request_with(CAN_DRAW, title="Create a creative brief", detail="Visuals for the launch.")
    )
    image = next(p for p in result.proposals if p.kind == "generate_image")
    assert image.count == 1


@pytest.mark.asyncio
async def test_the_prompt_is_the_brief_rather_than_a_second_deliverable():
    result, _ = await run(request_with(CAN_DRAW))
    image = next(p for p in result.proposals if p.kind == "generate_image")

    assert "One lamp burning" in image.prompt
    assert "Amber against near-black" in image.prompt
    # The shot list is three different frames and the specs are fields, so
    # neither belongs in a prompt for one picture.
    assert "from the doorway" not in image.prompt
    assert "4:5 for stories" not in image.prompt
    assert len(image.prompt) <= IMAGE_PROMPT_MAX


@pytest.mark.asyncio
async def test_a_brief_with_nothing_to_draw_asks_for_nothing():
    """An image from an empty description is a stock picture with a bill on it."""
    result, _ = await run(request_with(CAN_DRAW), StubProviders(body="   \n\n   "))
    assert [p.kind for p in result.proposals] == ["write_artifact"]


@pytest.mark.asyncio
async def test_the_aspect_is_one_of_the_four_the_channels_use():
    result, _ = await run(request_with(CAN_DRAW))
    image = next(p for p in result.proposals if p.kind == "generate_image")
    assert image.aspect in ("1:1", "4:5", "9:16", "16:9")


@pytest.mark.asyncio
async def test_the_brief_prompt_stops_claiming_it_cannot_draw():
    """The sentence a person reads at the top of the brief has to be true.

    It said "this system cannot generate images yet" unconditionally. On a
    workspace that has connected an image model that is now false, and a
    deliverable that opens with a false statement about the product is worse than
    one that opens with nothing.
    """
    _, providers = await run(request_with(CAN_DRAW))
    assert "cannot generate images" not in providers.system_prompts[0]

    _, providers = await run(request_with(None))
    assert "cannot generate images" in providers.system_prompts[0]


def test_the_prompt_is_capped_at_what_the_wire_accepts():
    """The vendor refuses an over-length prompt outright, so it is cut here."""
    long_brief = "## Concept\n" + ("a very long description " * 200)
    prompt = image_prompt_from_brief(long_brief)
    assert prompt is not None
    assert len(prompt) <= IMAGE_PROMPT_MAX
    # Cut at a word boundary: half a word is a worse prompt than a shorter one.
    assert not prompt.endswith("a very lon")


def test_a_brief_without_headings_still_draws_something():
    """A brief with the right words and the wrong formatting is still a brief."""
    assert image_prompt_from_brief("One lamp in an empty office.") == "One lamp in an empty office."


def test_the_execute_prompt_only_changes_its_opening_sentence():
    """`images` is not a licence to rewrite the brief's structure."""
    without = build_execute_prompt("brief")
    with_images = build_execute_prompt("brief", images=True)
    for section in ("## Concept", "## Shot list", "## Art direction", "## Specs"):
        assert section in without and section in with_images
    assert "—" not in with_images
