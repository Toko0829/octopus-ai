import type { ProjectSummary } from '@octopus/contracts';

/**
 * Turning task rows into the numbers a person reads on the project list.
 *
 * Pure, and separate from the route, for the reason `planEmbedPayload` is: this
 * is the kind of logic that fails silently. A miscount does not throw, does not
 * fail a type check and renders as a perfectly plausible progress figure, so the
 * only thing that can catch it is an assertion.
 */

/**
 * Finished, in the sense that dependents may move.
 *
 * Counted at `approved` rather than `done` to match `private.task_deps_satisfied`,
 * which does the same and says why: waiting for `paid` would hold a whole graph
 * on a bank transfer. The number a person reads and the number the scheduler acts
 * on should not disagree about what "done" means.
 */
export const DONE_STATES = new Set(['approved', 'done', 'paid']);

export interface TaskStateRow {
  project_id: string;
  state: string;
}

export interface ArtifactProjectRow {
  project_id: string;
}

export interface ProjectRowForSummary {
  id: string;
  goal: string;
  status: ProjectSummary['status'];
  created_at: string;
}

/**
 * `waitingOnYou` and `escalated` are counted out of the state set rather than
 * left inside a total, because they are the only two that ask the reader to do
 * something. `escalated` in particular means the step is waiting on a marketplace
 * that does not exist yet, so it is not progress and must not be presented as
 * pending work that is merely slow.
 *
 * Rows belonging to a project not in `projects` are ignored rather than creating
 * an entry. RLS can legitimately return a task whose project row was filtered by
 * a different predicate, and inventing a project from a task row would put a
 * goal-less entry on someone's list.
 */
export function summariseProjects(
  projects: ProjectRowForSummary[],
  tasks: TaskStateRow[],
  artifacts: ArtifactProjectRow[],
): ProjectSummary[] {
  const counts = new Map(
    projects.map((p) => [p.id, { total: 0, done: 0, waiting: 0, escalated: 0, artifacts: 0 }]),
  );

  for (const task of tasks) {
    const c = counts.get(task.project_id);
    if (!c) continue;
    c.total += 1;
    if (DONE_STATES.has(task.state)) c.done += 1;
    if (task.state === 'needs_user') c.waiting += 1;
    if (task.state === 'escalated') c.escalated += 1;
  }

  for (const artifact of artifacts) {
    const c = counts.get(artifact.project_id);
    if (c) c.artifacts += 1;
  }

  return (
    projects
      // Newest first: the thing someone just approved is the thing they came to look
      // at. String compare is safe on the ISO timestamps PostgREST returns.
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((p) => {
        const c = counts.get(p.id) ?? { total: 0, done: 0, waiting: 0, escalated: 0, artifacts: 0 };
        return {
          id: p.id,
          goal: p.goal,
          status: p.status,
          createdAt: p.created_at,
          taskCount: c.total,
          doneCount: c.done,
          waitingOnYou: c.waiting,
          escalated: c.escalated,
          artifactCount: c.artifacts,
        };
      })
  );
}

/**
 * Citations are document titles resolved at write time, stored as jsonb, so the
 * column can legally hold anything. Non-strings are dropped rather than coerced:
 * a citation a reader cannot follow is worse than an honest absence, and an empty
 * list already renders as "not grounded in a named source" rather than as nothing
 * at all.
 */
export function citationTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}
