import { describe, expect, it } from 'vitest';
import { hasWaiting, summariseWaiting, waitingMessage } from './waiting';
import type { TickReport, TickResult } from '@octopus/core';

/**
 * What a person is told when a task stops and waits for them.
 *
 * Before this, `NEEDS_USER` and `ESCALATED` were honest states with nothing behind
 * them: a task landed there and the person whose answer it needed was never told,
 * so a project stopped and the only evidence was rows nobody reads. The failures
 * asserted here are all of that kind, invisible rather than loud: copy that
 * overstates what is happening, and a digest that becomes chatter.
 */

function result(taskId: string, outcome: TickResult['outcome']): TickResult {
  return {
    taskId,
    outcome,
    decision: {
      target: outcome === 'failed' ? 'needs_user' : outcome,
      rule: 1,
      reason: 'x',
    } as never,
  };
}

const report = (results: TickResult[]): TickReport => ({ projectId: 'p1', results });

const titles = new Map([
  ['t1', 'Confirm the monthly ad budget'],
  ['t2', 'Choose the brand voice'],
  ['t3', 'Direct the launch creative'],
]);

describe('summariseWaiting', () => {
  it('keeps the two kinds of waiting apart', () => {
    // Only one of them is actionable. Merging them would tell somebody they can
    // answer a task that is actually waiting on a marketplace.
    const summary = summariseWaiting(
      report([result('t1', 'needs_user'), result('t3', 'escalated'), result('t9', 'ai_running')]),
    );

    expect(summary.needsUser.map((r) => r.taskId)).toEqual(['t1']);
    expect(summary.escalated.map((r) => r.taskId)).toEqual(['t3']);
  });

  it('reports nothing to say when nothing is waiting', () => {
    // The guard that stops a digest firing on every tick of a healthy project.
    expect(hasWaiting(summariseWaiting(report([result('t9', 'ai_running')])))).toBe(false);
  });
});

describe('waitingMessage', () => {
  it('names the steps in the plan words rather than handing over ids', () => {
    const message = waitingMessage(
      summariseWaiting(report([result('t1', 'needs_user'), result('t2', 'needs_user')])),
      titles,
    );

    expect(message).toContain('Confirm the monthly ad budget');
    expect(message).toContain('Choose the brand voice');
    expect(message).not.toContain('t1');
  });

  it('is one digest for several steps rather than one message each', () => {
    // ai-orchestrator.md requires batched digests and vision.md counts user
    // touches as a guardrail to drive down. Three questions are one conversation.
    const message = waitingMessage(
      summariseWaiting(
        report([result('t1', 'needs_user'), result('t2', 'needs_user'), result('t3', 'escalated')]),
      ),
      titles,
    );

    expect(message).toContain('2 steps need you');
    expect((message.match(/One step needs|steps need/g) ?? []).length).toBe(2);
  });

  it('does not claim an expert is on the way, because none is yet', () => {
    // The marketplace exists now, but a step sitting in `escalated` has not been
    // offered to anybody: dispatching it is the owner's click. A message
    // implying somebody had been contacted would still be false.
    const message = waitingMessage(summariseWaiting(report([result('t3', 'escalated')])), titles);

    expect(message).toContain('cannot start these myself');
    expect(message).not.toMatch(/expert (is|has been) (on the way|contacted|found)/i);
  });

  it('points at the panel, because that is where the three ways forward are', () => {
    // The retired copy said "I cannot bring one in yet", which stopped being
    // true the moment "Find an expert" appeared beside the other two buttons.
    const message = waitingMessage(summariseWaiting(report([result('t3', 'escalated')])), titles);

    expect(message).toContain('project panel');
    expect(message).not.toContain('cannot bring one in yet');
  });

  it('says nothing was spent when work has stopped', () => {
    const message = waitingMessage(summariseWaiting(report([result('t3', 'escalated')])), titles);
    expect(message).toContain('Nothing has been spent');
  });

  it('falls back to a placeholder rather than printing undefined', () => {
    // A title missing from the map is a read that returned less than expected,
    // and "undefined" in a chat message is the kind of detail that costs trust
    // out of proportion to the bug behind it.
    const message = waitingMessage(summariseWaiting(report([result('zz', 'needs_user')])), titles);
    expect(message).toContain('an unnamed step');
    expect(message).not.toContain('undefined');
  });

  it('never uses an em dash', () => {
    const message = waitingMessage(
      summariseWaiting(report([result('t1', 'needs_user'), result('t3', 'escalated')])),
      titles,
    );
    expect(message).not.toContain('—');
  });

  it('uses the singular when one step waits', () => {
    const message = waitingMessage(summariseWaiting(report([result('t1', 'needs_user')])), titles);
    expect(message).toContain('one step needs you');
  });

  it('points at the card rather than advertising a chat escape that no longer exists', () => {
    // Answers used to be chat messages, and the copy taught a "new goal:" prefix
    // for typing something else while a card was open. Every message is a goal
    // now, so the prefix would be a lie about how the room works.
    const message = waitingMessage(summariseWaiting(report([result('t1', 'needs_user')])), titles);
    expect(message).not.toContain('new goal');
    expect(message).toContain('card');
  });
});
