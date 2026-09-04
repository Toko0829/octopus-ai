import type { GenerationTarget } from './model-routing';

/**
 * Turning an approved brief into image bytes, on the workspace's own key.
 *
 * **The first outbound call in this system that produces bytes rather than
 * sentences, and it is here rather than in `services/ai` on purpose.** The Python
 * service holds no storage key and no Supabase write path (ADR-0006), so bytes
 * arriving there would have nowhere to go except back across the seam as base64,
 * which is a few megabytes travelling through an HTTP hop built to carry prose,
 * and a live customer credential reaching a second process for no reason.
 * `services/ai` says what to draw and this draws it (ADR-0033).
 *
 * **One call per image, not one call for three.** The vendor may or may not
 * return several images from one request depending on the model, and a partial
 * response would be indistinguishable from a smaller answer. Separate calls make
 * the failure unit the image: two land, one does not, and the person gets two
 * pictures and a sentence rather than nothing.
 *
 * **Nothing here decides whether to spend.** By the time this is called an owner
 * has approved a plan containing the step, a workspace owner has connected the
 * key and routed Creative at a model that makes images, and `IMAGE_GEN_ENABLED`
 * is on. This function's whole job is the wire.
 *
 * SECURITY: `prompt` is derived from a model's own brief and is untrusted (rule
 * 8). It travels as a data field in a JSON body, never interpolated into a URL or
 * a header, and it is bounded on both sides of the seam. `target.apiKey` is a
 * live customer credential: it is read once into a header and **never logged**,
 * which is why no error thrown here carries the target.
 */

/** The Interactions API, which is the surface Gemini's own docs mark current. */
const GOOGLE_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** One image, one minute. Generation is slower than text and slower than a plan step's patience. */
const IMAGE_TIMEOUT_MS = 60_000;

/**
 * What the endpoint actually returns, and it is JPEG because the vendor says so.
 *
 * This was `image/png`, chosen from the documentation with a comment arguing
 * that ad creative a person may put type over should not be a re-compressed
 * JPEG. That argument is fine and the API does not offer the choice: the first
 * live call came back **400 with `The value 'image/png' is not supported for
 * 'response_format.mime_type'. Supported values: 'image/jpeg'.`**
 *
 * One constant for the request and for the stored type, because they must agree.
 * Hardcoding `image/png` on the way out while asking for something else is how a
 * row ends up describing bytes that are not what it says, and the panel decides
 * whether to render an image from exactly that column.
 */
const IMAGE_MIME = 'image/jpeg';

/** The file extension for a media type, so an object's name is not a lie. */
export function extensionFor(contentType: string): string {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * What we are willing to store per image.
 *
 * A cap rather than a trust in the vendor, for the reason every bound in this
 * codebase is one: the number that decides how much of somebody's storage bill a
 * single approved step can commit should be ours. Eight megabytes is comfortably
 * above a 2K PNG and far below anything that would be an accident worth keeping.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** A 1x1 transparent PNG, for the fake vendor. Real bytes, no network, no bill. */
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export interface ImageRequest {
  prompt: string;
  count: number;
  aspect: '1:1' | '4:5' | '9:16' | '16:9';
}

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * A generation attempt that did not produce an image.
 *
 * **`kind` exists so the sentence the room gets can be true**, and it is a small
 * closed set because the person's next move differs across it and nothing else
 * about the error does. `auth` is a key to re-paste, `rate_limited` is a wait,
 * `policy` is a brief to reword, `unsupported` is a route pointed at something
 * that cannot draw, and `provider` is everything else, which is ours to look at.
 *
 * **It never carries the target.** The message is written into a log line and,
 * shortened, into a room; a struct holding a customer's API key has no business
 * anywhere near either.
 */
export class ImageGenError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate_limited' | 'policy' | 'provider' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'ImageGenError';
  }
}

/** One sentence per kind, for the Content-signed note when generation fails. */
export function imageFailureSentence(kind: ImageGenError['kind']): string {
  switch (kind) {
    case 'auth':
      return 'The image provider refused the workspace key, so the brief above is the deliverable.';
    case 'rate_limited':
      return 'The image provider is rate limiting this key, so the brief above is the deliverable.';
    case 'policy':
      return 'The image provider declined to draw this brief, so the brief above is the deliverable.';
    case 'unsupported':
      return 'The model routed to Creative does not make images, so the brief above is the deliverable.';
    default:
      return 'The image provider could not be reached, so the brief above is the deliverable.';
  }
}

type FetchLike = typeof fetch;

/**
 * Generate `count` images for one brief, or throw.
 *
 * Sequential rather than parallel, and that is the vendor's constraint rather
 * than a style: three simultaneous image calls on one key is the shape that gets
 * rate limited, and these run inside a step nobody is watching in real time. It
 * throws on the first failure rather than returning partial results, because the
 * caller's compensation is the same either way (deliver the brief, say why) and a
 * half-filled array would make "how many did the step produce" answerable two
 * ways.
 */
export async function generateImages(
  target: GenerationTarget,
  request: ImageRequest,
  fetchImpl: FetchLike = fetch,
): Promise<GeneratedImage[]> {
  if (target.vendor === 'fake') {
    // The in-repo vendor, so the whole path (propose, generate, upload, render)
    // can be walked on a live stack without spending anything.
    return Array.from({ length: request.count }, () => ({
      bytes: new Uint8Array(FAKE_PNG),
      contentType: 'image/png',
    }));
  }

  if (target.vendor !== 'google') {
    // Reachable only through a route that should not exist: the picker offers
    // Creative none but image models, and the registry says which those are. It
    // throws rather than returning nothing so the run says what happened.
    throw new ImageGenError(
      'unsupported',
      `${target.provider} has no image endpoint in this system, so nothing was generated.`,
    );
  }

  const images: GeneratedImage[] = [];
  for (let i = 0; i < request.count; i += 1) {
    images.push(await generateOne(target, request, fetchImpl));
  }
  return images;
}

async function generateOne(
  target: GenerationTarget,
  request: ImageRequest,
  fetchImpl: FetchLike,
): Promise<GeneratedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The vendor's own header. Never `Authorization`, and never a query
        // parameter: a key in a URL reaches access logs and referrers.
        'x-goog-api-key': target.apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: target.model,
        input: request.prompt,
        response_format: {
          type: 'image',
          // The only value this endpoint accepts. See IMAGE_MIME.
          mime_type: IMAGE_MIME,
          aspect_ratio: request.aspect,
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ImageGenError(
        'provider',
        `Image generation timed out after ${IMAGE_TIMEOUT_MS}ms.`,
      );
    }
    throw new ImageGenError('provider', 'The image provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // **The vendor's own explanation, kept rather than discarded.** Without it a
    // rejected call says only "400", and a 400 from an image endpoint is at
    // least two very different events: a prompt the vendor's policy refused, and
    // a request shape of ours it does not accept. The first is the person's to
    // act on and the second is ours, and a log line that cannot tell them apart
    // sends somebody to reword a brief over our bug. Found exactly that way, on
    // the first live call this code ever made.
    //
    // Bounded, because it is an untrusted string that reaches a log line, and
    // read as text rather than JSON because an error body is the one response
    // least likely to be the shape we expect. Our key cannot appear in it: it
    // travelled in a header and this is the vendor's own prose.
    const detail = await res.text().catch(() => '');
    throw statusError(res.status, detail.replace(/\s+/g, ' ').trim().slice(0, 400));
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ImageGenError('provider', 'The image provider returned something that is not JSON.');
  }

  const encoded = firstImageData(payload);
  if (!encoded) {
    throw new ImageGenError('provider', 'The image provider returned no image data.');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) {
    throw new ImageGenError('provider', 'The image provider returned an empty image.');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageGenError(
      'provider',
      `The image provider returned ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES} byte cap.`,
    );
  }

  return { bytes: new Uint8Array(bytes), contentType: IMAGE_MIME };
}

/**
 * A status code, as the thing a person would do about it.
 *
 * **400 is `provider`, not `policy`, and that was corrected by a live call.** It
 * read `policy` on the argument that the request shape is ours and pinned by a
 * test, so the field a vendor rejects must be the prompt. The test pins OUR side
 * of the wire and says nothing about the vendor's, and the very first live call
 * this code made came back 400 for a benign brief about ad hooks. Telling
 * somebody their creative was declined when the truth is our request shape is a
 * false statement on the surface they would act on, so the ambiguous code now
 * reads as ours until the body says otherwise.
 *
 * A safety refusal is still reported as one, read off the vendor's own body
 * rather than guessed from the number.
 */
function statusError(status: number, detail = ''): ImageGenError {
  const because = detail ? ` The provider said: ${detail}` : '';
  if (status === 401 || status === 403) {
    return new ImageGenError(
      'auth',
      `The image provider refused the key for this workspace.${because}`,
    );
  }
  if (status === 429) {
    return new ImageGenError(
      'rate_limited',
      `The image provider is rate limiting this key.${because}`,
    );
  }
  if (/safety|blocked|policy|prohibited/i.test(detail)) {
    return new ImageGenError(
      'policy',
      `The image provider declined to generate from this brief.${because}`,
    );
  }
  return new ImageGenError('provider', `The image provider returned ${status}.${because}`);
}

/**
 * The base64 payload, from either shape the API can answer in.
 *
 * `output_image.data` is the documented convenience field. The steps array is the
 * response's own structure, which is what `services/ai` walks for text, and it is
 * read as the fallback for the same reason it is there: the convenience field's
 * presence in the raw JSON is not promised, and a reader that knows only one
 * shape breaks on a response that is perfectly valid.
 */
function firstImageData(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const direct = (root.output_image as Record<string, unknown> | undefined)?.data;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const steps = Array.isArray(root.steps) ? root.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const content = (step as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const data = b.data ?? (b.image as Record<string, unknown> | undefined)?.data;
      if (typeof data === 'string' && data.length > 0) return data;
    }
  }
  return null;
}
