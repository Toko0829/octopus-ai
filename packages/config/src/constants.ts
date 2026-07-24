/**
 * Shared constants used across services. Keep domain enums here in sync with the
 * data model (docs/10-architecture/data-model.md) and the state machine
 * (docs/30-modules/business-projects-workflow.md).
 */

export const ROLES = ['user', 'human_node', 'verified_pro', 'admin', 'ops'] as const;
export type Role = (typeof ROLES)[number];

export const PROJECT_STATES = [
  'DRAFT',
  'PLANNING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const TASK_OWNER_TYPES = ['AI', 'HUMAN', 'USER'] as const;
export type TaskOwnerType = (typeof TASK_OWNER_TYPES)[number];

/** First shipped vertical (see docs/00-overview/vision.md). */
export const FIRST_VERTICAL = 'full-funnel-marketing' as const;
