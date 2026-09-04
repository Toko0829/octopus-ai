import { describe, expect, it } from 'vitest';
import { failureNotice, planEmbedPayload } from './agent-runs';
import { continuationRunId } from '../lib/agent-runner';
import { AiServiceError, ProposePlanProposal } from '../lib/ai';
import { PlanEmbedPayload } from '@octopus/contracts';

/**
 * The first tests in `apps/api`, and they start here for a reason.
 *
 * `infra-devops.md` records that this package had no runner while `services/ai`
 * has had pytest since it existed, and today made that untenable: four defects
 * shipped in this file's neighbourhood and **every one of them was silent**. None
 * raised, none showed up in a type check, and each was found only by driving the
 * product by hand and reading what appeared in the room.
 *
 * So the properties asserted here are the ones whose violation is invisible: copy
 * that tells a person something untrue, and a branch that quietly does nothing.
 */

describe('failureNotice', () => {
  it('says a timeout was a timeout rather than a service that did not answer', () => {
    // The defect this exists to prevent, and it reached a user. `architecture.md`
    // states "a timeout is reported as a timeout" as settled, while the route
    // flattened every AiServiceError into "the reasoning service did not
    // respond". The service was healthy and still working, so the message was
    // false, and it sends whoever debugs it in exactly the wrong direction.
    const notice = failureNotice(
      new AiServiceError('AI service timed out after 300000ms', 'timeout'),
    );

    expect(notice).toContain('still working');
    expect(notice).not.toContain('did not respond');
    expect(notice).not.toContain('could not reach');
  });

  it('offers a remedy only for the failure that is not our fault', () => {
    // A timeout is the only one of the four the person can do anything about,
    // so it is the only one that suggests anything. Telling someone to narrow
    // their goal when the service is unreachable would be useless advice
    // delivered confidently.
    const timeout = failureNotice(new AiServiceError('timed out', 'timeout'));
    expect(timeout.toLowerCase()).toContain('narrowing');

    for (const kind of ['unreachable', 'status', 'contract'] as const) {
      const notice = failureNotice(new AiServiceError('x', kind));
      expect(notice.toLowerCase()).not.toContain('narrowing');
    }
  });

  it('distinguishes all four failure kinds from each other', () => {
    const kinds = ['timeout', 'unreachable', 'status', 'contract'] as const;
    const notices = kinds.map((k) => failureNotice(new AiServiceError('x', k)));

    // Collapsing any two of these back into one sentence is precisely the
    // regression that shipped, so the test is that they stay distinct rather
    // than that each says any particular thing.
    expect(new Set(notices).size).toBe(kinds.length);
  });

  it('does not blame the reasoning service for a failure that was not its', () => {
    const notice = failureNotice(new Error('a bug in our own code'));

    expect(notice).toContain('my side');
    expect(notice).not.toContain('reasoning service');
  });

  it('never uses an em dash in anything it says', () => {
    // AGENTS.md rule 22, and this is user-facing copy on a trust surface. Nothing
    // else enforces it here: prettier does not read prose and a type checker
    // cannot see a character.
    const all = [
      failureNotice(new Error('x')),
      ...(['timeout', 'unreachable', 'status', 'contract'] as const).map((k) =>
        failureNotice(new AiServiceError('x', k)),
      ),
    ];

    for (const notice of all) {
      expect(notice).not.toContain('—');
    }
  });
});

describe('AiServiceError', () => {
  it('defaults to unreachable rather than to timeout', () => {
    // The default has to be the one that says "we could not talk to it", because
    // an untagged failure is genuinely unknown. Defaulting to `timeout` would
    // make an unknown fault claim the service was healthy and busy, which is the
    // false-reassurance direction.
    expect(new AiServiceError('x').kind).toBe('unreachable');
  });

  it('keeps its name so a catch block can identify it after serialisation', () => {
    expect(new AiServiceError('x').name).toBe('AiServiceError');
  });
});

describe('planEmbedPayload', () => {
  const step = {
    title: 'Turn the campaign on',
    detail: 'Go live within the budget band.',
    owner: 'AI' as const,
    citations: [1],
    risk_tier: 'high_risk' as const,
    depends_on: [] as string[],
    acceptance_criteria: ['spend stays inside the band'],
  };
  const plan = {
    kind: 'propose_plan' as const,
    title: 'Launch plan',
    summary: 'Four stages covered.',
    stages: [{ stage: 'channels' as const, steps: [step] }],
  };

  /** Asserts the shape before indexing, so a missing step fails as itself. */
  function firstStep(payload: ReturnType<typeof planEmbedPayload>) {
    const stage = payload.stages[0];
    expect(stage).toBeDefined();
    const mapped = stage!.steps[0];
    expect(mapped).toBeDefined();
    return mapped!;
  }

  it('renames risk_tier rather than spreading the step', () => {
    // The silent failure this guards. Both `riskTier` and `acceptanceCriteria`
    // carry defaults in the contract, so spreading the core's snake_case step
    // would parse cleanly and land every step on `reversible`, with nothing
    // raising anywhere. That is the same outcome the tier exists to prevent,
    // reached through the mapping instead of through the planner.
    const mapped = firstStep(planEmbedPayload(plan, 'grow my app', []));

    expect(mapped.riskTier).toBe('high_risk');
    expect(mapped.acceptanceCriteria).toEqual(['spend stays inside the band']);
    expect(mapped).not.toHaveProperty('risk_tier');
  });

  it('survives the contract it is about to be stored under', () => {
    // The route parses before writing, so a mapping the schema rejects is a
    // crash at run time rather than a type error. Asserted here instead.
    const parsed = PlanEmbedPayload.safeParse(planEmbedPayload(plan, 'grow my app', []));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.stages[0]?.steps[0]?.riskTier).toBe('high_risk');
  });

  it('defaults a core that omits the tier to reversible, at the wire schema', () => {
    // Where the default actually lives, which is worth pinning separately: by the
    // time the mapping runs, `requestPlan` has already parsed the response, so a
    // core older than this field is handled there rather than here. Absent must
    // land where every task already landed rather than failing the card.
    const parsed = ProposePlanProposal.safeParse({
      kind: 'propose_plan',
      title: 'Launch plan',
      summary: 'Four stages covered.',
      stages: [
        {
          stage: 'channels',
          steps: [
            { title: 'Draft the ads', detail: 'Three variants.', owner: 'AI', citations: [] },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const mapped = firstStep(planEmbedPayload(parsed.data, 'grow my app', []));
    expect(mapped.riskTier).toBe('reversible');
    expect(mapped.acceptanceCriteria).toEqual([]);
  });

  it('renames depends_on rather than spreading it, and keeps the id', () => {
    // The second field with a default, and it fails more quietly than the tier.
    // A spread drops `depends_on`, `dependsOn` defaults to `[]`, the card parses,
    // and `materialise_plan` writes a project with no edges. The result is a plan
    // that merely looks flat, and flat is what every plan used to be, so there is
    // nothing to notice.
    const withDeps = {
      ...plan,
      stages: [
        {
          stage: 'channels' as const,
          steps: [{ ...step, id: 'launch', depends_on: ['ad-copy'] }],
        },
      ],
    };
    const mapped = firstStep(planEmbedPayload(withDeps, 'grow my app', []));

    expect(mapped.id).toBe('launch');
    expect(mapped.dependsOn).toEqual(['ad-copy']);
    expect(mapped).not.toHaveProperty('depends_on');
  });

  it('omits the id entirely when the core sends none', () => {
    // Rather than writing `id: null`. A step that names itself and one that does
    // not stay distinguishable in the stored payload, and the SQL reads the key's
    // absence to mean "nothing can depend on this".
    const mapped = firstStep(planEmbedPayload(plan, 'grow my app', []));

    expect(mapped).not.toHaveProperty('id');
    expect(mapped.dependsOn).toEqual([]);
  });

  it('carries dependencies through the contract it is stored under', () => {
    const withDeps = {
      ...plan,
      stages: [
        {
          stage: 'channels' as const,
          steps: [{ ...step, id: 'launch', depends_on: ['ad-copy'] }],
        },
      ],
    };
    const parsed = PlanEmbedPayload.safeParse(planEmbedPayload(withDeps, 'grow my app', []));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.stages[0]?.steps[0]?.dependsOn).toEqual(['ad-copy']);
  });

  it('reads a card written before dependencies existed as one with none', () => {
    // Absent must not cost the card, the same rule the risk tier follows. An old
    // payload has neither key, and both have to survive the parse.
    const parsed = PlanEmbedPayload.safeParse({
      title: 'Launch plan',
      summary: 'S',
      citations: [],
      stages: [
        {
          stage: 'channels',
          steps: [
            { title: 'Draft the ads', detail: 'Three variants.', owner: 'AI', citations: [] },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.stages[0]?.steps[0]?.dependsOn).toEqual([]);
    expect(parsed.success && parsed.data.stages[0]?.steps[0]?.id).toBeUndefined();
  });
});

describe('planEmbedPayload provenance', () => {
  const plan: ProposePlanProposal = {
    kind: 'propose_plan',
    title: 't',
    summary: 's',
    stages: [],
  } as unknown as ProposePlanProposal;

  it('carries the run id and the card it replaces only when given', () => {
    const bare = planEmbedPayload(plan, 'g', []);
    expect('runId' in bare).toBe(false);
    expect('supersedes' in bare).toBe(false);

    const traced = planEmbedPayload(plan, 'g', [], [], {
      runId: 'run-1',
      supersedes: '11111111-1111-4111-8111-111111111111',
    });
    expect(traced.runId).toBe('run-1');
    expect(traced.supersedes).toBe('11111111-1111-4111-8111-111111111111');
    expect(PlanEmbedPayload.safeParse(traced).success).toBe(true);
  });
});

describe('continuationRunId', () => {
  it('is deterministic from the card, so a card finished twice collides rather than doubling', () => {
    const a = continuationRunId({ runId: 'run-1', round: 0 }, 'embed-1');
    const b = continuationRunId({ runId: 'run-1', round: 0 }, 'embed-1');
    expect(a).toBe(b);
    expect(a).toBe('run-1:r1');
  });

  it('falls back to the card id for a card written before runs were named', () => {
    expect(continuationRunId({ round: 1 }, 'embed-1')).toBe('embed-1:r2');
  });
});
