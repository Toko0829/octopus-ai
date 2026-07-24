# Diagrams

> Source-of-truth diagrams (Mermaid, kept in-repo so they version with the docs) plus exported assets (ERD, DAG, sequence). Update a diagram in the same PR as the behavior it depicts.

## Core loop (sequence)

```mermaid
sequenceDiagram
    actor User
    participant Web as apps/web (BFF)
    participant API as apps/api (Fastify)
    participant PG as Postgres (RLS)
    participant RT as Realtime
    participant Agent as apps/agent (Trigger.dev)
    participant Matcher as apps/matcher
    actor Node as Human Node

    User->>Web: "open a cafe in Austin"
    Web->>API: POST /rooms/:id/messages (JWT)
    API->>PG: insert message (RLS)
    PG-->>RT: trigger broadcast
    RT-->>User: message appears live
    API->>Agent: tasks.trigger(agent.run) -> 202 + runId
    Agent->>PG: rag_retrieve (pgvector hybrid)
    Agent->>PG: persist plan + task DAG
    Agent-->>RT: stream plan inline (as member)
    Agent->>Matcher: request_human_node (escrow held)
    Note over Agent: run SUSPENDS on waitpoint (days @ 0 compute)
    Matcher->>Node: offer (scope, price, deadline)
    Node->>PG: accept -> room_members insert (RLS)
    Node-->>RT: works in task thread w/ AI + User
    Node->>PG: submit proof (Storage)
    User->>API: approve
    API->>Matcher: complete waitpoint token
    Matcher->>Agent: resume
    Agent->>PG: release escrow -> payout + ledger
    Agent-->>RT: summary + next actions
```

## Two-layer brain (component)

```mermaid
flowchart TB
    subgraph Backbone["Durable execution backbone (Trigger.dev)"]
      W[Waitpoints] --- R[Retries/Idempotency] --- U[Run UI]
    end
    subgraph Core["Supervisor / orchestrator reasoning core"]
      P[Planner] --> DAG[(Task DAG - single writer)]
      P --> Tools[Typed tools]
      Tools --> Critic[Maker-checker critic]
    end
    Core -->|runs as durable tasks| Backbone
    Tools --> PG[(Postgres: source of truth)]
    Tools --> RAG[(pgvector RAG)]
```

## Planned exports

- `erd.*` — full entity-relationship diagram (from [data-model.md](../10-architecture/data-model.md)).
- `task-state.*` — the per-task state machine ([business-projects-workflow.md](../30-modules/business-projects-workflow.md)).
- `topology.*` — deployment topology ([architecture.md](../10-architecture/architecture.md)).

> Artifacts note: rendered exports (SVG/PNG) are generated from these Mermaid sources; keep the Mermaid the source of truth.
