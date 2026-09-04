/**
 * Which model drafts a campaign card, and what the card records about it.
 *
 * Its own file rather than an addition to `campaign-cards.test.ts`, because that
 * one tests the two pure helpers and needs no mocks at all: pulling `./ai` and
 * `./room-for-project` into it would put a module factory in front of a file
 * whose whole value is that it has none.
 *
 * **Ads by name, on the step's own stage's route only by accident.** A campaign
 * card is drafted for any step the router parked as needing spend authorisation,
 * whatever stage the planner filed it under, so the voice follows what the
 * message is about and the route follows the voice. A `measurement` step that
 * asks to spend money is still Ads asking, and still asked on the Ads model.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickReport, TickResult } from '@octopus/core';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const HEX = 'a'.repeat(64);
const KEY = 'sk-ant-live-not-a-real-key-4f2a';

interface Write {
  table: string;
  values: Record<string, unknown>;
}

let written: Write[];
let draftInputs: Record<string, unknown>[];
let draft: Record<string, unknown>;
let routeRow: Record<string, unknown> | null;
let connectionRow: Record<string, unknown> | null;

vi.mock('./ai', () => ({
  requestCampaignDraft: async (_url: string, input: Record<string, unknown>) => {
    draftInputs.push(input);
    return draft;
  },
}));

vi.mock('./room-for-project', () => ({
  roomForProject: async () => ROOM,
}));

const { produceCampaignCards } = await import('./campaign-cards');

function admin() {
  const builder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      in: () => b,
      maybeSingle: async () => {
        if (table === 'projects') return { data: { currency: 'USD' }, error: null };
        if (table === 'model_routes') return { data: routeRow, error: null };
        if (table === 'model_connections') return { data: connectionRow, error: null };
        // The same builder answers two `messages` reads: the "already carded?"
        // guard before the draft, which must be null so every test is a first
        // pass, and the id read after the insert, which must not be, or the embed
        // is never written and the card is half a card.
        if (table === 'messages' && b.__inserted) return { data: { id: 'msg-1' }, error: null };
        return { data: null, error: null };
      },
      insert: (values: Record<string, unknown>) => {
        written.push({ table, values });
        b.__inserted = true;
        return b;
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({
          data:
            table === 'tasks'
              ? [{ id: TASK, title: 'Launch the Meta campaign', detail: '', stage: 'channels' }]
              : [],
          error: null,
        }),
    });
    return b;
  };
  return { from: (table: string) => builder(table) } as never;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const report = {
  projectId: PROJECT,
  results: [
    {
      taskId: TASK,
      outcome: 'needs_user',
      decision: {
        target: 'needs_user',
        rule: 'high_risk_needs_authorisation',
        reason: 'because',
      },
    } as unknown as TickResult,
  ],
} as TickReport;

async function connectAds() {
  const { modelConnectionAad, parseMasterKey, seal } = await import('./envelope');
  const sealed = seal(KEY, parseMasterKey(HEX), modelConnectionAad(ROOM, 'anthropic', 1));
  routeRow = { role: 'ads', provider: 'anthropic', model: 'claude-sonnet-5' };
  connectionRow = {
    key_ciphertext: sealed.ciphertext,
    key_iv: sealed.iv,
    key_tag: sealed.tag,
    key_version: 1,
  };
}

beforeEach(() => {
  written = [];
  draftInputs = [];
  routeRow = null;
  connectionRow = null;
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
  draft = {
    core: 'test',
    citations: [],
    model: 'gpt-5.4',
    proposals: [
      {
        kind: 'propose_campaign',
        task_id: TASK,
        name: 'Meta prospecting',
        channel: 'meta',
        summary: 'Cold audiences, creator angle.',
        citations: [],
      },
    ],
  };
});

const messages = () => written.filter((w) => w.table === 'messages');

describe('the route a campaign draft takes', () => {
  it('sends nothing when the room has routed nothing', async () => {
    await produceCampaignCards(admin(), report, { aiServiceUrl: 'http://ai', log });
    expect(draftInputs[0]?.generation).toBeNull();
  });

  it('asks on the Ads route, with the decrypted key', async () => {
    await connectAds();
    await produceCampaignCards(admin(), report, {
      aiServiceUrl: 'http://ai',
      modelKeySecret: HEX,
      log,
    });
    expect(draftInputs[0]?.generation).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: KEY,
    });
  });

  it('logs the model and never the key', async () => {
    await connectAds();
    await produceCampaignCards(admin(), report, {
      aiServiceUrl: 'http://ai',
      modelKeySecret: HEX,
      log,
    });
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).toContain('claude-sonnet-5');
    expect(logged).not.toContain(KEY);
  });
});

describe('what the card records', () => {
  it('stamps the message with the model that drafted it', async () => {
    draft.model = 'claude-sonnet-5';
    await produceCampaignCards(admin(), report, { aiServiceUrl: 'http://ai', log });
    expect(messages()[0]?.values).toMatchObject({ persona: 'ads', model: 'claude-sonnet-5' });
  });

  it('records null rather than a guess when the service names nothing', async () => {
    draft.model = null;
    await produceCampaignCards(admin(), report, { aiServiceUrl: 'http://ai', log });
    expect(messages()[0]?.values.model).toBeNull();
  });

  it('still asks the owner to authorise, whatever model wrote it', async () => {
    // A model on a message is an attribution. The card is still owner-gated and
    // pending, and nothing runs until somebody types a budget (ADR-0032).
    await produceCampaignCards(admin(), report, { aiServiceUrl: 'http://ai', log });
    expect(written.find((w) => w.table === 'action_embeds')?.values).toMatchObject({
      component: 'campaign',
      required_role: 'owner',
      state: 'pending',
    });
  });
});
