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
 *
 * **`payout_pending` was missing, and the comment above claimed it was not.** The
 * SQL predicate is `state not in ('approved','payout_pending','paid','done')`, so
 * for the whole life of the payout slice a step between "the owner approved it"
 * and "the transfer landed" was counted as unfinished on the project list while
 * the panel beside it read "Done, payment pending" and the scheduler let its
 * dependents run. Three surfaces, two answers. Fixed here rather than in the SQL
 * because the SQL was right; this set is the copy that drifted.
 *
 * This is now the single definition of "satisfied" on the TypeScript side, and
 * `blockedBy` in `routes/projects.ts` reads it rather than restating it.
 */
export const DONE_STATES = new Set(['approved', 'payout_pending', 'paid', 'done']);

/**
 * The states the executor is holding a step in.
 *
 * Two rather than one: `ai_running` is the model working and `ai_self_check` is
 * the critic reading what it produced, and both are the agent busy on that step
 * from the reader's side. Stopping at `ai_running` would blink the panel off
 * between the draft and its review, which reads as the work having finished.
 *
 * Deliberately not `routing`: that is the scheduler deciding who takes the step,
 * and no voice owns it yet.
 */
export const WORKING_STATES = new Set(['ai_running', 'ai_self_check']);

export interface TaskStateRow {
  project_id: string;
  state: string;
  /** Present only on the reads that select them; `working` needs both. */
  stage?: string | null;
  title?: string | null;
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
    projects.map((p) => [
      p.id,
      {
        total: 0,
        done: 0,
        waiting: 0,
        escalated: 0,
        artifacts: 0,
        working: [] as { stage: string | null; title: string }[],
      },
    ]),
  );

  for (const task of tasks) {
    const c = counts.get(task.project_id);
    if (!c) continue;
    c.total += 1;
    if (DONE_STATES.has(task.state)) c.done += 1;
    if (task.state === 'needs_user') c.waiting += 1;
    if (task.state === 'escalated') c.escalated += 1;
    if (WORKING_STATES.has(task.state)) {
      // The title is what the reader sees, so an absent one falls back to words
      // rather than to `undefined`. A read that did not select these columns
      // yields a working entry with no title instead of crashing the summary,
      // which is the same stance `citations` takes two functions below.
      c.working.push({ stage: task.stage ?? null, title: task.title ?? 'an unnamed step' });
    }
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
        const c = counts.get(p.id) ?? {
          total: 0,
          done: 0,
          waiting: 0,
          escalated: 0,
          artifacts: 0,
          working: [],
        };
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
          working: c.working,
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
