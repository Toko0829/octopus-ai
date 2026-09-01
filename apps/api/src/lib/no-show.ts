import type { SupabaseClient } from '@supabase/supabase-js';
import { WORK_WARN_BEFORE_MS } from '@octopus/marketplace';
import { postSystemMessage } from './system-message';
import { roomForProject } from './room-for-project';

/**
 * A step somebody took and did not deliver.
 *
 * `escrow_funded` and `in_progress` are the two states where an owner's money is
 * committed against work that has not arrived. Until slice 6 neither had an exit
 * that was not the owner cancelling the whole step, which means an expert who
 * accepted and then vanished pinned part of the budget indefinitely and left the
 * plan with a hole in it. This is that exit.
 *
 * ---------- What this sweep does and does not decide ----------
 *
 * **It selects and it bounds. `public.reassign_engagement` does the work**, in
 * one transaction, because every partial state is unsafe: a moved task with a
 * stale hold makes `accept_offer` refuse the replacement for money already spoken
 * for, and a moved task with a live engagement makes the replacement collide on
 * `engagements_one_live_idx` and unwind permanently on every retry. That
 * function's header argues it in full.
 *
 * **It never reassigns a step that was handed over.** The read is narrowed to
 * `escrow_funded` and `in_progress`, and the transition map refuses the arc from
 * anywhere else, which is two guards for one rule on purpose. **A deadline that
 * passes after the work arrives is the owner's failure to review, not the node's
 * failure to work**, and taking somebody's finished work away to give their fee
 * to a stranger is the worst thing this sweep could do.
 *
 * **It warns before it acts.** A pass first tells any node inside 24 hours of
 * their deadline, once, so reassignment is never the first thing a working person
 * hears about a date they lost track of. Somebody who has genuinely disappeared
 * is unaffected either way, which is why the warning is a day rather than an
 * hour.
 *
 * ---------- The ordering, and the one thing it is ----------
 *
 * The transaction commits, then the room is told. `escrow-reconcile.ts:284-294`
 * argues this and it holds here: the message is keyed on the engagement, so a
 * crash between the commit and the post leaves the next pass unable to say it
 * twice, and a collision is the mechanism working rather than an error.
 *
 * There is no ordering **inside** the reassignment to state, which is the point
 * of it being one function.
 *
 * ---------- Where it sits on the tick ----------
 *
 * Immediately after the escrow reconcile and immediately **before** the matcher,
 * and the adjacency is deliberate the way optimize-after-metrics is: this sweep
 * produces tasks at `matching`, and the matcher picks them up in the same pass
 * rather than a tick later. A person waiting on a replacement expert waits one
 * interval less for no extra work.
 */

/** The two states where money is committed and nothing has been delivered. */
const ABANDONABLE = ['escrow_funded', 'in_progress'] as const;

/** How many engagements one read may consider. Bounds the read, not the work. */
const ENGAGEMENT_READ_LIMIT = 200;

interface LiveEngagement {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  deadline_at: string | null;
  agreed_price: number | string;
  currency: string;
}

export interface NoShowSweepDeps {
  admin: SupabaseClient;
  /** Bounds reassignments PERFORMED, not engagements examined. Warnings are free. */
  maxPerPass: number;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  now?: () => Date;
}

export interface NoShowSweepResult {
  /** Nodes told their deadline is close. One message per engagement, ever. */
  warned: number;
  /** Steps returned to the market, with their escrow given back. */
  reassigned: number;
  /** Could not act this pass. Retried next pass, nothing moved. */
  waiting: number;
}

export async function noShowSweep(deps: NoShowSweepDeps): Promise<NoShowSweepResult> {
  const result: NoShowSweepResult = { warned: 0, reassigned: 0, waiting: 0 };
  const now = deps.now?.() ?? new Date();

  // Live engagements with a deadline. `ended_at is null` is the whole definition
  // of live (`20260904120000`), and `deadline_at` is not null on anything
  // accepted since `20260906122000`; an older row with none is simply never
  // selected, which is the right direction to fail in.
  const { data: rows, error } = await deps.admin
    .from('engagements')
    .select('id, task_id, project_id, node_id, deadline_at, agreed_price, currency')
    .is('ended_at', null)
    .not('deadline_at', 'is', null)
    .order('deadline_at', { ascending: true })
    .limit(ENGAGEMENT_READ_LIMIT);
  if (error) throw error;

  const engagements = (rows ?? []) as LiveEngagement[];
  if (engagements.length === 0) return result;

  // One batched task read rather than a join, for `roomForProject`'s reason:
  // PostgREST relationship guessing fails silently and this is the read that
  // decides whether somebody loses work.
  const { data: taskRows, error: taskError } = await deps.admin
    .from('tasks')
    .select('id, state, title')
    .in(
      'id',
      engagements.map((e) => e.task_id),
    );
  if (taskError) throw taskError;

  const taskById = new Map(
    (taskRows ?? []).map((t) => [
      t.id as string,
      { state: t.state as string, title: (t.title as string) ?? 'a step' },
    ]),
  );

  for (const engagement of engagements) {
    if (result.reassigned >= deps.maxPerPass) break;

    const task = taskById.get(engagement.task_id);
    // A step that has been handed over, approved, cancelled or taken back is not
    // this sweep's. Checked here as well as in the map and in the function,
    // because this is the layer that can say nothing at all rather than raising.
    if (!task || !ABANDONABLE.includes(task.state as (typeof ABANDONABLE)[number])) continue;

    const deadline = new Date(engagement.deadline_at as string).getTime();
    const remaining = deadline - now.getTime();

    try {
      if (remaining > 0) {
        if (remaining <= WORK_WARN_BEFORE_MS) {
          const warned = await warnNode(deps, engagement, task.title);
          if (warned) result.warned += 1;
        }
        continue;
      }

      await reassign(deps, engagement, task.title);
      result.reassigned += 1;
    } catch (err) {
      // Per item, so one engagement that cannot be moved does not stop the pass
      // reaching the others. Never swallowed (rule 16): this is money and
      // somebody's work, and a silent skip here is a step that stays stuck for
      // exactly as long as nobody reads the logs.
      result.waiting += 1;
      deps.log.error(
        { err, engagementId: engagement.id, taskId: engagement.task_id },
        'could not act on an overdue engagement',
      );
    }
  }

  if (result.warned || result.reassigned || result.waiting) {
    deps.log.info(result, 'no-show sweep complete');
  }
  return result;
}

/**
 * Tell the room a deadline is close.
 *
 * **In the thread, not the room stream**, because it is addressed to the node and
 * the node cannot read the room stream. The owner sees it anyway: they read
 * thread messages, marked rather than hidden.
 *
 * Keyed on the engagement alone, so it is said **once ever** rather than once per
 * pass for the last day of every deal. A collision is the mechanism working.
 */
async function warnNode(
  deps: NoShowSweepDeps,
  engagement: LiveEngagement,
  title: string,
): Promise<boolean> {
  const { data: threadRow, error } = await deps.admin
    .from('threads')
    .select('id, room_id')
    .eq('task_id', engagement.task_id)
    .maybeSingle();
  if (error) throw error;

  const thread = threadRow as { id: string; room_id: string } | null;
  if (!thread) {
    deps.log.warn(
      { engagementId: engagement.id, taskId: engagement.task_id },
      'an engagement is close to its deadline but its task has no thread to say so in',
    );
    return false;
  }

  const { error: insertError } = await deps.admin.from('messages').insert({
    room_id: thread.room_id,
    thread_id: thread.id,
    author_id: null,
    author_kind: 'system',
    body:
      `This step is due within a day. If "${title}" is not handed over by then it goes back ` +
      'to the marketplace and the payment is released back to the owner. Say where you have ' +
      'got to if you need longer.',
    idempotency_key: `work-due-soon:${engagement.id}`,
  });
  // 23505 is silence: this pass had nothing new to say.
  if (insertError && insertError.code !== '23505') {
    deps.log.error({ err: insertError, engagementId: engagement.id }, 'could not warn a node');
    return false;
  }
  return insertError === null;
}

/**
 * End the deal and give the step back to the market.
 *
 * The rpc is the whole act; everything here is announcing it. **The message comes
 * after the commit** so a failure to post cannot undo a reassignment, and its key
 * carries the engagement so a crash between the two leaves the next pass unable
 * to post a second line.
 */
async function reassign(
  deps: NoShowSweepDeps,
  engagement: LiveEngagement,
  title: string,
): Promise<void> {
  const { error } = await deps.admin.rpc('reassign_engagement', {
    p_engagement_id: engagement.id,
  });
  if (error) throw error;

  const roomId = await roomForProject(deps.admin, engagement.project_id);
  if (!roomId) {
    deps.log.warn(
      { engagementId: engagement.id, projectId: engagement.project_id },
      'reassigned an engagement whose project has no room, so nobody was told',
    );
    return;
  }

  // **The owner is told what happened to their money as well as to their step**,
  // because "an expert dropped it" and "you have your budget back" are two facts
  // and only one of them is obvious. The node's name is not in the message: the
  // roster cannot see a thread-scoped membership, and naming somebody in the
  // sentence that says they failed is a decision this slice has no reason to
  // take.
  await postSystemMessage(
    deps.admin,
    deps.log,
    roomId,
    `work-reassigned:${engagement.id}`,
    `The expert working on "${title}" did not hand it over by the agreed date, so the step has ` +
      'gone back to the marketplace and the payment that was held for it is available again. ' +
      'A new expert will be offered it on the next pass.',
  );
}
