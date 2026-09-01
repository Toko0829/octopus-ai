/**
 * The four routes a node uses to do the work they took, and the one property
 * that matters more than the rest: **a thread-scoped member reads nothing through
 * a policy here**, so the route is the entire control.
 *
 * A separate file from `nodes.test.ts` rather than more cases in it. That file's
 * stub is tuned to onboarding, offers and acceptance; these routes read a
 * different set of tables and need an artifact writer, and growing one stub until
 * it serves both is how a fixture starts being the thing under test.
 *
 * What is pinned here:
 *
 *   1. **Authorisation is the caller-scoped engagement read.** A stranger naming
 *      somebody else's engagement gets 404, not 403, and nothing is written.
 *   2. **The floor check runs before anything is written and before the task
 *      moves.** A bounced submission writes no artifact and performs no update,
 *      which is why `proof_submitted -> in_progress` turned out not to be needed.
 *   3. **The task row is authoritative about what the step asks for**, so a form
 *      answering a different number of criteria is refused rather than padded.
 *   4. **Every move is conditional on the state that was read**, so a step that
 *      moved underneath the caller produces a refusal rather than a second write.
 *   5. **A proof file is only reachable through its own engagement's task**, so an
 *      artifact id from elsewhere cannot be redeemed for a signed URL.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NODE = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const PROJECT = '66666666-6666-4666-8666-666666666666';
const ARTIFACT = '77777777-7777-4777-8777-777777777777';
const FOREIGN_ARTIFACT = '88888888-8888-4888-8888-888888888888';

let profileRow: Record<string, unknown> | null;
let engagementRow: Record<string, unknown> | null;
let taskRow: Record<string, unknown> | null;
let artifactRows: Record<string, unknown>[];
let threadRows: Record<string, unknown>[];
/** What a conditional `tasks` update reports as moved. Empty means somebody else won. */
let taskUpdateMoves: Record<string, unknown>[];
let written: { table: string; op: string; values?: Record<string, unknown> }[];
let filters: { column: string; value: unknown }[];
let signedUrl: string | null;

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const applied: Record<string, unknown> = {};
      let didUpdate = false;

      const rowsFor = () => {
        if (table === 'tasks') return didUpdate ? taskUpdateMoves : taskRow ? [taskRow] : [];
        if (table === 'artifacts') {
          // The signed-URL read is constrained on task AND kind; the stub honours
          // both so a foreign artifact id genuinely returns nothing.
          return artifactRows.filter(
            (r) =>
              (applied.task_id === undefined || r.task_id === applied.task_id) &&
              (applied.kind === undefined || r.kind === applied.kind) &&
              (applied.id === undefined || r.id === applied.id),
          );
        }
        if (table === 'threads') return threadRows;
        if (table === 'room_members') return [{ user_id: NODE }];
        return [];
      };

      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          applied[column] = value;
          return b;
        },
        is: (column: string, value: unknown) => {
          filters.push({ column, value });
          return b;
        },
        in: () => b,
        order: async () => ({ data: rowsFor(), error: null }),
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          return Object.assign(b, {
            maybeSingle: async () => ({ data: { id: ARTIFACT }, error: null }),
            select: () => b,
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        update: (values: Record<string, unknown>) => {
          written.push({ table, op: 'update', values });
          didUpdate = true;
          return b;
        },
        maybeSingle: async () => {
          if (table === 'node_profiles') return { data: profileRow, error: null };
          if (table === 'engagements') {
            // Read as the caller, constrained on the id AND the node. A stranger
            // filters on their own uuid and matches nothing, which is what RLS
            // would do.
            const match =
              engagementRow &&
              applied.id === engagementRow.id &&
              applied.node_id === engagementRow.node_id;
            return { data: match ? engagementRow : null, error: null };
          }
          if (table === 'tasks') return { data: taskRow, error: null };
          if (table === 'threads') return { data: threadRows[0] ?? null, error: null };
          if (table === 'artifacts') return { data: rowsFor()[0] ?? null, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rowsFor(), error: null }),
      });
      return b;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
        createSignedUrl: async () => ({
          data: signedUrl ? { signedUrl } : null,
          error: signedUrl ? null : { message: 'no' },
        }),
      }),
    },
    async rpc() {
      return { data: null, error: null };
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

const { nodeRoutes } = await import('./nodes');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(multipart, { limits: { files: 5, fileSize: 25 * 1024 * 1024 } });
  await app.register(nodeRoutes, {
    verify: async (token: string) => ({ sub: token, role: 'user' as const }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
  });
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

/**
 * A multipart body, built by hand so the test exercises the real parser.
 *
 * Carries the auth header itself. The first draft returned only `payload` and
 * `headers`, and every call spread it after `headers: as(NODE)`, which replaced
 * the object wholesale and dropped the token: ten tests failed with 401 for a
 * reason that had nothing to do with what they were testing.
 */
function form(
  userId: string,
  fields: Record<string, string>,
  files: { name: string; type: string }[] = [],
) {
  const boundary = '----octopustest';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  for (const f of files) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\n` +
        `Content-Type: ${f.type}\r\n\r\nbytes\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return {
    payload: parts.join(''),
    headers: {
      ...as(userId),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

const LONG_NOTE = 'Shot the video on Tuesday, cut to 52 seconds, uploaded the master file.';

/** `nodes.test.ts`' factory, repeated because `NodeProfile` is parsed strictly. */
function aProfile(over: Record<string, unknown> = {}) {
  return {
    user_id: NODE,
    kyc_status: 'verified',
    availability: 'available',
    trust_score: null,
    completed_engagements: 0,
    service_jurisdictions: ['US-TX'],
    languages: ['en'],
    rate: 400,
    rate_period: 'task',
    currency: 'USD',
    ...over,
  };
}

beforeEach(() => {
  profileRow = aProfile();
  engagementRow = {
    id: ENGAGEMENT,
    task_id: TASK,
    project_id: PROJECT,
    node_id: NODE,
    ended_at: null,
  };
  taskRow = {
    id: TASK,
    project_id: PROJECT,
    state: 'escrow_funded',
    title: 'Shoot the launch video',
    acceptance_criteria: ['Under 60 seconds', 'Hook in the first 3 seconds'],
  };
  artifactRows = [];
  threadRows = [{ id: '99999999-9999-4999-8999-999999999999', task_id: TASK }];
  taskUpdateMoves = [{ id: TASK }];
  written = [];
  filters = [];
  signedUrl = 'https://storage.example/signed';
});

describe('who can reach a step at all', () => {
  it('refuses an unauthenticated caller', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 to a stranger naming an engagement that is not theirs', async () => {
    // The caller-scoped read is the authorisation. A 403 would confirm that this
    // engagement exists, which is a fact strangers do not get.
    profileRow = aProfile({ user_id: STRANGER });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(STRANGER),
    });
    expect(res.statusCode).toBe(404);
    expect(written).toHaveLength(0);
  });

  it('reads the engagement constrained on the node as well as the id', async () => {
    const app = await build();
    await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(filters).toContainEqual({ column: 'node_id', value: NODE });
  });
});

describe('starting work', () => {
  it('walks escrow_funded to in_progress', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(200);
    const move = written.find((w) => w.table === 'tasks' && w.op === 'update');
    expect(move?.values).toEqual({ state: 'in_progress' });
  });

  it('walks rejected to in_progress through the same route', async () => {
    // One button for two arcs: the node is going to work on this now, and
    // splitting them would put two controls on the console that differ only in
    // the copy above them.
    taskRow = { ...(taskRow as object), state: 'rejected' } as Record<string, unknown>;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(200);
    expect(written.find((w) => w.table === 'tasks')?.values).toEqual({ state: 'in_progress' });
  });

  it('treats an already-started step as done rather than as an error', async () => {
    taskRow = { ...(taskRow as object), state: 'in_progress' } as Record<string, unknown>;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(200);
    expect(written.filter((w) => w.table === 'tasks')).toHaveLength(0);
  });

  it('refuses a step that is not waiting to be started', async () => {
    taskRow = { ...(taskRow as object), state: 'proof_submitted' } as Record<string, unknown>;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(409);
    expect(written.filter((w) => w.table === 'tasks')).toHaveLength(0);
  });

  it('refuses an engagement that has already ended', async () => {
    engagementRow = { ...(engagementRow as object), ended_at: '2026-09-01T00:00:00Z' } as Record<
      string,
      unknown
    >;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ended');
  });

  it('refuses when the step moved between the read and the write', async () => {
    // The conditional update matched zero rows: the owner cancelled it, or a
    // sweep took it. Refused rather than retried, because what to do next
    // depends on where it went.
    taskUpdateMoves = [];
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('moved');
  });

  it('refuses a body, rather than ignoring one', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/start`,
      headers: as(NODE),
      payload: { state: 'approved' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('handing the work over', () => {
  beforeEach(() => {
    taskRow = { ...(taskRow as object), state: 'in_progress' } as Record<string, unknown>;
  });

  it('writes the proof and moves the step to proof_submitted', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, {
        note: LONG_NOTE,
        responses: JSON.stringify(['52s', 'price reveal at 0:02']),
      }),
    });
    expect(res.statusCode).toBe(201);
    const artifact = written.find((w) => w.table === 'artifacts');
    expect(artifact?.values?.kind).toBe('proof');
    expect(written.find((w) => w.table === 'tasks')?.values).toEqual({ state: 'proof_submitted' });
  });

  it('records the proof as authored by the node, not the agent', async () => {
    // `writeFileArtifact` hardcoded `created_by: 'agent'` while it had no caller.
    // A proof filed as the agent lies about its author on the one surface where
    // authorship is the point.
    const app = await build();
    await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s', 'yes']) }),
    });
    expect(written.find((w) => w.table === 'artifacts')?.values?.created_by).toBe('node');
  });

  it('writes no citations on a proof', async () => {
    // A node's proof is evidence that something happened in the world, not a
    // claim resting on a retrieved source. Rule 10 is about the second kind.
    const app = await build();
    await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s', 'yes']) }),
    });
    expect(written.find((w) => w.table === 'artifacts')?.values?.citations).toEqual([]);
  });

  it('bounces a blank criterion, writing nothing and moving nothing', async () => {
    // The whole reason `proof_submitted -> in_progress` turned out not to be
    // needed: the check runs before any write, so the step never left where it
    // was and the audit trail carries the bounce alone.
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s', '  ']) }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bounced.unaddressed).toEqual([1]);
    expect(written.filter((w) => w.table === 'artifacts')).toHaveLength(0);
    expect(written.filter((w) => w.table === 'tasks')).toHaveLength(0);
  });

  it('bounces a note too short to be a hand-over', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: 'done', responses: JSON.stringify(['52s', 'yes']) }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bounced.reasons.length).toBeGreaterThan(0);
    expect(written.filter((w) => w.table === 'tasks')).toHaveLength(0);
  });

  it('refuses a form answering a different number of criteria than the task asks for', async () => {
    // A replan can add or remove a criterion while the form is open, and
    // silently answering a question nobody asked is worse than asking somebody
    // to reload.
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s']) }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('criteria_changed');
  });

  it('accepts a step that carries no criteria at all', async () => {
    // Tasks planned before `20260816120000` have an empty array. The first
    // reader of a column must not break every row written before it existed.
    taskRow = { ...(taskRow as object), acceptance_criteria: [] } as Record<string, unknown>;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: '[]' }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a file type that is not on the allow-list', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s', 'yes']) }, [
        { name: 'payload.exe', type: 'application/x-msdownload' },
      ]),
    });
    expect(res.statusCode).toBe(415);
    expect(written.filter((w) => w.table === 'artifacts')).toHaveLength(0);
  });

  it('accepts a file that is on it, as its own row beside the note', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s', 'yes']) }, [
        { name: 'cut.mp4', type: 'video/mp4' },
      ]),
    });
    expect(res.statusCode).toBe(201);
    // One note row plus one file row: the note is not folded into the file,
    // because a file artifact carries `body: null` so it does not render as an
    // empty paragraph in the owner's panel.
    expect(written.filter((w) => w.table === 'artifacts')).toHaveLength(2);
  });

  it('refuses a step that is not open for hand-over', async () => {
    taskRow = { ...(taskRow as object), state: 'escrow_funded' } as Record<string, unknown>;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      ...form(NODE, { note: LONG_NOTE, responses: JSON.stringify(['52s', 'yes']) }),
    });
    expect(res.statusCode).toBe(409);
    expect(written.filter((w) => w.table === 'artifacts')).toHaveLength(0);
  });

  it('refuses a non-multipart body', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      headers: as(NODE),
      payload: { note: LONG_NOTE },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('reading back what was handed over', () => {
  it('returns only proof rows, never the AI drafts on the same task', async () => {
    // The filter is load-bearing rather than a convenience: without it this hands
    // a thread-scoped member every artifact on the task, which is exactly the
    // disclosure the projection-instead-of-policy decision exists to avoid.
    artifactRows = [
      {
        id: ARTIFACT,
        task_id: TASK,
        kind: 'proof',
        title: 'Proof',
        body: 'x',
        storage_path: null,
        created_at: 'now',
      },
      {
        id: FOREIGN_ARTIFACT,
        task_id: TASK,
        kind: 'draft',
        title: 'Draft',
        body: 'y',
        storage_path: null,
        created_at: 'now',
      },
    ];
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proof).toHaveLength(1);
    expect(res.json().proof[0].id).toBe(ARTIFACT);
  });

  it('does not put the storage path on the wire', async () => {
    artifactRows = [
      {
        id: ARTIFACT,
        task_id: TASK,
        kind: 'proof',
        title: 'f',
        body: null,
        storage_path: 'p/a/f.mp4',
        created_at: 'now',
      },
    ];
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/node/engagements/${ENGAGEMENT}/proof`,
      headers: as(NODE),
    });
    expect(res.json().proof[0].isFile).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain('p/a/f.mp4');
  });
});

describe('a link to a proof file', () => {
  beforeEach(() => {
    artifactRows = [
      {
        id: ARTIFACT,
        task_id: TASK,
        kind: 'proof',
        title: 'f',
        body: null,
        storage_path: 'p/a/f.mp4',
        created_at: 'now',
      },
      {
        id: FOREIGN_ARTIFACT,
        task_id: 'other',
        kind: 'proof',
        title: 'f',
        body: null,
        storage_path: 'other/a/f.mp4',
        created_at: 'now',
      },
    ];
  });

  it('signs a file on this engagement own task', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/node/engagements/${ENGAGEMENT}/proof/${ARTIFACT}/file-url`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('https://storage.example/signed');
    expect(res.json().expiresAt).toBeTruthy();
  });

  it('refuses an artifact id belonging to another task', async () => {
    // The read is constrained on `task_id` and `kind` as well as the id, so an
    // artifact id guessed or leaked from anywhere else cannot be redeemed.
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/node/engagements/${ENGAGEMENT}/proof/${FOREIGN_ARTIFACT}/file-url`,
      headers: as(NODE),
    });
    expect(res.statusCode).toBe(404);
  });
});
