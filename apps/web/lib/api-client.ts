'use client';

import type {
  ArtifactFileUrl,
  Channel,
  ChannelConnection,
  EmbedActionResponse,
  ListMessagesResponse,
  ListNotificationsResponse,
  MarkAllNotificationsReadResponse,
  MarkNotificationReadResponse,
  MarketingChannel,
  Message,
  NodeCredential,
  NodeEngagement,
  NodeEngagementResponse,
  NodeOffer,
  NodeProfile,
  NodeProofArtifact,
  NodeSkill,
  OpsDisputeDetail,
  OpsDisputeSummary,
  ProjectDetail,
  ProjectSummary,
  ResolveDisputeBody,
  RoomMember,
  SubmitRatingBody,
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
    headers: {
      // **Only when there is actually a body.** This was unconditional, which is
      // a lie on a bodyless POST: it declares JSON and sends none, and Fastify
      // refuses that before the handler with `FST_ERR_CTP_EMPTY_JSON_BODY`
      // ("Body cannot be empty when content-type is set to 'application/json'").
      //
      // It made every bodyless POST in this client unusable from a browser.
      // `acceptOffer` has carried it since slice 5 and nothing caught it: the
      // route tests use `app.inject`, which sends no content-type unless asked,
      // and every acceptance until now was driven through the rpc directly. Found
      // by clicking "Start work" on a real page.
      ...(init?.body !== undefined && init?.body !== null
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init?.headers ?? {}),
    },
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
  input:
    | { action: 'answer'; text: string }
    | { action: 'retry' }
    | { action: 'find_expert' }
    | { action: 'approve_work' }
    /** A rejection must say why: the node works from this note, so the API refuses an empty one. */
    | { action: 'reject_work'; text: string },
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
  input: { body: string; channelId?: string; threadId?: string; idempotencyKey: string },
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
/**
 * Set or clear what the owner authorises for a project.
 *
 * `null` clears the ceiling, which blocks new campaign approvals and leaves every
 * campaign already authorised exactly as it was.
 */
export function setProjectBudget(projectId: string, budgetCeiling: number | null) {
  return bff<ProjectDetail>(`/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ budgetCeiling }),
  });
}

/**
 * Set or clear a campaign's cost-per-conversion ceiling.
 *
 * Setting it authorises the automatic pause (ADR-0014). `null` clears it, which
 * stops the optimizer judging this campaign and touches nothing else.
 */
export function setCampaignCpaCeiling(
  projectId: string,
  campaignId: string,
  cpaCeiling: number | null,
) {
  return bff<ProjectDetail>(`/projects/${projectId}/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: JSON.stringify({ cpaCeiling }),
  });
}

/**
 * Resume a paused campaign.
 *
 * If the measured rollup still breaches the ceiling, the next sweep pauses it
 * again: resuming does not clear the breach, raising or clearing the ceiling
 * does. The server refuses with a sentence naming what is in the way (409) or
 * asks for a retry shortly (503).
 */
export function resumeCampaign(projectId: string, campaignId: string) {
  return bff<ProjectDetail>(`/projects/${projectId}/campaigns/${campaignId}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/* ---------------------------------------------------- the node's own record */

/**
 * A node's whole record, and only ever their own.
 *
 * Every path here is `/node`, singular, with no id in it. There is nothing to
 * pass and therefore nothing to tamper with: the API reads the caller's own row
 * under RLS and a person who was never invited gets a 404 rather than a 403.
 *
 * `NodeProfile` carries no verification log, and cannot: the subject of a
 * `node_verifications` row is refused it by grant, because a face-search result
 * names a third party. A projection that started returning one would fail to
 * typecheck here rather than quietly reaching a browser.
 */
export function getNode() {
  return bff<{ node: NodeProfile }>('/node');
}

/**
 * Change what a node owns about themselves.
 *
 * The body is validated `.strict()` on the far side, so sending `kycStatus` or
 * `trustScore` is a 400 rather than a field silently dropped. That is deliberate:
 * a trimmed field returns 200 and lets somebody believe a control applied.
 */
export function patchNode(patch: {
  serviceJurisdictions?: string[];
  languages?: string[];
  rate?: number | null;
  ratePeriod?: 'hour' | 'task' | null;
  currency?: string;
  availability?: 'available' | 'paused' | 'offboarded';
}) {
  return bff<{ node: NodeProfile }>('/node', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function addNodeSkill(tag: string) {
  return bff<{ skill: NodeSkill }>('/node/skills', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  });
}

export async function removeNodeSkill(tag: string) {
  // 204, so there is no body to parse and `bff` would throw on the empty one.
  const res = await fetch(`/api/bff/node/skills/${encodeURIComponent(tag)}`, { method: 'DELETE' });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message ?? `Request failed (${res.status})`);
  }
}

export function addNodeCredential(input: {
  kind: 'lawyer' | 'accountant' | 'notary';
  jurisdiction: string;
  issuer?: string;
  licenceNumber?: string;
}) {
  return bff<{ credential: NodeCredential }>('/node/credentials', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function revokeNodeCredential(credentialId: string) {
  return bff<{ credential: NodeCredential }>(`/node/credentials/${credentialId}/revoke`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Submit an identity check.
 *
 * `sessionRef` is the provider's own reference for the flow the person just
 * completed, the counterpart of an OAuth authorization code. The client never
 * chooses an outcome: for the built-in test verifier the reference is minted on
 * its own screen, and for a real provider it comes back from theirs.
 */
export function submitNodeVerification(provider: string, sessionRef: string) {
  return bff<{ node: NodeProfile }>('/node/verification', {
    method: 'POST',
    body: JSON.stringify({ provider, sessionRef }),
  });
}

/* ------------------------------------------------- channel connections */

/**
 * What accounts this workspace has connected.
 *
 * The response carries no token and cannot: `ChannelConnection` has no field for
 * one, so a projection that started returning credentials would fail to
 * typecheck here rather than quietly reaching a browser.
 */
export function getConnections(roomId: string) {
  return bff<{ connections: ChannelConnection[] }>(`/rooms/${roomId}/connections`);
}

/**
 * Begin an authorisation and get back where to send the browser.
 *
 * The caller chooses the provider and the channel and nothing else. The redirect
 * URI, the scopes and the signed state are all decided by the API, because a
 * client that could name its own redirect URI could send somebody's
 * authorisation code wherever it liked.
 */
export function startConnection(roomId: string, provider: string, channel: MarketingChannel) {
  return bff<{ authorizeUrl: string }>(`/rooms/${roomId}/connections/start`, {
    method: 'POST',
    body: JSON.stringify({ provider, channel }),
  });
}

/** Finish one. Called by the callback page with whatever the platform returned. */
export function completeConnection(
  roomId: string,
  input: { state: string; code?: string; error?: string },
) {
  return bff<{ connection: ChannelConnection }>(`/rooms/${roomId}/connections/callback`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Disconnect. A revocation rather than a delete, whatever the verb says. */
export function disconnectConnection(roomId: string, connectionId: string) {
  return bff<{ connection: ChannelConnection }>(`/rooms/${roomId}/connections/${connectionId}`, {
    method: 'DELETE',
  });
}

export function actOnEmbed(
  roomId: string,
  embedId: string,
  input: { action: 'approve' | 'request_changes'; note?: string; budgetCap?: number },
) {
  return bff<EmbedActionResponse>(`/rooms/${roomId}/embeds/${embedId}/actions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * The offers waiting for this node.
 *
 * A separate call from `getNode` on purpose: offers change when somebody else's
 * step moves, so refetching them after a decline should not also refetch a
 * profile nobody edited.
 *
 * The projection carries no task id and nothing identifying the owner, and that
 * is the access control rather than a tidy shape: a node has no grant on `tasks`
 * or `projects`, and the owner-sees-node and node-sees-owner pair stays closed
 * until the engagement slice opens it deliberately.
 */
export function getNodeOffers() {
  return bff<{ offers: NodeOffer[] }>('/node/offers');
}

/**
 * Say no to an offer.
 *
 * The reason is optional and reaches the owner's audit trail, because "the brief
 * is too vague" and "this is outside what I do" are different problems: the
 * first is fixable now, the second says the match itself was wrong.
 *
 * There is no accept counterpart, and its absence is a slice boundary rather
 * than an oversight. Accepting is inseparable from funding escrow, so a button
 * that wrote no ledger row would leave somebody holding work nobody had paid
 * for. The console says exactly that where the button will go.
 */
export function declineOffer(offerId: string, reason?: string) {
  return bff<{ offer: NodeOffer }>(`/node/offers/${offerId}/decline`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

/**
 * Say yes.
 *
 * **No body**, and that is a decision rather than an omission: the price is the
 * node's own rate, frozen at this moment, and the step is the one that was
 * offered. A field here would be a person naming what they are paid. The route
 * refuses a body rather than ignoring one.
 *
 * What comes back carries `roomId` and `threadId`, which the offer projection
 * deliberately hides. After acceptance those two ids ARE the admission: the
 * thread panel below cannot read or post without both.
 */
export function acceptOffer(offerId: string) {
  return bff<{ engagement: NodeEngagement }>(`/node/offers/${offerId}/accept`, {
    method: 'POST',
  });
}

/** The work this node took, with the room and thread each one lives in. */
export function getNodeEngagements() {
  return bff<{ engagements: NodeEngagement[] }>('/node/engagements');
}

/**
 * Start a step, or pick one back up after the owner sent it back.
 *
 * One call for both arcs (`escrow_funded -> in_progress` and
 * `rejected -> in_progress`) because they are the same act; the console changes
 * the label, not the request.
 */
export function startEngagementWork(engagementId: string) {
  return bff<NodeEngagementResponse>(`/node/engagements/${engagementId}/start`, {
    method: 'POST',
  });
}

/**
 * Hand the work over.
 *
 * **Not through `bff`**, because that helper sets `Content-Type: application/json`
 * and a multipart body carries its boundary in that header. `fetch` is called
 * directly with **no** `Content-Type` at all so the browser writes the boundary
 * itself; the BFF proxy forwards whatever it is given.
 *
 * A `200` means the floor check bounced it and `bounced` says why; a `201` means
 * the owner has it. Both carry the engagement, so the console re-renders from the
 * state rather than inferring it from the status code.
 */
export async function submitProof(
  engagementId: string,
  input: { note: string; responses: string[]; files: File[] },
): Promise<NodeEngagementResponse> {
  const form = new FormData();
  form.set('note', input.note);
  form.set('responses', JSON.stringify(input.responses));
  for (const file of input.files) form.append('file', file, file.name);

  const res = await fetch(`/api/bff/node/engagements/${engagementId}/proof`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message ?? `Could not hand that over (${res.status})`);
  }
  return (await res.json()) as NodeEngagementResponse;
}

/** What this node has already handed over on a step. */
export function getNodeProof(engagementId: string) {
  return bff<{ proof: NodeProofArtifact[] }>(`/node/engagements/${engagementId}/proof`);
}

/**
 * A short-lived link to one proof file the node submitted.
 *
 * Fetched on click, never with the list, for the reason the owner's panel does
 * the same: a signed URL is a bearer capability good for ten minutes without
 * signing in, so shipping one with every list would mint a download credential
 * for every file the moment the page opened.
 */
export function getNodeProofFileUrl(engagementId: string, artifactId: string) {
  return bff<ArtifactFileUrl>(`/node/engagements/${engagementId}/proof/${artifactId}/file-url`);
}

/* ------------------------------------------------------------------------- *
 * Disputes and ratings
 * ------------------------------------------------------------------------- */

/**
 * The owner freezes a step.
 *
 * Goes through the resolution endpoint like every other owner action on a step,
 * because it *is* one: `resolveStep` returns the step's new state and this
 * returns `disputed`. What happens behind it is not like the others at all -
 * `public.raise_dispute` moves the task and writes the grievance in one
 * transaction, since a frozen step with no dispute row is a step nobody can
 * explain.
 */
export function disputeStep(projectId: string, taskId: string, reason: string) {
  return bff<{ state: string; ranExecutor: boolean }>(
    `/projects/${projectId}/tasks/${taskId}/resolution`,
    { method: 'POST', body: JSON.stringify({ action: 'dispute', text: reason }) },
  );
}

/** The owner rates the expert, once the deal has finished cleanly. */
export function rateExpert(projectId: string, engagementId: string, body: SubmitRatingBody) {
  return bff<{ ratingId: string }>(`/projects/${projectId}/engagements/${engagementId}/rating`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * The node contests a rejection.
 *
 * Keyed on the engagement rather than the task, like every other node route: a
 * node reads their own deals and has no grant on `tasks` at all.
 */
export function disputeRejection(engagementId: string, reason: string) {
  return bff<{ disputeId: string }>(`/node/engagements/${engagementId}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** The node rates the client, once the deal has finished cleanly. */
export function rateClient(engagementId: string, body: SubmitRatingBody) {
  return bff<{ ratingId: string }>(`/node/engagements/${engagementId}/rating`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------- *
 * The ops console
 *
 * These four reach `/api/ops`, which is gated on `profiles.role` read from the
 * database by `apps/api/src/plugins/require-ops.ts`. A non-operator gets a 403
 * from every one of them, so nothing here needs its own idea of who may call it.
 * ------------------------------------------------------------------------- */

export function listOpsDisputes(status: 'open' | 'resolved' = 'open') {
  return bff<{ disputes: OpsDisputeSummary[] }>(`/ops/disputes?status=${status}`);
}

export function fetchOpsDispute(disputeId: string) {
  return bff<OpsDisputeDetail>(`/ops/disputes/${disputeId}`);
}

/**
 * The decision.
 *
 * Everything consequential happens inside one Postgres transaction; this is the
 * request that starts it. A 409 carries the raise's own sentence, so the message
 * shown to an operator is the one the database wrote.
 */
export function resolveOpsDispute(disputeId: string, body: ResolveDisputeBody) {
  return bff<{ dispute: { id: string; resolution: string | null }; replayed: boolean }>(
    `/ops/disputes/${disputeId}/resolve`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/* ---------------------------------------------------------------------------
 * The inbox.
 *
 * Called from both browser surfaces, `/app` and `/node`, which is unusual here
 * and is the reason these routes are in the ts-rest router while the node and
 * ops groups are not. Authorisation is total and uniform: the table returns the
 * caller their own rows, so there is no id to pass and nothing to scope.
 * ------------------------------------------------------------------------- */

export function listNotifications(q: { unread?: boolean; limit?: number; before?: string } = {}) {
  const params = new URLSearchParams();
  if (q.unread) params.set('unread', '1');
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.before) params.set('before', q.before);
  const qs = params.toString();
  return bff<ListNotificationsResponse>(qs ? `/notifications?${qs}` : '/notifications');
}

/** Idempotent: a second click returns the row with its original timestamp. */
export function markNotificationRead(id: string) {
  return bff<MarkNotificationReadResponse>(`/notifications/${id}/read`, { method: 'POST' });
}

export function markAllNotificationsRead() {
  return bff<MarkAllNotificationsReadResponse>('/notifications/read-all', { method: 'POST' });
}
