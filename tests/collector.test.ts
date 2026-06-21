import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeedItem } from '../src/types.js';

// Control the feeds; the rewriter must NOT be called at collection time.
const fetchAllFeeds = vi.fn<() => Promise<FeedItem[]>>();
vi.mock('../src/feeds.js', () => ({ fetchAllFeeds: () => fetchAllFeeds() }));

const rewriteToPost = vi.fn();
vi.mock('../src/rewriter.js', () => ({ rewriteToPost: (...a: unknown[]) => rewriteToPost(...a) }));

// Spy on filterRelevant so the collector tests never reach the real classify
// (which would resolve a provider and hit the network). The default impl just
// passes everything through, mirroring shadow/off mode (kept === curated). A
// case can override the mock to assert wiring (e.g. afterRelevance / dropping).
const filterRelevant = vi.fn(
  async (items: FeedItem[]) => ({ kept: items, decisions: [] })
);
vi.mock('../src/relevance.js', () => ({
  filterRelevant: (...a: unknown[]) => filterRelevant(...(a as Parameters<typeof filterRelevant>)),
}));

// Keep the collector offline: stub the audit emitter so it never hits the
// network. We still assert it's invoked with the decisions when present.
const emitRelevanceDecisions = vi.fn(async () => {});
vi.mock('../src/audit-emit.js', () => ({
  emitRelevanceDecisions: (...a: unknown[]) =>
    emitRelevanceDecisions(...(a as Parameters<typeof emitRelevanceDecisions>)),
}));

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
  // Restore the pass-through default so one case's override doesn't leak.
  filterRelevant.mockReset();
  filterRelevant.mockImplementation(async (items: FeedItem[]) => ({ kept: items, decisions: [] }));
  emitRelevanceDecisions.mockReset();
  emitRelevanceDecisions.mockImplementation(async () => {});
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

  // The two relevance-wiring tests re-import the collector against a freshly
  // mocked feeds + relevance module (the established self-contained pattern in
  // this file) so a prior test's vi.resetModules() can't leave a stale binding.
  it('runs the relevance filter between curate and insert; shadow/off keeps curated', async () => {
    vi.resetModules();
    const feeds = await import('../src/feeds.js');
    vi.spyOn(feeds, 'fetchAllFeeds').mockResolvedValue([
      feedItem({ dedupKey: 'k1', url: 'https://ex.com/1' }),
      feedItem({ dedupKey: 'k2', url: 'https://ex.com/2' }),
    ]);
    // Pass-through relevance (== shadow/off mode): nothing dropped.
    const filter = vi.fn(async (items: FeedItem[]) => ({ kept: items, decisions: [] }));
    vi.doMock('../src/relevance.js', () => ({ filterRelevant: filter }));
    const { runCollection: run } = await import('../src/collector.js');
    const { CandidateStore: Store } = await import('../src/store.js');
    const store = new Store(':memory:');

    const summary = await run(store, async () => {}, 0);

    // filterRelevant was invoked once with the curated list.
    expect(filter).toHaveBeenCalledTimes(1);
    expect(filter.mock.calls[0]![0]).toHaveLength(2);
    expect(summary.afterFilter).toBe(2);
    expect(summary.afterRelevance).toBe(2);
    expect(summary.droppedRelevance).toBe(0);
    expect(summary.fresh).toBe(2);
    store.close();
    vi.doUnmock('../src/relevance.js');
    vi.resetModules();
  });

  it("inserts only the kept set when relevance drops items (mode 'on')", async () => {
    vi.resetModules();
    const feeds = await import('../src/feeds.js');
    vi.spyOn(feeds, 'fetchAllFeeds').mockResolvedValue([
      feedItem({ dedupKey: 'keep', url: 'https://ex.com/keep' }),
      feedItem({ dedupKey: 'drop', url: 'https://ex.com/drop' }),
    ]);
    // Simulate mode 'on' dropping the second item.
    const filter = vi.fn(async (items: FeedItem[]) => ({
      kept: items.filter((i) => i.dedupKey === 'keep'),
      decisions: [],
    }));
    vi.doMock('../src/relevance.js', () => ({ filterRelevant: filter }));
    const { runCollection: run } = await import('../src/collector.js');
    const { CandidateStore: Store } = await import('../src/store.js');
    const store = new Store(':memory:');

    const sent: string[] = [];
    const summary = await run(
      store,
      async (c: { id: number }) => void sent.push(store.get(c.id)!.dedupKey),
      0
    );

    expect(summary.afterFilter).toBe(2);
    expect(summary.afterRelevance).toBe(1);
    expect(summary.droppedRelevance).toBe(1);
    expect(summary.fresh).toBe(1);
    expect(sent).toEqual(['keep']);
    store.close();
    vi.doUnmock('../src/relevance.js');
    vi.resetModules();
  });

  it('forwards the relevance decisions to the audit emitter (mode shadow, non-empty)', async () => {
    vi.resetModules();
    const feeds = await import('../src/feeds.js');
    vi.spyOn(feeds, 'fetchAllFeeds').mockResolvedValue([feedItem({ url: 'https://ex.com/1' })]);

    const decisions = [
      { url: 'https://ex.com/1', title: 'T', kept: false, stage: 'llm', score: 0, reason: 'r' },
    ];
    const filter = vi.fn(async (items: FeedItem[]) => ({ kept: items, decisions }));
    vi.doMock('../src/relevance.js', () => ({ filterRelevant: filter }));
    const emit = vi.fn(async (_decisions: unknown, _mode: string) => {});
    vi.doMock('../src/audit-emit.js', () => ({ emitRelevanceDecisions: emit }));
    // Default RELEVANCE_MODE in the test env is 'shadow' (not 'off'), so emit fires.
    const { runCollection: run } = await import('../src/collector.js');
    const { CandidateStore: Store } = await import('../src/store.js');
    const store = new Store(':memory:');

    await run(store, async () => {}, 0);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toEqual(decisions);
    expect(emit.mock.calls[0]![1]).toBe('shadow');
    store.close();
    vi.doUnmock('../src/relevance.js');
    vi.doUnmock('../src/audit-emit.js');
    vi.resetModules();
  });

  it('does NOT call the audit emitter when there are no decisions (off/shadow no-op)', async () => {
    // The top-level relevance mock returns decisions: [] → emit must be skipped.
    const store = new CandidateStore(':memory:');
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    await runCollection(store, async () => {}, 0);
    expect(emitRelevanceDecisions).not.toHaveBeenCalled();
    store.close();
  });
});
