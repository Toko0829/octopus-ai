import { describe, expect, it } from 'vitest';
import { ReplanEmbedPayload, ActionEmbed } from '@octopus/contracts';
import { ProposeReplanProposal } from '../lib/ai';

/**
 * The replan seam, tested where it fails silently.
 *
 * Two of the three things asserted here have already shipped as defects in this
 * repository once: a payload field dropped by a spread (the risk tier), and an
 * embed variant missing from the union that reads it (the artifact card, which
 * never rendered for anybody). The third is the modify op's exclusions, which are
 * an authorisation boundary expressed as fields that are absent, and absence is
 * the one thing a type checker cannot notice going missing.
 */

const TASK_ID = '11111111-1111-4111-8111-111111111111';

describe('ProposeReplanProposal', () => {
  const base = {
    kind: 'propose_replan' as const,
    project_id: '22222222-2222-4222-8222-222222222222',
    summary: 'Drop the paid work and lean on SEO.',
  };

  it('accepts the three ops and discriminates them on `op`', () => {
    const parsed = ProposeReplanProposal.safeParse({
      ...base,
      ops: [
        {
          op: 'add_step',
          stage: 'channels',
          id: 'seo-audit',
          title: 'Audit the current pages',
          detail: 'Find what already ranks.',
          owner: 'AI',
          citations: [1],
        },
        { op: 'cancel_task', task_id: TASK_ID, reason: 'not doing paid ads' },
        { op: 'modify_task', task_id: TASK_ID, detail: 'Narrow it.' },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ops.map((o) => o.op)).toEqual([
      'add_step',
      'cancel_task',
      'modify_task',
    ]);
  });

  it('refuses a diff with no ops', () => {
    // An empty diff is a proposal to change nothing, and rendering a card that
    // asks somebody to approve nothing is worse than saying there is no change.
    expect(ProposeReplanProposal.safeParse({ ...base, ops: [] }).success).toBe(false);
  });

  it('refuses a diff larger than a person will read', () => {
    // The cap is enforced this side as well as in the core, on this side's own
    // rule: the core may propose, and the bounds on what it proposes are this
    // side's to enforce rather than the prompt's to honour.
    const op = { op: 'cancel_task' as const, task_id: TASK_ID, reason: 'x' };
    expect(ProposeReplanProposal.safeParse({ ...base, ops: Array(11).fill(op) }).success).toBe(
      false,
    );
  });

  it('refuses an op kind nobody has written a handler for', () => {
    // The core widening its own powers by inventing an op should break the run
    // rather than be quietly dropped from the diff.
    expect(
      ProposeReplanProposal.safeParse({
        ...base,
        ops: [{ op: 'delete_project', task_id: TASK_ID }],
      }).success,
    ).toBe(false);
  });

  it('defaults an added step that omits its tier and edges', () => {
    // Absent must not cost the card, the same rule the plan step follows.
    const parsed = ProposeReplanProposal.safeParse({
      ...base,
      ops: [
        {
          op: 'add_step',
          stage: 'content',
          id: 'a',
          title: 'T',
          detail: 'D',
          owner: 'AI',
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const op = parsed.data.ops[0];
    expect(op?.op === 'add_step' && op.risk_tier).toBe('reversible');
    expect(op?.op === 'add_step' && op.depends_on).toEqual([]);
  });
});

describe('ReplanEmbedPayload', () => {
  const payload = {
    projectId: '22222222-2222-4222-8222-222222222222',
    reason: 'I do not want to run paid ads.',
    summary: 'Cancel the paid work, add an SEO audit.',
    ops: [
      {
        op: 'add_step',
        stage: 'channels',
        id: 'seo-audit',
        title: 'Audit the current pages',
        detail: 'Find what already ranks.',
        owner: 'AI',
        citations: [1],
        riskTier: 'reversible',
        acceptanceCriteria: ['names three pages'],
        dependsOn: [],
      },
      {
        op: 'cancel_task',
        taskId: TASK_ID,
        taskTitle: 'Draft the ad copy',
        reason: 'not doing paid ads',
      },
    ],
    citations: [{ sourceId: 'c1', label: 'SEO for a new site' }],
  };

  it('stores what the card needs to be readable on its own', () => {
    const parsed = ReplanEmbedPayload.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const cancel = parsed.data.ops[1];
    // The title is what makes the card an authorisation rather than a UUID.
    expect(cancel?.op === 'cancel_task' && cancel.taskTitle).toBe('Draft the ad copy');
  });

  it('keeps a modify op from carrying an owner, a tier or a state', () => {
    // The safety property, and it is expressed as fields that do not exist. Zod
    // strips unknown keys, so a payload asking to move a step from YOU to AI
    // parses cleanly and simply does not carry the request; `apply_plan_diff`
    // then names three columns rather than taking a payload, so there is nothing
    // to widen at either end.
    const parsed = ReplanEmbedPayload.safeParse({
      ...payload,
      ops: [
        {
          op: 'modify_task',
          taskId: TASK_ID,
          detail: 'Narrow it.',
          owner: 'AI',
          riskTier: 'read_only',
          state: 'approved',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const op = parsed.data.ops[0];
    expect(op).not.toHaveProperty('owner');
    expect(op).not.toHaveProperty('riskTier');
    expect(op).not.toHaveProperty('state');
  });

  it('reads a card written before task titles were stored', () => {
    const parsed = ReplanEmbedPayload.safeParse({
      ...payload,
      ops: [{ op: 'cancel_task', taskId: TASK_ID, reason: 'x' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ops[0]?.op === 'cancel_task').toBe(true);
  });

  it('survives the embed union the read path validates against', () => {
    // The artifact card never rendered for anybody because its variant was
    // missing from exactly this union, and the failure was silent: `toEmbed`
    // returned null and only the plain-text body reached the room.
    const parsed = ActionEmbed.safeParse({
      id: '33333333-3333-4333-8333-333333333333',
      messageId: '44444444-4444-4444-8444-444444444444',
      component: 'replan',
      payload,
      requiredRole: 'owner',
      state: 'pending',
      createdAt: new Date(0).toISOString(),
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.component).toBe('replan');
  });
});
