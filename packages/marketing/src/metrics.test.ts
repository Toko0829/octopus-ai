import { describe, expect, it } from 'vitest';
import { acceptMetricsRows, decideMetricsOutcome, duePeriods, METRICS_SOURCE } from './metrics';
import { METRICS_REQUIRED_SCOPES, PUBLISH_REQUIRED_SCOPES } from './scopes';
import { defaultScopesFor } from './auth-registry';
import { FAKE_AUTH_PROVIDER } from './fake-auth-provider';
import type { AdapterResult, MetricsRow } from './adapter';

const ENTITY = { externalId: 'fake:abc123def456' };

function row(over: Partial<MetricsRow> = {}): MetricsRow {
  return {
    externalId: ENTITY.externalId,
    periodStart: '2026-08-20T00:00:00.000Z',
    periodEnd: '2026-08-21T00:00:00.000Z',
    spend: 12.5,
    impressions: 4000,
    clicks: 100,
    conversions: 5,
    revenue: 210,
    extras: {},
    ...over,
  };
}

describe('duePeriods', () => {
  it('asks for whole past UTC days, oldest first', () => {
    const periods = duePeriods({
      from: '2026-08-18T00:00:00.000Z',
      lastPeriodEnd: null,
      now: '2026-08-21T09:30:00.000Z',
      cap: 7,
    });

    expect(periods).toEqual([
      { start: '2026-08-18T00:00:00.000Z', end: '2026-08-19T00:00:00.000Z' },
      { start: '2026-08-19T00:00:00.000Z', end: '2026-08-20T00:00:00.000Z' },
      { start: '2026-08-20T00:00:00.000Z', end: '2026-08-21T00:00:00.000Z' },
    ]);
  });

  it('never asks for today, because an append-only row cannot be completed later', () => {
    const periods = duePeriods({
      from: '2026-08-21T00:00:00.000Z',
      lastPeriodEnd: null,
      now: '2026-08-21T23:59:59.000Z',
      cap: 7,
    });
    expect(periods).toEqual([]);
  });

  it('floors a mid-day start to its day, so the first window is a whole day', () => {
    const periods = duePeriods({
      from: '2026-08-19T17:45:00.000Z',
      lastPeriodEnd: null,
      now: '2026-08-21T01:00:00.000Z',
      cap: 7,
    });

    expect(periods[0]).toEqual({
      start: '2026-08-19T00:00:00.000Z',
      end: '2026-08-20T00:00:00.000Z',
    });
    expect(periods).toHaveLength(2);
  });

  it('is empty when the campaign is already measured through yesterday', () => {
    const periods = duePeriods({
      from: '2026-08-01T00:00:00.000Z',
      lastPeriodEnd: '2026-08-21T00:00:00.000Z',
      now: '2026-08-21T12:00:00.000Z',
      cap: 7,
    });
    expect(periods).toEqual([]);
  });

  it('resumes from the last measured window rather than from the entity date', () => {
    const periods = duePeriods({
      from: '2026-08-01T00:00:00.000Z',
      lastPeriodEnd: '2026-08-19T00:00:00.000Z',
      now: '2026-08-21T06:00:00.000Z',
      cap: 7,
    });

    expect(periods).toEqual([
      { start: '2026-08-19T00:00:00.000Z', end: '2026-08-20T00:00:00.000Z' },
      { start: '2026-08-20T00:00:00.000Z', end: '2026-08-21T00:00:00.000Z' },
    ]);
  });

  it('rounds an off-boundary cursor UP, because double counting spend is the unsafe direction', () => {
    // Not a window this writer can produce. It is the shape a manual row or a
    // future window size could leave behind, and rounding down would overlap it.
    const periods = duePeriods({
      from: '2026-08-01T00:00:00.000Z',
      lastPeriodEnd: '2026-08-19T12:00:00.000Z',
      now: '2026-08-21T06:00:00.000Z',
      cap: 7,
    });

    expect(periods).toEqual([
      { start: '2026-08-20T00:00:00.000Z', end: '2026-08-21T00:00:00.000Z' },
    ]);
  });

  it('caps a long backlog at the oldest windows, so the middle is never stranded', () => {
    const periods = duePeriods({
      from: '2026-07-01T00:00:00.000Z',
      lastPeriodEnd: null,
      now: '2026-08-21T00:00:00.000Z',
      cap: 7,
    });

    expect(periods).toHaveLength(7);
    expect(periods[0]!.start).toBe('2026-07-01T00:00:00.000Z');
    expect(periods[6]!.end).toBe('2026-07-08T00:00:00.000Z');
  });

  it('returns nothing for a cap that cannot mean anything', () => {
    const base = {
      from: '2026-07-01T00:00:00.000Z',
      lastPeriodEnd: null,
      now: '2026-08-21T00:00:00.000Z',
    };
    expect(duePeriods({ ...base, cap: 0 })).toEqual([]);
    expect(duePeriods({ ...base, cap: -3 })).toEqual([]);
    expect(duePeriods({ ...base, cap: Number.NaN })).toEqual([]);
  });

  it('throws on an unusable timestamp rather than reporting a campaign as up to date', () => {
    expect(() =>
      duePeriods({
        from: 'not-a-date',
        lastPeriodEnd: null,
        now: '2026-08-21T00:00:00.000Z',
        cap: 7,
      }),
    ).toThrow(/not a usable timestamp/);

    expect(() =>
      duePeriods({
        from: '2026-08-01T00:00:00.000Z',
        lastPeriodEnd: 'whenever',
        now: '2026-08-21T00:00:00.000Z',
        cap: 7,
      }),
    ).toThrow(/not a usable timestamp/);
  });
});

describe('acceptMetricsRows', () => {
  const period = { start: '2026-08-20T00:00:00.000Z', end: '2026-08-21T00:00:00.000Z' };

  it('accepts exactly one matching row', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [row()]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.row.spend).toBe(12.5);
  });

  it('accepts an equivalent ISO form, since formatting is not a disagreement', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [
      row({ periodStart: '2026-08-20T00:00:00Z', periodEnd: '2026-08-21T00:00:00Z' }),
    ]);
    expect(verdict.ok).toBe(true);
  });

  it('refuses an empty answer rather than writing a zero nobody measured', () => {
    const verdict = acceptMetricsRows(ENTITY, period, []);
    expect(verdict).toMatchObject({ ok: false, rule: 'no_row_for_entity' });
  });

  it('refuses rows that are all for somebody else', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [row({ externalId: 'fake:someone-else' })]);
    expect(verdict).toMatchObject({ ok: false, rule: 'no_row_for_entity' });
  });

  it('refuses two rows for one entity and one window rather than summing them', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [row(), row({ spend: 3 })]);
    expect(verdict).toMatchObject({ ok: false, rule: 'multiple_rows_for_entity' });
  });

  it('refuses a row measured over a different window', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [
      row({ periodStart: '2026-08-19T00:00:00.000Z', periodEnd: '2026-08-21T00:00:00.000Z' }),
    ]);
    expect(verdict).toMatchObject({ ok: false, rule: 'period_mismatch' });
  });

  it('refuses an unparseable window rather than throwing', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [row({ periodEnd: 'sometime' })]);
    expect(verdict).toMatchObject({ ok: false, rule: 'period_mismatch' });
  });

  it('ignores a sibling row while accepting the one that was asked for', () => {
    const verdict = acceptMetricsRows(ENTITY, period, [
      row({ externalId: 'fake:a-child-entity', spend: 99 }),
      row(),
    ]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.row.spend).toBe(12.5);
  });
});

describe('decideMetricsOutcome', () => {
  function fail(error: AdapterResult<MetricsRow[]> extends { ok: true } ? never : unknown) {
    return decideMetricsOutcome({ ok: false, error } as AdapterResult<MetricsRow[]>);
  }

  it('writes what the platform answered', () => {
    const decision = decideMetricsOutcome({ ok: true, value: [row()], alreadyExisted: false });
    expect(decision).toMatchObject({ action: 'write' });
    if (decision.action === 'write') expect(decision.rows).toHaveLength(1);
  });

  it('writes regardless of alreadyExisted, because a read carries no key', () => {
    const decision = decideMetricsOutcome({ ok: true, value: [row()], alreadyExisted: true });
    expect(decision.action).toBe('write');
  });

  it('waits for a reconnect on an expired connection', () => {
    expect(fail({ kind: 'auth_expired', message: 'token gone' })).toMatchObject({
      action: 'await_reconnect',
      kind: 'auth_expired',
    });
  });

  it('treats a missing entity as gone rather than retryable', () => {
    expect(fail({ kind: 'not_found', message: 'no such campaign' })).toMatchObject({
      action: 'gone',
      kind: 'not_found',
    });
  });

  it('retries a rate limit, carrying the platform-suggested delay', () => {
    expect(
      fail({ kind: 'rate_limited', message: 'slow down', retryAfterMs: 60_000 }),
    ).toMatchObject({
      action: 'retry',
      kind: 'rate_limited',
      retryAfterMs: 60_000,
      contractViolation: false,
    });
  });

  it('retries a provider error', () => {
    expect(fail({ kind: 'provider_error', message: 'boom', status: 503 })).toMatchObject({
      action: 'retry',
      kind: 'provider_error',
      status: 503,
      contractViolation: false,
    });
  });

  it('flags a write-only error kind as a contract violation without closing anything', () => {
    // There is no terminal state for a measurement, so these stay retries. The
    // flag is what makes them loud enough to fix rather than lost among the rate
    // limits.
    for (const kind of ['invalid_spec', 'policy_rejected'] as const) {
      const decision = fail({ kind, message: 'not a read error' });
      expect(decision).toMatchObject({ action: 'retry', kind, contractViolation: true });
    }
  });

  it('never closes a campaign, whatever the platform said', () => {
    const kinds = [
      { kind: 'auth_expired', message: 'x' },
      { kind: 'not_found', message: 'x' },
      { kind: 'rate_limited', message: 'x' },
      { kind: 'provider_error', message: 'x' },
      { kind: 'invalid_spec', message: 'x' },
      { kind: 'policy_rejected', message: 'x' },
    ];
    for (const error of kinds) {
      const action = fail(error).action;
      expect(['retry', 'await_reconnect', 'gone']).toContain(action);
    }
  });

  it('states a next step in every refusal, without an em dash', () => {
    const errors = [
      { kind: 'auth_expired', message: 'x' },
      { kind: 'not_found', message: 'x' },
      { kind: 'rate_limited', message: 'x' },
      { kind: 'provider_error', message: 'x' },
      { kind: 'invalid_spec', message: 'x' },
      { kind: 'policy_rejected', message: 'x' },
    ];
    for (const error of errors) {
      const decision = fail(error);
      if (decision.action === 'write') throw new Error('unreachable');
      expect(decision.reason.length).toBeGreaterThan(20);
      expect(decision.reason).not.toContain('—');
    }
  });
});

describe('the source this sweep writes', () => {
  it('is the value the migration documents', () => {
    expect(METRICS_SOURCE).toBe('pull_metrics');
  });
});

describe('what a call needs is something a connection can be granted', () => {
  // A requirement the only consent screen in the product cannot grant would be a
  // permanent block that no user action could clear, and it would look exactly
  // like a broken integration.
  it('every required scope is one the fake provider asks for', () => {
    const asked = new Set(defaultScopesFor(FAKE_AUTH_PROVIDER));
    for (const scope of METRICS_REQUIRED_SCOPES) expect(asked.has(scope)).toBe(true);
    for (const scope of PUBLISH_REQUIRED_SCOPES) expect(asked.has(scope)).toBe(true);
  });

  it('reading does not require the scope that publishing requires', () => {
    // A person may untick `ads:write` on the consent screen. That connection can
    // no longer publish and can still be measured, and a campaign already live is
    // the worst possible moment for the numbers to stop.
    expect(METRICS_REQUIRED_SCOPES).not.toContain('ads:write');
  });
});
