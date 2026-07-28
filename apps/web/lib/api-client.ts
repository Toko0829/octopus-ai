'use client';

import type { Channel, ListMessagesResponse, Message, RoomMember } from '@octopus/contracts';

/**
 * Browser-side calls, always through the BFF at /api/bff/* so the access token
 * stays in an httpOnly cookie and never reaches page scripts.
 */

async function bff<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/bff${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function createRoom(name: string) {
  return bff<{ id: string; name: string; projectId: string | null }>('/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function getChannels(roomId: string) {
  return bff<{ channels: Channel[] }>(`/rooms/${roomId}/channels`);
}

export function getMembers(roomId: string) {
  return bff<{ members: RoomMember[] }>(`/rooms/${roomId}/members`);
}

/** Since-cursor catch-up. Called on reconnect so nothing missed while away is lost. */
export function getMessages(roomId: string, since?: number) {
  const q = since !== undefined ? `?since=${since}&limit=200` : '?limit=100';
  return bff<ListMessagesResponse>(`/rooms/${roomId}/messages${q}`);
}

/**
 * `idempotencyKey` is generated per composed message and reused if the send is
 * retried, so a flaky connection cannot produce two copies of one message.
 */
export function postMessage(
  roomId: string,
  input: { body: string; channelId?: string; idempotencyKey: string },
) {
  return bff<Message>(`/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
