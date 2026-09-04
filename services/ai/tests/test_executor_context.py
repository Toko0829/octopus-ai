"""What intake learned must reach the work, and must never reach the query.

Measured on a real run before this existed: the person gave their audience, the
planner used it in **4 of 15 steps**, and only **1 of 8 artifacts** mentioned it,
that one because the planner had written the word into a step title. So the plan
knew who it was for and the deliverable did not, and a copy step came back as ad
copy aimed at a performance marketer rather than at the customer.

The two halves pull in opposite directions and both are load-bearing:

* The context must be in the PROMPT, or the work is generic.
* The context must NOT be in the RETRIEVAL QUERY, because a niche audience word
  dominates a short query at a cross-encoder and retrieves nothing at all. That
  is measured twice in this project, most recently as a live goal that returned
  `refusing-v0` until the word was removed.

No network: the retriever and providers are stubs, so this asserts what is sent
rather than what a model replies.
"""

import json

import pytest

from octopus_ai.config import Settings
from octopus_ai.executor import execute_task
from octopus_ai.retrieval import RetrievalResult
from octopus_ai.schemas import ExecuteRequest, IntakeSlot, TraceContext


class Chunk:
    chunk_id = "chunk-1"
    citation_label = "Controlling CPA on paid social"
    source_url = None
    effective_date = None
    heading = "Hooks"
    text = "Creative is the main lever on automated targeting."
    contextual_text = "Creative is the main lever on automated targeting."


class StubRetriever:
    """Records the query it was asked for, so the test can assert on it."""

    def __init__(self) -> None:
        self.queries: list[str] = []
        self.scopes: list[tuple[str | None, str | None]] = []
        self.run_ids: list[str | None] = []

    async def retrieve(
        self, query: str, subqueries=None, room_id=None, project_id=None, agent_run_id=None
    ) -> RetrievalResult:
        self.queries.append(query)
        self.scopes.append((room_id, project_id))
        # Accepted rather than ignored: observability.md requires the run id to be
        # pivotable from any log line, and the retrieval path is where a step's
        # per-step re-retrieval is logged.
        self.run_ids.append(agent_run_id)
        # `grounded` is a property over `chunks`, not a field: an empty
        # retrieval is not grounding, and the type refuses to let a caller claim
        # otherwise.
        return RetrievalResult(
            chunks=[Chunk()], candidates_considered=25, dropped_below_threshold=0
        )


class StubProviders:
    """Records the prompt it was handed, and returns a valid artifact."""

    def __init__(self) -> None:
        self.user_prompts: list[str] = []
        self.system_prompts: list[str] = []

    async def complete_json(
        self, *, system: str, user: str, model=None, max_tokens=None, **_kwargs
    ) -> str:
        self.system_prompts.append(system)
        self.user_prompts.append(user)
        return json.dumps(
            {
                "title": "Cold traffic ad copy",
                "body": "## Variant 1, Problem first\nHeadline: x\nPrimary text: y\nCTA: z",
                "citations": ["Controlling CPA on paid social"],
            }
        )


def make_settings() -> Settings:
    return Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="sb_secret_test",
        openai_api_key="sk-test",
        cohere_api_key="co-test",
        # Off so the test exercises the executor rather than a second model call.
        groundedness_check=False,
    )


def request_with(context: list[IntakeSlot]) -> ExecuteRequest:
    return ExecuteRequest(
        task_id="task-1",
        title="Draft ad copy for cold paid social",
        detail="Five variants for people who have not heard of the product.",
        stage="creative",
        context=context,
        trace=TraceContext(agent_run_id="run-1", project_id="project-1", room_id="room-1"),
    )


CONTEXT = [
    IntakeSlot(key="icp", value="Students in the USA aged 18-25", source="stated"),
    IntakeSlot(key="offer", value="bluelly.com signups", source="stated"),
    IntakeSlot(key="budget_band", value="$2000/month", source="stated"),
]


@pytest.mark.asyncio
async def test_the_context_reaches_the_prompt():
    retriever, providers = StubRetriever(), StubProviders()
    await execute_task(request_with(CONTEXT), retriever, providers, make_settings())

    prompt = providers.user_prompts[0]
    assert "Students in the USA aged 18-25" in prompt
    assert "bluelly.com signups" in prompt
    # And the rule that governs it, so the model cannot present it as a source.
    assert "ABOUT THIS PERSON" in prompt
    assert "never" in providers.system_prompts[0].lower()


@pytest.mark.asyncio
async def test_the_context_never_reaches_the_retrieval_query():
    """The defect this project has measured twice, pinned so it cannot return."""
    retriever, providers = StubRetriever(), StubProviders()
    await execute_task(request_with(CONTEXT), retriever, providers, make_settings())

    query = retriever.queries[0]
    assert "student" not in query.lower()
    assert "bluelly" not in query.lower()
    assert "2000" not in query
    # It is the step's own words, and only those.
    assert "Draft ad copy for cold paid social" in query


@pytest.mark.asyncio
async def test_no_context_still_executes():
    """Absent context degrades to the output that shipped before this existed."""
    retriever, providers = StubRetriever(), StubProviders()
    result = await execute_task(request_with([]), retriever, providers, make_settings())

    assert result.core == "executing-v1"
    assert "ABOUT THIS PERSON" not in providers.user_prompts[0]


@pytest.mark.asyncio
async def test_retrieval_is_scoped_to_the_room_and_project():
    """A step retrieves this workspace's own business documents, not everyone's.

    The scope has to be passed explicitly because this service holds the secret
    key, which bypasses RLS: `hybrid_search`'s predicate is the only thing
    keeping one customer's product description out of another's deliverable.
    """
    retriever, providers = StubRetriever(), StubProviders()
    await execute_task(request_with(CONTEXT), retriever, providers, make_settings())

    assert retriever.scopes == [("room-1", "project-1")]


class RepeatingProviders(StubProviders):
    """A maker that cites one source twice and one it was never given."""

    async def complete_json(
        self, *, system: str, user: str, model=None, max_tokens=None, **_kwargs
    ) -> str:
        self.system_prompts.append(system)
        self.user_prompts.append(user)
        return json.dumps(
            {
                "title": "Cold traffic ad copy",
                "body": "## Variant 1, Problem first\nHeadline: x\nPrimary text: y\nCTA: z",
                "citations": [
                    "Controlling CPA on paid social",
                    "Controlling CPA on paid social",
                    "A source nobody supplied",
                ],
            }
        )


@pytest.mark.asyncio
async def test_a_source_quoted_twice_is_listed_once():
    """Citations are per chunk, so one document usually contributes several.

    Listing it repeatedly reads as several independent sources agreeing rather
    than one being quoted more than once, which overstates the grounding on the
    surface built to let somebody check it.
    """
    result = await execute_task(
        request_with([]), StubRetriever(), RepeatingProviders(), make_settings()
    )
    artifact = result.proposals[0]
    assert artifact.citations == ["Controlling CPA on paid social"]


@pytest.mark.asyncio
async def test_a_duplicate_is_not_counted_as_a_fabrication():
    """The two are different events and the summary must not conflate them.

    A repeated citation is the model quoting one source twice. An unsupplied one
    is it naming a source it was never given, which is what the checker escalates
    a task for. Reporting the first as the second would make a harmless habit
    look like the failure that stops work.
    """
    result = await execute_task(
        request_with([]), StubRetriever(), RepeatingProviders(), make_settings()
    )
    # Three cited, one genuinely unsupplied. The duplicate is not in that count.
    assert "1 unsupplied citation(s) dropped" in result.reasoning_summary
