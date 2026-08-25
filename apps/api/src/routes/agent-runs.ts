import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import {
  AiServiceError,
  requestIntake,
  requestPlan,
  type IntakeResponse,
  type PlanResponse,
  type ProposePlanProposal,
} from '../lib/ai';
import { PlanEmbedPayload, QuestionEmbedPayload } from '@octopus/contracts';
import { decideIntakeTurn, type PendingIntake } from '@octopus/core';
import type { IntakeSlot } from '@octopus/contracts';

/**
 * Agent runs: the Node half of ADR-0006's "Python proposes, Node executes".
 *
 * The request thread only authorises the caller and starts the run, then returns
 * `202 + runId` (AGENTS.md rule 4). Progress reaches the client over Realtime,
 * because the agent participates by INSERTing message rows like any other member.
 *
 * NOT YET DURABLE. The step below runs in-process, so a crash or deploy mid-run
 * loses it. ADR-0001 puts this on Trigger.dev v3, which needs credentials this
 * project does not have yet. The seam is shaped for that move: `startRun` is one
 * function with a run id, no shared state, and no reliance on the request being
 * open. Until then, treat a lost run as possible and re-trigger.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });
const StartRunBody = z.object({ goal: z.string().trim().min(1).max(4000) });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface AgentRunRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  /** Budget for one planning turn. Defaults to the production value. */
  aiTimeoutMs?: number;
  /**
   * Rounds of intake questions allowed before the run plans with what it has.
   *
   * Mirrors the AI service's `INTAKE_MAX_ROUNDS` and is enforced here as well,
   * because a card written before the cap changed must not be able to hold
   * someone in an interrogation the service would no longer start.
   */
  intakeMaxRounds?: number;
  intakeTimeoutMs?: number;
}

const DEFAULT_INTAKE_MAX_ROUNDS = 2;

/**
 * Consecutive turns that may produce no usable goal before the agent stops asking.
 *
 * Bounded separately from the answer rounds because the two limit different
 * things. `intakeMaxRounds` limits how much we interrogate someone who has told
 * us what they want; this limits how long we keep asking someone who has not.
 *
 * Following the thread is the right behaviour, and following it forever is a
 * system that will not take no for an answer. Two attempts, then it says plainly
 * that it cannot help and stops opening cards.
 */
const MAX_INTAKE_STALLS = 2;

/**
 * What a failed run says in the room, and why it distinguishes the cases.
 *
 * `architecture.md` requires that "a timeout is reported as a timeout", because
 * telling someone the service did not respond when it did, slowly, sends the next
 * person to debug it in exactly the wrong direction. That was written as settled
 * and this function is what actually makes it true: every failure used to be
 * flattened into one sentence here, so the distinction existed in the logs and
 * was lost on the surface a person reads.
 *
 * A timeout is also the only one of these that is not a fault, so it is the only
 * one that says what to do about it. The rest are ours to fix, and saying so
 * plainly beats offering a remedy that would not work.
 */
export function failureNotice(err: unknown): string {
  const prefix = 'The agent could not complete this run.';

  if (!(err instanceof AiServiceError)) {
    return `${prefix} Something went wrong on my side.`;
  }

  switch (err.kind) {
    case 'timeout':
      return (
        `${prefix} The reasoning service was still working when I stopped waiting, ` +
        'so nothing was written. A whole funnel takes longer to think through than ' +
        'a single question does, and this environment may simply need a larger ' +
        'budget for it. Narrowing the goal to the part you most need also works.'
      );
    case 'unreachable':
      return `${prefix} I could not reach the reasoning service at all.`;
    case 'status':
      return `${prefix} The reasoning service answered with an error.`;
    case 'contract':
      return `${prefix} The reasoning service answered in a shape I do not accept.`;
  }
}

/** Bounded echo of the person's own words, for the redirect copy. */
function echo(text: string, limit = 120): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit).trimEnd()}...`;
}

/**
 * User-facing copy lives here, templated, rather than being generated.
 *
 * Refusals and questions are a trust surface, and `planner.py` already templates
 * its refusals for the same reason: brand voice is a rule (no em dashes, no hype,
 * AGENTS.md rule 22) and a generated sentence is one prompt drift away from
 * breaking it. The model classifies; the words are ours.
 */
const INTAKE_COPY = {
  opening:
    'Hello. I run the marketing side of a business: positioning and offer, content, ' +
    'creative, paid ads, SEO, email, organic social, and conversion.\n\n' +
    'What are you trying to grow, and what do you sell?',

  redirect: (what: string) =>
    `I cannot help with ${what} itself. That sits outside what I have sources for, ` +
    'so anything I drafted about it would not be grounded in anything.\n\n' +
    'What I do is the marketing side: getting people to find and buy what you offer. ' +
    'If there is a growth goal inside this, tell me what you want more of and I will ' +
    'take it from there.',

  giveUp:
    'I do not think I can help with this one, and I would rather say so than keep asking.\n\n' +
    'What I have sources for is full-funnel digital marketing for the US market. ' +
    'If you want help growing something, start a new message with what you sell and ' +
    'who you sell it to.\n\n' +
    'Nothing has been spent, published, or connected to your accounts.',
} as const;

/**
 * The plan proposal as the contract wants it, which is not the shape the core
 * sends.
 *
 * The core speaks snake_case and the contract speaks camelCase, so the fields are
 * **renamed rather than spread**. That distinction is load-bearing for exactly one
 * of them: `riskTier` carries a default, so a spread would drop the core's
 * `risk_tier`, the parse would succeed, and every step would land on `reversible`
 * with nothing raising. That is the same failure the tier exists to prevent,
 * arriving through the mapping instead of through the planner.
 *
 * Exported so the mapping is testable without a database, a room, or a running
 * core. It is pure.
 */
export function planEmbedPayload(
  plan: ProposePlanProposal,
  goal: string,
  citations: PlanResponse['citations'],
  context: IntakeSlot[] = [],
) {
  return {
    // Carried on the card because approving it creates a project, and a project
    // needs the goal in the person's words rather than the model's restatement
    // of it. It also completes the flywheel label: `feedback_events.subject`
    // stores this payload, and an output with no input is not a training pair.
    goal,
    // What intake established, carried so the EXECUTOR can reach it. Measured on
    // a real run: the planner used the person's audience in 4 of 15 steps and
    // only 1 of 8 artifacts mentioned it, because the slots reached planning and
    // died there. Omitted entirely when empty rather than stored as `[]`, so an
    // absent context and an empty one stay distinguishable in the audit trail.
    ...(context.length ? { context } : {}),
    title: plan.title,
    summary: plan.summary,
    stages: plan.stages.map((stage) => ({
      stage: stage.stage,
      steps: stage.steps.map((step) => ({
        title: step.title,
        detail: step.detail,
        owner: step.owner,
        citations: step.citations,
        riskTier: step.risk_tier,
        acceptanceCriteria: step.acceptance_criteria,
      })),
    })),
    citations: citations.map((citation) => ({
      sourceId: citation.source_id,
      label: citation.label,
      url: citation.url ?? null,
      effectiveDate: citation.effective_date ?? null,
    })),
  };
}

export async function agentRunRoutes(
  app: FastifyInstance,
  opts: AgentRunRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  /**
   * Post as the agent. This is the only path by which anything the reasoning core
   * says becomes visible, and it deliberately lives here rather than in Python.
   */
  async function postAsAgent(roomId: string, body: string, runId: string, index: number) {
    const admin = createServiceClient(opts.supabase);
    const { error } = await admin.from('messages').insert({
      room_id: roomId,
      author_id: null,
      author_kind: 'agent',
      body,
      // Deterministic per run and position, so a retried run cannot post twice.
      idempotency_key: `agent-run:${runId}:${index}`,
    });
    if (error && error.code !== '23505') throw error;
  }

  /**
   * Post a plan: one message, plus the embed carrying its structure.
   *
   * The message body is the plain-text fallback, so the plan is still legible
   * anywhere the card does not render (a notification, a client that does not
   * know this embed type, the audit trail). The card is an enhancement of a
   * readable message rather than the only way to read it.
   *
   * `required_role: 'owner'` is written here and re-checked when the action is
   * taken. The UI is told about it so it can disable what the caller cannot do,
   * but that is a courtesy, not the control.
   */
  async function postPlan(
    roomId: string,
    goal: string,
    plan: ProposePlanProposal,
    citations: PlanResponse['citations'],
    runId: string,
    index: number,
    context: IntakeSlot[] = [],
  ) {
    const admin = createServiceClient(opts.supabase);
    const idempotencyKey = `agent-run:${runId}:${index}`;

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        body: `${plan.title}\n\n${plan.summary}`,
        idempotency_key: idempotencyKey,
      })
      .select('id')
      .maybeSingle();

    if (messageError) {
      // A replayed run hits the idempotency constraint, which means the plan was
      // already posted. Nothing more to do, and certainly not a second embed.
      if (messageError.code === '23505') return;
      throw messageError;
    }
    if (!message) return;

    const payload = planEmbedPayload(plan, goal, citations, context);

    // Validated before it is stored, not on the way out. A payload that cannot
    // satisfy the contract is a bug here; writing it anyway would move the
    // failure to every future read and to the browser, where it is far harder to
    // attribute.
    const parsed = PlanEmbedPayload.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`refusing to store an invalid plan payload: ${parsed.error.message}`);
    }

    const { error: embedError } = await admin.from('action_embeds').insert({
      message_id: message.id,
      room_id: roomId,
      component: 'plan',
      payload: parsed.data,
      required_role: 'owner',
      state: 'pending',
    });
    if (embedError && embedError.code !== '23505') throw embedError;
  }

  async function postSystemNotice(roomId: string, body: string, runId: string) {
    try {
      const admin = createServiceClient(opts.supabase);
      await admin.from('messages').insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'system',
        body,
        idempotency_key: `agent-run:${runId}:failed`,
      });
    } catch (err) {
      app.log.error({ err, runId, roomId }, 'could not post agent failure notice');
    }
  }

  /**
   * The open question card for this room, if there is one.
   *
   * Read as `service_role` rather than as the caller: this runs inside the agent
   * step, which has no request and no token, and it reads a row the caller can
   * already see through room membership anyway.
   */
  async function loadPendingIntake(roomId: string): Promise<PendingIntake | null> {
    const admin = createServiceClient(opts.supabase);
    const { data, error } = await admin
      .from('action_embeds')
      .select('id, payload')
      .eq('room_id', roomId)
      .eq('component', 'question')
      .eq('state', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    // Parsed, not trusted, exactly like the plan payload. A row that cannot
    // satisfy the contract is treated as no intake at all rather than crashing
    // the run: the person still gets an answer, they just get asked afresh.
    const parsed = QuestionEmbedPayload.safeParse(data.payload);
    if (!parsed.success) {
      app.log.warn({ embedId: data.id, roomId }, 'ignoring an unreadable question card');
      return null;
    }
    return { embedId: data.id as string, payload: parsed.data };
  }

  async function loadRoomOwner(roomId: string): Promise<string | null> {
    const admin = createServiceClient(opts.supabase);
    const { data, error } = await admin
      .from('rooms')
      .select('owner_id')
      .eq('id', roomId)
      .maybeSingle();
    if (error) throw error;
    return (data?.owner_id as string | null) ?? null;
  }

  /**
   * Close the question card this answer belongs to, and report whether we won.
   *
   * Conditional on `state = 'pending'` in the same statement, so two runs racing
   * on the same card cannot both consume it. Reading the state and then writing
   * it would be a race; doing both at once is not. Same guard the embed action
   * route uses, and for the same reason.
   *
   * Called AFTER the intake call rather than before. Marking first would mean a
   * failed or timed-out intake silently swallows what the person just typed;
   * this way the card stays pending and the next message tries again.
   */
  async function consumePendingIntake(embedId: string): Promise<boolean> {
    const admin = createServiceClient(opts.supabase);
    const { data, error } = await admin
      .from('action_embeds')
      .update({ state: 'answered', acted_at: new Date().toISOString() })
      .eq('id', embedId)
      .eq('state', 'pending')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  /**
   * Ask the person a batch of questions, as one message plus one card.
   *
   * Same two-row shape the plan uses and for the same reason: the message body is
   * the readable fallback anywhere the card does not render, so the questions
   * survive in a notification and in the audit trail. The card additionally
   * carries the intake's state, because the AI service is stateless (ADR-0006)
   * and something on this side has to hold the slots between rounds.
   */
  async function postQuestions(
    roomId: string,
    payload: QuestionEmbedPayload,
    body: string,
    runId: string,
    index: number,
  ) {
    const admin = createServiceClient(opts.supabase);

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        body,
        idempotency_key: `agent-run:${runId}:${index}`,
      })
      .select('id')
      .maybeSingle();

    if (messageError) {
      if (messageError.code === '23505') return;
      throw messageError;
    }
    if (!message) return;

    const parsed = QuestionEmbedPayload.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`refusing to store an invalid question payload: ${parsed.error.message}`);
    }

    const { error: embedError } = await admin.from('action_embeds').insert({
      message_id: message.id,
      room_id: roomId,
      component: 'question',
      payload: parsed.data,
      // Echoed for the UI. It is NOT what stops a non-owner answering, because an
      // answer arrives as a chat message and never reaches the action route where
      // this is checked. `decideIntakeTurn` is the enforcement.
      required_role: 'owner',
      state: 'pending',
    });
    if (embedError && embedError.code !== '23505') throw embedError;
  }

  /**
   * Put a consumed question back, when acting on its answer failed entirely.
   *
   * Only from `answered`, so this can never resurrect a card somebody else has
   * since acted on.
   */
  /**
   * Close a question the person walked away from.
   *
   * `dismissed` rather than `expired`, which means nobody acted in time, or
   * `rejected`, which is a verdict on something they were shown. This was a
   * deliberate act and neither of those, and `feedback_events` reads these
   * states as training labels, so borrowing one would put an untrue sentence in
   * the record.
   */
  async function dismissPendingIntake(embedId: string): Promise<void> {
    const admin = createServiceClient(opts.supabase);
    const { error } = await admin
      .from('action_embeds')
      .update({ state: 'dismissed', acted_at: new Date().toISOString() })
      .eq('id', embedId)
      .eq('state', 'pending');
    if (error) app.log.error({ err: error, embedId }, 'could not dismiss the question');
  }

  async function reopenPendingIntake(embedId: string): Promise<void> {
    const admin = createServiceClient(opts.supabase);
    const { error } = await admin
      .from('action_embeds')
      .update({ state: 'pending', acted_at: null })
      .eq('id', embedId)
      .eq('state', 'answered');
    if (error) app.log.error({ err: error, embedId }, 'could not reopen the question');
  }

  /**
   * Record what the person answered, and complete the steps that were waiting.
   *
   * **Their answer is the deliverable.** The plan gave them work only they could
   * do, a budget, a positioning call, which analytics source counts, so a task
   * that has been answered is done rather than merely unblocked. It is stored as
   * an artifact `created_by: 'user'` and the task moves `needs_user -> approved`,
   * which is the state that satisfies dependents.
   *
   * That arc had to be added to the machine (`20260815220000`). Before it the only
   * way out of `needs_user` was back to `routing`, where the router would send a
   * user-owned task straight to `needs_user` again: the answer had nowhere to land
   * and the loop had no end.
   *
   * Best effort per task, like a tick: one that will not move must not strand the
   * others, and every failure is logged rather than swallowed.
   */
  async function recordTaskAnswers(
    turn: Extract<ReturnType<typeof decideIntakeTurn>, { kind: 'task_answer' }>,
    runId: string,
    roomId: string,
  ): Promise<void> {
    const admin = createServiceClient(opts.supabase);

    // Consumed first, so a second message racing this one finds nothing to answer
    // rather than completing the same tasks twice.
    const won = await consumePendingIntake(turn.embedId);
    if (!won) {
      app.log.info({ agentRunId: runId, embedId: turn.embedId }, 'another run took this answer');
      return;
    }

    const { data: tasks, error: readError } = await admin
      .from('tasks')
      .select('id, project_id, title')
      .in('id', turn.taskIds)
      .eq('state', 'needs_user');

    if (readError) {
      app.log.error({ err: readError, agentRunId: runId }, 'could not read the answered tasks');
      return;
    }

    let completed = 0;
    for (const task of (tasks ?? []) as { id: string; project_id: string; title: string }[]) {
      try {
        const { error: artifactError } = await admin.from('artifacts').insert({
          task_id: task.id,
          project_id: task.project_id,
          kind: 'answer',
          title: task.title,
          body: turn.answer,
          // Deliberately none. The person's own decision rests on no retrieved
          // source, and attaching one would attribute their judgement to the
          // corpus. The checker never sees this: a human answering is not a
          // maker to be checked.
          citations: [],
          created_by: 'user',
        });
        if (artifactError) throw artifactError;

        const { error: moveError } = await admin
          .from('tasks')
          .update({ state: 'approved' })
          .eq('id', task.id)
          .eq('state', 'needs_user');
        if (moveError) throw moveError;

        completed += 1;
      } catch (err) {
        app.log.error(
          { err, taskId: task.id, agentRunId: runId },
          'could not complete an answered task',
        );
      }
    }

    if (completed > 0) {
      await postAsAgent(
        roomId,
        completed === 1
          ? 'Recorded. That step is done, and I will carry on with what it unblocks.'
          : `Recorded against ${completed} steps. I will carry on with what they unblock.`,
        runId,
        0,
      );
    } else {
      // **Nothing completed, and the card is already closed.** Consuming first is
      // what makes a race safe, and it is exactly what makes a failure silent:
      // the person answered, the question disappeared, and no step moved. That
      // happened, on an invalid enum value, and the room said nothing at all.
      //
      // So the card is reopened, which makes their next message an answer again
      // rather than a stray goal, and they are told plainly. Losing someone's
      // reply is bad; losing it without saying so is worse.
      await reopenPendingIntake(turn.embedId);
      await postAsAgent(
        roomId,
        'I could not record that against the steps it answers, so nothing has ' +
          'moved and the question is still open. This is a fault on my side ' +
          'rather than anything about your answer. Please send it again.',
        runId,
        0,
      );
      app.log.error(
        { agentRunId: runId, embedId: turn.embedId, asked: turn.taskIds.length },
        'recorded no answers; reopened the question',
      );
    }

    app.log.info(
      { agentRunId: runId, completed, asked: turn.taskIds.length },
      'task answers recorded',
    );
  }

  /**
   * Run intake, and decide whether this turn plans or asks.
   *
   * Returns the goal to plan from, or null when the run is finished for now
   * because a question went out or the request is outside what we can ground.
   *
   * **Intake failing is not a reason to refuse.** Any error here falls through to
   * planning on the original message, which is the behaviour that existed before
   * intake did. It improves a query; it is not a precondition for answering, and
   * letting an optional step take down a working path is the trade the AI service
   * already refuses to make. Nothing is granted by passing through: the
   * groundedness gate still runs inside `/plan`.
   */
  async function runIntake(
    roomId: string,
    message: string,
    runId: string,
    authorId: string,
  ): Promise<{ goal: string; context: IntakeSlot[] } | null> {
    const maxRounds = opts.intakeMaxRounds ?? DEFAULT_INTAKE_MAX_ROUNDS;

    let turn: ReturnType<typeof decideIntakeTurn>;
    try {
      const [pending, roomOwnerId] = await Promise.all([
        loadPendingIntake(roomId),
        loadRoomOwner(roomId),
      ]);
      turn = decideIntakeTurn({ message, authorId, roomOwnerId, pending, maxRounds });
    } catch (err) {
      app.log.error({ err, agentRunId: runId, roomId }, 'intake state unreadable, planning anyway');
      return { goal: message, context: [] };
    }

    // The person overrode an open card to start something new. Closing it first
    // matters: left pending, the next message would be read as an answer to a
    // question nobody is going to answer, which is the loop this escape exists
    // to break. Conditional on `pending` for the same reason consuming one is:
    // two runs racing must not both act on it.
    if (turn.kind === 'new_goal' && turn.dismissedEmbedId) {
      await dismissPendingIntake(turn.dismissedEmbedId);
      app.log.info(
        { agentRunId: runId, roomId, embedId: turn.dismissedEmbedId },
        'question card dismissed for a new goal',
      );
    }

    // The plan asked this person to do something only they can do, and they have
    // answered. That completes the step rather than describing a goal, so it never
    // reaches the reasoning core: there is nothing to reason about, the answer IS
    // the deliverable.
    if (turn.kind === 'task_answer') {
      await recordTaskAnswers(turn, runId, roomId);
      return null;
    }

    let intake: IntakeResponse;
    try {
      intake = await requestIntake(
        opts.aiServiceUrl,
        {
          roomId,
          goal: turn.goal,
          answers: turn.kind === 'answer' ? turn.answers : [],
          slots: turn.kind === 'answer' ? turn.slots : [],
          round: turn.kind === 'answer' ? turn.round : 0,
          agentRunId: runId,
        },
        opts.intakeTimeoutMs,
      );
    } catch (err) {
      app.log.warn({ err, agentRunId: runId, roomId }, 'intake failed, planning on the goal');
      return { goal: turn.goal, context: [] };
    }

    app.log.info(
      {
        agentRunId: runId,
        roomId,
        core: intake.core,
        outcome: intake.outcome,
        completeness: intake.completeness,
        proximity: intake.proximity,
        questions: intake.questions.length,
        stalls: turn.kind === 'restated_goal' ? turn.stalls : 0,
      },
      'intake complete',
    );

    // Consume the card BEFORE anything is written, so a lost race stops here
    // rather than after a duplicate question or a duplicate plan.
    if (turn.kind === 'answer' || turn.kind === 'restated_goal') {
      const won = await consumePendingIntake(turn.embedId);
      if (!won) {
        app.log.info({ agentRunId: runId, embedId: turn.embedId }, 'another run took this reply');
        return null;
      }
    }

    // Neither a greeting nor an out-of-domain request produces a goal, so both
    // keep the conversation open rather than ending it. They are handled together
    // because the mechanism is identical and only the words differ: one has
    // nothing to decline, the other has something to decline BEFORE asking.
    if (intake.outcome === 'not_a_request' || intake.outcome === 'out_of_domain') {
      const stalls = (turn.kind === 'restated_goal' ? turn.stalls : 0) + 1;

      // Following someone's thread is right. Following it forever is a system
      // that will not take no for an answer, so it stops and says so plainly
      // rather than asking a third time in different words.
      if (stalls > MAX_INTAKE_STALLS) {
        await postAsAgent(roomId, INTAKE_COPY.giveUp, runId, 0);
        return null;
      }

      const body =
        intake.outcome === 'not_a_request'
          ? INTAKE_COPY.opening
          : // Named before asking. Asking first and declining later would be
            // keeping someone talking rather than redirecting them honestly.
            INTAKE_COPY.redirect(echo(turn.goal));

      await postQuestions(
        roomId,
        {
          // Waiting for a goal, not for answers: their next message replaces the
          // goal instead of being filed as an answer to a goal we do not have.
          awaiting: 'goal',
          goal: '',
          questions: [],
          slots: intake.slots,
          round: 0,
          answers: [],
          stalls,
          taskIds: [],
        },
        body,
        runId,
        0,
      );
      return null;
    }

    if (!intake.ready && intake.questions.length > 0) {
      const lines = intake.questions.map((q) => `- ${q.question}`).join('\n');
      await postQuestions(
        roomId,
        {
          awaiting: 'answers',
          goal: turn.goal,
          questions: intake.questions,
          slots: intake.slots,
          round: turn.kind === 'answer' ? turn.round : 0,
          answers: turn.kind === 'answer' ? turn.answers : [],
          stalls: 0,
          taskIds: [],
        },
        'Before I plan this, a few things I do not know yet.\n\n' +
          `${lines}\n\n` +
          'Answer what you can in one message. I will work with whatever you give me.\n\n' +
          'To start on something else instead, begin your message with "new goal:".',
        runId,
        0,
      );
      return null;
    }

    // Ready. The refined goal is what retrieval should see: it is the request
    // restated from what intake established, and it is kept short because it is
    // reranked like any other query (ADR-0009).
    return { goal: intake.refined_goal || turn.goal, context: intake.slots };
  }

  async function startRun(roomId: string, message: string, runId: string, authorId: string) {
    try {
      const next = await runIntake(roomId, message, runId, authorId);
      // Intake asked a question, declined the subject, or lost a race. Either way
      // this run is finished and the next message starts another.
      if (!next) return;

      const goal = next.goal;
      // The goal searches; the context tailors. Keeping the person's audience,
      // budget and product name out of the query is measured rather than tidy:
      // folding them in returned nothing at all for "Get signups for travelers."
      const plan = await requestPlan(
        opts.aiServiceUrl,
        { roomId, goal, context: next.context, agentRunId: runId },
        opts.aiTimeoutMs,
      );

      app.log.info(
        {
          agentRunId: runId,
          roomId,
          core: plan.core,
          grounded: plan.grounded,
          proposals: plan.proposals.length,
          reasoning: plan.reasoning_summary,
        },
        'agent run planned',
      );

      for (const [index, proposal] of plan.proposals.entries()) {
        // Every kind is handled explicitly. The core cannot widen its own powers
        // by inventing one: an unknown kind fails the schema parse above, before
        // reaching this switch.
        switch (proposal.kind) {
          case 'post_message':
            await postAsAgent(roomId, proposal.body, runId, index);
            break;
          case 'propose_plan':
            await postPlan(roomId, goal, proposal, plan.citations, runId, index, next.context);
            break;
        }
      }
    } catch (err) {
      // A failed run must be visible in the room. Silence would look identical
      // to the agent deciding not to reply (AGENTS.md rule 16).
      app.log.error(
        { err, agentRunId: runId, roomId, kind: err instanceof AiServiceError ? err.kind : null },
        'agent run failed',
      );
      await postSystemNotice(roomId, failureNotice(err), runId);
    }
  }

  app.post(
    '/api/rooms/:roomId/agent-runs',
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const parsed = StartRunBody.safeParse(request.body);
      if (!parsed.success) {
        return fail(reply, 400, 'bad_request', 'A goal of 1 to 4000 characters is required.');
      }

      const { roomId } = params.data;

      // Membership is checked as the caller, so a non-member cannot make the
      // agent speak in a room they cannot see.
      const db = createUserClient(opts.supabase, request.accessToken as string);
      const { data: room, error } = await db
        .from('rooms')
        .select('id')
        .eq('id', roomId)
        .maybeSingle();
      if (error) {
        request.log.error({ err: error, roomId }, 'agent-run membership check failed');
        return fail(reply, 500, 'internal_error', 'Could not start the run.');
      }
      if (!room) return fail(reply, 404, 'not_found', 'Room not found.');

      const runId = randomUUID();

      // Deliberately not awaited: the request thread returns 202 and the client
      // follows along over Realtime.
      //
      // The caller's id travels with it because the run has to know whether this
      // message answers an open intake question, and only the room's owner can
      // do that: intake answers describe the person's own budget, customers and
      // timeline, which nobody else in the room is entitled to state for them.
      void startRun(roomId, parsed.data.goal, runId, request.user!.sub);

      return reply.code(202).send({ runId, status: 'accepted' });
    },
  );
}
