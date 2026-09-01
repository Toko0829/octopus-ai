/**
 * The file-url route's branch, extracted so it can be checked without a Supabase
 * client.
 *
 * The case worth pinning is the ordinary text artifact. Every artifact the
 * product has ever written has a `body` and a null `storage_path`, so this
 * branch is the common one, and asking Storage to sign a null path would either
 * throw deep inside the client or sign something. Either way an ordinary
 * artifact would surface as a 500.
 */

import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_COLUMNS,
  CampaignRow,
  decideFileUrl,
  projectCommitments,
  signedUrlExpiresAt,
  PROJECT_COLUMNS,
  ProjectRow,
  SIGNED_URL_TTL_SECONDS,
} from './projects';

/**
 * The select and the schema have to agree, and nothing else checks that.
 *
 * A PostgREST select is a string, so a column the schema requires and the query
 * omits is invisible to the type checker and fails at runtime instead. It failed
 * exactly that way: `6fcd0d6` added `budget_ceiling` and `currency` to
 * `ProjectRow`, updated the detail read and missed both reads in `listProjects`,
 * and every room holding a project answered 500 on the panel's first call from
 * that commit onward. `z.coerce.number()` turned the absent column into `NaN`,
 * which reads as a type error about a value nobody sent.
 */
describe('the projects select and ProjectRow', () => {
  it('selects every column the schema requires', () => {
    const selected = new Set(PROJECT_COLUMNS.split(',').map((c) => c.trim()));

    for (const column of Object.keys(ProjectRow.shape)) {
      expect(selected.has(column), `ProjectRow requires "${column}" and no read selects it`).toBe(
        true,
      );
    }
  });

  it('selects nothing the schema does not describe', () => {
    // The other direction, so a column dropped from the schema stops being read.
    // Cheap to keep true and it makes the constant the whole definition.
    for (const column of PROJECT_COLUMNS.split(',').map((c) => c.trim())) {
      expect(column in ProjectRow.shape, `"${column}" is selected and ProjectRow ignores it`).toBe(
        true,
      );
    }
  });
});

/**
 * The same agreement for `campaigns`, which earned its constant the moment the
 * schema grew a second coerced numeric: `cpa_ceiling` absent from a select would
 * surface as a NaN complaint about a value nobody sent, exactly the `6fcd0d6`
 * shape, on the read the optimizer's input travels through.
 */
describe('the campaigns select and CampaignRow', () => {
  it('selects every column the schema requires', () => {
    const selected = new Set(CAMPAIGN_COLUMNS.split(',').map((c) => c.trim()));

    for (const column of Object.keys(CampaignRow.shape)) {
      expect(selected.has(column), `CampaignRow requires "${column}" and no read selects it`).toBe(
        true,
      );
    }
  });

  it('selects nothing the schema does not describe', () => {
    for (const column of CAMPAIGN_COLUMNS.split(',').map((c) => c.trim())) {
      expect(
        column in CampaignRow.shape,
        `"${column}" is selected and CampaignRow ignores it`,
      ).toBe(true);
    }
  });
});

describe('decideFileUrl', () => {
  it('signs an artifact that has a file', () => {
    const decision = decideFileUrl({ storage_path: 'proj/art/brief.pdf' });

    expect(decision).toEqual({ kind: 'sign', storagePath: 'proj/art/brief.pdf' });
  });

  it('refuses a text artifact rather than trying to sign nothing', () => {
    const decision = decideFileUrl({ storage_path: null });

    expect(decision.kind).toBe('not_found');
    expect(decision.kind === 'not_found' && decision.reason).toBe('not_a_file');
  });

  it('treats a blank path as no file', () => {
    // An empty string is not a path, and it is what an over-eager writer or a
    // hand-edited row leaves behind. `createSignedUrl('')` is a request nobody
    // wants to find out the answer to.
    for (const blank of ['', '   ', '\n']) {
      expect(decideFileUrl({ storage_path: blank }).kind).toBe('not_found');
    }
  });

  it('reports an invisible or absent row as the same thing', () => {
    // RLS returns no row for both "does not exist" and "not yours", and the
    // route answers 404 to both on purpose: the API does not confirm the
    // existence of something it will not show you.
    const decision = decideFileUrl(null);

    expect(decision.kind === 'not_found' && decision.reason).toBe('invisible_or_absent');
  });

  it('distinguishes the two misses for the log, though not for the caller', () => {
    const reasons = [decideFileUrl(null), decideFileUrl({ storage_path: null })].map((d) =>
      d.kind === 'not_found' ? d.reason : 'sign',
    );

    expect(new Set(reasons).size).toBe(2);
  });
});

describe('signedUrlExpiresAt', () => {
  it('is the mint time plus the ttl, as an instant the client can compare', () => {
    const now = Date.UTC(2026, 7, 29, 12, 0, 0);

    expect(signedUrlExpiresAt(now)).toBe('2026-08-29T12:10:00.000Z');
  });

  it('keeps the window short, because the link is a bearer capability', () => {
    // Anyone holding the URL can fetch the object without presenting a token, so
    // the ttl is the exposure if one is copied out of a history or a screenshot.
    // A change to this number is a security decision and should fail here first.
    expect(SIGNED_URL_TTL_SECONDS).toBe(600);
  });
});

/**
 * The fourth of ADR-0020's four places.
 *
 * The ceiling has two committer classes since slice 5, and a panel counting only
 * campaigns would show headroom the next acceptance refuses to spend. That reads
 * as a broken check rather than as a full budget, and it is invisible: no type
 * error, no exception, just a number that is wrong in the direction of
 * encouraging spend.
 *
 * The filters are asserted individually because each one has a SQL twin that has
 * to agree with it.
 */
describe('projectCommitments', () => {
  const campaign = (state: string, budgetCap: number | null) => ({ state, budgetCap });

  it('sums non-terminal campaign caps', () => {
    const result = projectCommitments({
      campaigns: [campaign('ready', 400), campaign('live', 200)],
      heldAmounts: [],
    });

    expect(result.committedBudget).toBe(600);
    expect(result.escrowHeld).toBe(0);
  });

  it('lets a terminal campaign hold none of the ceiling', () => {
    for (const state of ['completed', 'cancelled', 'failed']) {
      expect(
        projectCommitments({ campaigns: [campaign(state, 900)], heldAmounts: [] }).committedBudget,
      ).toBe(0);
    }
  });

  it('lets a campaign with no cap contribute nothing rather than NaN', () => {
    const result = projectCommitments({
      campaigns: [campaign('ready', null), campaign('ready', 400)],
      heldAmounts: [],
    });

    expect(result.committedBudget).toBe(400);
  });

  it('counts held escrow as the second class', () => {
    const result = projectCommitments({
      campaigns: [campaign('ready', 400)],
      heldAmounts: [500],
    });

    expect(result.committedBudget).toBe(900);
    expect(result.escrowHeld).toBe(500);
  });

  it('converts a hold amount from the string PostgREST returns', () => {
    // numeric(12,2) arrives as text. Concatenating it instead of adding would
    // produce "0500", which is a money figure that is wrong in the worst way
    // available: silently, and without a type error.
    const result = projectCommitments({ campaigns: [], heldAmounts: ['500.00', '250.50'] });

    expect(result.escrowHeld).toBe(750.5);
  });

  it('drops a null amount rather than passing it into the sum', () => {
    expect(projectCommitments({ campaigns: [], heldAmounts: [null, '100'] }).escrowHeld).toBe(100);
  });

  it('breaks escrow out as well as folding it in', () => {
    // The two halves settle on different clocks, so an owner reading a total
    // they cannot reduce needs to know which half is which.
    const result = projectCommitments({
      campaigns: [campaign('ready', 100)],
      heldAmounts: ['300.00'],
    });

    expect(result).toEqual({ committedBudget: 400, escrowHeld: 300 });
  });
});
