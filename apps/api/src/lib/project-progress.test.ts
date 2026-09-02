import { describe, expect, it } from 'vitest';
import { citationTitles, summariseProjects, DONE_STATES } from './project-progress';

/**
 * Assert-and-return, rather than `[0]!`. Under `noUncheckedIndexedAccess` the
 * assertion is the honest version: if the function returned nothing, that is the
 * failure worth reporting, not a downstream property read on undefined.
 */
function one<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}

const project = (id: string, createdAt: string) => ({
  id,
  goal: `goal ${id}`,
  status: 'active' as const,
  created_at: createdAt,
});

describe('summariseProjects', () => {
  it('counts a finished step at approved, not only at done', () => {
    // Matches private.task_deps_satisfied. If these two ever disagree, a person
    // reads "3 of 8" while the scheduler has already unblocked the dependents.
    const p = one(
      summariseProjects(
        [project('p1', '2026-08-01T00:00:00Z')],
        [
          { project_id: 'p1', state: 'approved' },
          { project_id: 'p1', state: 'done' },
          { project_id: 'p1', state: 'paid' },
          { project_id: 'p1', state: 'ai_running' },
        ],
        [],
      ),
    );
    expect(p.taskCount).toBe(4);
    expect(p.doneCount).toBe(3);
  });

  it('counts waiting and escalated separately, because only one is actionable', () => {
    const p = one(
      summariseProjects(
        [project('p1', '2026-08-01T00:00:00Z')],
        [
          { project_id: 'p1', state: 'needs_user' },
          { project_id: 'p1', state: 'needs_user' },
          { project_id: 'p1', state: 'escalated' },
        ],
        [],
      ),
    );
    expect(p.waitingOnYou).toBe(2);
    expect(p.escalated).toBe(1);
    // Neither counts as progress: escalated waits on a marketplace that does not
    // exist, and presenting it as work in flight would be a false statement.
    expect(p.doneCount).toBe(0);
  });

  it('never counts a task or artifact belonging to another project', () => {
    // RLS can return a task whose project row was filtered by a different
    // predicate. Inventing a project from a task row would put a goal-less entry
    // on somebody's list.
    const summaries = summariseProjects(
      [project('p1', '2026-08-01T00:00:00Z')],
      [
        { project_id: 'p1', state: 'approved' },
        { project_id: 'p-unknown', state: 'approved' },
      ],
      [{ project_id: 'p1' }, { project_id: 'p-unknown' }],
    );
    const summary = one(summaries);
    expect(summary.taskCount).toBe(1);
    expect(summary.artifactCount).toBe(1);
  });

  it('returns a project with no tasks as zeroed rather than dropping it', () => {
    // A project whose plan was approved but whose tick has not run yet is real
    // and must appear, or approving something looks like it did nothing.
    const p = one(summariseProjects([project('p1', '2026-08-01T00:00:00Z')], [], []));
    expect(p.taskCount).toBe(0);
    expect(p.doneCount).toBe(0);
    expect(p.goal).toBe('goal p1');
  });

  it('orders newest first', () => {
    const ordered = summariseProjects(
      [
        project('old', '2026-08-01T00:00:00Z'),
        project('new', '2026-08-27T00:00:00Z'),
        project('mid', '2026-08-14T00:00:00Z'),
      ],
      [],
      [],
    );
    expect(ordered.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate the array it was given', () => {
    const input = [project('a', '2026-08-01T00:00:00Z'), project('b', '2026-08-27T00:00:00Z')];
    summariseProjects(input, [], []);
    expect(input.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('treats an unknown state as neither done nor waiting', () => {
    // A state added to the enum without being added here should under-report
    // progress, never over-report it.
    const p = one(
      summariseProjects(
        [project('p1', '2026-08-01T00:00:00Z')],
        [{ project_id: 'p1', state: 'something_new' }],
        [],
      ),
    );
    expect(p.taskCount).toBe(1);
    expect(p.doneCount).toBe(0);
    expect(p.waitingOnYou).toBe(0);
    expect(p.escalated).toBe(0);
  });

  it('does not count a rejected or failed step as done', () => {
    const p = one(
      summariseProjects(
        [project('p1', '2026-08-01T00:00:00Z')],
        [
          { project_id: 'p1', state: 'rejected' },
          { project_id: 'p1', state: 'failed' },
          { project_id: 'p1', state: 'cancelled' },
        ],
        [],
      ),
    );
    expect(p.doneCount).toBe(0);
  });

  /**
   * The set is a copy of `private.task_deps_satisfied`, whose predicate is
   * `state not in ('approved','payout_pending','paid','done')`. It is spelled
   * out here rather than described, because the copy drifted once already:
   * `payout_pending` was missing for the whole life of the payout slice, so a
   * step the scheduler had already unblocked and the panel already labelled
   * "Done, payment pending" was counted as unfinished on the project list.
   * Three surfaces, two answers, and nothing failing.
   */
  it('keeps DONE_STATES aligned with what the scheduler unblocks on', () => {
    expect([...DONE_STATES].sort()).toEqual(['approved', 'done', 'paid', 'payout_pending']);
  });

  it('counts a step whose payout is still moving as done', () => {
    const p = one(
      summariseProjects(
        [project('p1', '2026-08-01T00:00:00Z')],
        [
          { project_id: 'p1', state: 'payout_pending' },
          { project_id: 'p1', state: 'pending' },
        ],
        [],
      ),
    );
    expect(p.doneCount).toBe(1);
  });
});

describe('citationTitles', () => {
  it('keeps the titles a reader can follow', () => {
    expect(citationTitles(['Controlling CPA on paid social', 'Google Ads policies'])).toEqual([
      'Controlling CPA on paid social',
      'Google Ads policies',
    ]);
  });

  it('drops non-strings rather than coercing them', () => {
    // The column is jsonb, so it can legally hold anything. `String(null)` would
    // render the word "null" as a source, which is a fabricated citation.
    expect(citationTitles([null, 42, { title: 'x' }, 'Real source'])).toEqual(['Real source']);
  });

  it('drops blank entries, which would render as an unlabelled source', () => {
    expect(citationTitles(['', '   ', 'Real source'])).toEqual(['Real source']);
  });

  it('returns an empty list for anything that is not an array', () => {
    // Empty is meaningful and already rendered in words: uncited work must not
    // pass as grounded (rule 10).
    expect(citationTitles(null)).toEqual([]);
    expect(citationTitles(undefined)).toEqual([]);
    expect(citationTitles('a string')).toEqual([]);
    expect(citationTitles({ 0: 'looks arrayish' })).toEqual([]);
  });
});
