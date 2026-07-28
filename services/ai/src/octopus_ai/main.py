"""FastAPI app for the Octopus AI service.

The Python half of ADR-0006. It owns RAG and the reasoning core; it proposes and
never performs side effects. There is deliberately no database client and no
Supabase key in this service yet: it cannot write, so a jailbroken prompt here
still cannot move money or post as anyone.

The OpenAPI document FastAPI generates at /openapi.json is the contract the Node
side consumes (ADR-0004).
"""

import logging

from fastapi import FastAPI
from pydantic import BaseModel

from .planner import plan as run_plan
from .schemas import PlanRequest, PlanResponse

logger = logging.getLogger("octopus.ai")

app = FastAPI(
    title="Octopus AI service",
    version="0.0.0",
    summary="RAG and the agent reasoning core. Proposes; never writes.",
)


class Health(BaseModel):
    status: str
    service: str
    version: str


@app.get("/health", response_model=Health, tags=["ops"])
def health() -> Health:
    """Liveness probe. Mirrors the Node service's /api/health."""
    return Health(status="ok", service="octopus-ai", version=app.version)


@app.post("/plan", response_model=PlanResponse, tags=["reasoning"])
def plan(request: PlanRequest) -> PlanResponse:
    """Reason about a goal and return proposals for Node to execute.

    Correlation IDs are logged on every call so a step here can be tied back to
    its run in Node (observability.md).
    """
    logger.info(
        "plan requested",
        extra={
            "agent_run_id": request.trace.agent_run_id,
            "project_id": request.trace.project_id,
            "room_id": request.room_id,
        },
    )
    response = run_plan(request)
    logger.info(
        "plan produced",
        extra={
            "agent_run_id": request.trace.agent_run_id,
            "core": response.core,
            "grounded": response.grounded,
            "proposals": len(response.proposals),
        },
    )
    return response
