import type { SupabaseClient } from '@supabase/supabase-js';
import { postArtifact, transition, type ExecutorDeps } from './executor';
import { roomForProject } from './room-for-project';

/**
 * A step the executor finished and never got to say so.
 *
 * `executeTask` walks a passing AI step `ai_self_check -> approved -> done` and
 * then delivers the artifact into the room, as three writes in a row. It is not
 * durable: a crash between the first and the second leaves the step at
 * `approved`, which is not terminal, so a finished piece of work stays
 * cancellable by any later replan and is recorded in the audit trail as
 * abandoned if one does. The artifact row exists, cited and checked, and nobody
 * has been shown it. `business-projects-workflow.md` named the symptom and said
 * the sweep that heals it belongs beside `reclaimLostRuns`. This is that sweep.
 *
 * ---------- What is and is not a stranded step ----------
 *
 * **Only the AI arm, by `owner_type`.** `approved` is a state three arms share
 * and it means something different on each. On a human step it is the payout
 * authorisation, and `payout.ts` selects on it; walking one to `done` here would
 * take the step out from under the sweep that pays the expert. On a user step
 * the owner-answer path walks it on itself in the same request. On an AI step it
 * is the executor's, and the executor is the only writer that can be killed
 * between two adjacent statements without a transaction around them. Narrowing
 * on the column is the honest version of "whose step is this", and it is the
 * question `payout.ts` deliberately answers by join instead; here the join would
 * be to nothing, since an AI step has no engagement.
 *
 * **Never a campaign step.** `materialise_campaign` also lands a step at
 * `approved`, from `needs_user`, when the owner approves the card, whatever
 * its owner type. That step
 * is not finished: the campaign it authorised is `ready`, then `live`, then
 * whatever the optimize sweep decides, and the step at `approved` is what a
 * replan cancels to stop it. A `campaigns` row pointing at the task is the
 * exclusion, read as its own query rather than inferred from the absence of an
 * artifact, because "no artifact" is also what a crash before the artifact
 * write looks like.
 *
 * **Older than the executor's own gap.** The two writes are one round trip
 * apart, so a step approved in the last few minutes is far more likely to be
 * mid-flight than stranded. The grace window is generous rather than tight
 * because the cost of waiting one more pass is nothing and the cost of racing
 * the executor is real: if this sweep wrote `done` first, the executor's
 * conditional write would miss, and its miss is documented as meaning "somebody
 * cancelled the step", so it would deliver nothing and warn about a
 * cancellation that never happened. `tasks.updated_at` is bumped by the
 * transition trigger, so it is the time the step reached `approved`.
 *
 * ---------- What it writes, and in which order ----------
 *
 * The same rows the executor writes, through the same two functions, in the
 * same order: `approved -> done` conditionally on `approved`, an event saying
 * this was a recovery rather than a normal finish, then the artifact into the
 * room. The conditional write is what makes a second worker or a revived
 * executor harmless: whoever misses, misses cleanly and delivers nothing.
 * Delivery is keyed on the artifact id in `messages.idempotency_key`, so a
 * step whose artifact somehow already reached the room is not announced twice.
 *
 * **A stranded step with no artifact is finished and not delivered**, loudly.
 * The checker only passes a draft that exists, so an AI step at `approved` with
 * nothing to show is a row somebody edited or a crash shape this file has not
 * seen; either way `done` is still the true state of a step the machine
 * approved, and a warning naming the task is better than leaving it
 * cancellable forever while a person works out why.
 *
 * ---------- The historical rows ----------
 *
 * The live database holds AI steps at `approved` from before the executor
 * walked on at all, each with an artifact nobody was shown. The doc that added
 * the walk declined to backfill them in a migration, because a blanket update
 * would have caught human steps whose expert was still owed the escrow. This
 * sweep is that backfill done properly: it cannot touch a human step, it bounds
 * itself per pass, and it delivers the work rather than only relabelling the
 * row. The event it writes says `healed`, so the audit trail does not pretend
 * the invariant is older than it is.
 *
 * ---------- Where it sits on the tick ----------
 *
 * Directly after `reclaimLostRuns` and before the graph is walked. Both are
 * recovery, both act on what a dead worker left behind, and finishing a step
 * before the scheduler runs means a dependent that was waiting on nothing but
 * this second write is picked up in the same pass.
 */

/** How long a step may sit at `approved` before it is treated as stranded. */
export const HEAL_GRACE_MS = 5 * 60_000;

/** How many candidate steps one read may consider. Bounds the read, not the work. */
const TASK_READ_LIMIT = 50;

interface StrandedTask {
  id: string;
  project_id: string;
  title: string;
  stage: string | null;
  updated_at: string;
}

interface StoredArtifact {
  id: string;
  title: string | null;
  body: string | null;
  citations: unknown;
}

export interface HealSweepDeps {
  admin: SupabaseClient;
  /** Bounds steps FINISHED, not steps examined. */
  maxPerPass: number;
  /** Injectable for the test; the sweep otherwise reads the wall clock. */
  now?: () => Date;
  log: ExecutorDeps['log'];
}

export interface HealSweepReport {
  examined: number;
  healed: number;
  /** Candidates left alone because a campaign points at them. */
  campaigns: number;
  /** Conditional writes that missed: something moved the step first. */
  raced: number;
  failed: number;
}

export async function healSweep(deps: HealSweepDeps): Promise<HealSweepReport> {
  const { admin, log } = deps;
  const report: HealSweepReport = { examined: 0, healed: 0, campaigns: 0, raced: 0, failed: 0 };
  if (deps.maxPerPass <= 0) return report;

  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - HEAL_GRACE_MS).toISOString();

  // Oldest first, on purpose: the historical rows are the ones nobody has been
  // shown for longest, and a bounded pass that started with the newest would
  // keep them invisible for as many passes as there are newer strands.
  const { data: rows, error: readError } = await admin
    .from('tasks')
    .select('id, project_id, title, stage, updated_at')
    .eq('state', 'approved')
    .eq('owner_type', 'ai')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(TASK_READ_LIMIT);
  if (readError) throw readError;

  const candidates = (rows ?? []) as StrandedTask[];
  report.examined = candidates.length;
  if (candidates.length === 0) return report;

  // One read for the whole batch rather than one per step. A campaign step is
  // approved work that is deliberately not finished, so it is excluded before
  // any write rather than discovered after one.
  const { data: campaignRows, error: campaignError } = await admin
    .from('campaigns')
    .select('task_id')
    .in(
      'task_id',
      candidates.map((t) => t.id),
    );
  if (campaignError) throw campaignError;
  const campaignTasks = new Set(
    ((campaignRows ?? []) as { task_id: string | null }[])
      .map((c) => c.task_id)
      .filter((id): id is string => typeof id === 'string'),
  );

  for (const task of candidates) {
    if (report.healed >= deps.maxPerPass) break;

    if (campaignTasks.has(task.id)) {
      report.campaigns += 1;
      continue;
    }

    try {
      const outcome = await healOne(admin, task, log);
      if (outcome === 'healed') report.healed += 1;
      else report.raced += 1;
    } catch (err) {
      // Never swallowed, and never fatal to the pass: the next step may be fine,
      // and a step that could not be healed is a log line, not a stopped ticker
      // (rule 16).
      report.failed += 1;
      log.error({ err, taskId: task.id }, 'could not heal a stranded step');
    }
  }

  if (report.healed || report.raced || report.failed || report.campaigns) {
    log.info(report, 'heal sweep complete');
  }
  return report;
}

async function healOne(
  admin: SupabaseClient,
  task: StrandedTask,
  log: ExecutorDeps['log'],
): Promise<'healed' | 'raced'> {
  // The artifact is read before the state moves, so a step with nothing to show
  // is known before it is finished and the warning can say so precisely.
  const { data: artifactRow, error: artifactError } = await admin
    .from('artifacts')
    .select('id, title, body, citations')
    .eq('task_id', task.id)
    .eq('kind', 'draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (artifactError) throw artifactError;
  const artifact = (artifactRow ?? null) as StoredArtifact | null;

  const finished = await transition(
    admin,
    task.id,
    'done',
    'AI step complete, no payout owed. Finished by the heal sweep after the executor stopped between its two writes.',
    'approved',
  );
  if (!finished) {
    // The same race the executor names: `approved -> cancelled` is legal, and
    // so is the executor itself coming back and finishing. Either way the step
    // is somebody else's now and nothing is announced.
    log.warn({ taskId: task.id }, 'stranded step moved before it could be healed');
    return 'raced';
  }

  await admin.from('events').insert({
    project_id: task.project_id,
    actor_kind: 'system',
    verb: 'task.healed',
    subject_type: 'task',
    subject_id: task.id,
    payload: {
      from: 'approved',
      to: 'done',
      approvedAt: task.updated_at,
      artifactId: artifact?.id ?? null,
    },
  });

  if (!artifact) {
    log.warn(
      { taskId: task.id },
      'stranded step finished with no artifact to deliver; the checker should never have approved it',
    );
    return 'healed';
  }

  let roomId: string | null = null;
  try {
    roomId = await roomForProject(admin, task.project_id);
  } catch (err) {
    log.warn({ taskId: task.id, err: String(err) }, 'could not resolve the room for this task');
  }

  const citations = Array.isArray(artifact.citations)
    ? artifact.citations.filter((c): c is string => typeof c === 'string')
    : [];

  await postArtifact(admin, {
    projectId: task.project_id,
    roomId,
    taskId: task.id,
    artifactId: artifact.id,
    step: task.title,
    stage: task.stage,
    title: artifact.title ?? task.title,
    body: artifact.body ?? '',
    citations,
    log,
  });

  log.info({ taskId: task.id, artifactId: artifact.id }, 'healed a stranded step');
  return 'healed';
}
