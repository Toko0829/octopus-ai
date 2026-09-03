import { AGENT_PERSONAS, stripMention, type AgentPersona } from '@octopus/contracts';
import { REPLAN_REASON_MAX } from './intake';

/**
 * Turning "@Ads move the budget to Meta" into the reason a replan card carries.
 *
 * **A mention is a request, and this is where it becomes one the planner can
 * answer.** The grammar lives in `packages/contracts`, because the composer and
 * the server both have to agree on what counts as a mention. The sentence lives
 * here, beside `replanReason`, because it is server copy and because the two
 * must cap the same field the same way.
 *
 * Templated rather than generated, on the rule `INTAKE_COPY` records: a
 * generated sentence on a trust surface is one prompt drift away from breaking
 * brand voice, and the model classifies while the words stay ours. What the
 * model receives is the owner's own request plus one instruction about scope.
 *
 * **The scope instruction is guidance, not a guardrail.** It asks the planner to
 * stay in the mentioned voice's stages, and a planner that ignores it produces a
 * card whose ops the owner sees before anything is applied. Nothing here decides
 * what may happen; `apply_plan_diff` behind an owner-gated card still does
 * ([ADR-0031](../../../docs/40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)).
 */
export function mentionReason(persona: AgentPersona, text: string): string {
  const profile = AGENT_PERSONAS[persona];
  const stages = profile.stages;
  const stageWords =
    stages.length === 1
      ? `the ${stages[0]} stage`
      : `the ${stages.slice(0, -1).join(', ')} and ${stages[stages.length - 1]} stages`;

  const head = `The owner asked ${profile.name}, who owns ${stageWords}, to:`;
  const tail = `Change only the steps in ${stages.length === 1 ? 'that stage' : 'those stages'} unless the request cannot be met without touching others.`;

  // The request without its mention token: the planner is told who was asked in
  // the sentence above, and leaving "@Ads" in the quoted text invites it to
  // treat the token as part of the ask.
  const request = stripMention(text, persona).trim();
  const body = request.length > 0 ? request : 'nothing beyond the mention itself.';

  // Same shape as `replanReason`: reserve room for the fixed parts, then trim
  // the variable one. A reason over the limit is a 422 from the reasoning core
  // in the middle of somebody's request.
  const room = REPLAN_REASON_MAX - head.length - tail.length - 3;
  const trimmed = body.length > room ? `${body.slice(0, room - 3).trimEnd()}...` : body;

  return `${head} ${trimmed} ${tail}`;
}
