/**
 * The two mappings that turn a message into something the stream can render.
 *
 * `adapt.ts` had no test file before this. The half worth pinning is
 * `fromBroadcastRecord`: it reads a raw Postgres row off Realtime, which is the
 * one path into this client **that no route validated**. Everything the API
 * returns has been through `Message` on the server; a broadcast has been through
 * nothing at all, so every field it reads is a field this function has to decide
 * about on its own.
 *
 * `model` is the interesting case because it is deliberately not parsed against
 * a vocabulary (ADR-0032): vendors retire and rename ids, and an id this build
 * has never heard of is still the true answer to what wrote a message. So the
 * only check is that it is text, and the assertions below are about what happens
 * when it is not.
 */

import { describe, expect, it } from 'vitest';
import { fromBroadcastRecord, toMessage } from './adapt';
import type { Message } from '@octopus/contracts';

const ID = '11111111-1111-4111-8111-111111111111';

function record(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    author_id: null,
    author_kind: 'agent',
    persona: 'strategist',
    model: 'claude-sonnet-5',
    body: 'Here is the plan.',
    seq: 12,
    created_at: '2026-09-13T10:00:00.000Z',
    thread_id: null,
    ...over,
  };
}

describe('fromBroadcastRecord', () => {
  it('keeps the model the row carries', () => {
    expect(fromBroadcastRecord(record())?.model).toBe('claude-sonnet-5');
  });

  it('keeps an id this build has never heard of', () => {
    // The point of the open vocabulary. A client shipped before a model existed
    // should name it rather than render an agent message as unattributed.
    expect(fromBroadcastRecord(record({ model: 'claude-opus-7-preview' }))?.model).toBe(
      'claude-opus-7-preview',
    );
  });

  it('reads null when the row carries none', () => {
    expect(fromBroadcastRecord(record({ model: null }))?.model).toBeNull();
  });

  it('reads null when the column is absent entirely', () => {
    // Every row written before `20260913122000` arrives this way.
    const { model: _model, ...without } = record();
    expect(fromBroadcastRecord(without)?.model).toBeNull();
  });

  it('refuses anything that is not text', () => {
    // A number or an object reaching the stream would render beside a voice as
    // itself, which is how `[object Object]` ends up on screen next to a name.
    for (const value of [42, { id: 'x' }, ['a'], true]) {
      expect(fromBroadcastRecord(record({ model: value }))?.model).toBeNull();
    }
  });

  it('still reads the persona and the body beside it', () => {
    const message = fromBroadcastRecord(record());
    expect(message).toMatchObject({
      persona: 'strategist',
      body: 'Here is the plan.',
      authorKind: 'agent',
    });
  });
});

describe('toMessage', () => {
  it('carries the model through from the API shape', () => {
    const message: Message = {
      id: ID,
      roomId: ID,
      channelId: null,
      authorId: null,
      authorKind: 'agent',
      persona: 'content',
      model: 'gemini-3.8-flash',
      body: 'The landing page copy.',
      seq: 3,
      createdAt: '2026-09-13T10:00:00.000Z',
      threadId: null,
      embed: null,
    };
    expect(toMessage(message)).toMatchObject({ persona: 'content', model: 'gemini-3.8-flash' });
  });

  it('carries a null through as null, which is the ordinary case', () => {
    const message = {
      id: ID,
      roomId: ID,
      channelId: null,
      authorId: null,
      authorKind: 'system',
      persona: null,
      model: null,
      body: 'An expert accepted the step.',
      seq: 4,
      createdAt: '2026-09-13T10:00:00.000Z',
      threadId: null,
      embed: null,
    } as Message;
    expect(toMessage(message).model).toBeNull();
  });
});
