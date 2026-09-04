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

/**
 * Real uuids, because `ArtifactEmbedPayload` checks them.
 *
 * They were short strings until the card started carrying files, and the payload
 * quietly failed to parse on every run of this suite: `postArtifact` catches that
 * throw, logs it and delivers the message anyway, so the delivery assertions all
 * passed while the card they describe was never written. Nothing here asserted on
 * `action_embeds`, so nothing noticed.
 */
const TASK = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';
const ARTIFACT = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
/** The ids `writeFileArtifact` is stubbed to hand back, one per stored image. */
const ASSET_IDS = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'];

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
  model_routes: TableState;
  model_connections: TableState;
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
  provider?: string | null;
  model?: string | null;
};

/** Every `generation` the loop put on a request, so a routed run can be seen. */
let sentTargets: unknown[];

/** Every `creative` capability the loop put on a request, for the same reason. */
let sentCreative: unknown[];

/** What the stubbed generator draws, and what stops it. Reassigned per test. */
let generated: { bytes: Uint8Array; contentType: string }[];
let generationFailure: Error | null;
let imageCalls: { target: unknown; request: unknown }[];

/** Every file the loop asked to be stored, and the failure that stops storing. */
let storedFiles: Record<string, unknown>[];
let storeFailure: Error | null;

/** Thrown by the stubbed call when a test wants the transport to fail. */
let executionError: Error | null;

/**
 * Runs when the `tasks` update lands, so a test can move the row underneath the
 * loop the way a replan would. Returning `false` from it is not how the race is
 * simulated: the conditional write itself has to miss, which is what setting the
 * row's state to `cancelled` here achieves.
 */
let onTaskUpdate: (() => void) | null;

vi.mock('./ai', () => ({
  AiServiceError: class AiServiceError extends Error {},
  requestExecution: async (_url: string, input: { generation?: unknown; creative?: unknown }) => {
    sentTargets.push(input.generation ?? null);
    sentCreative.push(input.creative ?? null);
    if (executionError) throw executionError;
    return execution;
  },
}));

// The vendor call is stubbed and the error type is not: `imageFailureSentence`
// and `ImageGenError` decide what a person is told, and a fake version of either
// would leave the sentence in the room untested.
vi.mock('./image-gen', async () => {
  const actual = await vi.importActual<typeof import('./image-gen')>('./image-gen');
  return {
    ...actual,
    generateImages: async (target: unknown, request: unknown) => {
      imageCalls.push({ target, request });
      if (generationFailure) throw generationFailure;
      return generated;
    },
  };
});

// Storage has no fake in this file's `admin`, and it does not need one: what the
// loop owes is a correct call per image, which is what this records.
vi.mock('./artifact-files', () => ({
  writeFileArtifact: async (_admin: unknown, input: Record<string, unknown>) => {
    if (storeFailure) throw storeFailure;
    storedFiles.push(input);
    return { artifactId: ASSET_IDS[storedFiles.length - 1]!, storagePath: 'p/a/image.png' };
  },
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
    model_routes: { rows: [] },
    model_connections: { rows: [] },
  };
  written = [];
  sentTargets = [];
  sentCreative = [];
  imageCalls = [];
  generationFailure = null;
  generated = [{ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }];
  storedFiles = [];
  storeFailure = null;
  executionError = null;
  onTaskUpdate = null;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  execution = {
    core: 'test',
    reasoning_summary: '',
    provider: 'openai',
    model: 'gpt-5.4',
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
    expect(written.find((w) => w.table === 'messages' && w.op === 'insert')?.values?.persona).toBe(
      'content',
    );

    written.length = 0;
    tables.messages.rows = [];
    tables.tasks.rows[0]!.state = 'ai_running';
    tables.tasks.rows[0]!.stage = 'channels';
    await run();
    expect(written.find((w) => w.table === 'messages' && w.op === 'insert')?.values?.persona).toBe(
      'ads',
    );
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

/**
 * Attribution (ADR-0032). Which model produced a step's output is recorded in
 * three places, and the three are not redundant: the message names it to the
 * person reading the room, `task_runs` keeps it per attempt so the heal sweep can
 * re-deliver work it did not make, and the events carry it beside the persona so
 * the audit trail does not have to re-derive it from a row somebody may later
 * read differently.
 *
 * **What is recorded is what answered, not what was asked for.** The service
 * reports the model that ran, and a service that ignored a target would otherwise
 * be recorded as having honoured it.
 */
describe('executeTask · which model wrote it', () => {
  const runRow = () => written.find((w) => w.table === 'task_runs' && w.op === 'update');
  const artifactMessage = () => written.find((w) => w.table === 'messages' && w.op === 'insert');

  it('stamps the delivered artifact with the model that answered', async () => {
    execution.model = 'gemini-3.8-flash';
    execution.provider = 'google';
    await run();
    expect(artifactMessage()?.values?.model).toBe('gemini-3.8-flash');
  });

  it('records the provider and model on the attempt', async () => {
    execution.model = 'claude-sonnet-5';
    execution.provider = 'anthropic';
    await run();
    expect(runRow()?.values).toMatchObject({
      status: 'succeeded',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  it('carries them on the review verdict and on every executed hop', async () => {
    await run();
    const payloads = written
      .filter((w) => w.table === 'events')
      .map((w) => w.values?.payload as { provider?: string | null; model?: string | null });
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((p) => p.model === 'gpt-5.4' && p.provider === 'openai')).toBe(true);
  });

  it('records nulls when the service names nothing, rather than guessing', async () => {
    // An older service on the house path. Null means "nobody recorded which",
    // which is true; inferring `gpt-5.4` from our own configuration would write
    // a guess into an audit trail, where a guess and a fact look identical.
    execution.provider = null;
    execution.model = null;
    await run();
    expect(runRow()?.values).toMatchObject({ provider: null, model: null });
    expect(artifactMessage()?.values?.model).toBeNull();
  });

  it('sends no target for a room that has routed nothing', async () => {
    await run();
    expect(sentTargets).toEqual([null]);
  });
});

describe('executeTask · a routed room', () => {
  /**
   * The whole seam end to end, with a real sealed key: a route on the step's own
   * stage, an active connection, and the master key the row was sealed under.
   *
   * The stage picks the role exactly as it picks the voice, so a `content` step
   * is written by Content on the model routed to Content. That is the property
   * worth driving through the real `resolveGeneration` rather than a stub: the
   * mapping from stage to role runs through `personaForStage`, and a stub would
   * have proved only that this file agrees with itself.
   */
  const HEX = 'a'.repeat(64);
  const KEY = 'sk-ant-live-not-a-real-key-4f2a';

  beforeEach(async () => {
    const { modelConnectionAad, parseMasterKey, seal } = await import('./envelope');
    const sealed = seal(KEY, parseMasterKey(HEX), modelConnectionAad(ROOM, 'anthropic', 1));
    tables.tasks.rows[0]!.stage = 'content';
    tables.model_routes.rows = [
      { room_id: ROOM, role: 'content', provider: 'anthropic', model: 'claude-sonnet-5' },
    ];
    tables.model_connections.rows = [
      {
        room_id: ROOM,
        provider: 'anthropic',
        status: 'active',
        key_ciphertext: sealed.ciphertext,
        key_iv: sealed.iv,
        key_tag: sealed.tag,
        key_version: 1,
      },
    ];
    execution.provider = 'anthropic';
    execution.model = 'claude-sonnet-5';
  });

  function routedRun() {
    return executeTask(TASK, {
      admin: admin() as never,
      aiServiceUrl: 'http://ai:8000',
      modelKeySecret: HEX,
      log,
    });
  }

  it('sends the route belonging to the step stage, with the decrypted key', async () => {
    await routedRun();
    expect(sentTargets).toEqual([
      {
        vendor: 'anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: KEY,
        baseUrl: null,
      },
    ]);
  });

  it('logs the provider and the model, and never the key', async () => {
    await routedRun();
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).toContain('claude-sonnet-5');
    expect(logged).not.toContain(KEY);
  });

  it('fails the whole task rather than half of it when the key cannot be opened', async () => {
    // A master key that does not match the seal. Thrown rather than caught: the
    // next attempt would fail the same way, so burning both attempts and
    // escalating would hand a person a problem only an operator can fix.
    await expect(
      executeTask(TASK, {
        admin: admin() as never,
        aiServiceUrl: 'http://ai:8000',
        modelKeySecret: 'b'.repeat(64),
        log,
      }),
    ).rejects.toMatchObject({ name: 'ModelRoutingError', kind: 'unreadable' });
    expect(written.filter((w) => w.table === 'task_runs')).toHaveLength(0);
  });

  it('records where a failed attempt was sent, since there is no answer to read', async () => {
    executionError = new Error('socket hang up');
    await routedRun();
    const failed = written.filter((w) => w.table === 'task_runs' && w.op === 'update');
    expect(failed[0]?.values).toMatchObject({
      status: 'failed',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });
});

describe('executeTask · the images that come with a brief', () => {
  /**
   * The first deliverable this loop produces that is not text, and every property
   * here is a way it could quietly cost somebody something.
   *
   * The brief is the deliverable and the images ride with it (ADR-0033), so the
   * shape of every failure is the same: the step still finishes, the brief still
   * lands, and the room is told in one sentence why it is thinner than the brief
   * said it would be.
   */
  const HEX = 'a'.repeat(64);
  const KEY = 'AIza-not-a-real-key-4f2a';

  beforeEach(async () => {
    const { modelConnectionAad, parseMasterKey, seal } = await import('./envelope');
    const sealed = seal(KEY, parseMasterKey(HEX), modelConnectionAad(ROOM, 'google', 1));
    tables.tasks.rows[0]!.stage = 'creative';
    tables.model_routes.rows = [
      { room_id: ROOM, role: 'creative', provider: 'google', model: 'gemini-3.1-flash-image' },
    ];
    tables.model_connections.rows = [
      {
        room_id: ROOM,
        provider: 'google',
        status: 'active',
        key_ciphertext: sealed.ciphertext,
        key_iv: sealed.iv,
        key_tag: sealed.tag,
        key_version: 1,
      },
    ];
    execution.proposals = [
      ...execution.proposals,
      {
        kind: 'generate_image',
        prompt: 'Concept: one lamp in an empty office.',
        count: 2,
        aspect: '1:1',
      } as never,
    ];
  });

  function creativeRun(imageGenEnabled = true) {
    return executeTask(TASK, {
      admin: admin() as never,
      aiServiceUrl: 'http://ai:8000',
      modelKeySecret: HEX,
      imageGenEnabled,
      log,
    });
  }

  it('tells the core it can draw, without handing it the key', async () => {
    await creativeRun();
    expect(sentCreative[0]).toEqual({
      provider: 'google',
      model: 'gemini-3.1-flash-image',
      images: true,
    });
    // The credential stays on this side: the core never generates an image.
    expect(JSON.stringify(sentCreative)).not.toContain(KEY);
  });

  it('draws with the workspace key and stores one asset per image', async () => {
    generated = [
      { bytes: new Uint8Array([1]), contentType: 'image/png' },
      { bytes: new Uint8Array([2]), contentType: 'image/png' },
    ];
    await creativeRun();

    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0]?.target).toMatchObject({ provider: 'google', apiKey: KEY });
    expect(imageCalls[0]?.request).toMatchObject({ count: 2, aspect: '1:1' });
    expect(storedFiles).toHaveLength(2);
    expect(storedFiles[0]).toMatchObject({
      kind: 'asset',
      contentType: 'image/png',
      createdBy: 'agent',
      citations: [],
    });
  });

  it('draws after the review, so a brief that failed its own check costs nothing', async () => {
    await creativeRun();
    const approved = written.indexOf(taskWrite('approved')[0]!);
    const message = written.findIndex((w) => w.table === 'messages' && w.op === 'insert');
    expect(approved).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(approved);
  });

  it('puts the images on the card as ids and types, never as a link', async () => {
    await creativeRun();
    const embed = written.find((w) => w.table === 'action_embeds' && w.op === 'insert');
    const payload = embed?.values?.payload as { files: { artifactId: string }[] };
    expect(payload.files).toEqual([{ artifactId: ASSET_IDS[0], contentType: 'image/png' }]);
    // A signed URL is a ten-minute bearer credential and this row is stored and
    // re-broadcast, so nothing that looks like one may reach it.
    expect(JSON.stringify(payload)).not.toContain('http');
  });

  it('delivers the brief and says why when the provider refuses', async () => {
    const { ImageGenError } = await import('./image-gen');
    generationFailure = new ImageGenError('auth', 'refused');
    await creativeRun();

    expect(tables.tasks.rows[0]?.state).toBe('done');
    const message = written.find((w) => w.table === 'messages' && w.op === 'insert');
    expect(String(message?.values?.body)).toContain('refused the workspace key');
    expect(String(message?.values?.body)).toContain('Positioning brief');
    const embed = written.find((w) => w.table === 'action_embeds' && w.op === 'insert');
    expect((embed?.values?.payload as { files: unknown[] }).files).toEqual([]);
  });

  it('delivers the brief and says why when the images cannot be stored', async () => {
    storeFailure = new Error('bucket unreachable');
    await creativeRun();
    expect(tables.tasks.rows[0]?.state).toBe('done');
    expect(String(written.find((w) => w.table === 'messages')?.values?.body)).toContain(
      'could not be stored',
    );
  });

  it('draws nothing when the deployment has the flag off, and does not offer to', async () => {
    await creativeRun(false);
    // Withheld from the core rather than ignored on the way back: told it can be
    // drawn, the core opens the brief by saying images are coming, and a
    // deployment that then drew none would have put that sentence in the work.
    expect(sentCreative[0]).toBeNull();
    expect(imageCalls).toHaveLength(0);
    expect(storedFiles).toHaveLength(0);
  });

  it('draws nothing when Creative is routed at a model that cannot make images', async () => {
    tables.model_routes.rows[0]!.model = 'gemini-3.8-flash';
    await creativeRun();
    expect(sentCreative[0]).toBeNull();
    expect(imageCalls).toHaveLength(0);
  });

  it('does not draw again for a task that already has images', async () => {
    // The executor is not durable, so a crash after the images and before the
    // delivery leaves the heal sweep to finish the step. Spending somebody's
    // quota a second time for pictures they already have is the failure that
    // costs real money.
    tables.artifacts.rows.push({
      id: ASSET_IDS[1],
      task_id: TASK,
      kind: 'asset',
      content_type: 'image/png',
    });
    await creativeRun();
    expect(imageCalls).toHaveLength(0);
    const embed = written.find((w) => w.table === 'action_embeds' && w.op === 'insert');
    expect((embed?.values?.payload as { files: { artifactId: string }[] }).files).toEqual([
      { artifactId: ASSET_IDS[1], contentType: 'image/png' },
    ]);
  });
});

describe('executeTask · a workspace that has connected nothing', () => {
  it('offers the core no creative capability, and the ordinary path is unchanged', async () => {
    await run();
    expect(sentCreative).toEqual([null]);
    expect(imageCalls).toHaveLength(0);
    // No sentence about images either: the brief itself says this system does
    // not generate them, and a second message repeating it would be noise on
    // every creative step of every workspace that has connected nothing.
    const message = written.find((w) => w.table === 'messages' && w.op === 'insert');
    expect(String(message?.values?.body)).not.toContain('the brief above is the deliverable');
  });
});
