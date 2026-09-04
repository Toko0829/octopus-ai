import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nextStateAfterReview, review } from '@octopus/core';
import { ArtifactEmbedPayload, modelEntryFor, personaForStage } from '@octopus/contracts';
import { AiServiceError, requestExecution, type GenerateImageProposal } from './ai';
import { writeFileArtifact } from './artifact-files';
import {
  extensionFor,
  generateImages,
  imageFailureSentence,
  ImageGenError,
  type GeneratedImage,
} from './image-gen';
import { resolveGeneration, type GenerationTarget } from './model-routing';
import { planContextForProject, roomForProject } from './room-for-project';

/**
 * Running one AI-owned task: the maker-checker loop.
 *
 * The scheduler has already moved the task to `ai_running` and handed it here.
 * Everything after that is this function's, including the retries and the final
 * state, because the scheduler only picks up `pending` tasks and would never see
 * this one again.
 *
 *     ai_running -> [draft] -> ai_self_check -> [review] -> approved -> done
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
 * **`done` is reached here and only here on the AI arm.** `settle_payout`
 * produces it for a human step once the money has moved; an AI step owes nobody
 * anything, so the same terminal state is two conditional writes apart. Without
 * the second one an already-approved step stayed cancellable forever, which is
 * the gap slice 7 recorded and declined to close from a marketplace slice.
 *
 * NOT DURABLE. This runs in-process, like agent runs, so a crash mid-task leaves
 * it in `ai_running` with a `running` task_run. ADR-0001 puts it on a durable
 * backbone; until then a stuck `ai_running` task is the expected symptom, and so
 * is a step stranded at `approved` by a crash between the two writes above. That
 * second symptom has a sweep now: `heal.ts` walks a step the executor left at
 * `approved` on to `done` and delivers its artifact, using the two helpers this
 * file exports for exactly that reason, so the crash recovery and the happy path
 * write the same rows in the same order.
 */

const MAX_ATTEMPTS = 2;

export interface ExecutorDeps {
  admin: SupabaseClient;
  aiServiceUrl: string;
  aiTimeoutMs?: number;
  /** See `AgentRunnerOptions.modelKeySecret`. Null when the deployment has none. */
  modelKeySecret?: string | null;
  /**
   * Whether this deployment draws images for creative steps (`IMAGE_GEN_ENABLED`).
   *
   * **Defaulted to false here and to true in the environment**, which looks
   * backwards and is not. The flag's polarity is a deployment decision and lives
   * in `packages/config`; this default is what a caller that never heard of images
   * gets, and the safe answer for a caller that did not think about it is the
   * behaviour that predates the feature. Every real caller passes the env value.
   */
  imageGenEnabled?: boolean;
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

  // **The step's own stage picks the model, exactly as it picks the voice.** A
  // landing page is written by Content and on the model routed to Content; a
  // channel setup by Ads and on the Ads model. Resolved once for the task rather
  // than per attempt, for `context`'s reason: the routes cannot change between
  // two attempts of the same loop in any way worth honouring, and a retry is
  // already the slow path.
  //
  // Not caught. `ModelRoutingError` is a deployment fault or a key that will not
  // open, and both are true of the next attempt too, so the throw leaves the task
  // where the scheduler put it rather than burning two attempts and escalating a
  // step to a person who cannot fix an environment variable.
  //
  // Null when the room could not be resolved: with no room there are no routes to
  // read, which is the house default, and that is the same degradation the
  // retrieval scope already takes on that path.
  const generation: GenerationTarget | null = roomId
    ? await resolveGeneration(
        admin,
        roomId,
        personaForStage(task.stage),
        deps.modelKeySecret ?? null,
        log,
      )
    : null;
  if (generation) {
    log.info(
      {
        taskId,
        role: personaForStage(task.stage),
        provider: generation.provider,
        model: generation.model,
      },
      'generation resolved',
    );
  }

  // **What this workspace can draw with, resolved separately from what it writes
  // with.** Creative is its own role: a workspace can write on Claude and draw on
  // Gemini, and the step that produces a brief is a Content or Ads step whose
  // voice has nothing to do with which model makes the picture (ADR-0033).
  //
  // Three conditions, and each of them refuses for a different reason.
  // `imageGenEnabled` is the deployment's kill switch. A missing route is a
  // workspace that has connected nothing. `images` on the registry entry is a
  // route pointed at a model that cannot draw, which the picker does not offer
  // and a stale row can still hold.
  //
  // **The capability is withheld from the core when any of them says no**, rather
  // than sent and then ignored on the way back. The brief's own opening sentence
  // is written from this flag: told it can be drawn, the core writes "images will
  // be generated from this brief", and a deployment that then drew nothing would
  // have put a false statement into the deliverable itself.
  const creativeTarget: GenerationTarget | null =
    roomId && deps.imageGenEnabled
      ? await resolveGeneration(admin, roomId, 'creative', deps.modelKeySecret ?? null, log)
      : null;
  const canDraw = creativeTarget !== null && (modelEntryFor(creativeTarget.model)?.images ?? false);

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
          generation,
          // Provider and model without the key: the core decides whether to ask
          // for an image and never makes one, so it has no use for a credential
          // (ADR-0033). Null when this workspace, or this deployment, cannot draw.
          creative:
            canDraw && creativeTarget
              ? {
                  provider: creativeTarget.provider,
                  model: creativeTarget.model,
                  images: true,
                }
              : null,
        },
        deps.aiTimeoutMs,
      );
    } catch (err) {
      const message = err instanceof AiServiceError ? err.message : String(err);
      // The target rather than the response, because there is no response. What
      // this records is where the attempt was sent, which is the fact a failed
      // run has; null on the house path, where nobody chose anything.
      await finishRun(admin, run?.id, 'failed', message, attribution(generation));
      log.error({ taskId, attempt, err: message }, 'task execution call failed');
      // A transport failure is worth another attempt; an exhausted one is not.
      if (attempt < MAX_ATTEMPTS) continue;
      await transition(
        admin,
        taskId,
        'escalated',
        `Execution failed: ${message}`,
        undefined,
        attribution(generation),
      );
      return;
    }

    const draft = result.proposals.find((p) => p.kind === 'write_artifact');

    if (!draft) {
      // The core refused. That is it working: it declined to write something the
      // sources do not support. Retrying asks the same question of the same
      // corpus, so this goes to a person instead.
      await finishRun(admin, run?.id, 'succeeded', null, attribution(result));
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
      await finishRun(admin, run?.id, 'failed', artifactError.message, attribution(result));
      log.error({ taskId, attempt, err: artifactError }, 'artifact write failed');
      if (attempt < MAX_ATTEMPTS) continue;
      await transition(
        admin,
        taskId,
        'escalated',
        'Could not store the output.',
        undefined,
        attribution(result),
      );
      return;
    }

    await transition(
      admin,
      taskId,
      'ai_self_check',
      'Draft written, reviewing.',
      undefined,
      attribution(result),
    );

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
        // Which voice this step is delivered under, recorded beside the review
        // rather than derived later: `tasks.stage` can be edited by a plan diff,
        // and an audit trail that re-derives the speaker from today's row would
        // rewrite who said what.
        persona: personaForStage(task.stage),
        // Which model wrote the draft this verdict is about, beside the voice and
        // for the same reason: the audit trail should not have to re-derive it
        // from a `task_runs` row somebody may later read differently.
        provider: result.provider ?? null,
        model: result.model ?? null,
      },
    });

    await finishRun(admin, run?.id, 'succeeded', null, attribution(result));

    if (next === 'approved') {
      await transition(
        admin,
        taskId,
        'approved',
        'Output passed review.',
        undefined,
        attribution(result),
      );

      // **And then finished, which nothing on this arm had ever done.**
      // `approved` is not terminal, and "anything non-terminal may be cancelled"
      // is a universal rule of this map, so until now a step that produced its
      // artifact and passed its own check could still be cancelled by a replan
      // and recorded in the audit trail as abandoned work. `settle_payout` gave
      // `done` a producer for human steps in slice 7 and said, in its own
      // header, that the AI arm was this module's to close.
      //
      // **Two hops rather than one, because the map says so.** `ai_self_check`
      // reaches `approved` and nothing else; `approved` is where the graph
      // decides dependents may move, and `task_deps_satisfied` counts both, so
      // no dependent waits a moment longer for the second write.
      //
      // **A miss here is a race, not a failure.** The only way the conditional
      // write finds no row is that something walked the task out of `approved`
      // in between, and `approved -> cancelled` is exactly that arc. Losing that
      // race means the step was cancelled, so the artifact must not then be
      // announced as delivered work.
      const finished = await transition(
        admin,
        taskId,
        'done',
        'AI step complete, no payout owed.',
        'approved',
        attribution(result),
      );
      if (!finished) {
        log.warn(
          { taskId, attempt },
          'task left approved without reaching done; it moved underneath us',
        );
        return;
      }

      // **The pictures, after the review and before the delivery.** After,
      // because the checker judges the brief and a brief that failed its own
      // check is not something to spend somebody's image quota on. Before,
      // because the card names how many images came with it, and a card written
      // first would have to be edited afterwards.
      //
      // Never throws: `drawProposedImages` returns what it managed and says why
      // it stopped, so the brief is delivered whatever the vendor did (rule 16).
      const drawn = await drawProposedImages({
        admin,
        proposals: result.proposals,
        target: canDraw ? creativeTarget : null,
        taskId,
        projectId: task.project_id,
        taskRunId: run?.id ?? null,
        log,
      });

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
        model: result.model ?? null,
        files: drawn.files,
        note: drawn.note,
        log,
      });
      log.info({ taskId, attempt, artifactId: artifact?.id }, 'task approved and done');
      return;
    }

    if (next === 'escalated') {
      await transition(
        admin,
        taskId,
        'escalated',
        verdict.reasons.join(' '),
        undefined,
        attribution(result),
      );
      log.warn({ taskId, attempt, failures: verdict.failures }, 'task escalated after review');
      return;
    }

    // A bounded re-do. Back to ai_running for another attempt, which the loop
    // provides: the scheduler will never revisit this task, because it only ever
    // selects `pending` ones.
    await transition(
      admin,
      taskId,
      'ai_running',
      `Re-running: ${verdict.reasons.join(' ')}`,
      undefined,
      attribution(result),
    );
    log.info({ taskId, attempt, failures: verdict.failures }, 'retrying task');
  }
}

/**
 * Move the task, and record why.
 *
 * `from` makes the write conditional on the state this loop believes the task is
 * in, which is the same `.eq('state', ...)` idiom `settle_payout` and the task
 * actions use. It is optional because most hops here are unconditional by
 * design: this loop owns the task from `ai_running` onward, so a refused
 * transition is a defect and throwing is correct.
 *
 * The one hop that passes `from` is `approved -> done`, and it is also the one
 * hop where a miss is **not** a defect. `approved -> cancelled` is a legal arc
 * that a replan may walk in exactly that window, so a zero-row result there
 * means somebody cancelled the step between the two writes rather than that the
 * machine refused us. `returns false` so the caller can tell the two apart.
 */
export async function transition(
  admin: SupabaseClient,
  taskId: string,
  to: string,
  reason: string,
  from?: string,
  /**
   * Which model produced the work this hop is about, when the caller knows.
   *
   * Defaulted rather than required, because most of this map is not about a
   * model's output at all: the scheduler's own transitions, and the heal sweep's
   * recovery hop, are TypeScript moving a row. Absent means "nobody recorded
   * which", which is the same thing null means everywhere else in this slice.
   */
  attributed: RunAttribution = { provider: null, model: null },
): Promise<boolean> {
  let q = admin.from('tasks').update({ state: to }).eq('id', taskId);
  if (from !== undefined) q = q.eq('state', from);
  // `stage` rides along only to name the voice on the event below. Forgetting it
  // would not fail anything: `personaForStage(undefined)` is total and would
  // label every executed transition as the Strategist, which is a plausible
  // answer and a wrong one.
  const { data, error } = await q.select('id, project_id, stage').maybeSingle();

  // Not caught. The state machine in Postgres is the authority, and a loop that
  // swallowed a refused transition would carry on as though the task had moved.
  if (error) throw error;
  if (!data) {
    if (from !== undefined) return false;
    throw new Error(`task ${taskId} did not transition to ${to}`);
  }

  await admin.from('events').insert({
    project_id: data.project_id,
    actor_kind: 'agent',
    verb: 'task.executed',
    subject_type: 'task',
    subject_id: taskId,
    payload: {
      to,
      reason,
      persona: personaForStage(data.stage),
      provider: attributed.provider,
      model: attributed.model,
    },
  });
  return true;
}

/** Provider and model, as columns, from whichever of the two things we hold. */
export interface RunAttribution {
  provider: string | null;
  model: string | null;
}

/**
 * Read the attribution off a response or off a target.
 *
 * One function for both because the columns are the same and the precedence is
 * not: **the response wins wherever there is one**, because it says which model
 * answered rather than which one we asked for, and a service that ignored the
 * target would otherwise be recorded as having honoured it. A target is what a
 * failed attempt has instead, and recording where it was sent beats recording
 * nothing.
 */
function attribution(
  from: { provider?: string | null; model?: string | null } | null | undefined,
): RunAttribution {
  return { provider: from?.provider ?? null, model: from?.model ?? null };
}

async function finishRun(
  admin: SupabaseClient,
  runId: string | undefined,
  status: 'succeeded' | 'failed',
  error: string | null,
  attributed: RunAttribution = { provider: null, model: null },
): Promise<void> {
  if (!runId) return;
  await admin
    .from('task_runs')
    .update({
      status,
      error,
      provider: attributed.provider,
      model: attributed.model,
      ended_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

/** What the image half of a step produced, and what to say if it produced nothing. */
interface DrawnImages {
  files: { artifactId: string; contentType: string }[];
  /**
   * One sentence explaining an absence somebody would otherwise have to guess at,
   * or null when there is nothing to explain.
   *
   * **Only written when the attempt was made and failed.** A workspace that has
   * connected no image model needs no sentence here, because the brief itself
   * opens by saying this system does not generate images: the deliverable is the
   * place that statement belongs, and a second message repeating it would be
   * noise on every creative step of every workspace that has connected nothing,
   * addressed largely to members who could not connect one anyway.
   */
  note: string | null;
}

/**
 * Draw whatever the core asked for, and never let it cost the deliverable.
 *
 * **Every failure path here ends in "the brief is delivered".** That is the whole
 * design of the creative step: the brief is the record of what was asked for and
 * why, it carries the citations, and it is what a person hands to a designer. The
 * images are an enhancement on top of it, so a vendor outage, a refused key, a
 * rate limit or a content policy costs somebody a picture rather than a step.
 *
 * **A retry must not draw twice.** The executor is not durable, so a crash after
 * the images and before the delivery leaves the task at `approved` for the heal
 * sweep, and a re-run of the same task would otherwise spend the customer's quota
 * a second time for images they already have. The existing `asset` rows are the
 * idempotency key, exactly as the delivery message's is the artifact id.
 */
async function drawProposedImages(input: {
  admin: SupabaseClient;
  proposals: { kind: string }[];
  target: GenerationTarget | null;
  taskId: string;
  projectId: string;
  taskRunId: string | null;
  log: ExecutorDeps['log'];
}): Promise<DrawnImages> {
  const { admin, log, taskId } = input;
  const empty: DrawnImages = { files: [], note: null };

  const asked = input.proposals.find(
    (p): p is GenerateImageProposal => p.kind === 'generate_image',
  );
  // No request means either an ordinary step or a workspace that cannot draw,
  // and neither of those is an event.
  if (!asked) return empty;
  if (!input.target) {
    // Reachable only if the core proposed an image without being told it could,
    // which is a contract break rather than a configuration. Loud, and harmless.
    log.warn({ taskId }, 'an image was proposed with no creative route to draw it on');
    return empty;
  }

  const { data: existing, error: existingError } = await admin
    .from('artifacts')
    .select('id, content_type')
    .eq('task_id', taskId)
    .eq('kind', 'asset');
  if (existingError) {
    // Refusing to draw is the safe direction: an unreadable table is a reason to
    // skip a billable call, never a reason to make it twice.
    log.warn(
      { taskId, err: existingError.message },
      'could not check for images this task already has, so none were generated',
    );
    return empty;
  }
  if ((existing ?? []).length > 0) {
    log.info(
      { taskId, count: existing?.length },
      'this task already has images, not drawing again',
    );
    return {
      files: (existing ?? []).map((row) => ({
        artifactId: (row as { id: string }).id,
        contentType: (row as { content_type: string | null }).content_type ?? 'image/png',
      })),
      note: null,
    };
  }

  let images: GeneratedImage[];
  try {
    images = await generateImages(input.target, {
      prompt: asked.prompt,
      count: asked.count,
      aspect: asked.aspect,
    });
  } catch (err) {
    const kind = err instanceof ImageGenError ? err.kind : 'provider';
    log.error(
      {
        taskId,
        provider: input.target.provider,
        model: input.target.model,
        kind,
        err: String(err),
      },
      'image generation failed; delivering the brief without images',
    );
    return { files: [], note: imageFailureSentence(kind) };
  }

  const files: DrawnImages['files'] = [];
  for (const [index, image] of images.entries()) {
    try {
      const written = await writeFileArtifact(admin, {
        taskId,
        projectId: input.projectId,
        kind: 'asset',
        // The step's own numbering rather than the brief's title. A title is a
        // model's sentence and this is a filename inside a per-artifact folder,
        // where the only thing it has to be is stable and distinguishable.
        title: `Image ${index + 1}`,
        bytes: image.bytes,
        contentType: image.contentType,
        // The extension follows the bytes rather than an assumption. It said
        // `.png` while the vendor only ever returns JPEG, which would have put a
        // name on the object that disagreed with its own content type.
        filename: `image-${index + 1}.${extensionFor(image.contentType)}`,
        taskRunId: input.taskRunId,
        createdBy: 'agent',
        // Empty, and that is the honest answer rather than an omission. The
        // brief's citations are what the sources support; a picture drawn from a
        // paragraph is not itself grounded in a document, and copying the
        // brief's labels onto it would present it as though it were.
        citations: [],
      });
      files.push({ artifactId: written.artifactId, contentType: image.contentType });
    } catch (err) {
      // Per image, so two that landed are not thrown away by a third that did
      // not. The row and the object are written together by `writeFileArtifact`,
      // which compensates its own upload, so a failure here leaves nothing
      // behind.
      log.error({ taskId, index, err: String(err) }, 'could not store a generated image');
    }
  }

  if (files.length === 0) {
    return {
      files: [],
      note: 'The generated images could not be stored, so the brief above is the deliverable.',
    };
  }
  log.info({ taskId, images: files.length }, 'generated images for a creative step');
  return { files, note: null };
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
export async function postArtifact(
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
    /**
     * Which model wrote the artifact, or null.
     *
     * Required rather than optional, because the heal sweep is the second caller
     * and it delivers work produced by a run it did not make: leaving this
     * defaultable is how a re-delivered artifact silently loses the attribution
     * the original delivery had, which is the exact difference nobody notices.
     */
    model: string | null;
    /**
     * The generated images that came with this deliverable, as ids and types.
     *
     * **Never a URL.** A signed link is a ten-minute bearer credential and this
     * goes into `action_embeds`, which is stored and re-broadcast on every room
     * update, so a link here would be a credential written to a table and handed
     * to the whole room for as long as the row lives. The panel mints one per
     * click instead.
     */
    files?: { artifactId: string; contentType: string }[];
    /**
     * One sentence about an absence, appended to the message body.
     *
     * On the message rather than only in a log, because the person is looking at
     * a creative brief that said images were coming (rule 16). On the message
     * rather than as a second message, because a delivery and the reason it is
     * thinner than expected are one event, and two rows would notify twice.
     */
    note?: string | null;
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
    // Deduplicated for the same reason the card is. Citations are per chunk, and
    // one document usually contributes several, so repeating its label reads as
    // several sources agreeing rather than one being quoted more than once. The
    // core already dedupes what it returns; this also covers artifacts stored
    // before it did, which the backfill will deliver.
    const cited = [...new Set(input.citations)];
    const sources = cited.length
      ? `\n\nSources: ${cited.join('; ')}`
      : '\n\nNo sources are cited for this, so treat it as unverified.';

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        // The step's own stage decides who delivers it, so a landing page
        // arrives from Content and a channel setup from Ads without anybody
        // choosing per call site. A step with no stage, or one the planner
        // invented, falls to the Strategist rather than throwing: an unsigned
        // delivery is a cosmetic error and a thrown one is work that never
        // reaches the room, which is the failure `roomForProject` was written
        // to fix.
        persona: personaForStage(input.stage),
        // The artifact's title and body are the model's words; the step line and
        // the sources footer are ours, and a deliverable is a model's message.
        model: input.model,
        body: `${input.step}\n\n${input.title}\n\n${input.body}${sources}${
          input.note ? `\n\n${input.note}` : ''
        }`,
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
      projectId: input.projectId,
      step: input.step,
      stage: input.stage ?? undefined,
      title: input.title,
      body: input.body,
      citations: input.citations,
      files: input.files ?? [],
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
