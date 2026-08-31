/**
 * The select strings and the row schemas have to agree in both directions.
 *
 * `projects.test.ts:34-81` established this after a column mismatch surfaced as a
 * runtime 500 the type checker could not see. It matters more here than there,
 * because two of these constants are **security** projections rather than
 * convenience ones: `CREDENTIAL_COLUMNS` omits `evidence_path` and
 * `NODE_COLUMNS` omits `suspended_reason`, and a `select *` typed while
 * debugging would return both without failing anything.
 */

import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_COLUMNS,
  CredentialRow,
  NODE_COLUMNS,
  NodeRow,
  SKILL_COLUMNS,
  SkillRow,
} from './nodes';

const cases: [string, string, Record<string, unknown>][] = [
  ['node_profiles', NODE_COLUMNS, NodeRow.shape],
  ['node_skills', SKILL_COLUMNS, SkillRow.shape],
  ['node_credentials', CREDENTIAL_COLUMNS, CredentialRow.shape],
];

describe.each(cases)('the %s select and its row schema', (_table, columns, shape) => {
  const selected = columns.split(',').map((c) => c.trim());

  it('selects every column the schema requires', () => {
    for (const column of Object.keys(shape)) {
      expect(
        selected.includes(column),
        `the schema requires "${column}" and no read selects it`,
      ).toBe(true);
    }
  });

  it('selects nothing the schema does not describe', () => {
    for (const column of selected) {
      expect(column in shape, `"${column}" is selected and the schema ignores it`).toBe(true);
    }
  });
});

describe('the projections withhold what they were written to withhold', () => {
  it('never reads a credential evidence path', () => {
    // It will hold a storage key for a stranger's identity document.
    expect(CREDENTIAL_COLUMNS).not.toContain('evidence');
    expect('evidence_path' in CredentialRow.shape).toBe(false);
  });

  it('never reads a suspension note', () => {
    // Nothing writes it, and when something does it is a moderation note rather
    // than a sentence addressed to the person.
    expect(NODE_COLUMNS).not.toContain('suspended');
  });

  it('reads no column of node_verifications anywhere', () => {
    // The subject of one is refused it by grant, not shown zero rows.
    for (const [, columns] of cases) {
      expect(columns).not.toContain('provider');
      expect(columns).not.toContain('matched_node_id');
      expect(columns).not.toContain('idempotency_key');
    }
  });
});

describe('the numeric columns are coerced rather than trusted', () => {
  it('accepts a numeric arriving as a string, which is how the driver sends it', () => {
    // The `6fcd0d6` shape: numeric(12,2) comes back as a string often enough
    // that a plain z.number() fails in production and passes in tests.
    const parsed = NodeRow.parse({
      user_id: 'u',
      kyc_status: 'verified',
      availability: 'available',
      trust_score: '0.8000',
      completed_engagements: '3',
      service_jurisdictions: ['US'],
      languages: ['en'],
      rate: '120.00',
      rate_period: 'hour',
      currency: 'USD',
    });
    expect(parsed.rate).toBe('120.00');
  });

  it('accepts null arrays, since a row can predate a default', () => {
    const parsed = NodeRow.parse({
      user_id: 'u',
      kyc_status: 'unverified',
      availability: 'paused',
      trust_score: null,
      completed_engagements: 0,
      service_jurisdictions: null,
      languages: null,
      rate: null,
      rate_period: null,
      currency: 'USD',
    });
    expect(parsed.service_jurisdictions).toBeNull();
  });
});
