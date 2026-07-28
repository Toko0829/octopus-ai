/**
 * Types for the plan card, which is not rendered yet.
 *
 * They live beside the component rather than in lib/types.ts because lib/types.ts
 * describes shapes the API actually produces. Nothing produces a plan until the
 * orchestrator lands in Phase 2 (docs/10-architecture/roadmap.md); when it does,
 * these move into @octopus/contracts like every other wire shape.
 */

export type TaskOwner = 'AI' | 'HUMAN' | 'YOU';

export interface Citation {
  id: string;
  label: string;
  source: string;
  verified: string;
}

export interface PlanStage {
  id: string;
  title: string;
  detail: string;
  owner: TaskOwner;
  metric?: string;
}

export interface PlanCardData {
  title: string;
  goal: string;
  stages: PlanStage[];
  citations: Citation[];
  estCost: string;
  estTimeline: string;
  verified: string;
}
