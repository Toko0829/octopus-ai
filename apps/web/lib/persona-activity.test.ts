/**
 * What the members panel says each voice is doing.
 *
 * Two properties are worth stating before the cases.
 *
 * **The mapping happens here, not on the wire.** `ProjectSummary.working` sends
 * the stage, and this file turns it into a persona through the same registry the
 * stream renders names out of. Sending the persona instead would put a second
 * copy of `personaForStage` on the wire, and the wire copy would be the stale
 * one the first time a stage moves between voices.
 *
 * **A voice is working only while a step it owns is in the executor's hands.**
 * There is no wire that could say more: the AI service is stateless per call and
 * nothing reports progress inside one. Everything else is "Available", which is
 * a claim about this system's own rows rather than about the model.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '@octopus/contracts';
import { activityByPersona } from './persona-activity';
import { NO_MODELS, type ModelReadout } from './model-labels';

const project = (working: { stage: string | null; title: string }[]) =>
  ({ working }) as Pick<ProjectSummary, 'working'>;

const byId = (rows: ReturnType<typeof activityByPersona>) =>
  Object.fromEntries(rows.map((p) => [p.id, p]));

/**
 * The activity cases do not care which model anything runs on, so they say so
 * once here rather than passing an empty readout twelve times. The routing cases
 * below call `activityByPersona` directly with a readout that means something.
 */
const withModels = (
  projects: Pick<ProjectSummary, 'working'>[],
  strategistBusy: boolean,
  models: ModelReadout = NO_MODELS,
) => activityByPersona(projects, strategistBusy, models);

describe('activityByPersona', () => {
  it('returns all four voices in registry order, even with nothing running', () => {
    const rows = withModels([], false);
    expect(rows.map((p) => p.id)).toEqual(['strategist', 'content', 'ads', 'analyst']);
    expect(rows.every((p) => !p.working)).toBe(true);
  });

  it('falls back to the voice summary when it is doing nothing', () => {
    // The row must still say what this voice is for. A blank line beside a name
    // reads as something failing to load.
    const rows = byId(withModels([], false));
    expect(rows.strategist?.activity).toBeNull();
    expect(rows.ads?.summary).toContain('Channels');
  });

  it('names the step a voice is on', () => {
    const rows = byId(
      withModels([project([{ stage: 'content', title: 'Write send four' }])], false),
    );
    expect(rows.content?.working).toBe(true);
    expect(rows.content?.activity).toBe('Working on: Write send four');
    expect(rows.ads?.working).toBe(false);
  });

  it('routes a stage to the voice that owns it', () => {
    const rows = byId(
      withModels(
        [
          project([
            { stage: 'conversion', title: 'Build the landing page' },
            { stage: 'channels', title: 'Set up the campaign' },
            { stage: 'measurement', title: 'Read the numbers' },
          ]),
        ],
        false,
      ),
    );
    // Conversion is Content's, which is the division worth pinning: a landing
    // page is a piece of writing before it is a channel.
    expect(rows.content?.activity).toBe('Working on: Build the landing page');
    expect(rows.ads?.activity).toBe('Working on: Set up the campaign');
    expect(rows.analyst?.activity).toBe('Working on: Read the numbers');
  });

  it('sends an unknown or missing stage to the Strategist', () => {
    const rows = byId(
      withModels([project([{ stage: 'positioning', title: 'Pick the offer' }])], false),
    );
    expect(rows.strategist?.activity).toBe('Working on: Pick the offer');

    const noStage = byId(withModels([project([{ stage: null, title: 'Unfiled' }])], false));
    expect(noStage.strategist?.activity).toBe('Working on: Unfiled');
  });

  it('summarises rather than listing when a voice holds several steps', () => {
    const rows = byId(
      withModels(
        [
          project([
            { stage: 'content', title: 'Write send four' },
            { stage: 'creative', title: 'Cut the demo' },
            { stage: 'conversion', title: 'Build the landing page' },
          ]),
        ],
        false,
      ),
    );
    expect(rows.content?.activity).toBe('Working on: Write send four, and 2 more');
  });

  it('adds up across every project in the room', () => {
    const rows = byId(
      withModels(
        [
          project([{ stage: 'channels', title: 'Campaign A' }]),
          project([{ stage: 'channels', title: 'Campaign B' }]),
        ],
        false,
      ),
    );
    expect(rows.ads?.activity).toBe('Working on: Campaign A, and 1 more');
  });

  it('shows the Strategist working while this browser has a run in flight', () => {
    // Planning happens before a project exists, so there is no task row to find.
    // This is the one wait nothing else can report.
    const rows = byId(withModels([], true));
    expect(rows.strategist?.working).toBe(true);
    expect(rows.strategist?.activity).toBe('Working on a plan');
    expect(rows.content?.working).toBe(false);
  });

  it('prefers the named step over the generic planning line', () => {
    const rows = byId(
      withModels([project([{ stage: 'strategy', title: 'Pick the offer' }])], true),
    );
    expect(rows.strategist?.activity).toBe('Working on: Pick the offer');
  });

  it('survives a server that does not send working at all', () => {
    // The field is defaulted in the contract, but a hand-built object from an
    // older cache can still arrive without it.
    const rows = withModels([{} as Pick<ProjectSummary, 'working'>], false);
    expect(rows.every((p) => !p.working)).toBe(true);
  });

  it('writes no em dash in anything it says', () => {
    // AGENTS.md rule 22, over every sentence this file can produce.
    const rows = withModels(
      [
        project([
          { stage: 'content', title: 'One' },
          { stage: 'content', title: 'Two' },
        ]),
      ],
      true,
    );
    for (const p of rows) {
      expect(p.activity ?? '').not.toContain('—');
      expect(p.summary).not.toContain('—');
      expect(p.runsOn).not.toContain('—');
    }
  });
});

/**
 * Which model each voice runs on.
 *
 * The line is a report, and the three answers it can give are the three states a
 * room is actually in: routed, Auto with a house default the service named, and
 * Auto with a service that did not answer. The third is not an error on the
 * page. Some default still answers; we simply cannot name it, and naming one
 * anyway would be inventing the fact.
 */
describe('runsOn', () => {
  const route = (role: string, provider: string, model: string) =>
    ({ role, provider, model }) as ModelReadout['routes'][number];

  it('names the model a voice is routed to', () => {
    const rows = byId(
      withModels([], false, {
        routes: [route('strategist', 'anthropic', 'claude-opus-5')],
        houseDefault: { provider: 'openai', model: 'gpt-5.4' },
      }),
    );
    expect(rows.strategist?.runsOn).toBe('Claude Opus 5');
    // Everything unrouted still says what actually answers for it.
    expect(rows.content?.runsOn).toBe('GPT-5.4');
  });

  it('names the house default when the room has routed nothing', () => {
    const rows = withModels([], false, {
      routes: [],
      houseDefault: { provider: 'openai', model: 'gpt-5.4' },
    });
    expect(rows.every((p) => p.runsOn === 'GPT-5.4')).toBe(true);
  });

  it('says a default exists without naming one when the service did not answer', () => {
    const rows = byId(withModels([], false, NO_MODELS));
    expect(rows.analyst?.runsOn).toBe('the default model');
  });

  it('ignores the two roles that are not voices', () => {
    // `fallback` and `creative` are roles with no persona to sign them, so a
    // route for either must not leak onto a voice's line.
    const rows = byId(
      withModels([], false, {
        routes: [route('fallback', 'anthropic', 'claude-opus-5')],
        houseDefault: { provider: 'openai', model: 'gpt-5.4' },
      }),
    );
    expect(rows.strategist?.runsOn).toBe('GPT-5.4');
  });

  it('renders an id it has never heard of verbatim', () => {
    // A vendor shipping a model this build does not list is not a defect, and
    // "Unknown" over a real audit trail would be worse than the raw id.
    const rows = byId(
      withModels([], false, {
        routes: [route('ads', 'openai', 'gpt-9-something')],
        houseDefault: null,
      }),
    );
    expect(rows.ads?.runsOn).toBe('gpt-9-something');
  });
});
