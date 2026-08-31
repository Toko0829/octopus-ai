import { describe, expect, it } from 'vitest';

import { isKnownSkill, skillEntry } from './skill-taxonomy';
import {
  MAPPED_STAGES,
  mapIsWithinTaxonomy,
  mappedSkillTags,
  skillsForStage,
} from './stage-skills';

/**
 * The map's whole job is to be complete and to stay inside the taxonomy, and
 * both failures are silent in production: a stage the map has forgotten returns
 * no skills and the owner is told no expert can be found, while a tag the
 * taxonomy no longer accepts matches zero nodes forever. Neither raises.
 */
describe('skillsForStage', () => {
  /** The six the planner emits (services/ai/src/octopus_ai/planner.py:96). */
  const PLANNER_STAGES = [
    'strategy',
    'content',
    'creative',
    'channels',
    'conversion',
    'measurement',
  ];

  it('covers every stage the planner can emit', () => {
    for (const stage of PLANNER_STAGES) {
      expect(skillsForStage(stage), stage).not.toHaveLength(0);
    }
  });

  it('knows exactly those six and no others', () => {
    expect([...MAPPED_STAGES].sort()).toEqual([...PLANNER_STAGES].sort());
  });

  it('only emits tags the taxonomy accepts', () => {
    expect(mapIsWithinTaxonomy()).toBe(true);
    for (const tag of mappedSkillTags()) {
      expect(isKnownSkill(tag), tag).toBe(true);
    }
  });

  it('never emits a skill that needs a jurisdiction', () => {
    // notary, legal-filing and bookkeeping are unreachable from a marketing
    // plan, and a bare jurisdictional tag would be refused by the taxonomy
    // anyway. Asserted at the map so the reason is recorded, not just the shape.
    for (const tag of mappedSkillTags()) {
      expect(skillEntry(tag)?.requiresJurisdiction, tag).toBe(false);
    }
  });

  it('fails closed on a stage it does not know', () => {
    expect(skillsForStage('formation')).toEqual([]);
    expect(skillsForStage('')).toEqual([]);
    expect(skillsForStage('   ')).toEqual([]);
    expect(skillsForStage(null)).toEqual([]);
    expect(skillsForStage(undefined)).toEqual([]);
    expect(skillsForStage('drop table tasks')).toEqual([]);
  });

  it('tolerates the casing and padding a hand-written row might carry', () => {
    expect(skillsForStage('  Measurement ')).toEqual(skillsForStage('measurement'));
  });

  it('returns a frozen list, so a caller cannot edit the map through it', () => {
    const tags = skillsForStage('content');
    expect(() => (tags as string[]).push('paid-ads')).toThrow();
    expect(skillsForStage('content')).toHaveLength(2);
  });
});
