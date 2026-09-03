import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Record what the owner answered against one step, and complete it.
 *
 * **Their answer is the deliverable.** The plan gave them work only they could
 * do, a budget, a positioning call, which analytics source counts, so a task
 * that has been answered is done rather than merely unblocked. It is stored as
 * an artifact `created_by: 'user'` and the task moves to `approved`, which is
 * the state that satisfies dependents, and then on to `done`, because
 * `approved` is not terminal and a step the owner just finished must not stay
 * cancellable by a later replan.
 *
 * Extracted when the question card became the second writer of exactly this
 * sequence, beside the project panel's resolve route. Two copies of three
 * statements that must agree on the arc is where drift starts, and this
 * repository has recorded that drift once already (`DONE_STATES` missing a
 * state its comment claimed to mirror).
 *
 * **The first move is conditional on the state the caller read**, so two
 * writers racing cannot both complete the step. A miss is reported, not thrown:
 * the answer and its artifact are committed either way, and the caller decides
 * whether a lost race is a 409 (the panel, where a person is waiting for an
 * answer) or a log line (a card, where the answer is already on screen).
 */
export interface AnswerableTask {
  id: string;
  project_id: string;
  title: string;
  /** The state the caller read, which the first write is conditional on. */
  state: string;
}

export interface CompleteTaskOptions {
  /** Where the answer moves the step. `approved` for a `needs_user` answer. */
  to: string;
  /** Whether to walk on to `done` afterwards. */
  completes: boolean;
}

export type CompleteTaskResult =
  | { moved: false }
  | {
      moved: true;
      /** The state the step was actually left in. */
      finalState: string;
      /**
       * True when `completes` was asked for and the second hop found no row.
       * A race rather than a defect: `approved -> cancelled` is a legal arc.
       */
      finishMissed: boolean;
    };

export async function completeTaskWithAnswer(
  admin: SupabaseClient,
  task: AnswerableTask,
  text: string,
  options: CompleteTaskOptions,
): Promise<CompleteTaskResult> {
  // Deliberately no citations. The person's own decision rests on no retrieved
  // source, and attaching one would attribute their judgement to the corpus.
  // The checker never sees this: a human answering is not a maker to be checked.
  const { error: artifactError } = await admin.from('artifacts').insert({
    task_id: task.id,
    project_id: task.project_id,
    kind: 'answer',
    title: task.title,
    body: text,
    citations: [],
    created_by: 'user',
  });
  if (artifactError) throw artifactError;

  const { data: moved, error: moveError } = await admin
    .from('tasks')
    .update({ state: options.to })
    .eq('id', task.id)
    .eq('state', task.state)
    .select('id');
  if (moveError) throw moveError;
  if (!moved || moved.length === 0) return { moved: false };

  if (!options.completes) return { moved: true, finalState: options.to, finishMissed: false };

  const { data: finished, error: finishError } = await admin
    .from('tasks')
    .update({ state: 'done' })
    .eq('id', task.id)
    .eq('state', 'approved')
    .select('id');
  if (finishError) throw finishError;
  const done = !!finished && finished.length > 0;
  return { moved: true, finalState: done ? 'done' : options.to, finishMissed: !done };
}
