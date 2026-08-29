/**
 * The two reads a spend decision is made from.
 *
 * The property under test is that **the filtering happens before the
 * arithmetic**, and matches what `materialise_campaign` does in SQL. Two
 * conditions decide which siblings count: a terminal campaign holds none of the
 * ceiling, and one with no cap contributes nothing rather than turning the sum
 * into NULL. Both are asserted here and in `supabase/tests/materialise_campaign.sql`
 * so the pair cannot drift apart quietly.
 *
 * The third property is duller and has bitten this codebase before: PostgREST
 * returns `numeric(12,2)` as a **string**. `'900' > 1000` is false in JavaScript
 * for the wrong reason, so a check that never converted would be right by
 * accident and wrong the moment the numbers changed.
 */

import { describe, expect, it } from 'vitest';
import { checkSpendCap } from '@octopus/marketing';
import { readSpendInputs, spendCapInput } from './spend-reads';

type Row = Record<string, unknown> | null;

function stub(project: Row, campaigns: Record<string, unknown>[]) {
  const seen: string[] = [];
  const client = {
    from(table: string) {
      seen.push(table);
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        maybeSingle: async () => ({ data: project, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: campaigns, error: null }),
      };
      return builder;
    },
  };
  return { client: client as never, seen };
}

describe('reading what the project authorised', () => {
  it('converts the ceiling from the string PostgREST returns', async () => {
    const { client } = stub({ budget_ceiling: '1000.00', currency: 'USD' }, []);
    const reads = await readSpendInputs(client, 'p1');
    expect(reads.projectBudgetCeiling).toBe(1000);
    expect(typeof reads.projectBudgetCeiling).toBe('number');
  });

  it('keeps a null ceiling null, because null is nothing authorised', async () => {
    // Coercing this to 0 would be a different and much worse answer: 0 is a
    // ceiling that refuses spend, null is the absence of an authorisation, and
    // only one of them should tell a person to go and set a budget.
    const { client } = stub({ budget_ceiling: null, currency: 'USD' }, []);
    const reads = await readSpendInputs(client, 'p1');
    expect(reads.projectBudgetCeiling).toBeNull();
  });

  it('converts sibling caps to numbers', async () => {
    const { client } = stub({ budget_ceiling: '1000.00', currency: 'USD' }, [
      { budget_cap: '400.00', state: 'ready' },
    ]);
    const reads = await readSpendInputs(client, 'p1');
    expect(reads.existingCampaignCaps).toEqual([400]);
  });

  it('drops a sibling with no cap rather than passing null into the sum', async () => {
    const { client } = stub({ budget_ceiling: '1000.00', currency: 'USD' }, [
      { budget_cap: null, state: 'ready' },
      { budget_cap: '400.00', state: 'live' },
    ]);
    const reads = await readSpendInputs(client, 'p1');
    expect(reads.existingCampaignCaps).toEqual([400]);
  });

  it('reads the project currency, since a ceiling without one means nothing', async () => {
    const { client } = stub({ budget_ceiling: '1000.00', currency: 'EUR' }, []);
    expect((await readSpendInputs(client, 'p1')).currency).toBe('EUR');
  });

  it('throws when the project cannot be read, rather than reporting no ceiling', async () => {
    // A read failure that returned "no ceiling" would refuse every campaign and
    // look exactly like a deliberate decision.
    const { client } = stub(null, []);
    await expect(readSpendInputs(client, 'p1')).rejects.toThrow();
  });
});

describe('the composed verdict', () => {
  it('refuses when the sum passes the ceiling, not when one campaign does', async () => {
    // The case the composition exists for: three campaigns of 400 each pass
    // individually against a ceiling of 1000 and commit 1200 between them.
    const { client } = stub({ budget_ceiling: '1000.00', currency: 'USD' }, [
      { budget_cap: '400.00', state: 'ready' },
      { budget_cap: '400.00', state: 'live' },
    ]);
    const reads = await readSpendInputs(client, 'p1');
    const verdict = checkSpendCap(spendCapInput(reads, 400));
    expect(verdict.allowed).toBe(false);
  });

  it('allows a campaign that lands exactly on the ceiling', async () => {
    // The same boundary `materialise_campaign` asserts in SQL. Both sides use
    // `>` so that landing on the ceiling is authorised.
    const { client } = stub({ budget_ceiling: '1000.00', currency: 'USD' }, [
      { budget_cap: '600.00', state: 'ready' },
    ]);
    const reads = await readSpendInputs(client, 'p1');
    expect(checkSpendCap(spendCapInput(reads, 400)).allowed).toBe(true);
  });
});
