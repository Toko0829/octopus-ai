"""FastAPI app for the Octopus AI service.

The Python half of ADR-0006. It owns RAG and the reasoning core; it proposes and
never performs side effects. It reads the corpus and writes embeddings, but it
holds no ability to post as anyone, move money, or touch a user's rows: those
tools live in Node.

The OpenAPI document FastAPI generates at /openapi.json is the contract the Node
side consumes (ADR-0004).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

from .config import ConfigError, Settings, get_settings
from .db import Database
from .decompose import decompose
from .executor import execute_task
from .groundedness import assess
from .intake import run_intake
from .planner import build_sources_block, plan_grounded, refuse
from .providers import Providers
from .retrieval import Retriever
from .schemas import ExecuteRequest, IntakeRequest, IntakeResponse, PlanRequest, PlanResponse

logger = logging.getLogger("octopus.ai")


class _State:
    """Process-wide singletons. Built at startup, closed at shutdown."""

    settings: Settings | None = None
    db: Database | None = None
    providers: Providers | None = None
    retriever: Retriever | None = None


state = _State()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Build clients once per process, not once per request.

    A new httpx client per request would discard the connection pool and pay TLS
    setup on every embedding and rerank call.

    Configuration is resolved here so a missing key fails at startup with the
    variable named, rather than as a 500 on the first retrieval.
    """
    settings = get_settings()
    state.settings = settings
    state.db = Database(settings)
    state.providers = Providers(settings)
    state.retriever = Retriever(settings, state.db, state.providers)

    # Load the local embedder now, while nothing is waiting on it. bge-m3 takes
    # seconds and a couple of GB to come up, and paying that on the first request
    # pushed the whole call past Node's per-step timeout, so a cold service
    # looked like an unresponsive one. Warming here also means a missing or
    # corrupt model fails at startup with a named error, which is how the rest of
    # this service already treats configuration.
    if settings.embed_provider == "local":
        logger.info("warming local embedder", extra={"model": settings.active_embed_model})
        await state.providers.embed(["warmup"])

    # A disabled safety gate must be loud, not merely absent from the logs. The
    # symptom of it being off is the agent confidently answering questions its
    # corpus does not cover, which looks like working software.
    if not settings.groundedness_check:
        logger.warning(
            "GROUNDEDNESS_CHECK is off. The rerank threshold alone does not decide "
            "whether the corpus covers a question, so this service will plan from "
            "sources that may not support the answer (AGENTS.md rule 10)."
        )

    logger.info(
        "ai service ready",
        extra={
            "embed_model": settings.active_embed_model,
            "generation_model": settings.generation_model,
            "groundedness_check": settings.groundedness_check,
            "groundedness_model": settings.active_groundedness_model,
        },
    )
    try:
        yield
    finally:
        if state.db:
            await state.db.aclose()
        if state.providers:
            await state.providers.aclose()


app = FastAPI(
    title="Octopus AI service",
    version="0.1.0",
    summary="RAG and the agent reasoning core. Proposes; never writes.",
    lifespan=lifespan,
)


class Health(BaseModel):
    status: str
    service: str
    version: str
    configured: bool


@app.get("/health", response_model=Health, tags=["ops"])
def health() -> Health:
    """Liveness probe. Reports whether configuration resolved, without leaking it."""
    try:
        get_settings()
        configured = True
    except ConfigError:
        configured = False
    return Health(status="ok", service="octopus-ai", version=app.version, configured=configured)


@app.post("/intake", response_model=IntakeResponse, tags=["reasoning"])
async def intake(request: IntakeRequest) -> IntakeResponse:
    """Work out what the person wants, before anything is retrieved.

    Step 1 of the full-funnel playbook, and the one place in this service that
    deliberately does NOT touch RAG. What a person sells and who they sell it to
    is not in the corpus, so retrieving first would shape the questions around
    what we happen to have written down instead of around what they need.

    Returns scores rather than a decision the caller must trust: `completeness` is
    counted from a required-slot set that depends on how broad the request is, and
    `proximity` is measured against the stages the corpus covers. Both are
    computed in code. The model is asked only what it can actually judge, which is
    what this person said and which stages it touches.

    Stateless, like every other endpoint here. Node carries the slots between
    rounds, so making intake multi-turn does not give this service a session or a
    table it is not supposed to have (ADR-0006).
    """
    logger.info(
        "intake requested",
        extra={
            "agent_run_id": request.trace.agent_run_id,
            "project_id": request.trace.project_id,
            "room_id": request.room_id,
            "round": request.round,
        },
    )

    assert state.providers and state.settings  # set in lifespan

    return await run_intake(
        request,
        state.providers,
        model=state.settings.generation_model_cheap,
        min_completeness=state.settings.intake_min_completeness,
        max_rounds=state.settings.intake_max_rounds,
    )


@app.post("/plan", response_model=PlanResponse, tags=["reasoning"])
async def plan(request: PlanRequest) -> PlanResponse:
    """Reason about a goal and return proposals for Node to execute.

    Two independent checks decide whether anything is written, and they answer
    different questions. Retrieval asks which chunks rank best and drops the weak
    ones; the groundedness gate asks whether what survived actually answers the
    goal. A threshold cannot do the second job, because it ranks within the corpus
    and every marketing query has a best marketing chunk.

    Failing either one means refusing rather than answering from parametric
    knowledge (AGENTS.md rule 10).
    """
    logger.info(
        "plan requested",
        extra={
            "agent_run_id": request.trace.agent_run_id,
            "project_id": request.trace.project_id,
            "room_id": request.room_id,
        },
    )

    assert state.retriever and state.providers and state.settings  # set in lifespan

    try:
        # Decomposition runs before retrieval and degrades to the bare goal on
        # any failure, so a broken optimisation cannot break the request.
        subqueries = (
            await decompose(request.goal, state.providers, state.settings.generation_model_cheap)
            if state.settings.query_decomposition
            else None
        )
        retrieval = await state.retriever.retrieve(request.goal, subqueries=subqueries)
    except Exception:
        # A retrieval failure must not become an ungrounded answer. Refusing is
        # the correct degradation: the alternative is inventing a plan.
        logger.exception(
            "retrieval failed; refusing rather than answering ungrounded",
            extra={"agent_run_id": request.trace.agent_run_id},
        )
        return refuse(request)

    if not retrieval.grounded:
        return refuse(request, retrieval)

    # The groundedness gate (rule 10). Retrieval has told us which chunks rank
    # best; it has NOT told us whether the corpus answers the question, and it
    # cannot, because a score ranks within the corpus. An in-vocabulary but
    # uncovered goal clears the rerank threshold on both providers by a wide
    # margin, measured. See groundedness.py.
    #
    # Runs on the same sources block the planner will receive, so the gate cannot
    # approve one thing and the planner ground in another.
    if state.settings.groundedness_check:
        verdict = await assess(
            request.goal,
            build_sources_block(retrieval),
            state.providers,
            state.settings.active_groundedness_model,
        )
        if not verdict.may_plan:
            logger.info(
                "groundedness gate refused",
                extra={
                    "agent_run_id": request.trace.agent_run_id,
                    "outcome": verdict.outcome,
                    "chunks": len(retrieval.chunks),
                },
            )
            return refuse(
                request,
                retrieval,
                reason="unsupported" if verdict.outcome == "unsupported" else "unverified",
                detail=verdict.reason,
            )

    try:
        return await plan_grounded(request, retrieval, state.providers, state.settings)
    except Exception:
        logger.exception(
            "generation failed after successful retrieval",
            extra={"agent_run_id": request.trace.agent_run_id},
        )
        return refuse(request, retrieval)


@app.post("/execute", response_model=PlanResponse, tags=["reasoning"])
async def execute(request: ExecuteRequest) -> PlanResponse:
    """Draft the deliverable for one approved task, or refuse.

    Same two gates as `/plan`, applied at the more consequential moment. By the
    time a step executes the owner has approved the plan, so ungrounded output
    stops looking like a suggestion and starts looking like delivered work.

    This service still only proposes: the artifact row, the checker, and the
    task's state are all Node's (ADR-0006).
    """
    logger.info(
        "execute requested",
        extra={
            "task_id": request.task_id,
            "agent_run_id": request.trace.agent_run_id,
            "project_id": request.trace.project_id,
        },
    )

    assert state.retriever and state.providers and state.settings  # set in lifespan

    return await execute_task(request, state.retriever, state.providers, state.settings)
