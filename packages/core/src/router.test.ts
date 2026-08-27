/**
 * The router's rules, and specifically the two that override the planner.
 *
 * These are the first Node-side tests in the repository. That gap was recorded in
 * the README as missing rather than unnecessary, and this is the module that
 * makes it untenable: the router decides whether something runs unsupervised, and
 * "read it carefully" is not a control.
 */

import { describe, expect, it } from 'vitest';
import { routeTask, type RoutableTask } from './router';

function task(over: Partial<RoutableTask> = {}): RoutableTask {
  return { id: 't1', ownerType: 'ai', riskTier: 'reversible', citations: [1], ...over };
}

describe('the planner proposes, the router decides', () => {
  it('refuses to auto-run a high-risk task even when the plan said AI', () => {
    const decision = routeTask(task({ ownerType: 'ai', riskTier: 'high_risk' }));

    expect(decision.target).toBe('needs_user');
    expect(decision.rule).toBe('high_risk_needs_authorisation');
  });

  it('outranks owner_type for high risk regardless of who was named', () => {
    // The planner is a language model. If believing owner_type were enough, the
    // authorisation rule would live in the prompt again, which is what rules 7
    // and 11 forbid.
    for (const ownerType of ['ai', 'human', 'user'] as const) {
      expect(routeTask(task({ ownerType, riskTier: 'high_risk' })).target).toBe('needs_user');
    }
  });

  it('will not let an uncited step run unsupervised', () => {
    const decision = routeTask(task({ ownerType: 'ai', citations: [] }));

    expect(decision.target).toBe('escalated');
    expect(decision.rule).toBe('uncited_cannot_auto_run');
  });

  it('still runs uncited read-only work, because it gates nothing', () => {
    // Escalating research that changes nothing would bury the marketplace in
    // zero-risk work, and a safety rule that produces noise gets switched off.
    const decision = routeTask(task({ ownerType: 'ai', riskTier: 'read_only', citations: [] }));

    expect(decision.target).toBe('ai_running');
  });
});

describe('the ordinary cases', () => {
  it('sends a grounded, reversible AI step to the executor', () => {
    expect(routeTask(task()).target).toBe('ai_running');
  });

  it('sends human-owned work to the marketplace', () => {
    expect(routeTask(task({ ownerType: 'human' })).target).toBe('escalated');
  });

  it('sends user-owned work back to the person', () => {
    expect(routeTask(task({ ownerType: 'user' })).target).toBe('needs_user');
  });

  it('escalates a human-owned step before checking citations', () => {
    // Order matters: a human step with no citations is a human step, not an
    // uncited-AI problem, and reporting the wrong rule sends debugging astray.
    const decision = routeTask(task({ ownerType: 'human', citations: [] }));

    expect(decision.rule).toBe('human_owned');
  });
});

describe('every decision is explainable', () => {
  it('names the rule that fired and gives a reason', () => {
    const inputs: RoutableTask[] = [
      task(),
      task({ riskTier: 'high_risk' }),
      task({ ownerType: 'human' }),
      task({ ownerType: 'user' }),
      task({ citations: [] }),
    ];

    for (const input of inputs) {
      const decision = routeTask(input);
      expect(decision.rule).toBeTruthy();
      expect(decision.reason.length).toBeGreaterThan(10);
      // Product copy: no em dashes (AGENTS.md rule 22). These reasons reach the
      // audit event and the chat notice.
      expect(decision.reason).not.toContain('—');
    }
  });

  it('only ever returns a state the machine allows out of routing', () => {
    const allowed = new Set(['ai_running', 'escalated', 'needs_user']);
    const inputs: RoutableTask[] = [
      task(),
      task({ riskTier: 'high_risk' }),
      task({ riskTier: 'external' }),
      task({ riskTier: 'read_only', citations: [] }),
      task({ ownerType: 'human' }),
      task({ ownerType: 'user' }),
    ];

    for (const input of inputs) {
      expect(allowed.has(routeTask(input).target)).toBe(true);
    }
  });
});
