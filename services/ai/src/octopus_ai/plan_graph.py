"""Make the planner's stated dependencies into a graph the database will accept.

Pure, no IO, no model call: the same shape as `risk.py` and `deliverable.py`, and
for the same reason. What this decides is checkable by reading it.

## Why this repairs instead of refusing

`parse_plan` raises on an out-of-range citation, and the plan degrades to a cited
paragraph. That is right for a citation: an index the reader cannot follow is a
false statement on the surface rule 10 exists to protect, so the plan should not
ship carrying one.

A dependency is the opposite trade, and `materialise_plan` already wrote down
why: **an invented edge is worse than a missing one.** A missing edge lets two
steps run in parallel that perhaps should not have; an invented one blocks work
for a reason that does not exist and cannot be traced to anything. So the safe
repair for a dependency we cannot resolve is to drop it, and the safe repair for
a graph we cannot trust at all is to drop every edge, which is exactly the flat
plan this system shipped before dependencies existed. Known-good behaviour is
always available as the fallback, so **nothing about dependencies can cost
somebody their plan**.

Dropping is not the same as dropping silently, which is the defect this
repository keeps finding in itself. Every repair is returned as a problem string
for the caller to log, and `executor.py` sets the precedent: a citation naming a
source the maker was never given is dropped here rather than passed on, counted
separately so the drop is visible.

## Why the database still refuses what this repairs

`materialise_plan` raises on a dependency naming no step, and the acyclicity
trigger raises on a cycle. That is not a contradiction with dropping them here,
it is the same layering the risk tier already uses: the model proposes, code
repairs what it can safely repair, and Postgres refuses to guess about anything
that reaches it. A card can arrive from an older service, a replay, or a hand
edit, and the guard that outlives all of those is the one in the database.
"""

from __future__ import annotations

from .schemas import PlanStage, PlanStep

__all__ = ["find_cycle", "sanitise_dependencies"]


def _drop_all_edges(stages: list[PlanStage]) -> list[PlanStage]:
    """The flat plan: every step, no edges. What shipped before this feature."""
    return [
        PlanStage(
            stage=stage.stage,
            steps=[step.model_copy(update={"depends_on": []}) for step in stage.steps],
        )
        for stage in stages
    ]


def sanitise_dependencies(stages: list[PlanStage]) -> tuple[list[PlanStage], list[str]]:
    """Return the stages with only resolvable, acyclic dependencies, and what changed.

    The second element is a list of human-readable problems, empty when the model
    stated a clean graph. The caller logs them; none of them is fatal.

    Two failures are unrepairable per-edge and drop the whole graph to flat:

    * **Duplicate ids** make the id -> task map ambiguous, so an edge naming a
      duplicated id would bind to whichever row happened to be written last. That
      is an edge pointing somewhere nobody chose, which is the invented-edge
      failure with extra steps.
    * **A cycle** means the model's ordering reasoning was incoherent across that
      group. Cutting one edge to break it would be choosing arbitrarily which of
      the model's statements to keep, and the survivors would assert an order it
      never coherently stated.
    """
    problems: list[str] = []

    ids: list[str] = [step.id for stage in stages for step in stage.steps if step.id]
    seen: set[str] = set()
    duplicates: set[str] = set()
    for step_id in ids:
        if step_id in seen:
            duplicates.add(step_id)
        seen.add(step_id)

    if duplicates:
        problems.append(
            f"duplicate step ids {sorted(duplicates)}; dropping every dependency, "
            "because an id naming two steps cannot resolve to one task"
        )
        return _drop_all_edges(stages), problems

    known = seen
    cleaned: list[PlanStage] = []
    edges: dict[str, list[str]] = {}

    for stage in stages:
        steps: list[PlanStep] = []
        for step in stage.steps:
            kept: list[str] = []
            for ref in step.depends_on:
                if ref == step.id:
                    problems.append(f"step '{step.title}' depends on itself; dropped")
                    continue
                if ref not in known:
                    problems.append(
                        f"step '{step.title}' depends on '{ref}', which names no step "
                        "in this plan; dropped"
                    )
                    continue
                if ref in kept:
                    problems.append(f"step '{step.title}' lists '{ref}' twice; deduplicated")
                    continue
                kept.append(ref)

            steps.append(step.model_copy(update={"depends_on": kept}))
            if step.id:
                edges[step.id] = kept
        cleaned.append(PlanStage(stage=stage.stage, steps=steps))

    cycle = find_cycle(edges)
    if cycle:
        problems.append(
            f"dependencies form a cycle ({' -> '.join(cycle)}); dropping every "
            "dependency, because breaking it would mean choosing arbitrarily which "
            "stated order to keep"
        )
        return _drop_all_edges(stages), problems

    return cleaned, problems


def find_cycle(edges: dict[str, list[str]]) -> list[str] | None:
    """One cycle in the dependency graph, named, or None.

    Named rather than merely detected because the log line is the only thing that
    will ever tell anybody the model produced one, and "there is a cycle" does not
    say where to look.
    """
    UNVISITED, ACTIVE, DONE = 0, 1, 2
    state: dict[str, int] = dict.fromkeys(edges, UNVISITED)

    def walk(node: str, path: list[str]) -> list[str] | None:
        state[node] = ACTIVE
        path.append(node)
        for nxt in edges.get(node, ()):
            if nxt not in state:
                continue
            if state[nxt] == ACTIVE:
                return path[path.index(nxt) :] + [nxt]
            if state[nxt] == UNVISITED:
                found = walk(nxt, path)
                if found:
                    return found
        path.pop()
        state[node] = DONE
        return None

    for node in edges:
        if state[node] == UNVISITED:
            found = walk(node, [])
            if found:
                return found
    return None
