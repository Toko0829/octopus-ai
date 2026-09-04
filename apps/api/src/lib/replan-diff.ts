import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';
import {
  ReplanEmbedPayload,
  type AgentPersona,
  type IntakeSlot,
  type ModelRole,
} from '@octopus/contracts';
import { requestReplan, type ReplanTaskInput } from './ai';
import { resolveGeneration } from './model-routing';

/**
 * Producing a plan-change card for a running project.
 *
 * Lifted out of the replan route when a second caller arrived: a question card
 * finished after its plan was approved has answers that belong to a project
 * already running, and the only honest way to get them there is the same diff
 * an owner asks for from the panel. One producer, two askers.
 *
 * **This produces a card and applies nothing.** Applying is `apply_plan_diff`,
 * reached through the ordinary embed-action route, so a diff crosses the same
 * authorisation boundary a plan does whoever asked for it. Nothing in the system
 * replans on its own: a model proposing something is not the same as somebody
 * agreeing to it.
 */

export interface ReplanDiffOptions {
  aiServiceUrl: string;
  aiTimeoutMs?: number;
  /** See `AgentRunnerOptions.modelKeySecret`. Null when the deployment has none. */
  modelKeySecret?: string | null;
  log: FastifyBaseLogger;
}

export interface ReplanDiffInput {
  projectId: string;
  roomId: string;
  goal: string;
  reason: string;
  runId: string;
  /**
   * What intake established. When absent it is read from the plan card the
   * project came from; a finished question card passes its own merged slots,
   * which are that context plus the answers.
   */
  context?: IntakeSlot[];
  /**
   * Which voice posts the card and any notice about it. Defaults to the
   * Strategist, who owns the plan.
   *
   * Set by a mention, so `@Ads move the budget to Meta` comes back as a change
   * proposed by Ads. **It changes the signature on a card and nothing else**:
   * the ops are still proposed by the one reasoning core, the diff still applies
   * only through `apply_plan_diff` behind the owner's approval, and a persona
   * has no authority a plain replan does not (ADR-0031).
   */
  persona?: AgentPersona;
}

export async function produceDiff(
  admin: SupabaseClient,
  opts: ReplanDiffOptions,
  input: ReplanDiffInput,
): Promise<void> {
  const { projectId, roomId, goal, reason, runId } = input;
  const log = opts.log;
  // Whoever was asked answers. An owner opening the panel and asking for a
  // change is asking the planner, so the Strategist is the default; a mention
  // names a specialist, and a card that arrived under a different name than the
  // one addressed would read as the request having been reassigned.
  const persona: AgentPersona = input.persona ?? 'strategist';
  // **The voice and the route are the same choice.** `@Ads move the budget to
  // Meta` comes back signed by Ads, and it is answered on the model this
  // workspace routed to Ads, because a card that read as one specialist while
  // being written by another specialist's model would make the signature
  // decorative. The four personas are the first four `ModelRole` values by
  // construction, so the persona is the role.
  const role: ModelRole = persona;

  try {
    // The DAG travels to the core rather than being read by it: the task graph
    // is Node's (ADR-0006), and the core reaches Postgres for retrieval only.
    const { data: taskRows, error: tasksErr } = await admin
      .from('tasks')
      .select('id, title, detail, stage, state, owner_type')
      .eq('project_id', projectId)
      .order('position');
    if (tasksErr) throw tasksErr;

    const tasks = (taskRows ?? []) as Array<{
      id: string;
      title: string;
      detail: string | null;
      stage: string | null;
      state: string;
      owner_type: 'ai' | 'human' | 'user';
    }>;
    if (tasks.length === 0) {
      await postNotice(
        admin,
        roomId,
        runId,
        'That project has no steps to change.',
        persona,
        null,
        log,
      );
      return;
    }

    // Existing edges, so the core can tell whether an edge it is about to
    // propose closes a cycle rather than leaving the acyclicity trigger to
    // discover it under the owner's approval click.
    const { data: depRows, error: depsErr } = await admin
      .from('task_deps')
      .select('task_id, depends_on_task_id')
      .in(
        'task_id',
        tasks.map((t) => t.id),
      );
    if (depsErr) throw depsErr;

    const depsByTask = new Map<string, string[]>();
    for (const dep of (depRows ?? []) as Array<{ task_id: string; depends_on_task_id: string }>) {
      const list = depsByTask.get(dep.task_id) ?? [];
      list.push(dep.depends_on_task_id);
      depsByTask.set(dep.task_id, list);
    }

    const OWNER_TO_WIRE = { ai: 'AI', human: 'HUMAN', user: 'YOU' } as const;
    const wireTasks: ReplanTaskInput[] = tasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      detail: task.detail ?? '',
      stage: task.stage,
      state: task.state,
      owner: OWNER_TO_WIRE[task.owner_type],
      dependsOn: depsByTask.get(task.id) ?? [],
    }));

    // What intake established, carried from the plan card the project came
    // from unless the caller already holds a fresher copy. Same block the
    // planner and the executor receive, and governed by the same rule: it may
    // make a step concrete and it may never be cited.
    const context = input.context ?? (await readPlanContext(admin, projectId, log));
    const titles = new Map(tasks.map((t) => [t.id, t.title]));

    const generation = await resolveGeneration(
      admin,
      roomId,
      role,
      opts.modelKeySecret ?? null,
      log,
    );
    if (generation) {
      log.info(
        { projectId, runId, role, provider: generation.provider, model: generation.model },
        'generation resolved',
      );
    }

    const response = await requestReplan(
      opts.aiServiceUrl,
      { projectId, roomId, goal, reason, tasks: wireTasks, context, agentRunId: runId, generation },
      opts.aiTimeoutMs,
    );
    const model = response.model ?? null;

    for (const proposal of response.proposals) {
      if (proposal.kind === 'post_message') {
        // The core's own words, so this one is attributed. The two notices below
        // are ours and are not.
        await postNotice(admin, roomId, runId, proposal.body, persona, model, log);
        continue;
      }
      if (proposal.kind !== 'propose_replan') {
        // The core widening its own powers by returning a proposal kind this
        // path was not written for should be loud, not quietly ignored.
        log.error({ kind: proposal.kind, projectId }, 'unexpected proposal kind from /replan');
        continue;
      }

      const payload = ReplanEmbedPayload.safeParse({
        projectId: proposal.project_id,
        reason,
        summary: proposal.summary,
        ops: proposal.ops.map((op) =>
          op.op === 'add_step'
            ? {
                op: op.op,
                stage: op.stage,
                id: op.id,
                title: op.title,
                detail: op.detail,
                owner: op.owner,
                citations: op.citations,
                // Renamed rather than spread. Both defaulted fields would
                // survive a spread as their defaults, and a diff whose edges
                // all silently vanished still applies cleanly, which is the
                // failure nobody would notice.
                riskTier: op.risk_tier,
                acceptanceCriteria: op.acceptance_criteria,
                dependsOn: op.depends_on,
              }
            : op.op === 'cancel_task'
              ? {
                  op: op.op,
                  taskId: op.task_id,
                  // The step's title, so the card reads on its own rather than
                  // asking somebody to approve a UUID. Taken from the DAG this
                  // function already read, not from the model: it is a fact
                  // about a row, and asking for it would invite a second version
                  // of it that can disagree.
                  taskTitle: titles.get(op.task_id),
                  reason: op.reason,
                }
              : {
                  op: op.op,
                  taskId: op.task_id,
                  taskTitle: titles.get(op.task_id),
                  detail: op.detail,
                  acceptanceCriteria: op.acceptance_criteria,
                  addDependsOn: op.add_depends_on,
                },
        ),
        citations: response.citations.map((c) => ({
          sourceId: c.source_id,
          label: c.label,
          url: c.url ?? null,
          effectiveDate: c.effective_date ?? null,
        })),
      });

      if (!payload.success) {
        log.error({ err: payload.error, projectId }, 'replan payload failed its own contract');
        await postNotice(
          admin,
          roomId,
          runId,
          'I put together a change and could not store it. The plan is unchanged.',
          persona,
          null,
          log,
        );
        continue;
      }

      const { data: message, error: messageErr } = await admin
        .from('messages')
        .insert({
          room_id: roomId,
          author_id: null,
          author_kind: 'agent',
          persona,
          // The summary is the core's sentence about its own diff, so the row
          // records which model wrote it.
          model,
          body: proposal.summary,
          idempotency_key: `replan:${runId}`,
        })
        .select('id')
        .single<{ id: string }>();
      if (messageErr) {
        // A replayed continuation collides here, which means the card was
        // already posted. Nothing more to do, and certainly not a second embed.
        if (messageErr.code === '23505') return;
        throw messageErr;
      }

      const { error: embedErr } = await admin.from('action_embeds').insert({
        message_id: message.id,
        room_id: roomId,
        component: 'replan',
        payload: payload.data,
        // Owner only, re-checked server-side by the action route. The UI reads
        // this too, but the check that matters is not the UI's.
        required_role: 'owner',
        state: 'pending',
      });
      if (embedErr && embedErr.code !== '23505') throw embedErr;

      log.info({ projectId, runId, ops: proposal.ops.length }, 'replan card posted');
    }
  } catch (err) {
    log.error({ err, projectId, runId }, 'replan failed; the plan is unchanged');
    await postNotice(
      admin,
      roomId,
      runId,
      'I could not work out a change to the plan just now. Nothing has been altered, ' +
        'so the project is still running as it was.',
      persona,
      null,
      log,
    );
  }
}

/** The plan card's intake slots, or nothing. Never fatal: absent context degrades
 * to a diff written without knowing the audience, which is what every diff would
 * have had otherwise. */
export async function readPlanContext(
  admin: SupabaseClient,
  projectId: string,
  log: FastifyBaseLogger,
): Promise<IntakeSlot[]> {
  try {
    const { data: project } = await admin
      .from('projects')
      .select('source_embed_id')
      .eq('id', projectId)
      .maybeSingle<{ source_embed_id: string | null }>();
    if (!project?.source_embed_id) return [];
    const { data: embed } = await admin
      .from('action_embeds')
      .select('payload')
      .eq('id', project.source_embed_id)
      .maybeSingle<{ payload: { context?: IntakeSlot[] } }>();
    return embed?.payload?.context ?? [];
  } catch (err) {
    log.warn({ err, projectId }, 'could not read plan context for replan');
    return [];
  }
}

/** Say something in the room. A replan that produced nothing must still say so:
 * silence is indistinguishable from the request never having arrived.
 *
 * `model` is required rather than defaulted, because this one function posts both
 * the core's own `post_message` and our two failure sentences, and the caller is
 * the only place that knows which it is holding. Passing null is a decision; a
 * default would let forgetting look like one. */
async function postNotice(
  admin: SupabaseClient,
  roomId: string,
  runId: string,
  body: string,
  persona: AgentPersona,
  model: string | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const { error } = await admin.from('messages').insert({
    room_id: roomId,
    author_id: null,
    author_kind: 'agent',
    persona,
    model,
    body,
    idempotency_key: `replan-notice:${runId}`,
  });
  if (error && error.code !== '23505') {
    log.error({ err: error, roomId }, 'could not post replan notice');
  }
}
