/**
 * The proof floor, and specifically the two things it must never do: judge
 * whether the work is good, and strand a node who left a field blank.
 *
 * A separate file from `critic.test.ts` because the subject is different rather
 * than because the file is long. `review` is about citations; this is about
 * whether a person handed over something the owner can act on.
 */

import { describe, expect, it } from 'vitest';
import {
  nextStateAfterProofReview,
  reviewProof,
  type ProofContext,
  type SubmittedProof,
} from './critic';

const CRITERIA = ['The video is under 60 seconds', 'The hook lands in the first 3 seconds'];

const NOTE = 'Shot on Tuesday at the studio. Cut to 52 seconds, hook is the price reveal at 0:02.';

function proof(over: Partial<SubmittedProof> = {}): SubmittedProof {
  return {
    note: NOTE,
    responses: ['52 seconds, timeline attached.', 'Price reveal opens the cut.'],
    fileCount: 1,
    ...over,
  };
}

function context(over: Partial<ProofContext> = {}): ProofContext {
  return { acceptanceCriteria: CRITERIA, ...over };
}

describe('the proof floor', () => {
  it('passes a submission that says what happened and answers every criterion', () => {
    const verdict = reviewProof(proof(), context());
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.unaddressed).toEqual([]);
  });

  it('refuses an empty note and reports one cause rather than three', () => {
    const verdict = reviewProof(proof({ note: '   ' }), context());
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual(['empty_proof']);
    expect(verdict.reasons).toHaveLength(1);
  });

  it('does not let a file stand in for the note', () => {
    // A photo with no word about what it shows is not reviewable, and the
    // criteria responses are the half this function can actually check.
    const verdict = reviewProof(proof({ note: '', fileCount: 3 }), context());
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual(['empty_proof']);
  });

  it('refuses a note too short to be a hand-off', () => {
    const verdict = reviewProof(proof({ note: 'Done.' }), context());
    expect(verdict.failures).toContain('too_short');
  });

  it('names which criteria were left blank, by index', () => {
    const verdict = reviewProof(proof({ responses: ['52 seconds.', '   '] }), context());
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain('unaddressed_criteria');
    expect(verdict.unaddressed).toEqual([1]);
  });

  it('treats a missing response as blank rather than reading undefined as answered', () => {
    // The route pairs by index, so a short array is a blank answer and not an
    // absent question. Getting this backwards would let a submission pass by
    // sending fewer responses than there are criteria.
    const verdict = reviewProof(proof({ responses: ['52 seconds.'] }), context());
    expect(verdict.unaddressed).toEqual([1]);
  });

  it('passes when the step carried no criteria at all', () => {
    // Older tasks predate `20260816120000` and have an empty array. Refusing
    // them would make the first reader of a column break every row written
    // before it existed.
    const verdict = reviewProof(proof({ responses: [] }), context({ acceptanceCriteria: [] }));
    expect(verdict.passed).toBe(true);
  });

  it('has no opinion about whether the work is any good', () => {
    // The whole posture, asserted rather than only written in the header: a note
    // that answers every criterion passes even when what it describes is plainly
    // bad work. The owner is the checker.
    const verdict = reviewProof(
      proof({
        note: 'I did the absolute minimum here and I am not proud of the result at all.',
        responses: ['It is 59 seconds.', 'The hook is weak but it is there.'],
      }),
      context(),
    );
    expect(verdict.passed).toBe(true);
  });
});

describe('where a checked proof goes', () => {
  it('sends a passing proof to the owner', () => {
    expect(nextStateAfterProofReview(reviewProof(proof(), context()))).toBe('in_review');
  });

  it('returns a failing proof to the node rather than escalating or failing it', () => {
    // `nextStateAfterReview` can escalate because a model that invented a
    // citation will invent another. A person who left a field blank fixes it in
    // ten seconds, so there is no attempt counter and no terminal state here.
    const bounced = reviewProof(proof({ note: 'Done.' }), context());
    expect(nextStateAfterProofReview(bounced)).toBe('in_progress');
  });

  it('only ever returns one of two states, and never approves', () => {
    // Approving is the owner's arc. Nothing in the automated half may reach it,
    // because the AI does not decide that a person's work is finished.
    const allowed = new Set(['in_review', 'in_progress']);
    const verdicts = [
      reviewProof(proof(), context()),
      reviewProof(proof({ note: '' }), context()),
      reviewProof(proof({ note: 'ok' }), context()),
      reviewProof(proof({ responses: [] }), context()),
      reviewProof(proof({ responses: [] }), context({ acceptanceCriteria: [] })),
    ];
    for (const verdict of verdicts) {
      expect(allowed.has(nextStateAfterProofReview(verdict))).toBe(true);
    }
  });
});
