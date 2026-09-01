/**
 * `@octopus/core` — domain logic that is neither transport nor storage.
 *
 * What belongs here is the reasoning a reader should be able to check without
 * running anything: which tasks may run, and who is allowed to run them. What
 * does not belong here is IO. The scheduler takes its database access as an
 * injected port, and the router takes none at all.
 *
 * See docs/30-modules/business-projects-workflow.md.
 */

export {
  routeTask,
  type RoutableTask,
  type RouteDecision,
  type RouteRule,
  type RouteTarget,
  type TaskOwnerType,
  type TaskRiskTier,
} from './router';

export {
  review,
  nextStateAfterReview,
  reviewProof,
  nextStateAfterProofReview,
  type CriticFailure,
  type CriticVerdict,
  type ReviewableArtifact,
  type ReviewContext,
  type ProofContext,
  type ProofFailure,
  type ProofVerdict,
  type SubmittedProof,
} from './critic';

export {
  decideIntakeTurn,
  type IntakeTurn,
  type IntakeTurnInput,
  type PendingIntake,
} from './intake';

export {
  tick,
  summarise,
  dispatchRouted,
  retryTask,
  type SchedulerPorts,
  type TickOutcome,
  type TickReport,
  type TickResult,
} from './scheduler';

export {
  decideRecovery,
  leaseDurationMs,
  MAX_RECOVERY_ATTEMPTS,
  type ReclaimedRun,
  type RecoveryDecision,
  type RecoveryTarget,
} from './recovery';
