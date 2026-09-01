/**
 * The spend cap, as arithmetic somebody can check.
 *
 * Rule 7 puts authorisation and spend limits in tool code rather than in
 * prompts: a jailbroken prompt must still be unable to overspend. That rule is
 * only worth anything if the arithmetic it names is readable, and the way to
 * make it readable is to keep it out of the code that talks to Postgres and to a
 * platform at the same time. So the decision lives here, pure, and the two reads
 * that feed it (`projects.budget_ceiling`, the caps of a project's live sibling
 * campaigns) are IO in `apps/api`.
 *
 * Same shape as `routeTask` in `@octopus/core`, and for the same reason: the
 * verdict carries **which rule fired** and one sentence of why, because "why was
 * this refused" is the first question anyone asks and re-deriving it later means
 * guessing at the numbers the caller had at the time.
 */

/**
 * Everything the decision depends on. Nothing here is read from a database by
 * this module; the caller does that and passes the values in.
 */
export interface SpendCapInput {
  /**
   * `projects.budget_ceiling`. **`null` means nothing authorised, never
   * unlimited.** That is not this function's interpretation, it is the column's
   * own documented meaning (`20260813120000`, line 93), and it is the single
   * most consequential line in this file: reading `null` as "no limit set" would
   * turn every unbudgeted planning project into an open account.
   */
  projectBudgetCeiling: number | null;
  /**
   * `budget_cap` of the project's non-terminal sibling campaigns, in the same
   * currency. Terminal campaigns are excluded by the caller, because money
   * authorised for a cancelled campaign is not money still committed.
   *
   * A sibling with a `null` cap contributes nothing and the caller filters it
   * out, on the same reading as above: nothing authorised is nothing spent.
   */
  existingCampaignCaps: number[];
  /**
   * The `amount` of every escrow hold on this project still at `state = 'held'`,
   * in the same currency.
   *
   * **The second committer class, and it is required rather than optional**
   * ([ADR-0020](../../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)).
   * An optional field defaulting to `[]` would let a caller who had never heard
   * of escrow keep passing a ceiling check that no longer means what it says,
   * silently, which is the failure mode this whole function exists to refuse. A
   * required field makes every call site a place somebody had to decide.
   *
   * Since `20260904121000` a node accepting an offer holds part of the project's
   * authorised budget against that step. That is authorised spend against the
   * same number `budget_ceiling` guards, so counting only campaigns would let a
   * project with its entire ceiling in escrow authorise a campaign for the whole
   * ceiling again.
   *
   * A released or refunded hold commits nothing and is excluded by the caller,
   * on the same reading that excludes a terminal campaign: money no longer
   * committed is not money still committed.
   */
  existingEscrowHolds: number[];
  /** The cap being asked for. */
  proposedCap: number;
}

export type SpendCapRule = 'no_ceiling_authorised' | 'invalid_amount' | 'exceeds_project_ceiling';

export type SpendCapVerdict =
  { allowed: true } | { allowed: false; rule: SpendCapRule; reason: string };

/**
 * Decide, in priority order. The order is the safety property: the first two
 * rules refuse inputs that cannot be reasoned about at all, and only then does
 * the arithmetic run.
 *
 * The comparison is `<=`: a proposal that lands exactly on the ceiling is
 * allowed, because the ceiling is the authorised amount rather than an amount to
 * stay under. Asserted at the boundary in the tests, since off-by-one here is
 * either refusing what the owner authorised or spending a unit more than they
 * did, and neither is a rounding detail when it is money.
 */
export function checkSpendCap(input: SpendCapInput): SpendCapVerdict {
  const { projectBudgetCeiling, existingCampaignCaps, existingEscrowHolds, proposedCap } = input;

  // (1) No ceiling means nothing has been authorised. Refusing here is what
  // makes the column's stance real rather than documented.
  if (projectBudgetCeiling === null) {
    return {
      allowed: false,
      rule: 'no_ceiling_authorised',
      reason: 'This project has no authorised budget yet, so no campaign spend can be approved.',
    };
  }

  // (2) A number nobody can reason about is refused rather than defaulted, the
  // same stance the whole seam takes on an unrecognised risk tier or an unknown
  // provider. NaN in particular would make every comparison below false and
  // return `allowed: true` from a silent arithmetic failure, which is the worst
  // available outcome for a spend check.
  const amounts = [
    projectBudgetCeiling,
    proposedCap,
    ...existingCampaignCaps,
    ...existingEscrowHolds,
  ];
  if (amounts.some((n) => !Number.isFinite(n)) || proposedCap < 0 || projectBudgetCeiling < 0) {
    return {
      allowed: false,
      rule: 'invalid_amount',
      reason: 'One of the amounts is not a usable number, so the cap cannot be checked.',
    };
  }

  const campaigns = existingCampaignCaps.reduce((sum, n) => sum + n, 0);
  const escrow = existingEscrowHolds.reduce((sum, n) => sum + n, 0);
  const committed = campaigns + escrow;
  const total = committed + proposedCap;

  // (3) The ceiling is for the project, not for one campaign and not for one
  // engagement. Checking the proposal alone would let N campaigns of
  // ceiling-minus-one each pass individually and blow through it together, which
  // is exactly how a per-item limit fails. Since ADR-0020 the same is true
  // across the two classes: a campaign and an acceptance that each fit
  // separately can exceed the ceiling together.
  if (total > projectBudgetCeiling) {
    return {
      allowed: false,
      rule: 'exceeds_project_ceiling',
      // **Both classes are named**, because escrow does not appear in the
      // campaign list a person is looking at while reading this. A refusal
      // quoting one number they cannot account for reads as a broken check.
      reason:
        `This would commit ${total} against an authorised ceiling of ${projectBudgetCeiling}, ` +
        `with ${campaigns} already committed to other campaigns and ${escrow} held in escrow.`,
    };
  }

  return { allowed: true };
}
