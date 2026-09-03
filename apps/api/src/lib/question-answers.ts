import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';
import {
  QuestionEmbedPayload,
  type EmbedAnswerBody,
  type EmbedFinishBody,
  type IntakeSlotKey,
} from '@octopus/contracts';
import { remainingRequiredSlots } from '@octopus/core';
import { completeTaskWithAnswer } from './task-answers';
import { postSystemMessage } from './system-message';
import { profileFieldsFromSlots, writeProfileFields } from './room-profile';

/**
 * Acting on a question card: one answer at a time, on the card.
 *
 * A question card used to be answered by typing every answer into one chat
 * message, which a model parsed back into slots, and while it was pending it
 * claimed every message the owner wrote. Two of them were found holding rooms
 * for nearly two days. Answers now arrive here, through the same route every
 * other card is acted on through, which is what makes `required_role` the
 * enforcement rather than a hint: the route has already read the card as the
 * caller and checked the owner before this runs.
 *
 * Three things a caller can do, and the route has narrowed the body to them:
 *
 *   * **`answer` a slot.** Written by `answer_question_slot` in one statement,
 *     conditional on the card being pending, so two chips clicked in the same
 *     second cannot lose one another. The response carries the new payload and
 *     which required slots are still missing, so the card can render both
 *     without a second fetch. When nothing required is left the card closes
 *     itself and the run continues.
 *   * **`answer` a task.** The plan asked about a step only this person can do.
 *     Recorded on the card, then the step is completed through the same helper
 *     the project panel uses. The card closes once every step it named is
 *     answered.
 *   * **`finish`.** The person has said what they are going to say. The card
 *     closes with whatever it has, and the run plans from that.
 *
 * Nothing here writes `feedback_events`. A question has no verdict, and a label
 * derived from an answer would be a training example of a person approving
 * something they were never shown.
 */

export interface QuestionActionDeps {
  admin: SupabaseClient;
  log: FastifyBaseLogger;
  /** What happens once a card is closed. Runs after the response is sent. */
  continueFromCard: (
    roomId: string,
    embedId: string,
    payload: QuestionEmbedPayload,
  ) => Promise<void>;
}

export interface QuestionEmbedRow {
  id: string;
  room_id: string;
  payload: unknown;
}

export interface QuestionActionResult {
  status: number;
  body: Record<string, unknown>;
}

function refuse(status: number, error: string, message: string): QuestionActionResult {
  return { status, body: { error, message } };
}

/** Postgres raises every deliberate refusal in this domain as a check violation. */
const PG_CHECK_VIOLATION = '23514';

/**
 * Close the card, conditionally. Returns false when somebody else closed it
 * first, which is the same guard the verdict path uses and for the same reason:
 * checking state and then writing it is a race, doing both at once is not.
 */
async function closeCard(admin: SupabaseClient, embedId: string, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('action_embeds')
    .update({ state: 'answered', acted_by: userId, acted_at: new Date().toISOString() })
    .eq('id', embedId)
    .eq('state', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function handleQuestionAction(
  deps: QuestionActionDeps,
  embed: QuestionEmbedRow,
  body: EmbedAnswerBody | EmbedFinishBody,
  userId: string,
): Promise<QuestionActionResult> {
  const { admin, log } = deps;

  const parsed = QuestionEmbedPayload.safeParse(embed.payload);
  if (!parsed.success) {
    log.error({ embedId: embed.id }, 'question card payload is unreadable');
    return refuse(409, 'conflict', 'This card cannot be read.');
  }
  const payload = parsed.data;

  // A card left over from the chat-answer path, waiting for a goal that now
  // arrives as an ordinary message. Nothing on it can be answered.
  if (payload.awaiting === 'goal') {
    return refuse(
      409,
      'conflict',
      'This card has nothing to answer. Just say what you want to grow.',
    );
  }

  const respond = (state: string, next: unknown, remaining?: IntakeSlotKey[]) => ({
    status: 200,
    body: {
      id: embed.id,
      state,
      projectId: null,
      campaignId: null,
      payload: next,
      ...(remaining ? { remaining } : {}),
    },
  });

  // ------------------------------------------------------------------ finish

  if (body.action === 'finish') {
    if (payload.awaiting !== 'answers') {
      return refuse(409, 'conflict', 'This card closes on its own once every step is answered.');
    }
    const won = await closeCard(admin, embed.id, userId);
    if (!won) return refuse(409, 'conflict', 'This card was already acted on.');

    log.info({ embedId: embed.id, userId, filled: payload.slots.length }, 'question card finished');
    void deps.continueFromCard(embed.room_id, embed.id, payload);
    return respond('answered', payload);
  }

  // ------------------------------------------------------------ slot answer

  if (body.slot !== undefined) {
    if (payload.awaiting !== 'answers') {
      return refuse(
        409,
        'conflict',
        'This card asks about steps of the plan, not about your business.',
      );
    }

    const { data, error } = await admin.rpc('answer_question_slot', {
      p_embed_id: embed.id,
      p_slot: body.slot,
      p_value: body.value,
    });
    if (error) {
      if (error.code === PG_CHECK_VIOLATION) {
        return refuse(400, 'bad_request', 'An answer is 1 to 400 characters.');
      }
      log.error({ err: error, embedId: embed.id }, 'could not record a slot answer');
      return refuse(500, 'internal_error', 'Could not save that answer.');
    }
    // Null means the conditional update matched nothing: the card is closed.
    if (data === null) return refuse(409, 'conflict', 'This card was already acted on.');

    const next = QuestionEmbedPayload.safeParse(data);
    if (!next.success) {
      log.error({ embedId: embed.id }, 'the answered payload does not parse');
      return refuse(500, 'internal_error', 'Could not read the card back.');
    }

    const remaining = remainingRequiredSlots(next.data);
    log.info(
      { embedId: embed.id, userId, slot: body.slot, remaining: remaining.length },
      'slot answered on the card',
    );

    // A fact about the business is remembered for the next goal in this room.
    // The owner just typed it, so it is written as their word; the target
    // metric belongs to the goal and is skipped by the helper. Never fatal: the
    // answer is on the card whatever happens to the profile.
    try {
      const fields = profileFieldsFromSlots([
        { key: body.slot, value: body.value, source: 'stated' },
      ]);
      if (Object.keys(fields).length > 0) {
        await writeProfileFields(admin, embed.room_id, fields, userId);
      }
    } catch (err) {
      log.warn(
        { err, embedId: embed.id, slot: body.slot },
        'could not update the workspace profile',
      );
    }

    // The last required answer closes the card, so the person is not asked to
    // click a second time to say they are done when the card already knows.
    if (remaining.length === 0) {
      const won = await closeCard(admin, embed.id, userId);
      if (won) {
        void deps.continueFromCard(embed.room_id, embed.id, next.data);
        return respond('answered', next.data, remaining);
      }
    }
    return respond('pending', next.data, remaining);
  }

  // ------------------------------------------------------------ task answer

  const taskId = body.taskId as string;
  if (payload.awaiting !== 'task_answers') {
    return refuse(409, 'conflict', 'This card asks about your business, not about a step.');
  }

  const { data, error } = await admin.rpc('answer_question_task', {
    p_embed_id: embed.id,
    p_task_id: taskId,
    p_value: body.value,
  });
  if (error) {
    if (error.code === PG_CHECK_VIOLATION) {
      return refuse(400, 'bad_request', 'An answer is 1 to 400 characters.');
    }
    log.error({ err: error, embedId: embed.id, taskId }, 'could not record a task answer');
    return refuse(500, 'internal_error', 'Could not save that answer.');
  }
  // Null covers both a closed card and a task this card never asked about: the
  // function matches on `taskIds`, so the route cannot be used to write an
  // answer against a step the card did not name.
  if (data === null) {
    return refuse(
      409,
      'conflict',
      'This card was already acted on, or never asked about that step.',
    );
  }
  const next = QuestionEmbedPayload.safeParse(data);
  if (!next.success) {
    log.error({ embedId: embed.id }, 'the answered payload does not parse');
    return refuse(500, 'internal_error', 'Could not read the card back.');
  }

  // Now the step. Read fresh rather than trusted from the card: the card says
  // which step was asked about, the row says whether it is still waiting.
  const { data: taskRow, error: taskError } = await admin
    .from('tasks')
    .select('id, project_id, title, state')
    .eq('id', taskId)
    .maybeSingle();
  if (taskError) {
    log.error({ err: taskError, taskId }, 'could not read the answered task');
    return refuse(500, 'internal_error', 'Could not read the step.');
  }
  const task = taskRow as { id: string; project_id: string; title: string; state: string } | null;

  if (!task || task.state !== 'needs_user') {
    // The answer is on the card and stays there, so nothing the person typed
    // is lost. But the step is not waiting any more (a replan cancelled it, or
    // the panel answered it first), and saying it was completed would be false.
    log.info(
      { embedId: embed.id, taskId, state: task?.state ?? null },
      'answered step no longer waiting',
    );
    return refuse(
      409,
      'conflict',
      'That step is no longer waiting on you. Your answer is kept on the card.',
    );
  }

  const result = await completeTaskWithAnswer(admin, task, body.value, {
    to: 'approved',
    completes: true,
  });
  if (!result.moved) {
    return refuse(
      409,
      'conflict',
      'That step moved while you were writing. Your answer is kept on the card.',
    );
  }
  if (result.finishMissed) {
    log.warn({ taskId, embedId: embed.id }, 'answered step did not reach done');
  }

  // Said in the room, because the chat is the audit trail and a step that
  // completed without a line saying so is one nobody can dispute.
  await postSystemMessage(
    admin,
    log,
    embed.room_id,
    `question-task:${embed.id}:${taskId}`,
    `Recorded: ${task.title}. I will carry on with what it unblocks.`,
  );

  // Closed once every step it named has an answer. A card with one step left
  // stays open so that step can still be answered on it.
  const answered = new Set(Object.keys(next.data.taskAnswers ?? {}));
  const complete = next.data.taskIds.every((id) => answered.has(id));
  if (complete) {
    const won = await closeCard(admin, embed.id, userId);
    if (won) return respond('answered', next.data);
  }

  log.info(
    { embedId: embed.id, userId, taskId, finalState: result.finalState },
    'task answered on the card',
  );
  return respond('pending', next.data);
}
