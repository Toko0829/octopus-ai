import type { SupabaseClient } from '@supabase/supabase-js';
import type { SpendCapInput } from '@octopus/marketing';

/**
 * The three reads that feed `checkSpendCap`.
 *
 * The arithmetic lives in `packages/marketing` and has no database, no clock and
 * no `fetch`; this is the IO half, and the split is the one
 * `marketing-growth-engine.md` states: a spend limit nobody can read is not a
 * control, and a limit whose reasoning cannot be checked without a database is
 * not one either.
 *
 * **The filtering happens here on purpose.** `checkSpendCap` takes a plain array
 * of numbers and documents that the caller removes nulls, so the two conditions
 * that decide which siblings count are visible in the query rather than buried in
 * the arithmetic: a campaign in a terminal state holds none of the ceiling, and a
 * campaign with no cap contributes nothing rather than turning the sum into NULL.
 * `materialise_campaign` applies the same two conditions in SQL, and both are
 * asserted against the same boundary so the pair cannot drift quietly.
 */

/** Terminal campaigns hold none of the ceiling. Mirrors `private.campaign_state_is_terminal`. */
const TERMINAL_STATES = ['completed', 'cancelled', 'failed'] as const;

export interface SpendReads {
  projectBudgetCeiling: number | null;
  existingCampaignCaps: number[];
  /**
   * The second committer class
   * ([ADR-0020](../../../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)):
   * every escrow hold on this project still at `state = 'held'`.
   *
   * Filtered here rather than in the arithmetic, on this file's own rule: the
   * condition that decides which holds count is visible in the query, and
   * `accept_offer` and `materialise_campaign` apply the identical one in SQL.
   */
  escrowHeld: number[];
  currency: string;
}

/**
 * Read what the project authorised and what its live campaigns already commit.
 *
 * Throws rather than defaulting. A read failure that returned "no ceiling" would
 * refuse every campaign, and one that returned "no siblings" would authorise
 * spend against a ceiling it could not see: both are wrong answers that look like
 * decisions, so the caller is told the check could not be made.
 */
export async function readSpendInputs(
  admin: SupabaseClient,
  projectId: string,
): Promise<SpendReads> {
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('budget_ceiling, currency')
    .eq('id', projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project) throw new Error(`project ${projectId} not found`);

  const row = project as { budget_ceiling: number | string | null; currency: string | null };

  const { data: siblings, error: siblingError } = await admin
    .from('campaigns')
    .select('budget_cap, state')
    .eq('project_id', projectId)
    .not('state', 'in', `(${TERMINAL_STATES.join(',')})`);
  if (siblingError) throw siblingError;

  const caps = ((siblings ?? []) as { budget_cap: number | string | null }[])
    .map((c) => c.budget_cap)
    .filter((c): c is number | string => c !== null)
    // numeric(12,2) arrives as a string over PostgREST, so it is converted here
    // rather than compared as one. `'900' > 1000` is false in JavaScript for the
    // wrong reason, and a spend check that is right by accident is not a check.
    .map((c) => Number(c));

  // Held only, mirroring the terminal filter on campaigns directly above: a
  // refunded hold commits none of the ceiling exactly as a cancelled campaign
  // does. `accept_offer` and `materialise_campaign` both apply `state = 'held'`
  // under the project row lock, so this read and those two sums answer the same
  // question (ADR-0020's four-places contract).
  const { data: holds, error: holdError } = await admin
    .from('escrow_holds')
    .select('amount')
    .eq('project_id', projectId)
    .eq('state', 'held');
  if (holdError) throw holdError;

  const held = ((holds ?? []) as { amount: number | string | null }[])
    .map((h) => h.amount)
    .filter((a): a is number | string => a !== null)
    // numeric(12,2) arrives as a string over PostgREST, converted here for the
    // same reason the caps above are: a string comparison on money is a check
    // that is right by accident.
    .map((a) => Number(a));

  return {
    projectBudgetCeiling: row.budget_ceiling === null ? null : Number(row.budget_ceiling),
    existingCampaignCaps: caps,
    escrowHeld: held,
    currency: row.currency ?? 'USD',
  };
}

/** The shape `checkSpendCap` takes, assembled from a read and the number the owner typed. */
export function spendCapInput(reads: SpendReads, proposedCap: number): SpendCapInput {
  return {
    projectBudgetCeiling: reads.projectBudgetCeiling,
    existingCampaignCaps: reads.existingCampaignCaps,
    existingEscrowHolds: reads.escrowHeld,
    proposedCap,
  };
}
