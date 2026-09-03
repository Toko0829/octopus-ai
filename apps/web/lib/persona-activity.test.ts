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

const project = (working: { stage: string | null; title: string }[]) =>
  ({ working }) as Pick<ProjectSummary, 'working'>;

const byId = (rows: ReturnType<typeof activityByPersona>) =>
  Object.fromEntries(rows.map((p) => [p.id, p]));

describe('activityByPersona', () => {
  it('returns all four voices in registry order, even with nothing running', () => {
    const rows = activityByPersona([], false);
    expect(rows.map((p) => p.id)).toEqual(['strategist', 'content', 'ads', 'analyst']);
    expect(rows.every((p) => !p.working)).toBe(true);
  });

  it('falls back to the voice summary when it is doing nothing', () => {
    // The row must still say what this voice is for. A blank line beside a name
    // reads as something failing to load.
    const rows = byId(activityByPersona([], false));
    expect(rows.strategist?.activity).toBeNull();
    expect(rows.ads?.summary).toContain('Channels');
  });

  it('names the step a voice is on', () => {
    const rows = byId(
      activityByPersona([project([{ stage: 'content', title: 'Write send four' }])], false),
    );
    expect(rows.content?.working).toBe(true);
    expect(rows.content?.activity).toBe('Working on: Write send four');
    expect(rows.ads?.working).toBe(false);
  });

  it('routes a stage to the voice that owns it', () => {
    const rows = byId(
      activityByPersona(
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
      activityByPersona([project([{ stage: 'positioning', title: 'Pick the offer' }])], false),
    );
    expect(rows.strategist?.activity).toBe('Working on: Pick the offer');

    const noStage = byId(activityByPersona([project([{ stage: null, title: 'Unfiled' }])], false));
    expect(noStage.strategist?.activity).toBe('Working on: Unfiled');
  });

  it('summarises rather than listing when a voice holds several steps', () => {
    const rows = byId(
      activityByPersona(
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
      activityByPersona(
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
    const rows = byId(activityByPersona([], true));
    expect(rows.strategist?.working).toBe(true);
    expect(rows.strategist?.activity).toBe('Working on a plan');
    expect(rows.content?.working).toBe(false);
  });

  it('prefers the named step over the generic planning line', () => {
    const rows = byId(
      activityByPersona([project([{ stage: 'strategy', title: 'Pick the offer' }])], true),
    );
    expect(rows.strategist?.activity).toBe('Working on: Pick the offer');
  });

  it('survives a server that does not send working at all', () => {
    // The field is defaulted in the contract, but a hand-built object from an
    // older cache can still arrive without it.
    const rows = activityByPersona([{} as Pick<ProjectSummary, 'working'>], false);
    expect(rows.every((p) => !p.working)).toBe(true);
  });

  it('writes no em dash in anything it says', () => {
    // AGENTS.md rule 22, over every sentence this file can produce.
    const rows = activityByPersona(
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
    }
  });
});
