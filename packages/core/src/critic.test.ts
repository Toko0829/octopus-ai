/**
 * The checker, and specifically the difference between output that is merely
 * missing and output that claims a source it never had.
 */

import { describe, expect, it } from 'vitest';
import {
  nextStateAfterReview,
  review,
  type ReviewContext,
  type ReviewableArtifact,
} from './critic';

const SOURCES = ['Positioning and ICP for a solo founder', 'Designing the offer'];

function artifact(over: Partial<ReviewableArtifact> = {}): ReviewableArtifact {
  return {
    body: 'Narrow the positioning to founders who already tried the manual approach and hit a wall.',
    citations: [SOURCES[0] as string],
    ...over,
  };
}

function context(over: Partial<ReviewContext> = {}): ReviewContext {
  return { availableSources: SOURCES, expectsCitations: true, ...over };
}

describe('the floor conditions', () => {
  it('passes a grounded, substantive draft', () => {
    expect(review(artifact(), context()).passed).toBe(true);
  });

  it('fails output that is empty', () => {
    const verdict = review(artifact({ body: '   ' }), context());

    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual(['empty_output']);
  });

  it('reports one cause for an empty artifact rather than four', () => {
    // Empty output fails every other check too. Listing them all buries the one
    // that actually explains the problem.
    const verdict = review(artifact({ body: '', citations: ['Invented'] }), context());

    expect(verdict.failures).toHaveLength(1);
    expect(verdict.reasons).toHaveLength(1);
  });

  it('fails a stub', () => {
    expect(review(artifact({ body: 'OK.' }), context()).failures).toContain('too_short');
  });
});

describe('grounding survives execution', () => {
  it('fails a grounded step whose output cites nothing', () => {
    // Rule 10 applied to the work. The plan card would still show this step as
    // cited while the thing it produced rests on nothing.
    const verdict = review(artifact({ citations: [] }), context({ expectsCitations: true }));

    expect(verdict.failures).toContain('lost_grounding');
  });

  it('does not demand citations from a step that never had them', () => {
    const verdict = review(artifact({ citations: [] }), context({ expectsCitations: false }));

    expect(verdict.passed).toBe(true);
  });

  it('fails a citation the maker was never given', () => {
    const verdict = review(artifact({ citations: ['A source nobody supplied'] }), context());

    expect(verdict.failures).toContain('fabricated_citation');
    expect(verdict.reasons.join(' ')).toContain('A source nobody supplied');
  });

  it('separates a missing citation from an invented one', () => {
    // Different severity, and the routing below depends on the difference:
    // unverified output can be retried, invented verification cannot.
    const missing = review(artifact({ citations: [] }), context());
    const invented = review(artifact({ citations: ['Nope'] }), context());

    expect(missing.failures).toContain('lost_grounding');
    expect(missing.failures).not.toContain('fabricated_citation');
    expect(invented.failures).toContain('fabricated_citation');
  });
});

describe('what happens after a verdict', () => {
  it('approves on a pass', () => {
    expect(nextStateAfterReview(review(artifact(), context()), 1)).toBe('approved');
  });

  it('retries a recoverable failure once', () => {
    const verdict = review(artifact({ body: 'OK.' }), context());

    expect(nextStateAfterReview(verdict, 1)).toBe('ai_running');
  });

  it('stops retrying at the attempt limit', () => {
    const verdict = review(artifact({ body: 'OK.' }), context());

    expect(nextStateAfterReview(verdict, 2)).toBe('escalated');
  });

  it('never retries an invented citation', () => {
    // Asking the same maker again is how you get a second invented source.
    const verdict = review(artifact({ citations: ['Nope'] }), context());

    expect(nextStateAfterReview(verdict, 1)).toBe('escalated');
  });

  it('only ever returns a state the machine allows out of ai_self_check', () => {
    const allowed = new Set(['approved', 'ai_running', 'escalated']);
    const verdicts = [
      review(artifact(), context()),
      review(artifact({ body: '' }), context()),
      review(artifact({ body: 'OK.' }), context()),
      review(artifact({ citations: [] }), context()),
      review(artifact({ citations: ['Nope'] }), context()),
    ];

    for (const verdict of verdicts) {
      for (const attempt of [1, 2, 3]) {
        expect(allowed.has(nextStateAfterReview(verdict, attempt))).toBe(true);
      }
    }
  });
});
