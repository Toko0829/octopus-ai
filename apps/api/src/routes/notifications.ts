import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createUserClient, type SupabaseConfig } from '../lib/supabase';

/**
 * One person's inbox: read it, and mark it read.
 *
 * **Every query here runs as the caller, and that is the whole authorisation
 * model.** `20260909120000` gives `public.notifications` two own-row policies, a
 * `select` grant and an `update` grant narrowed to the single column `read_at`,
 * so the database already answers "whose rows are these" and "which column may
 * they touch" for every request. A service client would take that answer away
 * and put it in three route handlers, which is the shape
 * `apps/api/src/routes/ops.ts` needs (its authorisation is `profiles.role`,
 * which RLS cannot read) and this one does not.
 *
 * Concretely: there is no `.eq('user_id', userId)` anywhere below, and its
 * absence is deliberate rather than an oversight. Adding one would look like
 * defence and would in fact be a second place for the answer to live, which is
 * how the two drift. The route asks for rows; the table decides which exist.
 *
 * `apps/api/src/routes/notifications.test.ts` asserts the service client is
 * never constructed by any of these handlers, because that is the kind of change
 * that would pass every functional test while removing the backstop.
 */

const ListQuery = z.object({
  /** Present and `1` narrows to unread. Absent returns the whole recent inbox. */
  unread: z.literal('1').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Keyset cursor: the `created_at` of the oldest row the caller already holds. */
  before: z.string().datetime().optional(),
});

const IdParam = z.object({ id: z.string().uuid() });

/**
 * The columns a client may see, written once.
 *
 * PostgREST infers the row type from the literal select string, so this is a
 * const rather than a built expression (the reason `ops.ts:145-150` writes its
 * two orderings out in full). `key` and `event_id` are **not** here: they are
 * the dedup mechanism and the audit link, neither of which the browser has a use
 * for, and a column nobody reads is a column nobody has to keep meaning stable.
 */
const COLUMNS =
  'id, kind, recipient_role, subject_type, subject_id, project_id, payload, created_at, read_at';

interface NotificationRow {
  id: string;
  kind: string;
  recipient_role: string;
  subject_type: string;
  subject_id: string;
  project_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
}

function present(row: NotificationRow) {
  return {
    id: row.id,
    kind: row.kind,
    recipientRole: row.recipient_role,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    projectId: row.project_id,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface NotificationRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
}

export async function notificationRoutes(
  app: FastifyInstance,
  opts: NotificationRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  /**
   * The inbox and the badge, in one answer.
   *
   * Two queries rather than one, because they answer different questions over
   * different sets: the list is a page of at most a hundred rows, and the count
   * is over everything unread. Deriving the badge from the page would under-count
   * silently the moment somebody has more unread rows than fit, and a badge that
   * is quietly wrong is worse than no badge.
   */
  app.get('/api/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return fail(reply, 400, 'bad_request', 'That is not a valid inbox query.');
    }
    const { unread, limit, before } = parsed.data;
    const db = createUserClient(opts.supabase, request.accessToken as string);

    // `id` breaks ties on `created_at`, matching `notifications_inbox_idx`. Two
    // rows written by one event share a timestamp to the microsecond often
    // enough that a cursor on time alone can loop.
    let listQuery = db
      .from('notifications')
      .select(COLUMNS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (unread === '1') listQuery = listQuery.is('read_at', null);
    if (before) listQuery = listQuery.lt('created_at', before);

    const [list, count] = await Promise.all([
      listQuery,
      db.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    ]);

    if (list.error) {
      request.log.error({ err: list.error }, 'could not read the inbox');
      return fail(reply, 500, 'internal_error', 'Could not load your notifications.');
    }
    if (count.error) {
      request.log.error({ err: count.error }, 'could not count unread notifications');
      return fail(reply, 500, 'internal_error', 'Could not load your notifications.');
    }

    return reply.code(200).send({
      notifications: ((list.data ?? []) as NotificationRow[]).map(present),
      unread: count.count ?? 0,
    });
  });

  /**
   * Mark one read.
   *
   * **A second click is a 200, not a 409.** The update is guarded on `read_at is
   * null` so it moves exactly one row once, and when it moves none the row is
   * read back to tell the two cases apart: already read (200, the original
   * timestamp) from absent or somebody else's (404). Both of those are 404
   * because RLS returns no row for either, and the API does not confirm the
   * existence of something it will not show you.
   *
   * The timestamp sent here is discarded: `private.guard_notification_read`
   * overwrites it with `now()`, because the client says *that* it was read and
   * the database says *when*.
   */
  app.post('/api/notifications/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) return fail(reply, 400, 'bad_request', 'That is not a notification id.');
    const db = createUserClient(opts.supabase, request.accessToken as string);

    const marked = await db
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', params.data.id)
      .is('read_at', null)
      .select(COLUMNS)
      .maybeSingle();

    if (marked.error) {
      request.log.error({ err: marked.error, id: params.data.id }, 'could not mark read');
      return fail(reply, 500, 'internal_error', 'Could not mark that as read.');
    }
    if (marked.data) {
      return reply.code(200).send({ notification: present(marked.data as NotificationRow) });
    }

    const existing = await db
      .from('notifications')
      .select(COLUMNS)
      .eq('id', params.data.id)
      .maybeSingle();

    if (existing.error) {
      request.log.error({ err: existing.error, id: params.data.id }, 'could not re-read');
      return fail(reply, 500, 'internal_error', 'Could not mark that as read.');
    }
    if (!existing.data) {
      return fail(reply, 404, 'not_found', 'That notification is not in your inbox.');
    }
    return reply.code(200).send({ notification: present(existing.data as NotificationRow) });
  });

  /**
   * Mark everything read.
   *
   * No `user_id` filter, for the reason in this file's header: RLS scopes the
   * update to the caller's rows and adding a filter would be a second answer to
   * the same question. `is('read_at', null)` is not optimisation either, it is
   * the guard trigger's requirement: re-stamping a row that was already read
   * raises, so an unfiltered update would fail as soon as anybody had read
   * anything.
   */
  app.post('/api/notifications/read-all', { preHandler: requireAuth }, async (request, reply) => {
    const db = createUserClient(opts.supabase, request.accessToken as string);
    const { data, error } = await db
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .is('read_at', null)
      .select('id');

    if (error) {
      request.log.error({ err: error }, 'could not mark the inbox read');
      return fail(reply, 500, 'internal_error', 'Could not clear your notifications.');
    }
    return reply.code(200).send({ marked: (data ?? []).length, unread: 0 });
  });
}
