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
  imageUrls: [],
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

  it('keeps only allow-listed body images and strips invented/cover ones', async () => {
    const richItem: FeedItem = {
      ...ITEM,
      imageUrl: 'https://cdn/cover.jpg',
      // cover at [0] is NOT allowed in the body; only in1/in2 are
      imageUrls: ['https://cdn/cover.jpg', 'https://cdn/in1.png', 'https://cdn/in2.png'],
    };
    const body = [
      'Текст.',
      '![](https://cdn/in1.png)', // allowed → kept
      'Ещё текст.',
      '![](https://cdn/cover.jpg)', // cover → stripped (not in allow-list)
      '![](https://evil/fake.png)', // invented → stripped
    ].join('\n\n');
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ ...VALID, content: body })));

    const result = await rewriteToPost(richItem);
    expect(result.content).toContain('![](https://cdn/in1.png)');
    expect(result.content).not.toContain('cover.jpg');
    expect(result.content).not.toContain('evil/fake.png');
  });
});

describe('rewriteToPost (Gemini provider)', () => {
  it('calls the Gemini OpenAI-compatible endpoint and validates output', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'gemini');
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../src/rewriter.js');
    const result = await mod.rewriteToPost(ITEM);

    expect(result).toEqual(VALID);
    const call = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(call[0]).toContain('generativelanguage.googleapis.com');
    expect(call[1].headers.Authorization).toBe('Bearer test-gemini-key');

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws a readable error on a non-OK Gemini response', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'gemini');
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    vi.resetModules();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' })
    );

    const mod = await import('../src/rewriter.js');
    await expect(mod.rewriteToPost(ITEM)).rejects.toThrow(/Gemini ответил 429/);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
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
