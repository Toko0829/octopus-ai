/**
 * What a tick does, and the two things it deliberately refuses to do:
 * claim `ai_running` with no executor, and let one bad task freeze a project.
 */

import { describe, expect, it, vi } from 'vitest';
import { tick, summarise, type SchedulerPorts } from './scheduler';
import type { RoutableTask } from './router';

function task(over: Partial<RoutableTask> = {}): RoutableTask {
  return { id: 't1', ownerType: 'ai', riskTier: 'reversible', citations: [1], ...over };
}

function ports(tasks: RoutableTask[], over: Partial<SchedulerPorts> = {}): SchedulerPorts {
  return {
    readyTasks: async () => tasks,
    transition: async () => {},
    ...over,
  };
}

/**
 * The single result of a one-task tick.
 *
 * A helper rather than `results[0]!`, because the count is part of what these
 * tests mean: a tick that produced two results, or none, has already failed
 * whatever the first one says.
 */
function only<T>(results: T[]): T {
  expect(results).toHaveLength(1);
  return results[0] as T;
}

describe('the transition path', () => {
  it('walks pending to ready to routing before deciding anything', async () => {
    // Collapsed into one jump this would be faster and would lose the record of
    // the task having been routed, which is what you need to ask why it went
    // where it went.
    const seen: string[] = [];
    const p = ports([task({ ownerType: 'user' })], {
      transition: async (_id, to) => {
        seen.push(to);
      },
    });

    await tick('p1', p);

    expect(seen).toEqual(['ready', 'routing', 'needs_user']);
  });

  it('records why dependencies clearing is a separate fact from where it went', async () => {
    const reasons: string[] = [];
    const p = ports([task({ ownerType: 'human' })], {
      transition: async (_id, _to, reason) => {
        reasons.push(reason);
      },
    });

    await tick('p1', p);

    expect(reasons[0]).toMatch(/dependencies/i);
    expect(reasons[2]).toMatch(/marketplace|human/i);
    expect(reasons).toHaveLength(3);
  });
});

describe('it will not claim an executor it does not have', () => {
  it('leaves an AI task in routing when no executor is supplied', async () => {
    const seen: string[] = [];
    const p = ports([task()], {
      transition: async (_id, to) => {
        seen.push(to);
      },
    });

    const report = await tick('p1', p);

    expect(seen).toEqual(['ready', 'routing']);
    expect(only(report.results).outcome).toBe('awaiting_executor');
    expect(seen).not.toContain('ai_running');
  });

  it('does move to ai_running once an executor exists', async () => {
    const dispatchAi = vi.fn(async () => {});
    const seen: string[] = [];
    const p = ports([task()], {
      transition: async (_id, to) => {
        seen.push(to);
      },
      dispatchAi,
    });

    const report = await tick('p1', p);

    expect(seen).toEqual(['ready', 'routing', 'ai_running']);
    expect(dispatchAi).toHaveBeenCalledWith('t1');
    expect(only(report.results).outcome).toBe('ai_running');
  });

  it('still sets escalated and needs_user with nothing behind them', async () => {
    // Both mean "waiting for someone", which is true the moment it is set. That
    // is different from ai_running, which asserts work is happening.
    const p = ports([task({ ownerType: 'human' }), task({ id: 't2', ownerType: 'user' })]);

    const report = await tick('p1', p);

    expect(report.results.map((r) => r.outcome)).toEqual(['escalated', 'needs_user']);
  });
});

describe('one bad task does not freeze the project', () => {
  it('continues past a failure and records it', async () => {
    const p = ports(
      [task({ id: 'bad', ownerType: 'user' }), task({ id: 'good', ownerType: 'user' })],
      {
        transition: async (id) => {
          if (id === 'bad') throw new Error('illegal task transition');
        },
      },
    );

    const report = await tick('p1', p);

    expect(report.results.map((r) => r.outcome)).toEqual(['failed', 'needs_user']);
    expect(report.results[0]?.error).toContain('illegal task transition');
  });

  it('does not swallow the refusal', async () => {
    // The guard in Postgres is the authority. A scheduler that quietly skipped
    // rejected transitions would hide the disagreement rather than surface it.
    const p = ports([task({ ownerType: 'user' })], {
      transition: async () => {
        throw new Error('nope');
      },
    });

    const report = await tick('p1', p);

    expect(only(report.results).outcome).toBe('failed');
    expect(only(report.results).error).toBe('nope');
  });
});

describe('reporting', () => {
  it('summarises a mixed tick', async () => {
    const p = ports([
      task({ id: 'a' }),
      task({ id: 'b', ownerType: 'human' }),
      task({ id: 'c', ownerType: 'user' }),
      task({ id: 'd', riskTier: 'high_risk' }),
    ]);

    const counts = summarise(await tick('p1', p));

    expect(counts).toEqual({
      ai_running: 0,
      escalated: 1,
      needs_user: 2,
      awaiting_executor: 1,
      failed: 0,
    });
  });

  it('does nothing when nothing is ready', async () => {
    const report = await tick('p1', ports([]));

    expect(report.results).toEqual([]);
    expect(summarise(report).failed).toBe(0);
  });
});
