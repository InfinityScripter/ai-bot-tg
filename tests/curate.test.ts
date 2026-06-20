import { describe, expect, it } from 'vitest';

import { curateForQueue, parseKeywords, passesFilters } from '../src/curate.js';
import type { FeedItem } from '../src/types.js';

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: 'k',
    url: 'https://ex/1',
    title: 'Title',
    snippet: 'snippet',
    feedTitle: 'Feed',
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...overrides,
  };
}

describe('parseKeywords', () => {
  it('splits, trims, lowercases, drops empties', () => {
    expect(parseKeywords(' AI, ML ,, gpu ')).toEqual(['ai', 'ml', 'gpu']);
    expect(parseKeywords(undefined)).toEqual([]);
    expect(parseKeywords('')).toEqual([]);
  });
});

describe('passesFilters', () => {
  it('keeps everything when both lists empty', () => {
    expect(passesFilters(item(), [], [])).toBe(true);
  });

  it('include: keeps only items matching a keyword (title or snippet)', () => {
    const ai = item({ title: 'New AI chip' });
    const other = item({ title: 'Garden tips', snippet: 'flowers' });
    expect(passesFilters(ai, ['ai'], [])).toBe(true);
    expect(passesFilters(other, ['ai'], [])).toBe(false);
  });

  it('exclude: drops items matching a keyword, and takes precedence over include', () => {
    const sponsored = item({ title: 'AI news', snippet: 'sponsored post' });
    expect(passesFilters(sponsored, [], ['sponsored'])).toBe(false);
    // matches include 'ai' but also exclude 'sponsored' → excluded wins
    expect(passesFilters(sponsored, ['ai'], ['sponsored'])).toBe(false);
  });
});

describe('curateForQueue', () => {
  it('orders newest-first; undated items sort last', () => {
    const a = item({ dedupKey: 'a', publishedAt: 1000 });
    const b = item({ dedupKey: 'b', publishedAt: 3000 });
    const c = item({ dedupKey: 'c', publishedAt: null });
    const d = item({ dedupKey: 'd', publishedAt: 2000 });
    const out = curateForQueue([a, b, c, d], [], []);
    expect(out.map((i) => i.dedupKey)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('applies filters then sorts', () => {
    const keep1 = item({ dedupKey: 'k1', title: 'AI', publishedAt: 1000 });
    const drop = item({ dedupKey: 'd', title: 'cooking', publishedAt: 5000 });
    const keep2 = item({ dedupKey: 'k2', title: 'ML', snippet: 'ai stuff', publishedAt: 2000 });
    const out = curateForQueue([keep1, drop, keep2], ['ai'], []);
    expect(out.map((i) => i.dedupKey)).toEqual(['k2', 'k1']); // drop filtered, newest first
  });
});
