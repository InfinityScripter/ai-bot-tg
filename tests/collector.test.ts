import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeedItem } from '../src/types.js';

// Control the feeds; the rewriter must NOT be called at collection time.
const fetchAllFeeds = vi.fn<() => Promise<FeedItem[]>>();
vi.mock('../src/feeds.js', () => ({ fetchAllFeeds: () => fetchAllFeeds() }));

const rewriteToPost = vi.fn();
vi.mock('../src/rewriter.js', () => ({ rewriteToPost: (...a: unknown[]) => rewriteToPost(...a) }));

const { runCollection } = await import('../src/collector.js');
const { CandidateStore } = await import('../src/store.js');

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: 'https://ex.com/a',
    url: 'https://ex.com/a',
    title: 'T',
    snippet: 's',
    feedTitle: 'Feed',
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  fetchAllFeeds.mockReset();
  rewriteToPost.mockReset();
});

describe('runCollection — raw cards, no rewrite at collection', () => {
  it('does NOT rewrite; inserts collected and sends one raw card per fresh item', async () => {
    const store = new CandidateStore(':memory:');
    fetchAllFeeds.mockResolvedValue([
      feedItem({ dedupKey: 'k1', url: 'https://ex.com/1' }),
      feedItem({ dedupKey: 'k2', url: 'https://ex.com/2' }),
    ]);
    const sent: number[] = [];
    const sendRawCard = vi.fn(async (c: { id: number; state: string }) => {
      sent.push(c.id);
      expect(c.state).toBe('collected'); // card shows the RAW item
    });

    const summary = await runCollection(store, sendRawCard, 0);

    expect(rewriteToPost).not.toHaveBeenCalled();
    expect(summary.fresh).toBe(2);
    expect(summary.sent).toBe(2);
    expect(sent).toHaveLength(2);
    store.close();
  });

  it('persists the raw snippet + images so a later rewrite can run', async () => {
    const store = new CandidateStore(':memory:');
    fetchAllFeeds.mockResolvedValue([
      feedItem({ snippet: 'raw body', imageUrls: ['https://cdn/c.jpg'] }),
    ]);
    let capturedId = -1;
    await runCollection(store, async (c: { id: number }) => {
      capturedId = c.id;
    }, 0);

    const rebuilt = store.getFeedItem(store.get(capturedId)!);
    expect(rebuilt.snippet).toBe('raw body');
    expect(rebuilt.imageUrls).toEqual(['https://cdn/c.jpg']);
    store.close();
  });

  it('orders the queue newest-first before the cap', async () => {
    const store = new CandidateStore(':memory:');
    fetchAllFeeds.mockResolvedValue([
      feedItem({ dedupKey: 'old', url: 'https://ex/old', publishedAt: 1000 }),
      feedItem({ dedupKey: 'new', url: 'https://ex/new', publishedAt: 9000 }),
    ]);
    const order: string[] = [];
    await runCollection(
      store,
      async (c: { id: number }) => {
        order.push(store.get(c.id)!.dedupKey);
      },
      0
    );
    expect(order[0]).toBe('new'); // newest sent first
    store.close();
  });

  it('reports afterFilter=0 + filterActive when an include filter hides everything', async () => {
    vi.stubEnv('FILTER_INCLUDE', 'zzz-no-match');
    vi.resetModules();
    const feeds = await import('../src/feeds.js');
    // re-mock the freshly imported feeds module
    vi.spyOn(feeds, 'fetchAllFeeds').mockResolvedValue([feedItem({ title: 'Unrelated news' })]);
    const { runCollection: run } = await import('../src/collector.js');
    const { CandidateStore: Store } = await import('../src/store.js');
    const store = new Store(':memory:');

    const sent: number[] = [];
    const summary = await run(store, async (c: { id: number }) => void sent.push(c.id), 0);

    expect(summary.fetched).toBe(1);
    expect(summary.afterFilter).toBe(0);
    expect(summary.filterActive).toBe(true);
    expect(sent).toHaveLength(0);
    store.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('counts a DM failure without aborting the run', async () => {
    const store = new CandidateStore(':memory:');
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    const summary = await runCollection(store, async () => {
      throw new Error('telegram down');
    }, 0);
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    store.close();
  });
});
