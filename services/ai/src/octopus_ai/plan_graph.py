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

import re

from .schemas import STEP_ID_PATTERN, PlanStage, PlanStep

__all__ = [
    "STEP_ID_MAX_LENGTH",
    "find_cycle",
    "normalise_op_ids",
    "normalise_plan_ids",
    "normalise_step_ids",
    "sanitise_dependencies",
    "slugify_step_id",
]

# The length `STEP_ID_PATTERN` allows. Held here as a number as well as inside
# the regex because truncation needs the number and a regex cannot be asked for
# one. The two must agree; `test_plan_parsing` pins that they do.
STEP_ID_MAX_LENGTH = 32

_STEP_ID = re.compile(STEP_ID_PATTERN)
_NOT_SLUG = re.compile(r"[^a-z0-9]+")


def slugify_step_id(raw: object) -> str | None:
    """The nearest valid step id to what the model wrote, or None if there is none.

    Lowercased, every run of anything but a letter or digit collapsed to one
    hyphen, trimmed to the pattern's length, and hyphens stripped from both ends
    so the trim cannot leave one dangling. `None` means nothing usable survived,
    and the caller drops the id rather than inventing one: a step with no id is
    a step nothing can depend on, which is the flat plan and is safe.
    """
    if not isinstance(raw, str):
        return None
    slug = _NOT_SLUG.sub("-", raw.lower()).strip("-")
    if not slug:
        return None
    slug = slug[:STEP_ID_MAX_LENGTH].rstrip("-")
    return slug or None


def normalise_step_ids(steps: list[dict]) -> list[str]:
    """Rewrite each step's `id` and `depends_on` in place to satisfy the pattern.

    Why this exists: the model was asked for "readable" ids and never told the
    length, so it wrote `define-signup-event-and-cpa-ceiling`, Pydantic rejected
    the id, and `parse_plan` threw the entire fifteen-step plan away over one
    slug. Measured on a live run, and the second plan in the same container went
    the same way. An id is a join key and nothing more, so the safe repair is to
    shorten it and carry every reference to it along, not to lose the plan.

    Rules, in order:

    * An id that already matches the pattern is left exactly as written, and its
      value is reserved first, so a shortened id can never collide into it and
      quietly steal its dependants.
    * The same raw id appearing twice maps to the same new id both times, so a
      genuine duplicate stays a duplicate for `sanitise_dependencies` to report;
      only a collision *created* by truncation gets a `-2`, `-3` suffix.
    * `depends_on` entries are rewritten through the same map. An entry naming
      something else (a task uuid on the replan path, or an id that was dropped)
      is left alone for the next layer to judge.

    Returns one problem string per repair. None of them is fatal.
    """
    problems: list[str] = []
    taken: set[str] = set()
    for step in steps:
        raw = step.get("id")
        if isinstance(raw, str) and _STEP_ID.fullmatch(raw):
            taken.add(raw)

    mapping: dict[str, str] = {}
    for step in steps:
        raw = step.get("id")
        if raw is None or (isinstance(raw, str) and _STEP_ID.fullmatch(raw)):
            continue
        title = step.get("title", "?")
        if isinstance(raw, str) and raw in mapping:
            step["id"] = mapping[raw]
            continue

        slug = slugify_step_id(raw)
        if slug is None:
            step["id"] = None
            problems.append(
                f"step {title!r} has id {raw!r}, which has nothing a slug can be made "
                "from; dropped, so nothing can depend on this step"
            )
            continue

        candidate = slug
        n = 2
        while candidate in taken:
            suffix = f"-{n}"
            candidate = slug[: STEP_ID_MAX_LENGTH - len(suffix)].rstrip("-") + suffix
            n += 1
        if candidate != slug:
            problems.append(
                f"step {title!r} id {raw!r} shortened to {slug!r} collided with another "
                f"step; renamed {candidate!r}"
            )
        else:
            problems.append(f"step {title!r} id {raw!r} normalised to {candidate!r}")
        taken.add(candidate)
        if isinstance(raw, str):
            mapping[raw] = candidate
        step["id"] = candidate

    if mapping:
        for step in steps:
            deps = step.get("depends_on")
            if isinstance(deps, list):
                step["depends_on"] = [
                    mapping.get(dep, dep) if isinstance(dep, str) else dep for dep in deps
                ]

    return problems


def normalise_plan_ids(data: dict) -> list[str]:
    """`normalise_step_ids` over every step of a plan object, in place."""
    stages = data.get("stages")
    if not isinstance(stages, list):
        return []
    steps: list[dict] = []
    for stage in stages:
        if isinstance(stage, dict) and isinstance(stage.get("steps"), list):
            steps.extend(step for step in stage["steps"] if isinstance(step, dict))
    return normalise_step_ids(steps)


def normalise_op_ids(data: dict) -> list[str]:
    """`normalise_step_ids` over the `add_step` ops of a replan diff, in place.

    Only added steps carry a slug; cancel and modify name existing tasks by uuid,
    and those pass through `depends_on` untouched because they match no slug.
    """
    ops = data.get("ops")
    if not isinstance(ops, list):
        return []
    added = [op for op in ops if isinstance(op, dict) and op.get("op") == "add_step"]
    return normalise_step_ids(added)


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
