import { describe, expect, it } from 'vitest';
import type { QuestionEmbedPayload } from '@octopus/contracts';
import {
  applyAnswer,
  dismissableQuestion,
  profileSlots,
  remainingRequiredSlots,
  replanReason,
} from './intake';

/**
 * What a question card means, now that answers arrive on the card.
 *
 * The old suite pinned `decideIntakeTurn`, which decided whether a chat message
 * was an answer or a goal. That decision no longer exists: a message is a goal.
 * What is pinned here is the smaller set of rules the card and the route still
 * share, and the one rule about a new goal that replaced the escape prefix.
 */

function card(over: Partial<QuestionEmbedPayload> = {}): QuestionEmbedPayload {
  return {
    awaiting: 'answers',
    goal: 'get my first 100 customers',
    questions: [
      { slot: 'icp', question: 'Who is it for?' },
      { slot: 'budget_band', question: 'How much a month?' },
    ],
    slots: [],
    round: 0,
    answers: [],
    stalls: 0,
    taskIds: [],
    ...over,
  };
}

describe('applyAnswer', () => {
  it('replaces an inference with what the person said', () => {
    const before = card({ slots: [{ key: 'icp', value: 'founders', source: 'inferred' }] });
    const after = applyAnswer(before, 'icp', '  solo founders in the US ');
    expect(after.slots).toEqual([
      { key: 'icp', value: 'solo founders in the US', source: 'stated' },
    ]);
  });

  it('replaces an earlier answer of their own too', () => {
    // A person correcting themselves is the ordinary case, and a card that kept
    // both would hand the planner two audiences.
    const before = card({ slots: [{ key: 'icp', value: 'creators', source: 'stated' }] });
    const after = applyAnswer(before, 'icp', 'agencies');
    expect(after.slots.filter((s) => s.key === 'icp')).toHaveLength(1);
    expect(after.slots[0]?.value).toBe('agencies');
  });

  it('leaves the other slots and everything else alone', () => {
    const before = card({ slots: [{ key: 'offer', value: 'a course', source: 'stated' }] });
    const after = applyAnswer(before, 'budget_band', '500_2k');
    expect(after.slots.map((s) => s.key)).toEqual(['offer', 'budget_band']);
    expect(after.goal).toBe(before.goal);
    expect(after.questions).toBe(before.questions);
  });
});

describe('remainingRequiredSlots', () => {
  it('counts only what the card asked about', () => {
    // Intake asks for what it does not know. A card with two questions is done
    // when those two are answered, even though four slots are required.
    expect(remainingRequiredSlots(card())).toEqual(['icp', 'budget_band']);
  });

  it('shrinks as answers land, whatever their source', () => {
    const half = card({ slots: [{ key: 'icp', value: 'founders', source: 'inferred' }] });
    expect(remainingRequiredSlots(half)).toEqual(['budget_band']);
    expect(remainingRequiredSlots(applyAnswer(half, 'budget_band', 'over_10k'))).toEqual([]);
  });

  it('never requires a timeline', () => {
    // Collected when offered and never blocking, which is the rule intake.py
    // holds; a card must not hold somebody for a slot the service would not.
    const asked = card({ questions: [{ slot: 'timeline', question: 'By when?' }] });
    expect(remainingRequiredSlots(asked)).toEqual([]);
  });

  it('is in the required order, not the order asked', () => {
    const reversed = card({
      questions: [
        { slot: 'budget_band', question: 'How much?' },
        { slot: 'offer', question: 'What do you sell?' },
      ],
    });
    expect(remainingRequiredSlots(reversed)).toEqual(['offer', 'budget_band']);
  });
});

describe('dismissableQuestion', () => {
  it('closes an intake card when the owner moves on', () => {
    expect(dismissableQuestion(card())).toBe(true);
  });

  it('closes a leftover card that was waiting for a goal', () => {
    // Nothing can answer one now: the chat path that fed it is gone.
    expect(dismissableQuestion(card({ awaiting: 'goal', goal: '', questions: [] }))).toBe(true);
  });

  it('keeps a task-answers card open', () => {
    // It belongs to a plan that is still running, and the steps it names still
    // need the person whatever they type next.
    expect(
      dismissableQuestion(
        card({
          awaiting: 'task_answers',
          goal: '',
          questions: [],
          taskIds: ['11111111-1111-4111-8111-111111111111'],
        }),
      ),
    ).toBe(false);
  });
});

describe('replanReason', () => {
  it('names only what the person stated, in the chip vocabulary', () => {
    const reason = replanReason([
      { key: 'icp', value: 'solo founders', source: 'stated' },
      { key: 'offer', value: 'a course', source: 'inferred' },
      { key: 'budget_band', value: '500_2k', source: 'stated' },
    ]);
    expect(reason).toContain('the audience is solo founders');
    expect(reason).toContain('the budget is $500 to $2,000 a month');
    // A model's inference is not something the owner added.
    expect(reason).not.toContain('a course');
  });

  it('says so when nothing was stated, rather than sending an empty reason', () => {
    expect(replanReason([{ key: 'offer', value: 'x', source: 'inferred' }])).toContain(
      'nothing new',
    );
  });

  it('never uses an em dash and stays inside the replan body limit', () => {
    const long = replanReason([
      { key: 'icp', value: 'x'.repeat(400), source: 'stated' },
      { key: 'offer', value: 'y'.repeat(400), source: 'stated' },
      { key: 'target_metric', value: 'z'.repeat(400), source: 'stated' },
    ]);
    expect(long).not.toContain('—');
    expect(long.length).toBeLessThanOrEqual(1000);
  });
});

describe('profileSlots', () => {
  it('turns stored facts into stated slots and skips what is empty', () => {
    expect(
      profileSlots({
        icp: ' solo founders ',
        offer: null,
        budget_band: '',
        timeline: 'this_quarter',
      }),
    ).toEqual([
      { key: 'icp', value: 'solo founders', source: 'stated' },
      { key: 'timeline', value: 'this_quarter', source: 'stated' },
    ]);
  });

  it('yields nothing for a workspace with no profile', () => {
    expect(profileSlots(null)).toEqual([]);
    expect(profileSlots(undefined)).toEqual([]);
  });

  it('never produces a target metric, which belongs to a goal', () => {
    const keys = profileSlots({ icp: 'a', offer: 'b', budget_band: 'c', timeline: 'd' }).map(
      (s) => s.key,
    );
    expect(keys).not.toContain('target_metric');
  });
});
