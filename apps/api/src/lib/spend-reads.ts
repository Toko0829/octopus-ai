import type { SupabaseClient } from '@supabase/supabase-js';
import type { SpendCapInput } from '@octopus/marketing';

/**
 * The two reads that feed `checkSpendCap`.
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

  return {
    projectBudgetCeiling: row.budget_ceiling === null ? null : Number(row.budget_ceiling),
    existingCampaignCaps: caps,
    currency: row.currency ?? 'USD',
  };
}

/** The shape `checkSpendCap` takes, assembled from a read and the number the owner typed. */
export function spendCapInput(reads: SpendReads, proposedCap: number): SpendCapInput {
  return {
    projectBudgetCeiling: reads.projectBudgetCeiling,
    existingCampaignCaps: reads.existingCampaignCaps,
    proposedCap,
  };
}
