import { describe, expect, it } from 'vitest';
import type { TaskState } from '@octopus/contracts';
import { DISPUTABLE_BY_NODE, resolveTask } from './task-resolution';

describe('resolveTask · answer', () => {
  it('completes a step that was waiting on the person', () => {
    const out = resolveTask('needs_user', 'answer', 'I set the ceiling at 2000 a month.');
    expect(out).toEqual({ ok: true, resolution: { to: 'approved', writesArtifact: true } });
  });

  it('completes a step that was escalated to an expert who cannot be brought in', () => {
    // The whole point of the change. Before it, `escalated` had one arc and it
    // led to a marketplace that does not exist.
    const out = resolveTask('escalated', 'answer', 'I checked the categories myself.');
    expect(out).toEqual({ ok: true, resolution: { to: 'approved', writesArtifact: true } });
  });

  it('lands on approved rather than done, because approved unblocks dependents', () => {
    const out = resolveTask('escalated', 'answer', 'done it');
    expect(out.ok && out.resolution.to).toBe('approved');
  });

  it('refuses an empty write-up instead of storing an artifact with no content', () => {
    // The artifacts check constraint would refuse this anyway. Catching it here
    // means the person is told what to do, not shown a database error.
    for (const text of ['', '   ', '\n\t ']) {
      const out = resolveTask('escalated', 'answer', text);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toMatch(/tell me what you did/i);
    }
  });

  it('refuses on a step that is not waiting, naming that rather than erroring', () => {
    for (const state of ['ai_running', 'approved', 'done', 'pending'] as const) {
      const out = resolveTask(state, 'answer', 'anything');
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toMatch(/not waiting on you/i);
    }
  });
});

describe('resolveTask · retry', () => {
  it('sends an escalated step back through the router', () => {
    const out = resolveTask('escalated', 'retry', '');
    expect(out).toEqual({ ok: true, resolution: { to: 'routing', writesArtifact: false } });
  });

  it('never writes an artifact, because nothing was produced', () => {
    const out = resolveTask('escalated', 'retry', 'ignored');
    expect(out.ok && out.resolution.writesArtifact).toBe(false);
  });

  it('refuses to retry a step waiting on the person', () => {
    // Re-routing a user-owned task sends it straight back to `needs_user` by rule
    // 2, which is the exact loop 20260815220000 was written to close. Offering
    // the button would reopen it from the UI.
    const out = resolveTask('needs_user', 'retry', '');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/needed an expert/i);
  });

  it('refuses to retry a step that is already running or finished', () => {
    for (const state of ['ai_running', 'approved', 'done'] as const) {
      expect(resolveTask(state, 'retry', '').ok).toBe(false);
    }
  });
});

describe('resolveTask: find_expert', () => {
  it('sends an escalated step to the marketplace', () => {
    const out = resolveTask('escalated', 'find_expert', '');
    expect(out.ok).toBe(true);
    expect(out.ok && out.resolution.to).toBe('matching');
  });

  it('writes no artifact, because nothing was produced', () => {
    const out = resolveTask('escalated', 'find_expert', 'ignored');
    expect(out.ok && out.resolution.writesArtifact).toBe(false);
  });

  it('refuses a step that is waiting on the person rather than on an expert', () => {
    // `needs_user` is a decision only the owner can make. Offering it to a
    // stranger would be asking somebody else to choose their brand direction.
    const out = resolveTask('needs_user', 'find_expert', '');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/needed an expert/i);
  });

  it('refuses from every state that is not escalated', () => {
    for (const state of [
      'pending',
      'ready',
      'routing',
      'ai_running',
      'matching',
      'offered',
      'approved',
      'done',
    ] as const) {
      expect(resolveTask(state, 'find_expert', '').ok, state).toBe(false);
    }
  });

  it('writes no em dash in its refusal, per rule 22', () => {
    const out = resolveTask('needs_user', 'find_expert', '');
    expect(out.ok === false && out.reason).not.toContain('—');
  });
});

describe('resolveTask · the owner verdict on expert work', () => {
  const NOTE = 'The hook does not land. Recut so the price reveal is in the first two seconds.';

  it('approves work that an expert handed over', () => {
    const out = resolveTask('proof_submitted', 'approve_work', '');
    expect(out).toEqual({ ok: true, resolution: { to: 'approved', writesArtifact: false } });
  });

  it('sends work back with the note as the deliverable', () => {
    const out = resolveTask('proof_submitted', 'reject_work', NOTE);
    expect(out).toEqual({ ok: true, resolution: { to: 'rejected', writesArtifact: true } });
  });

  it('refuses to send work back with no reason', () => {
    // The asymmetry is the point: approving needs no words, rejecting does. The
    // node reads that note and works from it, and their fee sits in escrow while
    // they guess without one.
    const out = resolveTask('proof_submitted', 'reject_work', '   ');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/needs to change/i);
  });

  it('refuses a verdict on a step with nothing waiting for review', () => {
    for (const state of [
      'escrow_funded',
      'in_progress',
      'approved',
      'rejected',
      'done',
      'escalated',
      'needs_user',
    ] as const) {
      expect(resolveTask(state, 'approve_work', '').ok, state).toBe(false);
      expect(resolveTask(state, 'reject_work', NOTE).ok, state).toBe(false);
    }
  });

  it('names the race when somebody is already recording a verdict', () => {
    // `in_review` is transit-only: the route walks proof_submitted through it in
    // one request. Seeing it means another click got there first, and saying so
    // is more useful than "nothing to review".
    const out = resolveTask('in_review', 'approve_work', '');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/already recording/i);
  });

  it('does not let the review verbs reach a step the other verbs own', () => {
    // The two control families must not overlap: `stuck` is "the plan cannot
    // continue without you", `reviewable` is "somebody is waiting to be paid".
    expect(resolveTask('escalated', 'approve_work', '').ok).toBe(false);
    expect(resolveTask('proof_submitted', 'answer', 'done').ok).toBe(false);
    expect(resolveTask('proof_submitted', 'find_expert', '').ok).toBe(false);
    expect(resolveTask('proof_submitted', 'retry', '').ok).toBe(false);
  });

  it('writes no em dash in its refusals, per rule 22', () => {
    const refusals = [
      resolveTask('proof_submitted', 'reject_work', ''),
      resolveTask('in_review', 'approve_work', ''),
      resolveTask('done', 'approve_work', ''),
    ];
    for (const out of refusals) {
      expect(out.ok === false && out.reason).not.toContain('\u2014');
    }
  });
});

/**
 * Slice 8: the dispute decision, pinned.
 *
 * Appended to the four blocks above rather than replacing them. `resolveTask`
 * is pure and separate from the route because rules 7 and 11 put authorisation
 * in code that can be read in one screen. These two blocks exist for the same
 * reason one level up: the sets they encode are duplicated in SQL
 * (`public.raise_dispute` holds the same lists), and ADR-0011's two-layer rule
 * only pays off while the two layers agree. When they disagree the person sees
 * a readable refusal from one and a raise from the other, which is the failure
 * these blocks are meant to catch first.
 */

const DISPUTABLE: TaskState[] = ['escrow_funded', 'in_progress', 'payout_pending'];

const NOT_DISPUTABLE_BY_OWNER: TaskState[] = [
  'proof_submitted',
  'in_review',
  'approved',
  'rejected',
  'paid',
  'done',
  'cancelled',
  'escalated',
  'needs_user',
];

describe('resolveTask, dispute', () => {
  it('allows the three states that sit before the transfer', () => {
    // All three are before the money leaves, which is what makes disputing them
    // mean anything: `payouts.transfer_id` is write-once and money that has left
    // cannot be recalled by a state change.
    for (const state of DISPUTABLE) {
      const outcome = resolveTask(state, 'dispute', 'The work never arrived');
      expect(outcome.ok, `${state} should be disputable`).toBe(true);
      if (outcome.ok) {
        expect(outcome.resolution.to).toBe('disputed');
        // The grievance is a column on `disputes`, not a deliverable on the step.
        expect(outcome.resolution.writesArtifact).toBe(false);
      }
    }
  });

  it('refuses every other state, and names the review path from proof_submitted', () => {
    for (const state of NOT_DISPUTABLE_BY_OWNER) {
      const outcome = resolveTask(state, 'dispute', 'Something is wrong');
      expect(outcome.ok, `${state} should not be disputable`).toBe(false);
    }

    // The one refusal worth wording specifically. Work handed over and not yet
    // judged is a review rather than a dispute, and the owner already has
    // `reject_work` with a required note: a cheaper, more informative act that
    // returns the step to the node with something to fix.
    const handedOver = resolveTask('proof_submitted', 'dispute', 'Not good enough');
    expect(handedOver.ok).toBe(false);
    if (!handedOver.ok) {
      expect(handedOver.reason).toContain('Send it back');
    }
  });

  it('requires a stated grievance', () => {
    // Stronger than `reject_work`'s version of this rule: the text freezes
    // somebody's fee, an operator reads it to decide, and the other party has to
    // be able to answer it.
    for (const text of ['', '   ', '\n\t ']) {
      const outcome = resolveTask('in_progress', 'dispute', text);
      expect(outcome.ok).toBe(false);
    }
  });

  it('does not disturb the actions that were already there', () => {
    // Adding a member to the action union is the kind of change that silently
    // re-routes an existing branch, so the four that existed are re-pinned here.
    expect(resolveTask('escalated', 'find_expert', '')).toMatchObject({ ok: true });
    expect(resolveTask('escalated', 'retry', '')).toMatchObject({ ok: true });
    expect(resolveTask('needs_user', 'answer', 'I did it')).toMatchObject({ ok: true });
    expect(resolveTask('proof_submitted', 'approve_work', '')).toMatchObject({ ok: true });
    // And the states that were never disputable are still not answerable either.
    expect(resolveTask('in_progress', 'answer', 'anything')).toMatchObject({ ok: false });
  });
});

describe('DISPUTABLE_BY_NODE', () => {
  it('is exactly rejected, and nothing else', () => {
    // The only act in this system a node takes against the owner, and it is one
    // state because `rejected` is the only point where a person has told them
    // no. Widening it would let a node freeze work nobody has judged yet.
    expect([...DISPUTABLE_BY_NODE]).toEqual(['rejected']);
  });

  it('shares no state with the three the owner can dispute from', () => {
    // Not a tidiness property. If the two sets overlapped, one state would admit
    // a dispute from either party and `raise_dispute` would have to decide which
    // grievance it was recording from the role argument alone, which the caller
    // supplies.
    for (const state of DISPUTABLE) {
      expect(DISPUTABLE_BY_NODE.has(state)).toBe(false);
    }
  });
});
