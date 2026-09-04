/**
 * The image call, pinned at the wire.
 *
 * **A stubbed `fetch` rather than a live key**, for the reason every wire-shape
 * test in this repository uses one: the thing worth pinning is the request we
 * send and the response we can read, and both are true whether or not a vendor is
 * reachable from a test runner. What the stub cannot prove is that the vendor
 * still accepts this shape, which is a live check on somebody's own key rather
 * than a unit test (rule 21).
 *
 * The properties here are the ones that cost money or leak credentials if they
 * drift: the key travels in a header and never in a URL, the prompt travels in a
 * body and never in a path, one call is made per image, and a response that is
 * not an image is an error rather than an empty artifact.
 */

import { describe, expect, it, vi } from 'vitest';
import { generateImages, imageFailureSentence, ImageGenError, MAX_IMAGE_BYTES } from './image-gen';
import type { GenerationTarget } from './model-routing';

const GOOGLE: GenerationTarget = {
  vendor: 'google',
  provider: 'google',
  model: 'gemini-3.1-flash-image',
  apiKey: 'AIza-not-a-real-key-4f2a',
  baseUrl: null,
};

const REQUEST = {
  prompt: 'Concept: one lamp in an empty office.',
  count: 1,
  aspect: '1:1',
} as const;

/** A one-pixel PNG, base64, as the vendor would return it. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function stub(body: unknown) {
  return vi.fn(async () => okResponse(body));
}

describe('generateImages', () => {
  it('sends the prompt in the body and the key in a header', async () => {
    const fetchImpl = stub({ output_image: { data: PIXEL } });
    await generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    // The key never reaches a URL: query strings land in access logs and referrers.
    expect(url).not.toContain('AIza');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(GOOGLE.apiKey);

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gemini-3.1-flash-image');
    expect(body.input).toBe(REQUEST.prompt);
    expect(body.response_format).toEqual({
      type: 'image',
      mime_type: 'image/png',
      aspect_ratio: '1:1',
    });
  });

  it('makes one call per image, so a failed third does not lose the first two', async () => {
    const fetchImpl = stub({ output_image: { data: PIXEL } });
    const images = await generateImages(
      GOOGLE,
      { ...REQUEST, count: 3 },
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(images).toHaveLength(3);
    expect(images[0]?.contentType).toBe('image/png');
    expect(images[0]?.bytes.length).toBeGreaterThan(0);
  });

  it('reads the steps shape as well as the convenience field', async () => {
    // `output_image` is documented and its presence in the raw JSON is not
    // promised; the steps array is the response's own structure, which is what
    // the text path already walks.
    const fetchImpl = stub({ steps: [{ content: [{ type: 'image', data: PIXEL }] }] });
    const images = await generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch);
    expect(images).toHaveLength(1);
  });

  it('turns a refused key into an auth error rather than a number', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(
      generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('turns a rate limit into a wait rather than a failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429 }));
    await expect(
      generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('reads a 400 as the brief being declined, because the shape is ours and pinned', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    await expect(
      generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'policy' });
  });

  it('refuses a response with no image rather than storing nothing', async () => {
    const fetchImpl = stub({ steps: [{ content: [{ type: 'text', text: 'I cannot' }] }] });
    await expect(
      generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(ImageGenError);
  });

  it('refuses an image over the byte cap', async () => {
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 1).toString('base64');
    const fetchImpl = stub({ output_image: { data: huge } });
    await expect(
      generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'provider' });
  });

  it('reports a network failure as unreachable rather than as an empty answer', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      generateImages(GOOGLE, REQUEST, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'provider' });
  });

  it('refuses a vendor with no image endpoint instead of calling one', async () => {
    const fetchImpl = stub({ output_image: { data: PIXEL } });
    await expect(
      generateImages(
        { ...GOOGLE, vendor: 'anthropic', provider: 'anthropic', model: 'claude-opus-5' },
        REQUEST,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: 'unsupported' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('draws the fake vendor without a network call at all', async () => {
    const fetchImpl = stub({});
    const images = await generateImages(
      { ...GOOGLE, vendor: 'fake', provider: 'fake', model: 'fake-image', apiKey: 'fake-key' },
      { ...REQUEST, count: 2 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(images).toHaveLength(2);
    expect(images[0]?.contentType).toBe('image/png');
    expect(images[0]?.bytes.length).toBeGreaterThan(0);
  });
});

describe('imageFailureSentence', () => {
  it('says what happened and that the brief is still the deliverable', () => {
    for (const kind of ['auth', 'rate_limited', 'policy', 'provider', 'unsupported'] as const) {
      const sentence = imageFailureSentence(kind);
      expect(sentence).toContain('the brief above is the deliverable');
      // Rule 22: this reaches a person in a room.
      expect(sentence).not.toContain('—');
      expect(sentence.endsWith('.')).toBe(true);
    }
  });
});
