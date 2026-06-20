import { afterEach, describe, expect, it, vi } from 'vitest';

import { publishToBlog, toBlogPostBody } from '../src/publisher.js';
import type { RewriteResult } from '../src/types.js';

const REWRITE: RewriteResult = {
  title: 'New title',
  description: 'Summary',
  content: 'Body',
  tags: ['t1', 't2'],
  metaTitle: 'Meta',
  metaDescription: 'Meta desc',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toBlogPostBody', () => {
  it('maps a rewrite into the publish body with published status (no cover)', () => {
    const body = toBlogPostBody(REWRITE);
    expect(body).toEqual({
      title: 'New title',
      description: 'Summary',
      content: 'Body',
      tags: ['t1', 't2'],
      metaTitle: 'Meta',
      metaDescription: 'Meta desc',
      metaKeywords: ['t1', 't2'],
      publish: 'published',
    });
    expect(body).not.toHaveProperty('coverUrl');
  });

  it('includes coverUrl when an image is provided', () => {
    const body = toBlogPostBody(REWRITE, 'https://cdn.example.com/p.jpg');
    expect(body.coverUrl).toBe('https://cdn.example.com/p.jpg');
  });

  it('omits coverUrl when image is null', () => {
    expect(toBlogPostBody(REWRITE, null)).not.toHaveProperty('coverUrl');
  });
});

describe('publishToBlog', () => {
  it('POSTs with the bearer token and returns the post id on 201', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, post: { id: 'post-9' } }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const id = await publishToBlog(REWRITE);
    expect(id).toBe('post-9');

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe('http://localhost:7272/api/post/new');
    expect(call[1].method).toBe('POST');
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-bot-api-token-value');
  });

  it('sends an Idempotency-Key header when a dedup key is given', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ post: { id: 'p' } }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await publishToBlog(REWRITE, null, 'https://example.com/a');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('https://example.com/a');
  });

  it('omits the Idempotency-Key header when no dedup key is given', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ post: { id: 'p' } }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await publishToBlog(REWRITE);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('throws PublishError(maybePosted=false) on a 4xx (clear client rejection)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 }))
    );
    const { PublishError } = await import('../src/publisher.js');
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({
      name: 'PublishError',
      maybePosted: false,
    });
    expect(PublishError).toBeDefined();
  });

  it('throws PublishError(maybePosted=true) on a 5xx (may have committed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 502 }))
    );
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({ maybePosted: true });
  });

  it('throws PublishError(maybePosted=true) on a 201 with an unreadable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 201 }))
    );
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({ maybePosted: true });
  });

  it('throws PublishError(maybePosted=false) when it cannot connect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({ maybePosted: false });
  });

  it('accepts a post returned with _id instead of id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ post: { _id: 'mongo-id' } }), { status: 201 }))
    );
    expect(await publishToBlog(REWRITE)).toBe('mongo-id');
  });

  it('throws on a non-201 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 }))
    );
    await expect(publishToBlog(REWRITE)).rejects.toThrow(/401/);
  });

  it('throws when the response has no post id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 201 }))
    );
    await expect(publishToBlog(REWRITE)).rejects.toThrow(/id/i);
  });

  it('throws a readable error when fetch itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    await expect(publishToBlog(REWRITE)).rejects.toThrow(/связаться с блогом/);
  });
});
