import type { FastifyBaseLogger } from 'fastify';
import { createServiceClient, type SupabaseConfig } from './supabase';
import {
  AiServiceError,
  requestIntake,
  requestPlan,
  type IntakeResponse,
  type PlanResponse,
  type ProposePlanProposal,
} from './ai';
import {
  PlanEmbedPayload,
  QuestionEmbedPayload,
  type AgentPersona,
  type IntakeSlot,
  type IntakeQuestion,
} from '@octopus/contracts';
import { dismissableQuestion, profileSlots, replanReason } from '@octopus/core';
import { produceDiff } from './replan-diff';
import { profileFieldsFromSlots, readProfile, writeProfileFields } from './room-profile';

/**
 * Agent runs: the Node half of ADR-0006's "Python proposes, Node executes".
 *
 * Lifted out of the route so that a run can be started from two places: the
 * message route, when a person posts a goal, and the embed route, when a person
 * finishes a question card. Both are the same run with a different first step,
 * and having the second import the first is what keeps "how a plan is posted"
 * written once.
 *
 * **Planning starts beside the questions, not after them** (ADR-0029, decision
 * 2). A whole-funnel goal used to stop at the question card until every answer
 * was in. It plans immediately now, from the refined goal and whatever is known,
 * and the card sits beside the plan as the thing that would sharpen it. A
 * finished card supersedes a plan nobody has approved yet, or becomes a replan
 * card for one that is already running, and never applies anything on its own.
 *
 * **The workspace profile seeds the first round** (decision 3). Four of the
 * five slots are facts about the business rather than about a goal, so what the
 * owner has said before is handed to intake as stated slots and the second goal
 * in a room asks nothing.
 *
 * NOT YET DURABLE. Everything here runs in-process, so a crash or deploy mid-run
 * loses it. ADR-0001 puts this on Trigger.dev v3, which needs credentials this
 * project does not have yet. The seam is shaped for that move: each entry point
 * is one function with a run id, no shared state, and no reliance on a request
 * being open. Until then, treat a lost run as possible and re-trigger.
 */

export interface AgentRunnerOptions {
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  /** Budget for one planning turn. Defaults to the production value. */
  aiTimeoutMs?: number;
  /**
   * Rounds of intake questions allowed before the run stops asking.
   *
   * Mirrors the AI service's `INTAKE_MAX_ROUNDS` and is enforced here as well,
   * because a card written before the cap changed must not be able to hold
   * someone in an interrogation the service would no longer start.
   */
  intakeMaxRounds?: number;
  intakeTimeoutMs?: number;
  log: FastifyBaseLogger;
}

export const DEFAULT_INTAKE_MAX_ROUNDS = 2;

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

/** Bounded echo of the person's own words, for the redirect and started copy. */
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
export const INTAKE_COPY = {
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

  /**
   * The message a question card hangs off. The questions are repeated in plain
   * text because the card is an enhancement of a readable message, never the
   * only way to read it (a notification, a client that does not know the type).
   * It says the plan is already on its way, because it is.
   */
  questions: (questions: IntakeQuestion[]) =>
    'I have started on a plan and will post it here in a minute or two. ' +
    'These would make it sharper.\n\n' +
    `${questions.map((q) => `- ${q.question}`).join('\n')}\n\n` +
    'Answer on the card, in any order. When you are done I will update the plan ' +
    'with what you said.',

  started: (goal: string) => `Working on a plan for: ${goal}. This usually takes a minute or two.`,

  updating: 'Updating the plan with what you said. This usually takes a minute or two.',
} as const;

/**
 * The plan proposal as the contract wants it, which is not the shape the core
 * sends.
 *
 * The core speaks snake_case and the contract speaks camelCase, so the fields are
 * **renamed rather than spread**. That distinction is load-bearing for the two
 * that carry defaults. A spread would drop the core's `risk_tier`, the parse would
 * succeed, and every step would land on `reversible` with nothing raising: the
 * same failure the tier exists to prevent, arriving through the mapping instead of
 * through the planner. `depends_on` fails the identical way and more quietly
 * still, since a plan whose edges all vanished is a plan that merely looks flat,
 * and flat is what every plan used to be.
 *
 * Exported so the mapping is testable without a database, a room, or a running
 * core. It is pure.
 */
export function planEmbedPayload(
  plan: ProposePlanProposal,
  goal: string,
  citations: PlanResponse['citations'],
  context: IntakeSlot[] = [],
  provenance: { runId?: string; supersedes?: string } = {},
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
    // Which run produced this, so a question card from the same run can find
    // the plan it refines, and which card this one replaces, so the client can
    // mark the old one without a fetch. Omitted when absent for the same
    // reason as `context`.
    ...(provenance.runId ? { runId: provenance.runId } : {}),
    ...(provenance.supersedes ? { supersedes: provenance.supersedes } : {}),
    title: plan.title,
    summary: plan.summary,
    stages: plan.stages.map((stage) => ({
      stage: stage.stage,
      steps: stage.steps.map((step) => ({
        // Omitted rather than written as null when the core sends no id, so a
        // step that names itself and one that does not stay distinguishable in
        // the stored payload rather than both reading as "id: null".
        ...(step.id ? { id: step.id } : {}),
        dependsOn: step.depends_on,
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

/** The deterministic id of the run a finished card continues. */
export function continuationRunId(
  payload: Pick<QuestionEmbedPayload, 'runId' | 'round'>,
  embedId: string,
) {
  return `${payload.runId ?? embedId}:r${payload.round + 1}`;
}

export interface AgentRunner {
  /**
   * A person posted a message. Intake decides whether it plans, asks, or
   * declines; a plan is posted as a card in the room, and a question card
   * beside it when the goal was broad.
   */
  startRun(roomId: string, message: string, runId: string, authorId: string): Promise<void>;
  /**
   * A person finished a question card. If its plan is already a running
   * project, the answers become a replan card; otherwise intake runs again
   * with what the card collected and a new plan replaces the pending one.
   */
  continueFromCard(roomId: string, embedId: string, payload: QuestionEmbedPayload): Promise<void>;
}

export function createAgentRunner(opts: AgentRunnerOptions): AgentRunner {
  const log = opts.log;
  const maxRounds = opts.intakeMaxRounds ?? DEFAULT_INTAKE_MAX_ROUNDS;

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
      persona: 'strategist',
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
    supersedes?: string,
  ) {
    const admin = createServiceClient(opts.supabase);
    const idempotencyKey = `agent-run:${runId}:${index}`;

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        persona: 'strategist',
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

    const payload = planEmbedPayload(plan, goal, citations, context, { runId, supersedes });

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

  /**
   * A short line about the run itself, in one of two voices.
   *
   * **`'system'` and a persona are different claims and the caller must pick
   * one.** "Working on a plan for X" is the Strategist saying what it is doing,
   * and it reads as an evasion in the platform's flat voice when the next
   * message in the room is signed. "The agent could not complete this run" is
   * the platform reporting a fault in the machinery, and signing it would have
   * the Strategist calmly announce its own failure as though it had chosen to.
   *
   * The idempotency key is unchanged by the voice, so a run that posted a
   * notice before this change still collides with itself after it.
   */
  async function postNotice(
    roomId: string,
    body: string,
    runId: string,
    key: string,
    voice: 'system' | AgentPersona,
  ) {
    try {
      const admin = createServiceClient(opts.supabase);
      const { error } = await admin.from('messages').insert({
        room_id: roomId,
        author_id: null,
        author_kind: voice === 'system' ? 'system' : 'agent',
        persona: voice === 'system' ? null : voice,
        body,
        idempotency_key: `agent-run:${runId}:${key}`,
      });
      if (error && error.code !== '23505') throw error;
    } catch (err) {
      log.error({ err, runId, roomId, key, voice }, 'could not post agent notice');
    }
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
   * Close the intake cards a new goal makes moot.
   *
   * An intake card is about the goal that produced it. The owner typing a new
   * goal has moved on, so its questions are no longer sharpening anything, and
   * left pending it would sit in the room offering answers to a plan nobody is
   * making. A task-answers card is not closed: it belongs to a plan that already
   * exists and is still running.
   *
   * `dismissed` rather than `expired`, which means nobody acted in time, or
   * `rejected`, which is a verdict on something they were shown. This was a
   * deliberate act and neither of those, and `feedback_events` reads these
   * states as training labels, so borrowing one would put an untrue sentence in
   * the record.
   *
   * Which cards qualify is decided in code from the parsed payload rather than
   * by a filter string on the jsonb, because a hand-built PostgREST filter that
   * is slightly wrong matches nothing and says so to nobody.
   */
  async function dismissOpenIntake(roomId: string, runId: string): Promise<void> {
    const admin = createServiceClient(opts.supabase);
    const { data, error } = await admin
      .from('action_embeds')
      .select('id, payload')
      .eq('room_id', roomId)
      .eq('component', 'question')
      .eq('state', 'pending');
    if (error) throw error;

    const moot = ((data ?? []) as { id: string; payload: unknown }[]).filter((row) => {
      const parsed = QuestionEmbedPayload.safeParse(row.payload);
      // A card that cannot be read cannot be answered either, so it is closed
      // rather than left to hold the room.
      return !parsed.success || dismissableQuestion(parsed.data);
    });
    if (moot.length === 0) return;

    const { error: updateError } = await admin
      .from('action_embeds')
      .update({ state: 'dismissed', acted_at: new Date().toISOString() })
      .in(
        'id',
        moot.map((row) => row.id),
      )
      .eq('state', 'pending');
    if (updateError) throw updateError;

    log.info(
      { agentRunId: runId, roomId, dismissed: moot.length },
      'intake cards closed by a new goal',
    );
  }

  /**
   * Ask the person a batch of questions, as one message plus one card.
   *
   * Same two-row shape the plan uses and for the same reason: the message body is
   * the readable fallback anywhere the card does not render, so the questions
   * survive in a notification and in the audit trail. The card additionally
   * carries the intake's state, because the AI service is stateless (ADR-0006)
   * and something on this side has to hold the slots between rounds.
   *
   * No `expires_at`. A card used to claim the room's next message, which is why
   * it had to expire; it claims nothing now, so it stays answerable until it is
   * answered, finished, or made moot by a new goal.
   */
  async function postQuestions(
    roomId: string,
    payload: QuestionEmbedPayload,
    body: string,
    runId: string,
  ) {
    const admin = createServiceClient(opts.supabase);

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        persona: 'strategist',
        body,
        // Its own key, not position 0. The card and the plan now land in the
        // same run, and the plan's first proposal is keyed `:0`; sharing that
        // key made the plan's insert collide and read as a replay, so a plan
        // was produced, nothing was posted, and nothing said so. Found by
        // driving the product against the live stack, not by any test here.
        idempotency_key: `agent-run:${runId}:questions`,
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
      // Enforced on the embed action route, which is where an answer now
      // arrives. The UI reads it to hide the controls from everybody else.
      required_role: 'owner',
      state: 'pending',
    });
    if (embedError && embedError.code !== '23505') throw embedError;
  }

  /**
   * Remember what the owner stated about the business.
   *
   * Only stated slots, only the four business keys, only the keys present, and
   * only when the goal came from the owner: a member's message is a goal too,
   * but what a member says is not the workspace's word about itself. Never
   * fatal, because the plan is the point and the profile is a convenience.
   */
  async function rememberStated(roomId: string, slots: IntakeSlot[], ownerId: string | null) {
    if (!ownerId) return;
    try {
      const admin = createServiceClient(opts.supabase);
      const fields = profileFieldsFromSlots(slots);
      if (Object.keys(fields).length === 0) return;
      await writeProfileFields(admin, roomId, fields, ownerId);
      log.info({ roomId, keys: Object.keys(fields) }, 'workspace profile updated from intake');
    } catch (err) {
      log.warn({ err, roomId }, 'could not remember the stated slots; the plan proceeds');
    }
  }

  /**
   * Run intake on a goal and decide what this turn does.
   *
   * Returns the goal to plan from, or null when the request is outside what we
   * can ground. **Asking no longer stops planning.** A broad goal with slots
   * still empty posts the question card AND returns the refined goal, so the
   * plan is produced in the same run and the card sits beside it; the person
   * sees work start instead of an interview.
   *
   * **Intake failing is not a reason to refuse.** Any error here falls through to
   * planning on the original goal with whatever slots were carried, which is the
   * behaviour that existed before intake did. It improves a query; it is not a
   * precondition for answering, and letting an optional step take down a working
   * path is the trade the AI service already refuses to make. Nothing is granted
   * by passing through: the groundedness gate still runs inside `/plan`.
   */
  async function runIntake(
    roomId: string,
    goal: string,
    runId: string,
    carried: { slots: IntakeSlot[]; round: number },
  ): Promise<{ goal: string; context: IntakeSlot[]; asked: boolean } | null> {
    let intake: IntakeResponse;
    try {
      intake = await requestIntake(
        opts.aiServiceUrl,
        {
          roomId,
          goal,
          answers: [],
          slots: carried.slots,
          round: carried.round,
          agentRunId: runId,
        },
        opts.intakeTimeoutMs,
      );
    } catch (err) {
      log.warn({ err, agentRunId: runId, roomId }, 'intake failed, planning on the goal');
      return { goal, context: carried.slots, asked: false };
    }

    log.info(
      {
        agentRunId: runId,
        roomId,
        core: intake.core,
        outcome: intake.outcome,
        completeness: intake.completeness,
        proximity: intake.proximity,
        questions: intake.questions.length,
        round: carried.round,
        seeded: carried.slots.length,
      },
      'intake complete',
    );

    // Neither a greeting nor an out-of-domain request produces a goal. Both are
    // answered with a plain message and the conversation is left open: the next
    // thing the person types is a goal, as every message is now. No card, because
    // a card that waited for a goal was the mechanism by which the room used to
    // be held, and there is nothing on it to answer.
    if (intake.outcome === 'not_a_request') {
      await postAsAgent(roomId, INTAKE_COPY.opening, runId, 0);
      return null;
    }
    if (intake.outcome === 'out_of_domain') {
      // Named before asking. Asking first and declining later would be keeping
      // someone talking rather than redirecting them honestly.
      await postAsAgent(roomId, INTAKE_COPY.redirect(echo(goal)), runId, 0);
      return null;
    }

    // Enforced on this side as well as in the service: a card written before
    // the cap changed must not hold someone in an interrogation. The card goes
    // out first so it sits above the plan it refines.
    let asked = false;
    if (!intake.ready && intake.questions.length > 0 && carried.round < maxRounds) {
      await postQuestions(
        roomId,
        {
          awaiting: 'answers',
          goal,
          questions: intake.questions,
          slots: intake.slots,
          round: carried.round,
          answers: [],
          stalls: 0,
          taskIds: [],
          runId,
        },
        INTAKE_COPY.questions(intake.questions),
        runId,
      );
      asked = true;
    }

    // The refined goal is what retrieval should see: it is the request restated
    // from what intake established, and it is kept short because it is reranked
    // like any other query (ADR-0009).
    return { goal: intake.refined_goal || goal, context: intake.slots, asked };
  }

  /**
   * Post what the core proposed. Separated from asking for it so a
   * continuation can retire the plan it replaces only once the replacement
   * exists: expiring first and then failing would leave the person with no plan.
   */
  async function postProposals(
    roomId: string,
    goal: string,
    plan: PlanResponse,
    context: IntakeSlot[],
    runId: string,
    supersedes?: string,
  ): Promise<void> {
    for (const [index, proposal] of plan.proposals.entries()) {
      // Every kind is handled explicitly. The core cannot widen its own powers
      // by inventing one: an unknown kind fails the schema parse above, before
      // reaching this switch.
      switch (proposal.kind) {
        case 'post_message':
          await postAsAgent(roomId, proposal.body, runId, index);
          break;
        case 'propose_plan':
          await postPlan(roomId, goal, proposal, plan.citations, runId, index, context, supersedes);
          break;
      }
    }
  }

  /**
   * The planning half of a run: the same whichever entry point reached it.
   *
   * The goal searches; the context tailors. Keeping the person's audience,
   * budget and product name out of the query is measured rather than tidy:
   * folding them in returned nothing at all for "Get signups for travelers."
   */
  async function requestPlanFor(
    roomId: string,
    goal: string,
    context: IntakeSlot[],
    runId: string,
  ): Promise<PlanResponse> {
    const plan = await requestPlan(
      opts.aiServiceUrl,
      { roomId, goal, context, agentRunId: runId },
      opts.aiTimeoutMs,
    );

    log.info(
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
    return plan;
  }

  /** The question card this run asked, if it asked one. */
  async function loadRunQuestion(roomId: string, runId: string) {
    const admin = createServiceClient(opts.supabase);
    const { data, error } = await admin
      .from('action_embeds')
      .select('id, state, payload')
      .eq('room_id', roomId)
      .eq('component', 'question')
      .eq('payload->>runId', runId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const parsed = QuestionEmbedPayload.safeParse(data.payload);
    if (!parsed.success) return null;
    return { id: data.id as string, state: data.state as string, payload: parsed.data };
  }

  /** The plan card a run produced, if it produced one. */
  async function loadRunPlan(roomId: string, runId: string) {
    const admin = createServiceClient(opts.supabase);
    const { data, error } = await admin
      .from('action_embeds')
      .select('id, state')
      .eq('room_id', roomId)
      .eq('component', 'plan')
      .eq('payload->>runId', runId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string; state: string } | null) ?? null;
  }

  /**
   * Retire a plan nobody approved, conditionally, and say whether we did.
   *
   * `expired` rather than `dismissed`: the person did nothing to this card, its
   * window closed because a better one arrived. Not `rejected`, which is a
   * verdict `feedback_events` would read as a label. `expires_at` is stamped so
   * the row says when, as the column has meant since it was written.
   */
  async function expirePlan(planEmbedId: string): Promise<boolean> {
    const admin = createServiceClient(opts.supabase);
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from('action_embeds')
      .update({ state: 'expired', expires_at: now, acted_at: now })
      .eq('id', planEmbedId)
      .eq('state', 'pending')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  async function startRun(roomId: string, message: string, runId: string, authorId: string) {
    try {
      // Every message is a goal. An owner's goal also closes the intake cards
      // that were sharpening the previous one; anybody else's message is still a
      // goal, and touches no card, because the cards are about the owner's own
      // business and a member's message says nothing about it.
      const ownerId = await loadRoomOwner(roomId);
      const fromOwner = ownerId !== null && ownerId === authorId;
      if (fromOwner) await dismissOpenIntake(roomId, runId);

      // What the workspace already knows, as stated slots for round 0. Read
      // best-effort: a profile that cannot be read costs a question, not a plan.
      let seed: IntakeSlot[] = [];
      try {
        seed = profileSlots(await readProfile(createServiceClient(opts.supabase), roomId));
      } catch (err) {
        log.warn({ err, roomId }, 'could not read the workspace profile; asking instead');
      }

      const goal = message.trim();
      const next = await runIntake(roomId, goal, runId, { slots: seed, round: 0 });
      // Intake declined the subject. This run is finished and the next message
      // starts another.
      if (!next) return;

      // Said in the room the moment there is something to work on, because a
      // minute of silence after a message looks like the agent deciding not
      // to reply (rule 16).
      await postNotice(roomId, INTAKE_COPY.started(echo(goal)), runId, 'started', 'strategist');
      if (fromOwner) await rememberStated(roomId, next.context, ownerId);

      const plan = await requestPlanFor(roomId, next.goal, next.context, runId);
      await postProposals(roomId, next.goal, plan, next.context, runId);

      // The card may have been finished while the plan was being written. The
      // action side continues the run only when it can find this plan, so if it
      // ran first it found nothing and planned on its own; either way the
      // continuation run id is deterministic and the two collide harmlessly.
      if (next.asked) {
        const card = await loadRunQuestion(roomId, runId);
        if (card && card.state === 'answered') {
          log.info({ agentRunId: runId, embedId: card.id }, 'card was finished during planning');
          await continueFromCard(roomId, card.id, card.payload);
        }
      }
    } catch (err) {
      // A failed run must be visible in the room. Silence would look identical
      // to the agent deciding not to reply (AGENTS.md rule 16).
      log.error(
        { err, agentRunId: runId, roomId, kind: err instanceof AiServiceError ? err.kind : null },
        'agent run failed',
      );
      await postNotice(roomId, failureNotice(err), runId, 'failed', 'system');
    }
  }

  async function continueFromCard(
    roomId: string,
    embedId: string,
    payload: QuestionEmbedPayload,
  ): Promise<void> {
    // Deterministic, so a card finished twice (a double click that beat the
    // conditional update, or the run and the action both continuing) collides
    // on every idempotency key below rather than posting a second plan. Older
    // cards carry no run id and fall back to the card's own.
    const baseRun = payload.runId ?? embedId;
    const runId = continuationRunId(payload, embedId);
    const admin = createServiceClient(opts.supabase);

    try {
      const existing = await loadRunPlan(roomId, baseRun);

      // The plan was approved and is running: the answers become a diff, on the
      // same card and through the same boundary a person's own request would
      // take. Nothing is applied here.
      if (existing) {
        const { data: project, error } = await admin
          .from('projects')
          .select('id, goal, status')
          .eq('source_embed_id', existing.id)
          .maybeSingle<{ id: string; goal: string; status: string }>();
        if (error) throw error;
        if (project && project.status !== 'completed' && project.status !== 'cancelled') {
          await postNotice(roomId, INTAKE_COPY.updating, runId, 'started', 'strategist');
          await produceDiff(
            admin,
            { aiServiceUrl: opts.aiServiceUrl, aiTimeoutMs: opts.aiTimeoutMs, log },
            {
              projectId: project.id,
              roomId,
              goal: project.goal,
              reason: replanReason(payload.slots),
              runId,
              context: payload.slots,
            },
          );
          return;
        }
      }

      // A replay: the continuation already produced its plan. Only make sure
      // the old one is retired, then stop, so no second AI call is spent.
      if (await loadRunPlan(roomId, runId)) {
        if (existing && existing.state === 'pending') await expirePlan(existing.id);
        return;
      }

      const next = await runIntake(roomId, payload.goal, runId, {
        slots: payload.slots,
        round: payload.round + 1,
      });
      if (!next) return;

      await postNotice(roomId, INTAKE_COPY.updating, runId, 'started', 'strategist');
      const plan = await requestPlanFor(roomId, next.goal, next.context, runId);

      // Retire the pending plan only now that its replacement exists, and pass
      // its id on so the client can mark it without a fetch.
      let supersedes: string | undefined;
      if (existing && existing.state === 'pending' && (await expirePlan(existing.id))) {
        supersedes = existing.id;
      }
      await postProposals(roomId, next.goal, plan, next.context, runId, supersedes);
    } catch (err) {
      log.error(
        {
          err,
          agentRunId: runId,
          roomId,
          embedId,
          kind: err instanceof AiServiceError ? err.kind : null,
        },
        'continuation from a question card failed',
      );
      await postNotice(roomId, failureNotice(err), runId, 'failed', 'system');
    }
  }

  return { startRun, continueFromCard };
}
