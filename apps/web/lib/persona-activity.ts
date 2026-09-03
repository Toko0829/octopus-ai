import { AGENT_PERSONAS, personaForStage, type AgentPersona, type ProjectSummary } from '@octopus/contracts';
import type { UiPersona } from './types';

/**
 * What each of the four voices is doing right now, for the members panel.
 *
 * **Derived from a read the client already makes.** `ChatApp` refetches the
 * project list on every arriving message, because the things that change it (a
 * plan approved, a tick routing steps) all announce themselves in the room.
 * `working` rides along on that response, so this needs no polling, no second
 * subscription and no server-side presence table. The panel moves when something
 * actually happened, which is the same argument the waiting badge already makes.
 *
 * **This is honest about what it does not know.** A voice is shown as working
 * only while a step it owns is in the executor's hands. Everything else reads
 * "Available", which is a claim about this system's own rows rather than about
 * the model. There is no wire that could say more: the AI service is stateless
 * per call and nothing reports progress inside one.
 */

/** How many step titles to name before summarising the rest. */
const TITLES_SHOWN = 1;

export function activityByPersona(
  projects: Pick<ProjectSummary, 'working'>[],
  strategistBusy: boolean,
): UiPersona[] {
  const byPersona = new Map<AgentPersona, string[]>();

  for (const project of projects) {
    for (const step of project.working ?? []) {
      const persona = personaForStage(step.stage);
      const titles = byPersona.get(persona) ?? [];
      titles.push(step.title);
      byPersona.set(persona, titles);
    }
  }

  return (Object.keys(AGENT_PERSONAS) as AgentPersona[]).map((key) => {
    const titles = byPersona.get(key) ?? [];
    // The Strategist is also busy while this browser's own run is in flight.
    // That run has no task row to be found in `working`: planning happens before
    // a project exists, which is exactly the wait that looks longest.
    const working = titles.length > 0 || (key === 'strategist' && strategistBusy);

    return {
      id: key,
      name: AGENT_PERSONAS[key].name,
      initials: AGENT_PERSONAS[key].initials,
      summary: AGENT_PERSONAS[key].summary,
      working,
      activity: describeActivity(titles, working),
    };
  });
}

/**
 * One line, in words a person can check against the plan.
 *
 * A voice working with no named step is the Strategist planning, which is the
 * one case where naming the work would mean naming a task that does not exist
 * yet.
 */
function describeActivity(titles: string[], working: boolean): string | null {
  if (titles.length === 0) return working ? 'Working on a plan' : null;
  if (titles.length <= TITLES_SHOWN) return `Working on: ${titles[0]}`;
  return `Working on: ${titles[0]}, and ${titles.length - TITLES_SHOWN} more`;
}
