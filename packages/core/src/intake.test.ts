import { describe, expect, it } from 'vitest';
import { decideIntakeTurn, type PendingIntake } from './intake';

/**
 * The failures here are all silent ones. Reading a fresh goal as an answer buries
 * it inside a stale intake; reading an answer as a goal discards what the person
 * just said and asks again; letting a non-owner answer lets someone else describe
 * a business that is not theirs. None of these throw.
 */

const OWNER = 'owner-1';

function pending(overrides: Partial<PendingIntake['payload']> = {}): PendingIntake {
  return {
    embedId: 'embed-1',
    payload: {
      awaiting: 'answers',
      goal: 'get me my first 100 customers',
      questions: [{ slot: 'budget_band', question: 'What can you spend?' }],
      slots: [{ key: 'icp', value: 'indie makers', source: 'stated' }],
      round: 0,
      answers: [],
      stalls: 0,
      taskIds: [],
      ...overrides,
    },
  };
}

describe('decideIntakeTurn', () => {
  it('treats a message as a goal when no question is open', () => {
    const turn = decideIntakeTurn({
      message: 'my CPA is too high',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: null,
      maxRounds: 2,
    });

    expect(turn).toEqual({ kind: 'new_goal', goal: 'my CPA is too high', stalls: 0 });
  });

  it('lets a reply replace the goal when the card was waiting for one', () => {
    // The person said "Hello", so there was no usable goal. Filing "I sell a
    // budgeting app" as an ANSWER would leave the goal as "Hello" and bury
    // everything real underneath it.
    const turn = decideIntakeTurn({
      message: 'I sell a budgeting app and need users',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending({ awaiting: 'goal', goal: '', stalls: 1, answers: [], slots: [] }),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('restated_goal');
    if (turn.kind !== 'restated_goal') return;
    expect(turn.goal).toBe('I sell a budgeting app and need users');
    // Carried, so a conversation that never lands cannot circle forever.
    expect(turn.stalls).toBe(1);
    expect(turn.embedId).toBe('embed-1');
  });

  it('does not apply the answer round cap to a card waiting for a goal', () => {
    // The two caps bound different things: `round` limits interrogating someone
    // who HAS told us what they want, `stalls` limits asking someone who has not.
    const turn = decideIntakeTurn({
      message: 'ok, I want more newsletter subscribers',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending({ awaiting: 'goal', goal: '', round: 5, stalls: 1 }),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('restated_goal');
  });

  it('reads a reply to a task question as completing a step, not as a goal', () => {
    // The plan asked for work only this person can do. Handing their budget
    // figure to intake would file it as context for a plan that already exists,
    // and the step it answers would stay waiting forever.
    const turn = decideIntakeTurn({
      message: '2000 dollars a month, and CPA under 40',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending({ awaiting: 'task_answers', goal: '', taskIds: ['task-1', 'task-2'] }),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('task_answer');
    if (turn.kind !== 'task_answer') return;
    expect(turn.answer).toBe('2000 dollars a month, and CPA under 40');
    expect(turn.taskIds).toEqual(['task-1', 'task-2']);
    expect(turn.embedId).toBe('embed-1');
  });

  it('does not let a non-owner answer a task question either', () => {
    // A human node must not be able to state this person's budget or make their
    // positioning call, and that is a stronger rule here than for intake: this
    // answer becomes a deliverable and completes a step.
    const turn = decideIntakeTurn({
      message: 'their budget is about 5000',
      authorId: 'node-9',
      roomOwnerId: OWNER,
      pending: pending({ awaiting: 'task_answers', taskIds: ['task-1'] }),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('new_goal');
  });

  it('does not apply the intake round cap to a task question', () => {
    // The cap exists to stop intake interrogating someone. A step the plan
    // raised is not an interrogation, and it must stay answerable however many
    // intake rounds happened earlier.
    const turn = decideIntakeTurn({
      message: 'use GA4 as the source of truth',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending({ awaiting: 'task_answers', round: 9, taskIds: ['task-1'] }),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('task_answer');
  });

  it('treats the owner reply to an open question as an answer, not a new goal', () => {
    const turn = decideIntakeTurn({
      message: 'about 300 dollars a month',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending(),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('answer');
    if (turn.kind !== 'answer') return;
    // The ORIGINAL goal survives. Planning from "about 300 dollars a month"
    // would be planning from the answer and losing the question.
    expect(turn.goal).toBe('get me my first 100 customers');
    expect(turn.answers).toEqual(['about 300 dollars a month']);
    expect(turn.round).toBe(1);
    expect(turn.embedId).toBe('embed-1');
  });

  it('keeps earlier answers rather than replacing them', () => {
    const turn = decideIntakeTurn({
      message: 'by the end of the quarter',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending({ round: 1, answers: ['about 300 dollars a month'] }),
      maxRounds: 3,
    });

    if (turn.kind !== 'answer') throw new Error('expected an answer');
    // The AI service is stateless, so anything dropped here is gone: a slot
    // filled in round one is only re-derivable from the words that filled it.
    expect(turn.answers).toEqual(['about 300 dollars a month', 'by the end of the quarter']);
  });

  it('carries prior slots forward untouched', () => {
    const turn = decideIntakeTurn({
      message: '300 a month',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending(),
      maxRounds: 2,
    });

    if (turn.kind !== 'answer') throw new Error('expected an answer');
    expect(turn.slots).toEqual([{ key: 'icp', value: 'indie makers', source: 'stated' }]);
  });

  it('refuses to let a non-owner answer an open question', () => {
    // A human node in the room must not be able to state this person's budget,
    // customers, or timeline. The embed's required_role cannot enforce it: an
    // answer is a chat message and never reaches the action route.
    const turn = decideIntakeTurn({
      message: 'their budget is about 5000',
      authorId: 'node-9',
      roomOwnerId: OWNER,
      pending: pending(),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('new_goal');
  });

  it('treats an unowned room as having nobody who can answer', () => {
    // Same safe default rooms.owner_id already takes for approvals: null means
    // nobody, never anybody.
    const turn = decideIntakeTurn({
      message: 'about 300 a month',
      authorId: OWNER,
      roomOwnerId: null,
      pending: pending(),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('new_goal');
  });

  it('stops treating messages as answers once the round cap is reached', () => {
    // Enforced on this side as well as in the AI service. A card written before
    // the cap was lowered must not be able to hold someone in an interrogation.
    const turn = decideIntakeTurn({
      message: 'and my timeline is three months',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: pending({ round: 2 }),
      maxRounds: 2,
    });

    expect(turn.kind).toBe('new_goal');
  });

  it('trims the incoming message', () => {
    const turn = decideIntakeTurn({
      message: '   my CPA is too high  ',
      authorId: OWNER,
      roomOwnerId: OWNER,
      pending: null,
      maxRounds: 2,
    });

    expect(turn).toEqual({ kind: 'new_goal', goal: 'my CPA is too high', stalls: 0 });
  });
});
