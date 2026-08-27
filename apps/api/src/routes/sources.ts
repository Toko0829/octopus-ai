import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { AiServiceError, requestSource } from '../lib/ai';
import { UnsafeUrlError, fetchPageText } from '../lib/fetch-url';

/**
 * Telling Octopus what your business actually is.
 *
 * **The gap this closes was visible in delivered work.** Every artifact the
 * executor produced ended with a variant of "product-specific claims could not
 * be included", because the corpus is ten documents of marketing principles and
 * knows nothing about the user's product. The ad copy came back written about
 * advertising rather than about the thing being advertised.
 *
 * Three checks, in the order the embeds route established:
 *
 *   1. **Membership**, by RLS as the caller. A non-member gets 404, not 403: the
 *      room is invisible to them and this API does not confirm it exists.
 *   2. **Owner only.** A source states facts about the business, and the same
 *      reasoning that keeps a human node from answering intake questions applies
 *      here more strongly: an expert dropped into a room must not be able to
 *      write the corpus every future deliverable is grounded in.
 *   3. **Exactly one of text or url**, so a request cannot half-specify what it
 *      wants and get whichever branch happens to run first.
 *
 * **202, then work in the background.** ADR-0006 says ingestion is job-driven and
 * never in the request path. Fetching a page and embedding it is seconds at best
 * and a slow site at worst, and the person is sitting in a chat room, so the
 * route accepts and the outcome arrives as a message. There is no job runner in
 * `services/ai` to hand this to, so the continuation lives here, exactly as
 * `agent-runs` does; the deviation is recorded in `ai-orchestrator.md`.
 *
 * **Nothing is silent** (rule 16). Success posts what was learned, failure posts
 * why, and both land in the room rather than only in a log the person cannot
 * read.
 */

const Params = z.object({ roomId: z.string().uuid() });

const Body = z
  .object({
    title: z.string().trim().min(1).max(140).optional(),
    text: z.string().trim().min(1).max(120_000).optional(),
    url: z.string().trim().min(1).max(2_000).optional(),
  })
  .refine((b) => Boolean(b.text) !== Boolean(b.url), {
    // Both would mean guessing which the person meant; neither is an empty
    // request. Either way the answer is a 400 rather than a plausible default.
    message: 'Provide either text or a url, not both and not neither.',
  });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface SourceRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  aiTimeoutMs?: number;
}

export async function sourceRoutes(app: FastifyInstance, opts: SourceRoutesOptions): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  async function postSystemNotice(roomId: string, body: string, key: string): Promise<void> {
    try {
      const admin = createServiceClient(opts.supabase);
      await admin.from('messages').insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'system',
        body,
        idempotency_key: key,
      });
    } catch (err) {
      // The last resort. If even the notice fails there is nowhere else to say
      // so, which is exactly why it is logged loudly rather than swallowed.
      app.log.error({ err, roomId }, 'could not post source outcome notice');
    }
  }

  app.post(
    '/api/rooms/:roomId/sources',
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = Params.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'roomId must be a uuid.');
      }
      const body = Body.safeParse(request.body);
      if (!body.success) {
        return fail(reply, 400, 'bad_request', body.error.issues[0]?.message ?? 'Invalid request.');
      }

      const { roomId } = params.data;
      const userId = request.user!.sub;
      const caller = createUserClient(opts.supabase, request.accessToken!);

      // (1) and (2) in one read. RLS decides whether the row is visible at all,
      // which is the membership check; owner_id decides whether this member may
      // write the knowledge base.
      const { data: room, error: roomError } = await caller
        .from('rooms')
        .select('id, owner_id')
        .eq('id', roomId)
        .maybeSingle();

      if (roomError) {
        request.log.error({ err: roomError, roomId }, 'room lookup failed');
        return fail(reply, 500, 'internal_error', 'Could not check the workspace.');
      }
      if (!room) {
        return fail(reply, 404, 'not_found', 'No such workspace.');
      }
      if (!room.owner_id || room.owner_id !== userId) {
        return fail(
          reply,
          403,
          'forbidden',
          'Only the workspace owner can add what Octopus knows about the business.',
        );
      }

      const runId = crypto.randomUUID();

      // Accepted. Everything after this happens without the caller waiting.
      void ingest(roomId, body.data, runId).catch((err) => {
        app.log.error({ err, roomId, runId }, 'source ingestion continuation failed');
      });

      return reply.code(202).send({ status: 'accepted', runId });
    },
  );

  async function ingest(
    roomId: string,
    input: { title?: string; text?: string; url?: string },
    runId: string,
  ): Promise<void> {
    let title = input.title?.trim() ?? '';
    let text = input.text?.trim() ?? '';
    let sourceUrl: string | null = null;

    if (input.url) {
      try {
        const page = await fetchPageText(input.url);
        text = page.text;
        sourceUrl = page.url;
        // The person's own title wins when they gave one. Otherwise the page's,
        // otherwise the address, which is at least stable and recognisable.
        title = title || page.title || page.url;
      } catch (err) {
        const why = err instanceof UnsafeUrlError ? err.message : 'That page could not be read.';
        await postSystemNotice(roomId, `I could not read that page. ${why}`, `source:${runId}`);
        return;
      }
    }

    if (!title) {
      // Everything a document is superseded by is keyed on its title, so an
      // untitled source would be a new document on every submission.
      title = 'About this business';
    }

    try {
      const result = await requestSource(
        opts.aiServiceUrl,
        { roomId, title, text, sourceUrl, agentRunId: runId },
        opts.aiTimeoutMs,
      );

      const what = sourceUrl ? `"${title}" from ${sourceUrl}` : `"${title}"`;
      const body = result.skipped_unchanged
        ? `I already had ${what}, unchanged, so nothing was re-read.`
        : result.superseded
          ? `Updated what I know from ${what}. It replaces the previous version and I will use it from the next plan onward.`
          : `Recorded ${what} as something I know about your business. I will use it when I plan and when I write.`;

      await postSystemNotice(roomId, body, `source:${runId}`);
      app.log.info(
        {
          roomId,
          runId,
          documentId: result.document_id,
          chunks: result.chunks_written,
          skipped: result.skipped_unchanged,
        },
        'source ingested',
      );
    } catch (err) {
      const kind = err instanceof AiServiceError ? err.kind : null;
      // A timeout here is not a fault, so it does not read as one. The rest are
      // ours, and saying so plainly beats offering a remedy that will not work.
      const why =
        kind === 'timeout'
          ? 'It took longer than I allow for one document. A shorter description usually goes through.'
          : 'Something on my side went wrong while reading it.';
      await postSystemNotice(
        roomId,
        `I could not record that source. ${why} Nothing was saved, so you can send it again.`,
        `source:${runId}`,
      );
      app.log.error({ err, roomId, runId, kind }, 'source ingestion failed');
    }
  }
}
