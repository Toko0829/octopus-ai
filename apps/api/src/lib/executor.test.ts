/**
 * The maker-checker loop, and the property this file was written for: an AI step
 * that passes its own check reaches a **terminal** state.
 *
 * Until it did, `executeTask` stopped at `approved`, which is not terminal, and
 * "anything non-terminal may be cancelled" is a universal rule of the task map.
 * So a step that had produced its artifact, passed the checker and been
 * delivered into the room could still be cancelled by a later replan and
 * recorded in the audit trail as abandoned work. `settle_payout` closed the same
 * hole on the human arm in slice 7 and said, in its own header, that this arm
 * was `business-projects-workflow.md`'s to close.
 *
 * What is pinned here:
 *
 *   1. **A passing review walks `ai_self_check -> approved -> done`**, in that
 *      order, and the `done` write is conditional on `approved` so a replay
 *      cannot walk it twice.
 *   2. **The artifact is delivered only after the step is finished.** The
 *      ordering is the crash argument: the artifact row already exists before
 *      `approved`, so announcing it first would only widen the window in which a
 *      delivered step is still cancellable.
 *   3. **Losing the race is not a failure.** If something walks the task out of
 *      `approved` in between, which `approved -> cancelled` legally may, the loop
 *      warns and delivers nothing rather than announcing work that was cancelled.
 *   4. **A failing review never reaches `done`.** The checker owns the verdict,
 *      and an escalated step is somebody else's now.
 *
 * There was no test file here at all before this one; the loop was covered only
 * through `critic.test.ts`'s pure verdict.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const TASK = 't1';
const PROJECT = 'p1';
const ROOM = 'r1';
const ARTIFACT = 'a1';
const RUN = 'run1';

/** A body over the checker's 40-character floor, so a pass is a real pass. */
const BODY = 'A full paragraph of usable draft output for the step, well over the floor.';

interface TableState {
  rows: Record<string, unknown>[];
}

interface Tables {
  tasks: TableState;
  task_runs: TableState;
  artifacts: TableState;
  messages: TableState;
  action_embeds: TableState;
  events: TableState;
}

let tables: Tables;
let written: { table: string; op: string; values?: Record<string, unknown>; on: string[] }[];
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

/** What the fake AI service returns. Reassigned per test. */
let execution: {
  core: string;
  reasoning_summary: string;
  citations: { label: string }[];
  proposals: { kind: string; title: string; body: string; citations: string[] }[];
};

/**
 * Runs when the `tasks` update lands, so a test can move the row underneath the
 * loop the way a replan would. Returning `false` from it is not how the race is
 * simulated: the conditional write itself has to miss, which is what setting the
 * row's state to `cancelled` here achieves.
 */
let onTaskUpdate: (() => void) | null;

vi.mock('./ai', () => ({
  AiServiceError: class AiServiceError extends Error {},
  requestExecution: async () => execution,
}));

vi.mock('./room-for-project', () => ({
  planContextForProject: async () => [],
  roomForProject: async () => ROOM,
}));

const { executeTask } = await import('./executor');

function admin() {
  return {
    from(table: string) {
      const state = tables[table as keyof Tables] ?? { rows: [] };
      const applied: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};

      const matches = () =>
        state.rows.filter((row) => Object.entries(applied).every(([col, val]) => row[col] === val));

      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied[column] = value;
          return b;
        },
        order: () => b,
        limit: async () => ({ data: matches(), error: null }),
        update: (values: Record<string, unknown>) => {
          // **Applied at the end of the chain, not here**, and the difference is
          // the whole test. PostgREST builders read `.update(...).eq(...).eq(...)`,
          // so at this point no filter has been declared yet; mutating now would
          // make every conditional write unconditional and a fake that cannot
          // miss cannot show that the real one does.
          const entry: (typeof written)[number] = { table, op: 'update', values, on: [] };
          written.push(entry);
          const apply = () => {
            entry.on = Object.keys(applied);
            const hit = matches();
            for (const row of hit) Object.assign(row, values);
            if (table === 'tasks' && hit.length > 0) onTaskUpdate?.();
            return hit;
          };
          return Object.assign(b, {
            select: () =>
              Object.assign(b, {
                maybeSingle: async () => {
                  const hit = apply();
                  return { data: hit[0] ?? null, error: null };
                },
                then: (resolve: (v: unknown) => unknown) => resolve({ data: apply(), error: null }),
              }),
          });
        },
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values, on: [] });
          const id = table === 'artifacts' ? ARTIFACT : table === 'task_runs' ? RUN : `${table}-1`;
          state.rows.push({ id, ...values });
          return Object.assign(b, {
            select: () =>
              Object.assign(b, {
                maybeSingle: async () => ({ data: { id }, error: null }),
              }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matches(), error: null }),
      });
      return b;
    },
  };
}

/** Every `tasks` state write, in order, which is the walk itself. */
const walk = () =>
  written
    .filter((w) => w.table === 'tasks' && w.op === 'update')
    .map((w) => w.values?.state as string);

const taskWrite = (state: string) =>
  written.filter((w) => w.table === 'tasks' && w.values?.state === state);

beforeEach(() => {
  tables = {
    tasks: {
      rows: [
        {
          id: TASK,
          project_id: PROJECT,
          title: 'Write the positioning brief',
          detail: 'Do the thing',
          stage: 'positioning',
          citations: [1],
          state: 'ai_running',
        },
      ],
    },
    task_runs: { rows: [] },
    artifacts: { rows: [] },
    messages: { rows: [] },
    action_embeds: { rows: [] },
    events: { rows: [] },
  };
  written = [];
  onTaskUpdate = null;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  execution = {
    core: 'test',
    reasoning_summary: '',
    citations: [{ label: 'Positioning and ICP' }],
    proposals: [
      {
        kind: 'write_artifact',
        title: 'Positioning brief',
        body: BODY,
        citations: ['Positioning and ICP'],
      },
    ],
  };
});

function run() {
  return executeTask(TASK, {
    admin: admin() as never,
    aiServiceUrl: 'http://ai:8000',
    log,
  });
}

describe('executeTask · a step that passes its own check', () => {
  it('walks ai_self_check to approved to done', async () => {
    await run();
    expect(walk()).toEqual(['ai_self_check', 'approved', 'done']);
  });

  it('reaches a terminal state, so a replan can no longer cancel finished work', async () => {
    await run();
    expect(tables.tasks.rows[0]?.state).toBe('done');
  });

  it('makes the done write conditional on approved, so a replay cannot walk it twice', async () => {
    await run();
    const [done, ...extra] = taskWrite('done');
    expect(extra).toHaveLength(0);
    expect(done?.on).toContain('state');
  });

  it('delivers the artifact into the room once the step is finished', async () => {
    await run();
    const message = written.find((w) => w.table === 'messages' && w.op === 'insert');
    expect(message?.values?.idempotency_key).toBe(`artifact:${ARTIFACT}`);
    // Ordering, not just presence. The artifact row already exists by the time
    // the step is approved, so announcing before finishing would only widen the
    // window in which delivered work is still cancellable.
    expect(written.indexOf(message!)).toBeGreaterThan(written.indexOf(taskWrite('done')[0]!));
  });

  it('signs the delivery with the voice that owns the step stage', async () => {
    // `positioning` is not one of the six funnel stages. The planner has
    // written stages this repository did not expect before, and `tasks.stage` is
    // free text, so the fallback is the case that actually runs in production
    // rather than a defensive branch: an unrecognised stage is delivered by the
    // Strategist rather than throwing away the work.
    await run();
    const message = written.find((w) => w.table === 'messages' && w.op === 'insert');
    expect(message?.values?.author_kind).toBe('agent');
    expect(message?.values?.persona).toBe('strategist');
  });

  it('delivers a content-stage step as Content', async () => {
    tables.tasks.rows[0]!.stage = 'content';
    await run();
    const message = written.find((w) => w.table === 'messages' && w.op === 'insert');
    expect(message?.values?.persona).toBe('content');
  });

  it('delivers a conversion-stage step as Content too, and a channels one as Ads', async () => {
    // Conversion is the division worth pinning: a landing page is a piece of
    // writing before it is a channel, so it belongs to the same voice that
    // wrote the copy pointing at it.
    tables.tasks.rows[0]!.stage = 'conversion';
    await run();
    expect(
      written.find((w) => w.table === 'messages' && w.op === 'insert')?.values?.persona,
    ).toBe('content');

    written.length = 0;
    tables.messages.rows = [];
    tables.tasks.rows[0]!.state = 'ai_running';
    tables.tasks.rows[0]!.stage = 'channels';
    await run();
    expect(
      written.find((w) => w.table === 'messages' && w.op === 'insert')?.values?.persona,
    ).toBe('ads');
  });

  it('records the voice on both events, so the audit trail names a speaker', async () => {
    // `task.executed` reads the stage off the row the update returned, which is
    // why `transition` selects it. Without that, every executed hop would be
    // labelled Strategist: plausible, and wrong for five stages out of six.
    tables.tasks.rows[0]!.stage = 'measurement';
    await run();
    const personas = written
      .filter((w) => w.table === 'events')
      .map((w) => (w.values?.payload as { persona?: string }).persona);
    expect(personas).toContain('analyst');
    expect(personas.every((p) => p === 'analyst')).toBe(true);
  });

  it('records why it moved, on both hops', async () => {
    await run();
    const reasons = written
      .filter((w) => w.table === 'events' && w.values?.verb === 'task.executed')
      .map((w) => (w.values?.payload as { to: string }).to);
    expect(reasons).toContain('approved');
    expect(reasons).toContain('done');
  });
});

describe('executeTask · when the step moves underneath the loop', () => {
  /**
   * `approved -> cancelled` is a legal arc and a replan may walk it in exactly
   * the window between the two writes. That is a race rather than a defect, so
   * the loop must not throw, and must not then announce the work: the step was
   * cancelled, and a delivery message would tell the room otherwise.
   */
  beforeEach(() => {
    onTaskUpdate = () => {
      const row = tables.tasks.rows[0];
      if (row?.state === 'approved') row.state = 'cancelled';
    };
  });

  it('does not throw', async () => {
    await expect(run()).resolves.toBeUndefined();
  });

  it('says so rather than failing silently', async () => {
    await run();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK }),
      expect.stringContaining('without reaching done'),
    );
  });

  it('delivers nothing, because the step was cancelled', async () => {
    await run();
    expect(written.filter((w) => w.table === 'messages')).toHaveLength(0);
  });
});

describe('executeTask · a step that fails its check', () => {
  it('never reaches done when the checker escalates a fabricated citation', async () => {
    // Fabrication is the one failure `nextStateAfterReview` refuses to retry, so
    // this escalates on the first attempt rather than after two.
    execution.proposals[0]!.citations = ['A source nobody supplied'];
    await run();
    expect(walk()).toEqual(['ai_self_check', 'escalated']);
    expect(taskWrite('done')).toHaveLength(0);
  });

  it('never reaches done when the core declines to execute', async () => {
    execution.proposals = [];
    await run();
    expect(walk()).toEqual(['escalated']);
    expect(taskWrite('done')).toHaveLength(0);
  });
});
