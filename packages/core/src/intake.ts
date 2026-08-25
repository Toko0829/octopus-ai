/**
 * What a new message in a room means while an intake is open.
 *
 * A goal arrives as a chat message, and so does the answer to a question the
 * agent asked about it. They are the same event on the wire, and only the room's
 * state tells them apart. Getting that wrong is not a cosmetic failure: reading a
 * fresh goal as an answer buries it inside a stale intake, and reading an answer
 * as a fresh goal throws away everything the person just told us and asks again.
 *
 * This is a decision, so it lives here with no IO. `apps/api` fetches the pending
 * card and writes the outcome; what any of it MEANS is decided in one pure
 * function that a reader can check without a database.
 */

import type { IntakeSlot, QuestionEmbedPayload } from '@octopus/contracts';

/** The open question card, if the room has one. */
export interface PendingIntake {
  embedId: string;
  payload: QuestionEmbedPayload;
}

export interface IntakeTurnInput {
  /** The message that just arrived. */
  message: string;
  /** Who wrote it. */
  authorId: string;
  /** The room's owner, or null if the room has none. */
  roomOwnerId: string | null;
  /** The open question card, or null. */
  pending: PendingIntake | null;
  /** Rounds allowed before intake stops asking. Mirrors INTAKE_MAX_ROUNDS. */
  maxRounds: number;
}

export type IntakeTurn =
  | {
      /** No intake is open: this message is a goal in its own right. */
      kind: 'new_goal';
      goal: string;
      stalls: 0;
    }
  | {
      /**
       * A card was open and waiting for a goal rather than for answers, because
       * the previous turn produced none: a greeting, or a request from a field
       * this system cannot ground. This message becomes the goal.
       */
      kind: 'restated_goal';
      goal: string;
      /** Carried so the conversation cannot circle forever. */
      stalls: number;
      embedId: string;
    }
  | {
      /**
       * This message answers a question the PLAN raised, about work only this
       * person can do. Their reply is the step's deliverable, not context.
       */
      kind: 'task_answer';
      answer: string;
      taskIds: string[];
      embedId: string;
    }
  | {
      /** This message answers an open question card. */
      kind: 'answer';
      /** The ORIGINAL goal, not this message. */
      goal: string;
      answers: string[];
      slots: IntakeSlot[];
      round: number;
      embedId: string;
    };

/**
 * Decide what this message is, given what the room was waiting for.
 *
 * Three rules, and the order matters.
 *
 * **1. No open card means a new goal.** The ordinary case, and the behaviour that
 * existed before intake.
 *
 * **2. A non-owner never answers an open question.** `discord-chat-spec.md` marks
 * the Question embed owner-only, and intake answers describe the person's own
 * business: their budget, their customers, their timeline. A human node sitting in
 * the room must not be able to supply those, and the enforcement has to be here
 * rather than on the embed's `required_role`, because an answer arrives as a chat
 * message and never touches the embed action route where that role is checked.
 *
 * Their message is still a message. It is simply not an answer, so it is treated
 * as a goal, which is what it would have been without an intake in flight.
 *
 * **3. The round cap is enforced on this side too**, not only inside the AI
 * service. A card written before the cap was lowered, or a service that keeps
 * asking, must not be able to hold someone in an interrogation: past the cap the
 * message is a goal and the run proceeds to planning with whatever is known.
 *
 * A room with an owner of `null` has nobody who can answer, which is the same
 * safe default `rooms.owner_id` already takes for approvals: nullable on purpose,
 * so an unowned room means nobody rather than anybody.
 *
 * **4. A card can be waiting for a goal rather than for answers**, and then this
 * message replaces the goal instead of extending it. See the branch below.
 */
export function decideIntakeTurn(input: IntakeTurnInput): IntakeTurn {
  const goal = input.message.trim();

  if (!input.pending) {
    return { kind: 'new_goal', goal, stalls: 0 };
  }

  const isOwner = input.roomOwnerId !== null && input.authorId === input.roomOwnerId;
  if (!isOwner) {
    return { kind: 'new_goal', goal, stalls: 0 };
  }

  const { payload, embedId } = input.pending;

  // **5. A card waiting on TASK answers is the plan asking, not intake.**
  //
  // The plan gave this person work only they can do: a budget, a positioning
  // call, which analytics source counts. Their reply completes a step that
  // already exists, so it is checked before the intake branches below. Handing it
  // to intake would file a budget figure as context for a plan nobody is making.
  if (payload.awaiting === 'task_answers') {
    return { kind: 'task_answer', answer: goal, taskIds: payload.taskIds, embedId };
  }

  // **4. A card waiting for a goal means this message IS the goal.**
  //
  // The previous turn produced no usable one, because the person said hello or
  // asked about something outside what this system can ground. Filing their reply
  // as an "answer" would leave the goal as "Hello" and bury everything real
  // underneath it, so the reply replaces the goal instead of extending it.
  //
  // The stall count comes with it, and that is the only thing carried forward:
  // following someone's thread is right, following it forever is a system that
  // will not take no for an answer.
  if (payload.awaiting === 'goal') {
    return { kind: 'restated_goal', goal, stalls: payload.stalls, embedId };
  }

  if (payload.round >= input.maxRounds) {
    return { kind: 'new_goal', goal, stalls: 0 };
  }

  return {
    kind: 'answer',
    goal: payload.goal,
    // Appended rather than replaced: round two must still see round one's answer,
    // since a slot filled earlier is only re-derivable from the words that filled
    // it. The AI service is stateless, so whatever is dropped here is gone.
    answers: [...payload.answers, goal],
    slots: payload.slots,
    round: payload.round + 1,
    embedId,
  };
}
