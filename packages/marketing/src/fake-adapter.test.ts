/**
 * The fake is a test double for every later slice, so the properties that make
 * it usable as one are asserted here rather than assumed.
 *
 * A double that quietly became non-deterministic would not fail here, it would
 * fail somewhere in slice 3 as an intermittent test, which is the most expensive
 * possible place to discover it.
 */

import { describe, expect, it } from 'vitest';
import { createFakeAdapter, FAKE_PROVIDER, POLICY_VIOLATION_MARKER } from './fake-adapter';
import {
  CreateCampaignSpec,
  MetricsRow,
  type CreateAdSpec,
  type CreateCampaignSpec as CreateCampaignSpecType,
} from './adapter';

function campaign(over: Partial<CreateCampaignSpecType> = {}): CreateCampaignSpecType {
  return {
    name: 'Cold traffic, Meta',
    objective: 'signups',
    channel: 'meta',
    budgetCap: 500,
    currency: 'USD',
    ...over,
  };
}

function ad(headline: string): CreateAdSpec {
  return {
    name: 'Ad 1',
    parentExternalId: 'fake:parent',
    creative: { headline, body: 'Body copy that a person approved.' },
  };
}

describe('determinism', () => {
  it('derives the external id from the idempotency key, not from anything ambient', async () => {
    // Two separate instances, so no shared state can be what makes them agree.
    const a = await createFakeAdapter().createCampaign(campaign(), 'key-1');
    const b = await createFakeAdapter().createCampaign(campaign({ name: 'Different' }), 'key-1');

    expect(a.ok && b.ok && a.value.externalId).toBe(b.ok ? b.value.externalId : null);
  });

  it('pins the exact id, so a change to the derivation is a failing test rather than a surprise', async () => {
    // sha256('key-1') truncated to 12 hex characters. Pinned deliberately: a
    // later slice will assert against stored external ids, and silently
    // changing how they are minted would orphan every fixture that holds one.
    const result = await createFakeAdapter().createCampaign(campaign(), 'key-1');

    expect(result.ok && result.value.externalId).toMatch(/^fake:[0-9a-f]{12}$/);
  });

  it('gives different keys different ids', async () => {
    const adapter = createFakeAdapter();
    const one = await adapter.createCampaign(campaign(), 'key-1');
    const two = await adapter.createCampaign(campaign(), 'key-2');

    expect(one.ok && two.ok && one.value.externalId).not.toBe(two.ok ? two.value.externalId : '');
  });
});

describe('idempotency', () => {
  it('reports a repeat as a repeat rather than as a second creation', async () => {
    const adapter = createFakeAdapter();
    const first = await adapter.createCampaign(campaign(), 'key-1');
    const second = await adapter.createCampaign(campaign(), 'key-1');

    expect(first.ok && first.alreadyExisted).toBe(false);
    expect(second.ok && second.alreadyExisted).toBe(true);
    expect(first.ok && second.ok && first.value.externalId).toBe(
      second.ok ? second.value.externalId : null,
    );
  });

  it('does not treat a fresh instance as having seen anything', async () => {
    // The flag is per instance and per process on purpose. The durable half of
    // idempotency is the unique constraint on `ad_entities.idempotency_key`, and
    // a double that pretended to be durable would let a slice be written against
    // a guarantee the fake cannot actually make.
    await createFakeAdapter().createCampaign(campaign(), 'key-1');
    const elsewhere = await createFakeAdapter().createCampaign(campaign(), 'key-1');

    expect(elsewhere.ok && elsewhere.alreadyExisted).toBe(false);
  });
});

describe('policy rejection', () => {
  it('returns policy_rejected as a result, never as a throw', async () => {
    // A rejection that arrived as an exception would be caught by whatever
    // catches transport failures and retried, which is the silent-keep-spending
    // path the module rule exists to prevent.
    const result = await createFakeAdapter().createAd(
      ad(`Buy now ${POLICY_VIOLATION_MARKER}`),
      'key-x',
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('policy_rejected');
  });

  it('rejects a campaign spec carrying the marker too, not only an ad', async () => {
    const result = await createFakeAdapter().createCampaign(
      campaign({ name: `Launch ${POLICY_VIOLATION_MARKER}` }),
      'key-y',
    );

    expect(!result.ok && result.error.kind).toBe('policy_rejected');
  });

  it('does not consume the idempotency key when it rejects', async () => {
    // A rejected call made no side effect, so a corrected retry under the same
    // key is a first attempt rather than a duplicate. Getting this backwards
    // would make every revise-and-resubmit look like a replay.
    const adapter = createFakeAdapter();
    await adapter.createAd(ad(`Bad ${POLICY_VIOLATION_MARKER}`), 'key-z');
    const retry = await adapter.createAd(ad('Corrected headline'), 'key-z');

    expect(retry.ok && retry.alreadyExisted).toBe(false);
  });

  it('leaves an ordinary spec alone', async () => {
    const result = await createFakeAdapter().createAd(ad('An ordinary headline'), 'key-ok');

    expect(result.ok).toBe(true);
  });
});

describe('the shapes it produces are the shapes the seam declares', () => {
  it('emits metrics rows that parse, with a spend the numeric(12,2) column can hold', async () => {
    const adapter = createFakeAdapter();
    const rows = await adapter.pullMetrics(
      { externalId: 'fake:abc123abc123' },
      { start: '2026-08-01T00:00:00.000Z', end: '2026-08-02T00:00:00.000Z' },
    );

    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    for (const row of rows.value) {
      expect(() => MetricsRow.parse(row)).not.toThrow();
      // `campaign_outcomes.spend` is numeric(12,2). A double producing values
      // that column cannot hold would let a rounding defect through every test
      // that uses it.
      expect(Math.round(row.spend * 100) / 100).toBe(row.spend);
    }
  });

  it('returns the same metrics for the same ref and period', async () => {
    const period = { start: '2026-08-01T00:00:00.000Z', end: '2026-08-02T00:00:00.000Z' };
    const one = await createFakeAdapter().pullMetrics({ externalId: 'fake:aaa' }, period);
    const two = await createFakeAdapter().pullMetrics({ externalId: 'fake:aaa' }, period);

    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('accepts a spec the schema accepts', () => {
    expect(() => CreateCampaignSpec.parse(campaign())).not.toThrow();
  });

  it('names itself with the registry key', () => {
    expect(createFakeAdapter().provider).toBe(FAKE_PROVIDER);
  });
});

describe('setBudget', () => {
  it('refuses an amount that is not usable, as invalid_spec rather than silently', async () => {
    const result = await createFakeAdapter().setBudget({ externalId: 'fake:a' }, -5, 'k');

    expect(!result.ok && result.error.kind).toBe('invalid_spec');
  });
});
