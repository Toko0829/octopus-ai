'use client';

import type {
  ArtifactFileUrl,
  Channel,
  EmbedActionResponse,
  ListMessagesResponse,
  Message,
  ProjectDetail,
  ProjectSummary,
  RoomMember,
} from '@octopus/contracts';

/**
 * Browser-side calls, always through the BFF at /api/bff/*.
 *
 * This is not a secrecy boundary: the session cookies are not `httpOnly`, so page
 * scripts can read the access token (docs/30-modules/auth-identity.md). What routing
 * through the BFF actually buys is that the token is attached server-side in exactly
 * one place, the browser never holds a long-lived credential for Fastify, and the API
 * origin is never exposed to the client.
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
  // `ownerId` is already sent by the API and was simply not declared here. The
  // chat shell derives whether the viewer may approve a card from it, so a new
  // room without it would render as one the creator cannot act in.
  return bff<{ id: string; name: string; projectId: string | null; ownerId: string | null }>(
    '/rooms',
    { method: 'POST', body: JSON.stringify({ name }) },
  );
}

/**
 * Tell Octopus something about this business.
 *
 * Accepted rather than completed: the API replies 202 and the outcome arrives in
 * the room as a message, because reading a page and embedding it takes longer
 * than a request should be held open for.
 */
export function addSource(roomId: string, input: { title?: string; text?: string; url?: string }) {
  return bff<{ status: string; runId: string }>(`/rooms/${roomId}/sources`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Start an agent run. Returns as soon as the run is accepted; the agent's reply
 * arrives over Realtime like any other member's message, so there is nothing to
 * await here beyond acceptance.
 */
export function startAgentRun(roomId: string, goal: string) {
  return bff<{ runId: string; status: 'accepted' }>(`/rooms/${roomId}/agent-runs`, {
    method: 'POST',
    body: JSON.stringify({ goal }),
  });
}

export function getChannels(roomId: string) {
  return bff<{ channels: Channel[] }>(`/rooms/${roomId}/channels`);
}

/**
 * What the approved plans in this room became.
 *
 * Resolved server-side through the plan card rather than `rooms.project_id`, so a
 * room that has had several plans approved lists all of them. Reading that column
 * would show the first and silently omit the rest.
 */
export function getProjects(roomId: string) {
  return bff<{ projects: ProjectSummary[] }>(`/rooms/${roomId}/projects`);
}

/**
 * Unstick a step: record that you did it yourself, or ask for another attempt.
 *
 * Targets one task by id, which is the point. Answering through the chat means
 * the room has to guess whether a sentence was an answer or a new request, and
 * guessing wrong silently loses whichever one it was. Naming the step removes
 * the question.
 */
export function resolveStep(
  projectId: string,
  taskId: string,
  input: { action: 'answer'; text: string } | { action: 'retry' },
) {
  return bff<{ state: string; ranExecutor: boolean }>(
    `/projects/${projectId}/tasks/${taskId}/resolution`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** One project with its steps and everything they produced. */
export function getProject(projectId: string) {
  return bff<ProjectDetail>(`/projects/${projectId}`);
}

/**
 * A download link for an artifact that is a file rather than text.
 *
 * Minted per click and short-lived, because the URL is a bearer capability:
 * anyone holding it can fetch the object until it expires, without signing in.
 * That is why it is not part of the project payload, where it would sit in
 * memory and in any logged response for as long as the panel is open.
 */
export function getArtifactFileUrl(projectId: string, artifactId: string) {
  return bff<ArtifactFileUrl>(`/projects/${projectId}/artifacts/${artifactId}/file-url`);
}

/**
 * Ask for the plan to be changed.
 *
 * Returns `202` and nothing else useful: the diff takes tens of seconds and
 * arrives as a card in the room, which is where it is approved. Nothing changes
 * until somebody approves it, so this call is safe to make and abandon.
 */
export function requestReplan(projectId: string, reason: string) {
  return bff<{ runId: string; status: string }>(`/projects/${projectId}/replan`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
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

/**
 * Record a verdict on an interactive card.
 *
 * The server re-checks `requiredRole`, the pending state, and membership. The UI
 * disables what the caller cannot do, but that is presentation: this call can be
 * made by anyone and is expected to be refused when it should be.
 */
export function actOnEmbed(
  roomId: string,
  embedId: string,
  input: { action: 'approve' | 'request_changes'; note?: string },
) {
  return bff<EmbedActionResponse>(`/rooms/${roomId}/embeds/${embedId}/actions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
