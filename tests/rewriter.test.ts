import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the Anthropic SDK: default export is a class with messages.create.
const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

const { rewriteToPost } = await import('../src/rewriter.js');
import type { FeedItem } from '../src/types.js';

const ITEM: FeedItem = {
  dedupKey: 'k',
  url: 'https://example.com/a',
  title: 'Source headline',
  snippet: 'Source snippet',
  feedTitle: 'Feed',
  imageUrl: null,
};

const VALID = {
  title: 'Rewritten',
  description: 'Summary',
  content: 'Body',
  tags: ['a'],
  metaTitle: 'M',
  metaDescription: 'MD',
};

/** Wraps a string as a Claude message response with one text block. */
function textResponse(text: string, stopReason = 'end_turn') {
  return { stop_reason: stopReason, content: [{ type: 'text', text }] };
}

afterEach(() => {
  create.mockReset();
});

describe('rewriteToPost', () => {
  it('returns the validated object from clean JSON output', async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify(VALID)));
    expect(await rewriteToPost(ITEM)).toEqual(VALID);
  });

  it('extracts JSON even with surrounding prose', async () => {
    create.mockResolvedValueOnce(textResponse(`Вот пост:\n${JSON.stringify(VALID)}\nГотово.`));
    expect(await rewriteToPost(ITEM)).toEqual(VALID);
  });

  it('throws on a refusal stop_reason', async () => {
    create.mockResolvedValueOnce(textResponse('', 'refusal'));
    await expect(rewriteToPost(ITEM)).rejects.toThrow(/refusal/i);
  });

  it('throws when there is no JSON in the output', async () => {
    create.mockResolvedValueOnce(textResponse('no json here'));
    await expect(rewriteToPost(ITEM)).rejects.toThrow(/не вернул JSON/);
  });

  it('throws when JSON is present but fails schema validation', async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ title: 'only title' })));
    await expect(rewriteToPost(ITEM)).rejects.toThrow(/валидаци/i);
  });

  it('clamps an over-long Claude title to keep the heading readable', async () => {
    const longTitle = 'А'.repeat(250);
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ ...VALID, title: longTitle })));
    const result = await rewriteToPost(ITEM);
    expect(result.title.length).toBeLessThanOrEqual(101); // 100 + ellipsis
  });
});

describe('rewriteToPost (REWRITE_MOCK)', () => {
  it('mock body does not start with a markdown heading and clamps the title', async () => {
    vi.stubEnv('REWRITE_MOCK', '1');
    vi.resetModules();
    const mod = await import('../src/rewriter.js');
    const longTitleItem = { ...ITEM, title: 'Б'.repeat(250), snippet: 'Тело новости.' };

    const result = await mod.rewriteToPost(longTitleItem);

    expect(result.content.startsWith('#')).toBe(false); // no "## title" duplicate
    expect(result.content).toContain('Тело новости.');
    expect(result.title.length).toBeLessThanOrEqual(101);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
