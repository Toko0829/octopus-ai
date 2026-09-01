import { describe, expect, it } from 'vitest';
import { resolveTask } from './task-resolution';

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
