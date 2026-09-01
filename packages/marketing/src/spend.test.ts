/**
 * The spend cap, table-driven, in the `router.test.ts` shape.
 *
 * The properties asserted here are the ones whose violation is invisible: a
 * `null` ceiling read as "no limit", a per-campaign check that lets N campaigns
 * blow through a project ceiling together, and a boundary that is off by one in
 * the direction of spending more than was authorised. None of the three raises,
 * none is a type error, and each one is money.
 */

import { describe, expect, it } from 'vitest';
import { checkSpendCap, type SpendCapInput } from './spend';

function input(over: Partial<SpendCapInput> = {}): SpendCapInput {
  return {
    projectBudgetCeiling: 1000,
    existingCampaignCaps: [],
    existingEscrowHolds: [],
    proposedCap: 100,
    ...over,
  };
}

describe('null is nothing authorised, never unlimited', () => {
  it('refuses when the project has no ceiling', () => {
    // The column's own comment is the specification (20260813120000:93). Reading
    // null as "no limit set" would turn every unbudgeted planning project into
    // an open account, and it would do it silently.
    const verdict = checkSpendCap(input({ projectBudgetCeiling: null }));

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.rule).toBe('no_ceiling_authorised');
  });

  it('refuses a null ceiling even when nothing is being asked for', () => {
    const verdict = checkSpendCap(input({ projectBudgetCeiling: null, proposedCap: 0 }));

    expect(verdict.allowed).toBe(false);
  });
});

describe('a ceiling of zero is a ceiling', () => {
  it('allows a zero proposal against a zero ceiling', () => {
    // Zero authorised and zero requested is consistent, and refusing it would
    // conflate "authorised nothing" with "has not decided", which is exactly the
    // distinction null carries.
    expect(checkSpendCap(input({ projectBudgetCeiling: 0, proposedCap: 0 })).allowed).toBe(true);
  });

  it('refuses any spend against a zero ceiling', () => {
    const verdict = checkSpendCap(input({ projectBudgetCeiling: 0, proposedCap: 1 }));

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.rule).toBe('exceeds_project_ceiling');
  });
});

describe('the ceiling is for the project, not for one campaign', () => {
  it('counts what is already committed to siblings', () => {
    // The defect this exists to prevent: checking the proposal alone lets three
    // campaigns of 400 each pass individually against a ceiling of 1000 and
    // commit 1200 between them. A per-item limit is not a limit.
    const verdict = checkSpendCap(
      input({ projectBudgetCeiling: 1000, existingCampaignCaps: [400, 400], proposedCap: 400 }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.rule).toBe('exceeds_project_ceiling');
  });

  it('says how much is already committed, so the refusal is actionable', () => {
    const verdict = checkSpendCap(
      input({ projectBudgetCeiling: 1000, existingCampaignCaps: [700], proposedCap: 500 }),
    );

    expect(verdict.allowed === false && verdict.reason).toContain('700');
    expect(verdict.allowed === false && verdict.reason).toContain('1000');
  });

  it('allows a proposal that exactly fills the remaining headroom', () => {
    expect(
      checkSpendCap(
        input({ projectBudgetCeiling: 1000, existingCampaignCaps: [700], proposedCap: 300 }),
      ).allowed,
    ).toBe(true);
  });
});

describe('escrow is the second committer class (ADR-0020)', () => {
  it('counts a held hold against the ceiling', () => {
    // The defect this exists to prevent: a project whose whole ceiling is in
    // escrow authorising a campaign for the whole ceiling again. Escrow does not
    // appear in the campaign list, so nothing else would have caught it.
    const verdict = checkSpendCap(
      input({ projectBudgetCeiling: 1000, existingEscrowHolds: [700], proposedCap: 500 }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.rule).toBe('exceeds_project_ceiling');
  });

  it('sums the two classes together rather than checking each', () => {
    // 400 in campaigns and 400 in escrow each leave headroom for 400 on their
    // own. Together they do not, and the two classes failing separately is
    // exactly how a per-class limit stops being a limit.
    const verdict = checkSpendCap(
      input({
        projectBudgetCeiling: 1000,
        existingCampaignCaps: [400],
        existingEscrowHolds: [400],
        proposedCap: 400,
      }),
    );

    expect(verdict.allowed).toBe(false);
  });

  it('names both classes in the refusal', () => {
    // A person reading this is looking at a campaign list that shows the 200 and
    // says nothing about the 700. A refusal quoting one number they cannot
    // account for reads as a broken check rather than as a full ceiling.
    const verdict = checkSpendCap(
      input({
        projectBudgetCeiling: 1000,
        existingCampaignCaps: [200],
        existingEscrowHolds: [700],
        proposedCap: 500,
      }),
    );

    expect(verdict.allowed === false && verdict.reason).toContain('200');
    expect(verdict.allowed === false && verdict.reason).toContain('700');
    expect(verdict.allowed === false && verdict.reason).toContain('escrow');
  });

  it('allows a proposal that exactly fills the headroom escrow left', () => {
    expect(
      checkSpendCap(
        input({
          projectBudgetCeiling: 1000,
          existingCampaignCaps: [200],
          existingEscrowHolds: [300],
          proposedCap: 500,
        }),
      ).allowed,
    ).toBe(true);
  });

  it('refuses one unit past the headroom escrow left', () => {
    // The boundary in both directions with a hold present, which is the pgTAP
    // suite's assertion restated in TypeScript. The pair is what stops the SQL
    // and this arithmetic drifting (ADR-0011's discipline, ADR-0020's four
    // places).
    expect(
      checkSpendCap(
        input({
          projectBudgetCeiling: 1000,
          existingCampaignCaps: [200],
          existingEscrowHolds: [300],
          proposedCap: 501,
        }),
      ).allowed,
    ).toBe(false);
  });

  it('lets a refunded hold contribute nothing, because the caller filtered it out', () => {
    // Stated as a test rather than as a comment because the filtering lives in
    // `readSpendInputs`, and a reader of this file would otherwise have to go
    // and check that a settled hold never arrives here.
    expect(
      checkSpendCap(
        input({ projectBudgetCeiling: 1000, existingEscrowHolds: [], proposedCap: 1000 }),
      ).allowed,
    ).toBe(true);
  });
});

describe('the boundary', () => {
  it('allows a proposal landing exactly on the ceiling', () => {
    // The ceiling is the authorised amount, not an amount to stay under.
    // Off by one here refuses what the owner actually authorised.
    expect(checkSpendCap(input({ projectBudgetCeiling: 1000, proposedCap: 1000 })).allowed).toBe(
      true,
    );
  });

  it('refuses one unit over', () => {
    expect(checkSpendCap(input({ projectBudgetCeiling: 1000, proposedCap: 1001 })).allowed).toBe(
      false,
    );
  });
});

describe('an amount nobody can reason about is refused, never defaulted', () => {
  // NaN is the case worth naming: every comparison against it is false, so a
  // version without this guard would fall through to `allowed: true` from a
  // silent arithmetic failure. That is the worst available outcome for a spend
  // check, and it is the shape of failure this repository keeps finding.
  const bad: Array<[string, Partial<SpendCapInput>]> = [
    ['NaN proposal', { proposedCap: Number.NaN }],
    ['NaN ceiling', { projectBudgetCeiling: Number.NaN }],
    ['NaN sibling', { existingCampaignCaps: [Number.NaN] }],
    ['NaN escrow hold', { existingEscrowHolds: [Number.NaN] }],
    ['infinite ceiling', { projectBudgetCeiling: Number.POSITIVE_INFINITY }],
    ['negative proposal', { proposedCap: -1 }],
    ['negative ceiling', { projectBudgetCeiling: -1 }],
  ];

  it.each(bad)('refuses %s', (_label, over) => {
    const verdict = checkSpendCap(input(over));

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.rule).toBe('invalid_amount');
  });

  it('refuses an infinite proposal rather than treating it as the largest request', () => {
    const verdict = checkSpendCap(
      input({ projectBudgetCeiling: 1000, proposedCap: Number.POSITIVE_INFINITY }),
    );

    expect(verdict.allowed === false && verdict.rule).toBe('invalid_amount');
  });
});

describe('every refusal is explainable', () => {
  it('names the rule that fired and gives a reason', () => {
    const refused = [
      checkSpendCap(input({ projectBudgetCeiling: null })),
      checkSpendCap(input({ proposedCap: Number.NaN })),
      checkSpendCap(input({ proposedCap: 5000 })),
    ];

    for (const verdict of refused) {
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed === false) {
        expect(verdict.rule).toBeTruthy();
        expect(verdict.reason.length).toBeGreaterThan(20);
        // AGENTS.md rule 22. These sentences reach a person on a money surface,
        // and nothing else here enforces it: prettier does not read prose and a
        // type checker cannot see a character.
        expect(verdict.reason).not.toContain('—');
      }
    }
  });

  it('distinguishes its three rules from each other', () => {
    const rules = [
      checkSpendCap(input({ projectBudgetCeiling: null })),
      checkSpendCap(input({ proposedCap: Number.NaN })),
      checkSpendCap(input({ proposedCap: 5000 })),
    ].map((v) => (v.allowed === false ? v.rule : 'allowed'));

    expect(new Set(rules).size).toBe(3);
  });
});
