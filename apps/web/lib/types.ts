/** UI types for the Phase-1 chat shell (mock-driven; mirrors the eventual API shapes). */

export type Role = 'you' | 'agent' | 'node' | 'pro' | 'admin';
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type TaskOwner = 'AI' | 'HUMAN' | 'YOU';

export interface Member {
  id: string;
  name: string;
  handle: string;
  role: Role;
  presence: Presence;
  initials: string;
  activity?: string;
}

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

export type MessageKind = 'text' | 'plan' | 'system';

export interface Message {
  id: string;
  authorId: string;
  kind: MessageKind;
  body?: string;
  plan?: PlanCardData;
  ts: string;
  streaming?: boolean;
  planState?: 'pending' | 'approved' | 'changes';
}

export interface Channel {
  id: string;
  name: string;
  section: string;
  kind: 'text' | 'topic';
  unread?: number;
}

export interface Business {
  id: string;
  name: string;
  mark: string;
  accent: string;
}
