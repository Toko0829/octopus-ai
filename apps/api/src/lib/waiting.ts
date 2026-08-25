import type { SupabaseClient } from '@supabase/supabase-js';
import type { TickReport, TickResult } from '@octopus/core';
import { QuestionEmbedPayload } from '@octopus/contracts';
import { roomForProject } from './room-for-project';

/**
 * Telling somebody that a task is waiting on them.
 *
 * Until now `NEEDS_USER` and `ESCALATED` were honest waiting states with nothing
 * behind them: a task landed there and sat, and the person whose answer it needed
 * was never told. A project stopped, and the only evidence was rows nobody looks
 * at. That is the silent failure rule 16 forbids, arriving as a product problem
 * rather than an exception.
 *
 * **One message per tick, not one per task.** `ai-orchestrator.md` requires the
 * agent to report as batched digests rather than chatter, and `vision.md` counts
 * user touches as a guardrail metric to drive down. Three tasks needing a budget,
 * a brand decision and an account connection are one conversation, not three
 * notifications.
 *
 * **The two states are not merged**, because only one of them is actionable. A
 * task needing the person is something they can answer now; a task needing an
 * expert node is waiting on a marketplace that does not exist yet, and saying so
 * plainly beats implying somebody is on their way.
 */

/** The outcomes that mean a human is now the blocker. */
const WAITING_OUTCOMES = ['needs_user', 'escalated'] as const;

export interface WaitingSummary {
  needsUser: TickResult[];
  escalated: TickResult[];
}

/**
 * Split a tick's results into the two kinds of waiting. Pure, so the message it
 * produces can be checked without a database.
 */
export function summariseWaiting(report: TickReport): WaitingSummary {
  return {
    needsUser: report.results.filter((r) => r.outcome === 'needs_user'),
    escalated: report.results.filter((r) => r.outcome === 'escalated'),
  };
}

export function hasWaiting(summary: WaitingSummary): boolean {
  return summary.needsUser.length > 0 || summary.escalated.length > 0;
}

/**
 * Compose the digest.
 *
 * Templated here rather than generated, for the reason `planner.py` templates its
 * refusals: this is user-facing copy on a trust surface, brand voice is an
 * enforced rule (no em dashes, no hype, rule 22), and a generated sentence is one
 * prompt drift away from breaking it.
 *
 * Titles are the plan's own words, echoed back so the person recognises which
 * step they are being asked about rather than being handed an id.
 */
export function waitingMessage(summary: WaitingSummary, titles: Map<string, string>): string {
  const name = (r: TickResult) => titles.get(r.taskId) ?? 'an unnamed step';
  const parts: string[] = [];

  if (summary.needsUser.length > 0) {
    const lines = summary.needsUser.map((r) => `- ${name(r)}`).join('\n');
    parts.push(
      `I have started on the plan and ${summary.needsUser.length === 1 ? 'one step needs' : `${summary.needsUser.length} steps need`} you:\n\n${lines}\n\n` +
        'Each is a decision, an authorisation, or something only you know. ' +
        'Tell me what you want and I will carry on.',
    );
  }

  if (summary.escalated.length > 0) {
    const lines = summary.escalated.map((r) => `- ${name(r)}`).join('\n');
    // Deliberately not dressed up as progress. The marketplace is Phase 2 work
    // that does not exist, so a message implying someone has been contacted would
    // be false on the surface this product asks people to trust.
    parts.push(
      `${summary.escalated.length === 1 ? 'One step needs' : `${summary.escalated.length} steps need`} an expert rather than me:\n\n${lines}\n\n` +
        'I cannot bring one in yet, so these are paused rather than under way. ' +
        'Nothing has been spent or published.',
    );
  }

  return parts.join('\n\n');
}

/**
 * Post the digest into the project's room.
 *
 * Never throws. A tick that failed to announce its results is worse than one that
 * did not, and it is much worse if that failure also stops the tick: the tasks
 * moved correctly and the state machine is the record. So this logs loudly and
 * returns, rather than unwinding work that already committed.
 */
export async function notifyWaiting(
  admin: SupabaseClient,
  report: TickReport,
  log: {
    info: (o: unknown, m: string) => void;
    warn: (o: unknown, m: string) => void;
    error: (o: unknown, m: string) => void;
  },
): Promise<void> {
  const summary = summariseWaiting(report);
  if (!hasWaiting(summary)) return;

  try {
    const roomId = await roomForProject(admin, report.projectId);
    // Loud rather than quiet. This used to read "a project with no room has
    // nobody to tell", which was true and hid a real defect: `rooms.project_id`
    // is claimed by the FIRST project approved in a room, so every later project
    // in that room went unannounced with nothing said about it.
    if (!roomId) {
      log?.warn(
        { projectId: report.projectId },
        'project has no room, so waiting steps cannot be reported',
      );
      return;
    }

    const waitingIds = WAITING_OUTCOMES.flatMap((outcome) =>
      report.results.filter((r) => r.outcome === outcome).map((r) => r.taskId),
    );
    const { data: tasks, error: taskError } = await admin
      .from('tasks')
      .select('id, title')
      .in('id', waitingIds);
    if (taskError) throw taskError;

    const titles = new Map<string, string>(
      ((tasks ?? []) as { id: string; title: string }[]).map((t) => [t.id, t.title]),
    );

    // Keyed on the tasks themselves rather than on a run id, because the same set
    // can only reach this state once: the scheduler selects PENDING tasks, so a
    // task already waiting is never routed again. A replayed tick therefore
    // collides here instead of posting a second identical digest.
    const key = `waiting:${report.projectId}:${[...waitingIds].sort().join(',')}`;

    const { data: message, error: postError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        body: waitingMessage(summary, titles),
        idempotency_key: key,
      })
      .select('id')
      .maybeSingle();
    if (postError && postError.code !== '23505') throw postError;

    // The card is what makes the answer attachable. Without it the person reads
    // "this step needs you", replies, and the reply is understood as a brand new
    // goal, because nothing in the room records which steps the question was
    // about. Only for `needs_user`: an escalated task is waiting on an expert, and
    // a card inviting an answer nobody can act on would be a false offer.
    const answerable = summary.needsUser.map((r) => r.taskId);
    if (message && answerable.length > 0) {
      const payload = QuestionEmbedPayload.safeParse({
        awaiting: 'task_answers',
        goal: '',
        questions: [],
        slots: [],
        round: 0,
        answers: [],
        stalls: 0,
        taskIds: answerable,
      });
      if (!payload.success) {
        throw new Error(`refusing to store an invalid question payload: ${payload.error.message}`);
      }

      const { error: embedError } = await admin.from('action_embeds').insert({
        message_id: message.id,
        room_id: roomId,
        component: 'question',
        payload: payload.data,
        // Echoed for the UI. What actually stops a human node answering on the
        // owner's behalf is `decideIntakeTurn`, because an answer arrives as a
        // chat message and never touches the route where this is checked.
        required_role: 'owner',
        state: 'pending',
      });
      if (embedError && embedError.code !== '23505') throw embedError;
    }

    log.info(
      {
        projectId: report.projectId,
        needsUser: summary.needsUser.length,
        escalated: summary.escalated.length,
      },
      'told the room which steps are waiting on a person',
    );
  } catch (err) {
    log.error(
      { err, projectId: report.projectId },
      'could not announce waiting tasks; the tasks moved correctly and are recorded',
    );
  }
}
