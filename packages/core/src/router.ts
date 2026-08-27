/**
 * The router: given a task, decide who executes it.
 *
 * `owner_type` already carries what the **planner proposed** (a plan step's
 * AI / HUMAN / YOU, materialised onto the row). This is not that. This is the
 * enforcement, and the difference is the entire point of the module: the planner
 * is a language model, so its opinion about who should do something is an input
 * to the decision and never the decision itself.
 *
 * Concretely, a task the planner marked `ai` still cannot auto-run if it is
 * high-risk or uncited. Rules 7 and 11 put authorisation in tool code rather than
 * in prompts, and a router that simply believed `owner_type` would be putting it
 * back in the prompt by another route.
 *
 * Pure on purpose. No IO, no clock, no database: a decision this consequential
 * should be readable in one screen and testable without a running system.
 */

import type { TaskRiskTier } from '@octopus/contracts';

/** Mirrors `public.task_owner_type`. */
export type TaskOwnerType = 'ai' | 'human' | 'user';

/**
 * Re-exported rather than redeclared. The tier now travels on the plan card, so
 * `packages/contracts` owns the definition (rule 9) and a second copy here would
 * be the thing that drifts the first time a tier is added.
 */
export type { TaskRiskTier };

/**
 * Where a task in `routing` goes next. A strict subset of `task_state`: these are
 * the three outcomes the state machine allows out of `routing`.
 */
export type RouteTarget = 'ai_running' | 'escalated' | 'needs_user';

export interface RoutableTask {
  id: string;
  ownerType: TaskOwnerType;
  riskTier: TaskRiskTier;
  /** Indices into the plan's citations. Empty means the step rests on no source. */
  citations: number[];
}

export interface RouteDecision {
  target: RouteTarget;
  /**
   * Which rule fired. Recorded rather than derived, because "why did this
   * escalate" is the question anyone debugging a stuck project asks first, and
   * re-deriving it later means guessing at the inputs the task had at the time.
   */
  rule: RouteRule;
  /** One sentence, for the audit event and the chat notice. */
  reason: string;
}

export type RouteRule =
  | 'high_risk_needs_authorisation'
  | 'user_owned'
  | 'human_owned'
  | 'uncited_cannot_auto_run'
  | 'ai_owned';

/**
 * Decide, in priority order. The order is the safety property: the first two
 * rules override what the planner asked for, and everything after them is the
 * ordinary case.
 */
export function routeTask(task: RoutableTask): RouteDecision {
  // (1) Irreversible or money-moving work always asks the person, whatever the
  // plan said. security-compliance.md lists "high-risk / irreversible" as a
  // mandatory escalation, and rule 11 requires per-action confirmation rather
  // than a blanket one. This deliberately outranks `owner_type`: a planner that
  // marks a high-risk step `AI` is exactly the case this exists to catch.
  if (task.riskTier === 'high_risk') {
    return {
      target: 'needs_user',
      rule: 'high_risk_needs_authorisation',
      reason: 'High-risk or irreversible, so it needs the owner to authorise it.',
    };
  }

  // (2) A decision, an authorisation, or a fact only the person has.
  if (task.ownerType === 'user') {
    return {
      target: 'needs_user',
      rule: 'user_owned',
      reason: 'Needs a decision or a fact only the owner has.',
    };
  }

  // (3) Judgement, taste, relationships, or access the AI does not have.
  if (task.ownerType === 'human') {
    return {
      target: 'escalated',
      rule: 'human_owned',
      reason: 'Needs expert human judgement, so it goes to the marketplace.',
    };
  }

  // (4) Rule 10, applied to work rather than to prose. An uncited step is one the
  // corpus did not support, and the plan card already marks it unverified. Letting
  // the AI act on it anyway would make the citation requirement cosmetic: the
  // claim would be flagged while the action it gates went ahead.
  //
  // `read_only` is exempt because research that reads nothing and changes nothing
  // cannot gate anything either. Escalating those would bury the marketplace in
  // work that carries no risk, which is how a safety rule gets switched off.
  if (task.citations.length === 0 && task.riskTier !== 'read_only') {
    return {
      target: 'escalated',
      rule: 'uncited_cannot_auto_run',
      reason: 'No source supports this step, so it cannot run unsupervised (rule 10).',
    };
  }

  // (5) The ordinary case.
  return {
    target: 'ai_running',
    rule: 'ai_owned',
    reason: 'Grounded, reversible, and within what the AI may do alone.',
  };
}
