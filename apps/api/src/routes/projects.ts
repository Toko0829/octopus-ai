import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  Artifact,
  ArtifactFileUrl,
  ProjectDetail,
  ProjectSummary,
  Task,
} from '@octopus/contracts';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { citationTitles, summariseProjects } from '../lib/project-progress';

/**
 * Reading what an approved plan became: the project, its tasks, and what those
 * tasks produced.
 *
 * Until these routes existed the workflow engine had no surface at all. A person
 * approved a plan, the scheduler routed eight steps, the executor wrote eight
 * artifacts, and the only evidence was a handful of cards scattered through the
 * chat stream. "Planning visibly and delivering invisibly is worse than doing
 * neither" is already the argument for the artifact card; this is the same
 * argument one level up, for the work as a whole.
 *
 * Every query runs as the caller, so RLS decides what exists. None of these
 * handlers filter by membership themselves.
 *
 * **A room is resolved to its projects through the plan card, never through
 * `rooms.project_id`.** That column is written once, by `materialise_plan`, under
 * `where ... and project_id is null`, so the first plan approved in a room claims
 * it permanently and every later project is linked to nothing. Reading it here
 * would show one project and silently omit the rest, which is the same defect
 * that lost eight delivered artifacts (see `room-for-project.ts`) and the same one
 * `20260827110000` removed from the RLS predicate. `projects.source_embed_id` is
 * unique, set at creation and never changed.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });
const ProjectParams = z.object({ projectId: z.string().uuid() });
const ArtifactParams = z.object({
  projectId: z.string().uuid(),
  artifactId: z.string().uuid(),
});

const ProjectRow = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.enum(['draft', 'planning', 'active', 'paused', 'completed', 'cancelled']),
  created_at: z.string(),
  source_embed_id: z.string().nullable(),
});

const TaskRow = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  stage: z.string().nullable(),
  owner_type: z.enum(['ai', 'human', 'user']),
  state: z.string(),
  risk_tier: z.enum(['read_only', 'reversible', 'external', 'high_risk']),
  position: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ArtifactRow = z.object({
  id: z.string(),
  task_id: z.string(),
  kind: z.enum(['draft', 'analysis', 'asset', 'proof', 'answer']),
  title: z.string().nullable(),
  body: z.string().nullable(),
  storage_path: z.string().nullable(),
  citations: z.unknown(),
  created_by: z.enum(['user', 'agent', 'node', 'system']),
  created_at: z.string(),
});

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/**
 * How long a download link lives.
 *
 * Ten minutes. The link is a bearer capability, so the window is the exposure if
 * one is copied out of a browser's history or a screenshot; ten minutes is long
 * enough to click and download a large file and short enough that a leaked one
 * is stale before it is useful. It is minted per request, so a shorter-lived
 * link costs nothing but a round trip.
 */
export const SIGNED_URL_TTL_SECONDS = 600;

/**
 * What the file-url route should do about an artifact row, decided separately
 * from doing it.
 *
 * Pure so the branch is testable without a Supabase client, and specifically so
 * the **"text artifact" case is pinned**. A row with no `storage_path` is not a
 * file, and asking Storage to sign a null path would either throw deep inside
 * the client or, worse, sign something. Both would surface as a 500 for a
 * perfectly ordinary artifact.
 *
 * All three misses are 404, matching how a non-member gets 404 on a room: the
 * API does not confirm the existence of something it will not show you. The
 * `reason` distinguishes them for the log, which is where the difference is
 * actually useful.
 */
export type FileUrlDecision =
  | { kind: 'sign'; storagePath: string }
  | { kind: 'not_found'; reason: 'invisible_or_absent' | 'not_a_file' };

export function decideFileUrl(row: { storage_path: string | null } | null): FileUrlDecision {
  if (!row) return { kind: 'not_found', reason: 'invisible_or_absent' };
  const path = row.storage_path?.trim();
  if (!path) return { kind: 'not_found', reason: 'not_a_file' };
  return { kind: 'sign', storagePath: path };
}

/** When a link minted now stops working, as an instant the client can compare against. */
export function signedUrlExpiresAt(nowMs: number, ttlSeconds = SIGNED_URL_TTL_SECONDS): string {
  return new Date(nowMs + ttlSeconds * 1000).toISOString();
}

export interface ProjectRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
}

export async function projectRoutes(
  app: FastifyInstance,
  opts: ProjectRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  app.get(
    '/api/rooms/:roomId/projects',
    { preHandler: requireAuth },
    async (request, reply): Promise<{ projects: ProjectSummary[] } | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const roomId = params.data.roomId;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        // Confirm the room first. A room the caller cannot see and a room with no
        // projects both yield an empty list otherwise, and telling those apart is
        // the whole reason this surface exists.
        const { data: room, error: roomErr } = await db
          .from('rooms')
          .select('id, project_id')
          .eq('id', roomId)
          .maybeSingle<{ id: string; project_id: string | null }>();
        if (roomErr) throw roomErr;
        if (!room) return fail(reply, 404, 'not_found', 'Room not found.');

        const { data: embeds, error: embedErr } = await db
          .from('action_embeds')
          .select('id')
          .eq('room_id', roomId)
          .eq('component', 'plan');
        if (embedErr) throw embedErr;

        const embedIds = (embeds ?? []).map((e) => (e as { id: string }).id);

        // Two plain reads merged here rather than one `.or()` filter string.
        // Same reasoning as `roomForProject`: a hand-built PostgREST filter fails
        // silently when it is wrong, and silently returning fewer projects than
        // exist is precisely the defect being removed.
        const byCard = embedIds.length
          ? await db
              .from('projects')
              .select('id, goal, status, created_at, source_embed_id')
              .in('source_embed_id', embedIds)
          : { data: [], error: null };
        if (byCard.error) throw byCard.error;

        const byRoom = room.project_id
          ? await db
              .from('projects')
              .select('id, goal, status, created_at, source_embed_id')
              .eq('id', room.project_id)
          : { data: [], error: null };
        if (byRoom.error) throw byRoom.error;

        const projects = new Map<string, z.infer<typeof ProjectRow>>();
        for (const row of [...(byCard.data ?? []), ...(byRoom.data ?? [])]) {
          const p = ProjectRow.parse(row);
          projects.set(p.id, p);
        }
        if (projects.size === 0) return { projects: [] };

        const ids = [...projects.keys()];

        const [{ data: tasks, error: taskErr }, { data: artifacts, error: artErr }] =
          await Promise.all([
            db.from('tasks').select('id, project_id, state').in('project_id', ids),
            db.from('artifacts').select('id, project_id').in('project_id', ids),
          ]);
        if (taskErr) throw taskErr;
        if (artErr) throw artErr;

        return {
          projects: summariseProjects(
            [...projects.values()].map((p) => ({
              id: p.id,
              goal: p.goal,
              status: p.status,
              created_at: p.created_at,
            })),
            (tasks ?? []) as { project_id: string; state: string }[],
            (artifacts ?? []) as { project_id: string }[],
          ),
        };
      } catch (err) {
        request.log.error({ err, roomId, userId: request.user?.sub }, 'listProjects failed');
        return fail(reply, 500, 'internal_error', 'Could not load projects.');
      }
    },
  );

  app.get(
    '/api/projects/:projectId',
    { preHandler: requireAuth },
    async (request, reply): Promise<ProjectDetail | FastifyReply> => {
      const params = ProjectParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'projectId must be a UUID.');
      const projectId = params.data.projectId;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { data: projectRow, error: projectErr } = await db
          .from('projects')
          .select('id, goal, status, created_at, source_embed_id')
          .eq('id', projectId)
          .maybeSingle();
        if (projectErr) throw projectErr;
        // Invisible and absent are the same answer on purpose, the same way a
        // non-member gets 404 on a room: the API does not confirm that a project
        // it will not show you exists.
        if (!projectRow) return fail(reply, 404, 'not_found', 'Project not found.');
        const project = ProjectRow.parse(projectRow);

        const [{ data: taskRows, error: taskErr }, { data: artifactRows, error: artErr }] =
          await Promise.all([
            db
              .from('tasks')
              .select(
                'id, project_id, title, detail, stage, owner_type, state, risk_tier, position, created_at, updated_at',
              )
              .eq('project_id', projectId)
              .order('position', { ascending: true }),
            db
              .from('artifacts')
              .select(
                'id, task_id, kind, title, body, storage_path, citations, created_by, created_at',
              )
              .eq('project_id', projectId)
              .order('created_at', { ascending: true }),
          ]);
        if (taskErr) throw taskErr;
        if (artErr) throw artErr;

        const byTask = new Map<string, Artifact[]>();
        for (const row of artifactRows ?? []) {
          const a = ArtifactRow.parse(row);
          const list = byTask.get(a.task_id) ?? [];
          list.push({
            id: a.id,
            taskId: a.task_id,
            kind: a.kind,
            title: a.title,
            body: a.body,
            storagePath: a.storage_path,
            citations: citationTitles(a.citations),
            createdBy: a.created_by,
            createdAt: a.created_at,
          });
          byTask.set(a.task_id, list);
        }

        const tasks: Task[] = (taskRows ?? []).map((row) => {
          const t = TaskRow.parse(row);
          return {
            id: t.id,
            projectId: t.project_id,
            title: t.title,
            detail: t.detail,
            stage: t.stage,
            ownerType: t.owner_type,
            state: t.state as Task['state'],
            riskTier: t.risk_tier,
            position: t.position,
            createdAt: t.created_at,
            updatedAt: t.updated_at,
            artifacts: byTask.get(t.id) ?? [],
          };
        });

        // The room is read through the card, matching both the delivery path and
        // the RLS predicate. Null is a legacy project rather than an error.
        let roomId: string | null = null;
        if (project.source_embed_id) {
          const { data: embed, error: embedErr } = await db
            .from('action_embeds')
            .select('room_id')
            .eq('id', project.source_embed_id)
            .maybeSingle<{ room_id: string }>();
          if (embedErr) throw embedErr;
          roomId = embed?.room_id ?? null;
        }

        return {
          id: project.id,
          goal: project.goal,
          status: project.status,
          createdAt: project.created_at,
          roomId,
          tasks,
        };
      } catch (err) {
        request.log.error({ err, projectId, userId: request.user?.sub }, 'getProject failed');
        return fail(reply, 500, 'internal_error', 'Could not load the project.');
      }
    },
  );

  /**
   * A short-lived download link for one file artifact.
   *
   * **The artifact row is read with the caller-scoped client, and that read is
   * the authorization.** RLS row visibility decides whether this person may have
   * the file: if `artifacts_select_member` does not return the row, there is
   * nothing to sign. The service client is used only afterwards, to mint the
   * URL, because signing needs a key no client may hold. Reading the row with
   * the service client and then checking membership in code would put the
   * authorization back in this handler, where the next handler would have to
   * remember to repeat it.
   *
   * The `storage.objects` select policy added by `20260829124000` is the second
   * layer, and both terminate in `private.is_project_member`, so the policy and
   * this route agree by construction rather than by two people remembering the
   * same rule.
   *
   * **The signed URL is never logged.** It is a bearer capability: anyone holding
   * it can fetch the object until it expires, so it belongs in the response and
   * nowhere else, exactly like an access token.
   */
  app.get(
    '/api/projects/:projectId/artifacts/:artifactId/file-url',
    { preHandler: requireAuth },
    async (request, reply): Promise<ArtifactFileUrl | FastifyReply> => {
      const params = ArtifactParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'projectId and artifactId must be UUIDs.');
      }
      const { projectId, artifactId } = params.data;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { data: row, error } = await db
          .from('artifacts')
          .select('id, storage_path')
          .eq('id', artifactId)
          .eq('project_id', projectId)
          .maybeSingle<{ id: string; storage_path: string | null }>();
        if (error) throw error;

        const decision = decideFileUrl(row);
        if (decision.kind === 'not_found') {
          request.log.info(
            { projectId, artifactId, reason: decision.reason, userId: request.user?.sub },
            'file url refused',
          );
          return fail(reply, 404, 'not_found', 'No file is available for that artifact.');
        }

        const admin = createServiceClient(opts.supabase);
        const { data: signed, error: signErr } = await admin.storage
          .from('artifacts')
          .createSignedUrl(decision.storagePath, SIGNED_URL_TTL_SECONDS);
        if (signErr) throw signErr;

        // An absent URL with no error would otherwise be returned as `undefined`
        // and fail Zod parsing at the client, which reads as a contract bug
        // rather than as a missing object.
        if (!signed?.signedUrl) {
          request.log.error({ projectId, artifactId }, 'storage returned no signed url');
          return fail(reply, 404, 'not_found', 'No file is available for that artifact.');
        }

        return { url: signed.signedUrl, expiresAt: signedUrlExpiresAt(Date.now()) };
      } catch (err) {
        // The message, not the error object. Rule 16 forbids a silent failure, so
        // something has to be logged; the storage client's errors can carry a
        // response body, and a signed URL that reached the logs would outlive the
        // request that was allowed to have it.
        request.log.error(
          {
            projectId,
            artifactId,
            userId: request.user?.sub,
            err: err instanceof Error ? err.message : String(err),
          },
          'getArtifactFileUrl failed',
        );
        return fail(reply, 500, 'internal_error', 'Could not prepare the download.');
      }
    },
  );
}
