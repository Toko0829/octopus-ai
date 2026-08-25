import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nextStateAfterReview, review } from '@octopus/core';
import { ArtifactEmbedPayload } from '@octopus/contracts';
import { AiServiceError, requestExecution } from './ai';
import { planContextForProject, roomForProject } from './room-for-project';

/**
 * Running one AI-owned task: the maker-checker loop.
 *
 * The scheduler has already moved the task to `ai_running` and handed it here.
 * Everything after that is this function's, including the retries and the final
 * state, because the scheduler only picks up `pending` tasks and would never see
 * this one again.
 *
 *     ai_running -> [draft] -> ai_self_check -> [review] -> approved
 *                                                        -> ai_running (bounded re-do)
 *                                                        -> escalated
 *
 * Three things worth knowing before changing it.
 *
 * **Every attempt is its own `task_runs` row.** A retry that overwrote the
 * previous attempt would erase why the first one failed, which is the thing you
 * need when a task escalates after two tries.
 *
 * **A refusal is not a failure.** The core declining to execute an ungrounded
 * step is it working correctly, so that path escalates to a human rather than
 * retrying: asking the same core again with the same corpus produces the same
 * refusal, more slowly.
 *
 * **The checker decides, not this loop.** `nextStateAfterReview` owns whether a
 * failure is worth another attempt, and it refuses to retry a fabricated citation
 * on the grounds that asking again is how you get a second one.
 *
 * NOT DURABLE. This runs in-process, like agent runs, so a crash mid-task leaves
 * it in `ai_running` with a `running` task_run. ADR-0001 puts it on a durable
 * backbone; until then a stuck `ai_running` task is the expected symptom.
 */

const MAX_ATTEMPTS = 2;

export interface ExecutorDeps {
  admin: SupabaseClient;
  aiServiceUrl: string;
  aiTimeoutMs?: number;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  detail: string | null;
  stage: string | null;
  citations: number[] | null;
}

export async function executeTask(taskId: string, deps: ExecutorDeps): Promise<void> {
  const { admin, log } = deps;

  const { data: task, error: readError } = await admin
    .from('tasks')
    .select('id, project_id, title, detail, stage, citations')
    .eq('id', taskId)
    .maybeSingle<TaskRow>();

  if (readError || !task) {
    throw readError ?? new Error(`task ${taskId} not found`);
  }

  // Whether the plan step this task came from was grounded. The checker holds
  // output to the standard the plan set, and no higher: a step that never cited
  // anything cannot be failed for not citing anything.
  const expectsCitations = (task.citations ?? []).length > 0;

  // Read once for the task rather than per attempt: it cannot change between
  // retries, and a retry is already the slow path. Failing to read it must not
  // stop the work, because an executor with no context writes exactly what it
  // wrote before this existed.
  let context: Awaited<ReturnType<typeof planContextForProject>> = [];
  try {
    context = await planContextForProject(admin, task.project_id);
  } catch (err) {
    log.warn({ taskId, err: String(err) }, 'could not read plan context, executing without it');
  }

  // Resolved once and used twice: as the retrieval scope, so the step is written
  // from this workspace's own business documents, and as the room the finished
  // artifact is posted into. Both previously looked it up separately.
  let roomId: string | null = null;
  try {
    roomId = await roomForProject(admin, task.project_id);
  } catch (err) {
    log.warn({ taskId, err: String(err) }, 'could not resolve the room for this task');
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const agentRunId = randomUUID();

    const { data: run } = await admin
      .from('task_runs')
      .insert({ task_id: taskId, agent_run_id: agentRunId, status: 'running', attempt })
      .select('id')
      .maybeSingle();

    let result;
    try {
      result = await requestExecution(
        deps.aiServiceUrl,
        {
          taskId,
          title: task.title,
          detail: task.detail ?? '',
          stage: task.stage,
          agentRunId,
          projectId: task.project_id,
          roomId,
          context,
        },
        deps.aiTimeoutMs,
      );
    } catch (err) {
      const message = err instanceof AiServiceError ? err.message : String(err);
      await finishRun(admin, run?.id, 'failed', message);
      log.error({ taskId, attempt, err: message }, 'task execution call failed');
      // A transport failure is worth another attempt; an exhausted one is not.
      if (attempt < MAX_ATTEMPTS) continue;
      await transition(admin, taskId, 'escalated', `Execution failed: ${message}`);
      return;
    }

    const draft = result.proposals.find((p) => p.kind === 'write_artifact');

    if (!draft) {
      // The core refused. That is it working: it declined to write something the
      // sources do not support. Retrying asks the same question of the same
      // corpus, so this goes to a person instead.
      await finishRun(admin, run?.id, 'succeeded', null);
      await transition(
        admin,
        taskId,
        'escalated',
        `The core declined to execute this step. ${result.reasoning_summary}`,
      );
      log.info({ taskId, attempt, core: result.core }, 'core refused to execute');
      return;
    }

    const { data: artifact, error: artifactError } = await admin
      .from('artifacts')
      .insert({
        task_id: taskId,
        project_id: task.project_id,
        kind: 'draft',
        title: draft.title,
        body: draft.body,
        citations: draft.citations,
        task_run_id: run?.id ?? null,
        created_by: 'agent',
      })
      .select('id')
      .maybeSingle();

    if (artifactError) {
      await finishRun(admin, run?.id, 'failed', artifactError.message);
      log.error({ taskId, attempt, err: artifactError }, 'artifact write failed');
      if (attempt < MAX_ATTEMPTS) continue;
      await transition(admin, taskId, 'escalated', 'Could not store the output.');
      return;
    }

    await transition(admin, taskId, 'ai_self_check', 'Draft written, reviewing.');

    const verdict = review(
      { body: draft.body, citations: draft.citations },
      { availableSources: result.citations.map((c) => c.label), expectsCitations },
    );
    const next = nextStateAfterReview(verdict, attempt, MAX_ATTEMPTS);

    await admin.from('events').insert({
      project_id: task.project_id,
      actor_kind: 'agent',
      verb: 'task.reviewed',
      subject_type: 'task',
      subject_id: taskId,
      payload: {
        attempt,
        passed: verdict.passed,
        failures: verdict.failures,
        reasons: verdict.reasons,
        artifact_id: artifact?.id ?? null,
        next,
      },
    });

    await finishRun(admin, run?.id, 'succeeded', null);

    if (next === 'approved') {
      await transition(admin, taskId, 'approved', 'Output passed review.');
      // The work is only delivered once somebody can read it. Until this existed
      // an approved step wrote a full artifact into a table nobody but a
      // developer with SQL could reach, so the product planned visibly and
      // delivered invisibly, which looks from outside exactly like stopping.
      await postArtifact(admin, {
        projectId: task.project_id,
        roomId,
        taskId,
        artifactId: artifact?.id ?? null,
        step: task.title,
        stage: task.stage ?? null,
        title: draft.title,
        body: draft.body,
        citations: draft.citations,
        log,
      });
      log.info({ taskId, attempt, artifactId: artifact?.id }, 'task approved');
      return;
    }

    if (next === 'escalated') {
      await transition(admin, taskId, 'escalated', verdict.reasons.join(' '));
      log.warn({ taskId, attempt, failures: verdict.failures }, 'task escalated after review');
      return;
    }

    // A bounded re-do. Back to ai_running for another attempt, which the loop
    // provides: the scheduler will never revisit this task, because it only ever
    // selects `pending` ones.
    await transition(admin, taskId, 'ai_running', `Re-running: ${verdict.reasons.join(' ')}`);
    log.info({ taskId, attempt, failures: verdict.failures }, 'retrying task');
  }
}

async function transition(
  admin: SupabaseClient,
  taskId: string,
  to: string,
  reason: string,
): Promise<void> {
  const { data, error } = await admin
    .from('tasks')
    .update({ state: to })
    .eq('id', taskId)
    .select('id, project_id')
    .maybeSingle();

  // Not caught. The state machine in Postgres is the authority, and a loop that
  // swallowed a refused transition would carry on as though the task had moved.
  if (error) throw error;
  if (!data) throw new Error(`task ${taskId} did not transition to ${to}`);

  await admin.from('events').insert({
    project_id: data.project_id,
    actor_kind: 'agent',
    verb: 'task.executed',
    subject_type: 'task',
    subject_id: taskId,
    payload: { to, reason },
  });
}

async function finishRun(
  admin: SupabaseClient,
  runId: string | undefined,
  status: 'succeeded' | 'failed',
  error: string | null,
): Promise<void> {
  if (!runId) return;
  await admin
    .from('task_runs')
    .update({ status, error, ended_at: new Date().toISOString() })
    .eq('id', runId);
}

/**
 * Post a finished deliverable into the project's room, as a message plus a card.
 *
 * Same two-row shape the plan uses and for the same reason: the message body is
 * the readable fallback anywhere the card does not render, so the work survives in
 * a notification and in the audit trail, and the card is an enhancement rather
 * than the only way to read it.
 *
 * Never throws. The task is approved and the artifact is stored; failing to
 * announce it must not undo either, and the row remains the record. Logged loudly
 * rather than swallowed (rule 16).
 */
async function postArtifact(
  admin: SupabaseClient,
  input: {
    projectId: string;
    roomId: string | null;
    taskId: string;
    artifactId: string | null;
    step: string;
    stage: string | null;
    title: string;
    body: string;
    citations: string[];
    log: ExecutorDeps['log'];
  },
): Promise<void> {
  try {
    // Already resolved by the caller. Loud when it is missing, because the
    // failure this replaced was silent: a finished, cited artifact written to
    // the database and never mentioned, which reads as the system having stopped.
    const roomId = input.roomId;
    if (!roomId) {
      input.log?.warn(
        { projectId: input.projectId, artifactId: input.artifactId },
        'artifact has no room to post into, so delivered work is invisible',
      );
      return;
    }

    // A deliverable with no citation is not the same as one with sources, and the
    // reader has to be told which they are holding. Rule 10 applied to work:
    // uncited output must never be presented as if it were grounded.
    const sources = input.citations.length
      ? `\n\nSources: ${input.citations.join('; ')}`
      : '\n\nNo sources are cited for this, so treat it as unverified.';

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        body: `${input.step}\n\n${input.title}\n\n${input.body}${sources}`,
        // One delivery per artifact. A retried run that reached approval twice
        // would collide here rather than posting the work a second time.
        idempotency_key: `artifact:${input.artifactId ?? input.taskId}`,
      })
      .select('id')
      .maybeSingle();

    if (messageError) {
      if (messageError.code === '23505') return;
      throw messageError;
    }
    if (!message || !input.artifactId) return;

    const payload = ArtifactEmbedPayload.safeParse({
      taskId: input.taskId,
      artifactId: input.artifactId,
      step: input.step,
      stage: input.stage ?? undefined,
      title: input.title,
      body: input.body,
      citations: input.citations,
    });
    if (!payload.success) {
      // Validated before it is stored, not on the way out. An invalid payload
      // written here would move the failure to every future read and into the
      // browser, where it is much harder to attribute.
      throw new Error(`refusing to store an invalid artifact payload: ${payload.error.message}`);
    }

    const { error: embedError } = await admin.from('action_embeds').insert({
      message_id: message.id,
      room_id: roomId,
      component: 'artifact',
      payload: payload.data,
      // Reports rather than asks. Reviewing a deliverable is a real decision and
      // it belongs with the marketplace's maker-checker, not bolted on here.
      // `reported` rather than `pending` or `approved`: the first would claim
      // somebody owes an action, the second would record a verdict nobody gave,
      // and `feedback_events` reads this column as a training label.
      required_role: 'owner',
      state: 'reported',
    });
    if (embedError && embedError.code !== '23505') throw embedError;
  } catch (err) {
    input.log.error(
      { err, taskId: input.taskId },
      'could not post the deliverable; the task is approved and the artifact is stored',
    );
  }
}
