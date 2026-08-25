import { describe, expect, it } from 'vitest';
import { decideRecovery, leaseDurationMs, MAX_RECOVERY_ATTEMPTS } from './recovery';

/**
 * The failures here are the two that a hand-rolled runner gets wrong, and ADR-0010
 * accepts owning both: a crash that retries forever, and a lease so short that a
 * healthy worker is reclaimed while it is still working.
 */

const run = { taskId: 't1', runId: 'r1', attempt: 1 };

describe('decideRecovery', () => {
  it('retries a lost worker rather than escalating it immediately', () => {
    // Unlike a fabricated citation, which the critic never retries, a lost worker
    // carries no signal about why. "The process went away" is the kind of failure
    // a second attempt plausibly fixes.
    expect(decideRecovery(run).target).toBe('ai_running');
  });

  it('escalates once the attempts are spent instead of retrying forever', () => {
    // The bound is the only thing between a transient fault and an infinite loop,
    // which is why this is a decision rather than an unconditional re-dispatch.
    const decision = decideRecovery({ ...run, attempt: MAX_RECOVERY_ATTEMPTS });

    expect(decision.target).toBe('escalated');
    expect(decision.reason).toContain('no attempts left');
  });

  it('escalates rather than failing, so a stuck task reaches a person', () => {
    // FAILED is terminal; ESCALATED is somebody's queue. Same choice the critic
    // makes at its own ceiling.
    const decision = decideRecovery({ ...run, attempt: 99 });
    expect(decision.target).toBe('escalated');
  });

  it('shares the critic ceiling so one stuck task has one explanation', () => {
    // A person reading a stuck task should not have to work out which of two
    // limits stopped it.
    expect(MAX_RECOVERY_ATTEMPTS).toBe(2);
  });

  it('carries the run and attempt through, so a recovery is traceable', () => {
    const decision = decideRecovery(run);
    expect(decision).toMatchObject({ taskId: 't1', runId: 'r1', attempt: 1 });
    expect(decision.reason).not.toBe('');
  });
});

describe('leaseDurationMs', () => {
  it('outlives a slow step by a wide margin', () => {
    // Reclaiming a healthy worker is the one failure this mechanism must not
    // introduce: two workers on one task, with the idempotency keys suddenly
    // load-bearing on their own.
    expect(leaseDurationMs(90_000)).toBeGreaterThan(90_000 * 2);
  });

  it('never goes below a floor, however small the configured budget', () => {
    // A misconfigured one-second budget must not produce a lease that expires
    // before a worker has finished starting up.
    expect(leaseDurationMs(1_000)).toBe(60_000);
  });

  it('scales with the budget, because the budget scales with the hardware', () => {
    // ADR-0009: a plan is ~71s on twelve threads and ~230s on one, so a lease
    // pinned to a constant would be generous on a laptop and wrong on a container.
    expect(leaseDurationMs(300_000)).toBeGreaterThan(leaseDurationMs(90_000));
  });
});
