import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeedItem } from '../src/types.js';

// Control the feeds and the rewrite outcome per test.
const fetchAllFeeds = vi.fn<() => Promise<FeedItem[]>>();
vi.mock('../src/feeds.js', () => ({ fetchAllFeeds: () => fetchAllFeeds() }));

const rewriteToPost = vi.fn();
vi.mock('../src/rewriter.js', () => ({ rewriteToPost: (...a: unknown[]) => rewriteToPost(...a) }));

const { runCollection } = await import('../src/collector.js');
const { CandidateStore } = await import('../src/store.js');

function feedItem(): FeedItem {
  return {
    dedupKey: 'https://ex.com/a',
    url: 'https://ex.com/a',
    title: 'T',
    snippet: 's',
    feedTitle: 'Feed',
    imageUrl: null,
    imageUrls: [],
  };
}

const noopSend = vi.fn().mockResolvedValue(undefined);

afterEach(() => {
  fetchAllFeeds.mockReset();
  rewriteToPost.mockReset();
  noopSend.mockReset();
});

describe('runCollection — invalid override auto-clear', () => {
  it('clears the override when a rewrite fails with a model-not-found error', async () => {
    const store = new CandidateStore(':memory:');
    store.setModelOverride('glm', 'glm-retired-model');
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    rewriteToPost.mockRejectedValue(new Error('GLM ответил 404: model not found'));

    const summary = await runCollection(store, noopSend);

    expect(summary.failed).toBe(1);
    expect(store.getModelOverride()).toBeNull(); // override cleared → env next run
    store.close();
  });

  it('keeps the override on a transient error (e.g. 429 rate limit)', async () => {
    const store = new CandidateStore(':memory:');
    store.setModelOverride('glm', 'glm-4.7-flash');
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    rewriteToPost.mockRejectedValue(new Error('GLM ответил 429: rate limited'));

    await runCollection(store, noopSend);

    expect(store.getModelOverride()).toEqual({ provider: 'glm', model: 'glm-4.7-flash' });
    store.close();
  });
});
