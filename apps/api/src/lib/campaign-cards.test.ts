/**
 * Which steps get a campaign card, and what the card says.
 *
 * Two properties are worth stating before the tests.
 *
 * **The candidate filter reads the router's verdict, not the step's words.** A
 * task is a candidate because the tick parked it at `needs_user` under
 * `high_risk_needs_authorisation`. Matching on titles or stages here would be a
 * second copy of the vocabulary `risk.py` already owns, and two copies of a
 * safety rule are two rules that can disagree.
 *
 * **The payload is renamed field by field and never spread.** `planEmbedPayload`
 * records what a spread costs: the shapes differ only by case, so `{...proposal}`
 * type-checks, drops every renamed field and silently defaults. Here the field
 * that would vanish is the channel, and a card rendering a default channel asks
 * somebody to authorise spend somewhere they did not choose.
 */

import { describe, expect, it } from 'vitest';
import type { TickReport, TickResult } from '@octopus/core';
import { CampaignEmbedPayload } from '@octopus/contracts';
import { campaignCandidates, campaignEmbedPayload } from './campaign-cards';

function result(taskId: string, outcome: TickResult['outcome'], rule: string): TickResult {
  return {
    taskId,
    outcome,
    decision: { target: 'needs_user', rule: rule as never, reason: 'because' },
  } as TickResult;
}

function report(results: TickResult[]): TickReport {
  return { projectId: 'p1', results } as TickReport;
}

describe('which steps are offered a campaign card', () => {
  it('takes a step the router stopped for an authorisation', () => {
    const r = report([result('t1', 'needs_user', 'high_risk_needs_authorisation')]);
    expect(campaignCandidates(r).map((c) => c.taskId)).toEqual(['t1']);
  });

  it('leaves a step that needs the person for what they know', () => {
    // `user_owned` is the planner saying only the owner can do this, which is a
    // question rather than an authorisation. Offering a campaign card there would
    // ask somebody to approve spend in answer to "what is your brand voice".
    const r = report([result('t1', 'needs_user', 'user_owned')]);
    expect(campaignCandidates(r)).toEqual([]);
  });

  it('leaves an escalated step alone', () => {
    // Escalated is waiting on an expert who does not exist yet. A card inviting an
    // authorisation would imply the work is ready to run.
    const r = report([result('t1', 'escalated', 'human_owned')]);
    expect(campaignCandidates(r)).toEqual([]);
  });

  it('ignores a high-risk step that actually started', () => {
    // The rule can only be `high_risk_needs_authorisation` when the outcome is
    // `needs_user`, but asserting both halves means a future outcome cannot widen
    // this filter by accident.
    const r = report([result('t1', 'ai_running', 'high_risk_needs_authorisation')]);
    expect(campaignCandidates(r)).toEqual([]);
  });

  it('picks out only the authorisation steps from a mixed tick', () => {
    const r = report([
      result('t1', 'needs_user', 'high_risk_needs_authorisation'),
      result('t2', 'needs_user', 'user_owned'),
      result('t3', 'ai_running', 'ai_owned'),
      result('t4', 'needs_user', 'high_risk_needs_authorisation'),
    ]);
    expect(campaignCandidates(r).map((c) => c.taskId)).toEqual(['t1', 't4']);
  });
});

const proposal = {
  kind: 'propose_campaign' as const,
  task_id: '11111111-1111-4111-8111-111111111111',
  name: 'Meta prospecting, cold audiences',
  objective: 'First 100 customers',
  channel: 'meta' as const,
  summary: 'Meta carries cold reach for a creator launch.',
  citations: [1],
};

const input = {
  projectId: '22222222-2222-4222-8222-222222222222',
  taskId: '11111111-1111-4111-8111-111111111111',
  currency: 'USD',
  citations: [{ source_id: 's1', label: 'Paid acquisition for creators', url: null }],
};

describe('the card payload', () => {
  it('is valid against the contract', () => {
    const parsed = CampaignEmbedPayload.safeParse(campaignEmbedPayload(proposal, input));
    expect(parsed.success).toBe(true);
  });

  it('carries the channel the core chose', () => {
    const p = CampaignEmbedPayload.parse(campaignEmbedPayload(proposal, input));
    // The field a spread would have dropped.
    expect(p.channel).toBe('meta');
  });

  it('posts with no budget, because the model never proposes one', () => {
    const p = CampaignEmbedPayload.parse(campaignEmbedPayload(proposal, input));
    expect(p.budgetCap).toBeNull();
  });

  it('cannot carry a budget even if the core sends one', () => {
    // There is no budget field on the proposal and no parameter for one here, so
    // a core that started emitting a number would have it ignored rather than
    // rendered as something a person authorised.
    const withBudget = { ...proposal, budget_cap: 5000 } as typeof proposal;
    const p = CampaignEmbedPayload.parse(campaignEmbedPayload(withBudget, input));
    expect(p.budgetCap).toBeNull();
  });

  it('denominates the card in the project currency, not a default', () => {
    const p = CampaignEmbedPayload.parse(
      campaignEmbedPayload(proposal, { ...input, currency: 'EUR' }),
    );
    expect(p.currency).toBe('EUR');
  });

  it('resolves 1-based citation indices to the sources the reader can open', () => {
    const p = CampaignEmbedPayload.parse(campaignEmbedPayload(proposal, input));
    expect(p.citations).toEqual([
      { sourceId: 's1', label: 'Paid acquisition for creators', url: null, effectiveDate: null },
    ]);
  });

  it('drops an index pointing past the sources rather than rendering a broken one', () => {
    // Rule 10 is about what a reader can follow. An index with nothing behind it
    // is worse than no citation, because it reads as grounding that exists.
    const p = CampaignEmbedPayload.parse(
      campaignEmbedPayload({ ...proposal, citations: [1, 9] }, input),
    );
    expect(p.citations).toHaveLength(1);
  });

  it('keeps the objective optional rather than inventing one', () => {
    const p = CampaignEmbedPayload.parse(
      campaignEmbedPayload({ ...proposal, objective: undefined }, input),
    );
    expect(p.objective).toBeUndefined();
  });

  it('names the project and task the approval will act on', () => {
    const p = CampaignEmbedPayload.parse(campaignEmbedPayload(proposal, input));
    expect(p.projectId).toBe(input.projectId);
    expect(p.taskId).toBe(input.taskId);
  });
});
