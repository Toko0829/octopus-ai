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
from .planner import plan_grounded, refuse
from .providers import Providers
from .retrieval import Retriever
from .schemas import PlanRequest, PlanResponse

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

    logger.info(
        "ai service ready",
        extra={
            "embed_model": settings.active_embed_model,
            "generation_model": settings.generation_model,
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


@app.post("/plan", response_model=PlanResponse, tags=["reasoning"])
async def plan(request: PlanRequest) -> PlanResponse:
    """Reason about a goal and return proposals for Node to execute.

    Retrieval decides which core answers. Nothing above the relevance threshold
    means the request is refused rather than answered from parametric knowledge
    (AGENTS.md rule 10).
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
        retrieval = await state.retriever.retrieve(request.goal)
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

    try:
        return await plan_grounded(request, retrieval, state.providers, state.settings)
    except Exception:
        logger.exception(
            "generation failed after successful retrieval",
            extra={"agent_run_id": request.trace.agent_run_id},
        )
        return refuse(request, retrieval)
