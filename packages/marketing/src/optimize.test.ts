import { describe, expect, it } from 'vitest';
import {
  decideCpaBreach,
  decidePauseOutcome,
  pauseIdempotencyKey,
  resumeIdempotencyKey,
} from './optimize';
import { OPTIMIZE_REQUIRED_SCOPES } from './scopes';
import { defaultScopesFor } from './auth-registry';
import { FAKE_AUTH_PROVIDER } from './fake-auth-provider';
import { createFakeAdapter } from './fake-adapter';
import type { AdapterEntityRef, AdapterResult } from './adapter';

const CAMPAIGN = '3b6a3e51-1d54-49a5-a2a0-1c3a0a4a90aa';

// The fake adapter's pinned two-day rollup, as the metrics sweep suite measures
// it: 198.05/11 and 34.85/2. Used here so the breach fixtures are the numbers a
// live fake campaign actually produces rather than invented round ones.
const FAKE_TWO_DAY = { spendToDate: 232.9, conversionsToDate: 13, periodsMeasured: 2 };

describe('decideCpaBreach', () => {
  it('abstains when no whole day has been measured, because unmeasured is not zero', () => {
    const verdict = decideCpaBreach({
      spendToDate: null,
      conversionsToDate: null,
      periodsMeasured: 0,
      cpaCeiling: 10,
    });
    expect(verdict.breach).toBe(false);
    expect(verdict.rule).toBe('nothing_measured');
  });

  it('abstains when spend was measured and conversions never were: no invented zero', () => {
    // Judging a null as zero conversions would manufacture the worst possible
    // number for the campaign out of an absence, which is the exact confusion
    // the outcomes table exists to prevent.
    const verdict = decideCpaBreach({
      spendToDate: 500,
      conversionsToDate: null,
      periodsMeasured: 3,
      cpaCeiling: 1,
    });
    expect(verdict.breach).toBe(false);
    expect(verdict.rule).toBe('conversions_unmeasured');
  });

  it('breaches on measured zero conversions once spend passes one allowance', () => {
    // conversions = 0 needs no special case: the allowance is ceiling * 1.
    const verdict = decideCpaBreach({
      spendToDate: 25,
      conversionsToDate: 0,
      periodsMeasured: 1,
      cpaCeiling: 20,
    });
    expect(verdict.breach).toBe(true);
    if (verdict.breach) expect(verdict.allowance).toBe(20);
  });

  it('does not breach on measured zero conversions still inside the first allowance', () => {
    const verdict = decideCpaBreach({
      spendToDate: 15,
      conversionsToDate: 0,
      periodsMeasured: 1,
      cpaCeiling: 20,
    });
    expect(verdict).toMatchObject({ breach: false, rule: 'within_ceiling' });
  });

  it('spending exactly the allowance is not a breach: the ceiling is authorised, not forbidden', () => {
    const verdict = decideCpaBreach({
      spendToDate: 30,
      conversionsToDate: 2,
      periodsMeasured: 1,
      cpaCeiling: 10,
    });
    expect(verdict).toMatchObject({ breach: false, rule: 'within_ceiling' });
  });

  it('holds the fake campaign within a ceiling of 20 and breaches it at 15', () => {
    const within = decideCpaBreach({ ...FAKE_TWO_DAY, cpaCeiling: 20 });
    expect(within).toMatchObject({ breach: false, rule: 'within_ceiling' });

    const breached = decideCpaBreach({ ...FAKE_TWO_DAY, cpaCeiling: 15 });
    expect(breached.breach).toBe(true);
    if (breached.breach) {
      // The arithmetic is carried so the event payload and the room message can
      // state it without recomputing.
      expect(breached.spend).toBe(232.9);
      expect(breached.conversions).toBe(13);
      expect(breached.cpaCeiling).toBe(15);
      expect(breached.allowance).toBe(210);
    }
  });

  it('refuses to judge against a garbage ceiling, loudly', () => {
    for (const cpaCeiling of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const verdict = decideCpaBreach({ ...FAKE_TWO_DAY, cpaCeiling });
      expect(verdict.breach).toBe(false);
      expect(verdict.rule).toBe('unusable_input');
    }
  });

  it('refuses to judge a garbage rollup, loudly', () => {
    // The NaN twin of the NULL defects this repository keeps recording: a wrong
    // answer wearing the shape of a right one must abstain, not pause.
    const verdict = decideCpaBreach({
      spendToDate: Number.NaN,
      conversionsToDate: 3,
      periodsMeasured: 1,
      cpaCeiling: 10,
    });
    expect(verdict.breach).toBe(false);
    expect(verdict.rule).toBe('unusable_input');
  });
});

describe('the pause and resume keys', () => {
  it('are exactly the documented strings, epoch included', () => {
    expect(pauseIdempotencyKey(CAMPAIGN, 0)).toBe(`pause:${CAMPAIGN}:cpa:0`);
    expect(resumeIdempotencyKey(CAMPAIGN, 1)).toBe(`resume:${CAMPAIGN}:1`);
  });

  it('are deterministic, and distinct across epochs', () => {
    // Same epoch, same key: the crash-resume path must replay. New epoch, new
    // key: a second breach after a resume must be its own side effect, or a
    // record-replay platform answers it with the first pause's recorded result
    // and the money keeps moving.
    expect(pauseIdempotencyKey(CAMPAIGN, 0)).toBe(pauseIdempotencyKey(CAMPAIGN, 0));
    expect(pauseIdempotencyKey(CAMPAIGN, 1)).not.toBe(pauseIdempotencyKey(CAMPAIGN, 0));
    expect(resumeIdempotencyKey(CAMPAIGN, 2)).not.toBe(resumeIdempotencyKey(CAMPAIGN, 1));
  });

  it('throws on an epoch that is not a non-negative integer, because that is our defect', () => {
    for (const epoch of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => pauseIdempotencyKey(CAMPAIGN, epoch)).toThrow(/non-negative integer/);
      expect(() => resumeIdempotencyKey(CAMPAIGN, epoch)).toThrow(/non-negative integer/);
    }
  });
});

describe('decidePauseOutcome', () => {
  const REF: AdapterEntityRef = { externalId: 'fake:abc123def456' };

  it('confirms a success and carries alreadyExisted so a replay reads as a replay', () => {
    const fresh = decidePauseOutcome({ ok: true, value: REF, alreadyExisted: false });
    expect(fresh).toMatchObject({
      action: 'confirm',
      externalId: REF.externalId,
      alreadyExisted: false,
    });

    const replay = decidePauseOutcome({ ok: true, value: REF, alreadyExisted: true });
    expect(replay).toMatchObject({ action: 'confirm', alreadyExisted: true });
  });

  it('waits for the owner on auth_expired rather than retrying what we cannot fix', () => {
    const decision = decidePauseOutcome({
      ok: false,
      error: { kind: 'auth_expired', message: 'token expired' },
    });
    expect(decision.action).toBe('await_reconnect');
  });

  it('reports a not_found as gone and never invents a confirmation', () => {
    const decision = decidePauseOutcome({
      ok: false,
      error: { kind: 'not_found', message: 'no such campaign' },
    });
    expect(decision.action).toBe('gone');
  });

  it('retries rate limits and provider errors quietly, carrying what the platform said', () => {
    const limited = decidePauseOutcome({
      ok: false,
      error: { kind: 'rate_limited', message: 'slow down', retryAfterMs: 60_000 },
    });
    expect(limited).toMatchObject({
      action: 'retry',
      kind: 'rate_limited',
      retryAfterMs: 60_000,
      contractViolation: false,
    });

    const failed = decidePauseOutcome({
      ok: false,
      error: { kind: 'provider_error', message: 'boom', status: 502 },
    });
    expect(failed).toMatchObject({
      action: 'retry',
      kind: 'provider_error',
      status: 502,
      contractViolation: false,
    });
  });

  it('flags mutation-vocabulary refusals as contract violations, because a pause sends no spec', () => {
    for (const kind of ['invalid_spec', 'policy_rejected'] as const) {
      const decision = decidePauseOutcome({
        ok: false,
        error: { kind, message: 'nonsense answer' },
      });
      expect(decision).toMatchObject({ action: 'retry', kind, contractViolation: true });
    }
  });

  it('never produces an action that closes the campaign', () => {
    // `live -> failed` is not a legal arc and a campaign we could not pause is
    // still spending; the union has no close and this pins that it stays gone.
    const results: AdapterResult<AdapterEntityRef>[] = [
      { ok: true, value: REF, alreadyExisted: false },
      { ok: false, error: { kind: 'auth_expired', message: 'x' } },
      { ok: false, error: { kind: 'not_found', message: 'x' } },
      { ok: false, error: { kind: 'rate_limited', message: 'x' } },
      { ok: false, error: { kind: 'provider_error', message: 'x' } },
      { ok: false, error: { kind: 'invalid_spec', message: 'x' } },
      { ok: false, error: { kind: 'policy_rejected', message: 'x' } },
    ];
    for (const result of results) {
      const action = decidePauseOutcome(result).action;
      expect(['confirm', 'retry', 'await_reconnect', 'gone']).toContain(action);
    }
  });
});

describe('the fake adapter can stop and start spend', () => {
  const REF: AdapterEntityRef = { externalId: 'fake:abc123def456' };

  it('pause and resume echo the ref and report a repeated key as a replay', async () => {
    const adapter = createFakeAdapter();

    const paused = await adapter.pause(REF, pauseIdempotencyKey(CAMPAIGN, 0));
    expect(paused).toEqual({ ok: true, value: REF, alreadyExisted: false });

    const replayed = await adapter.pause(REF, pauseIdempotencyKey(CAMPAIGN, 0));
    expect(replayed).toEqual({ ok: true, value: REF, alreadyExisted: true });

    const resumed = await adapter.resume(REF, resumeIdempotencyKey(CAMPAIGN, 1));
    expect(resumed).toEqual({ ok: true, value: REF, alreadyExisted: false });

    // The second breach's pause carries a new epoch, so it is a new act at the
    // platform rather than a replay of the first pause.
    const secondPause = await adapter.pause(REF, pauseIdempotencyKey(CAMPAIGN, 1));
    expect(secondPause).toEqual({ ok: true, value: REF, alreadyExisted: false });
  });
});

describe('what pausing needs is something a connection can be granted', () => {
  it('every required scope is one the fake provider asks for', () => {
    const asked = new Set(defaultScopesFor(FAKE_AUTH_PROVIDER));
    for (const scope of OPTIMIZE_REQUIRED_SCOPES) expect(asked.has(scope)).toBe(true);
  });

  it('pausing requires the write scope, because stopping money mutates delivery', () => {
    expect(OPTIMIZE_REQUIRED_SCOPES).toContain('ads:write');
  });
});
