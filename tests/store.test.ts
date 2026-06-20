import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CandidateStore } from '../src/store.js';
import type { FeedItem, RewriteResult } from '../src/types.js';

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: 'https://example.com/a',
    url: 'https://example.com/a',
    title: 'Title A',
    snippet: 'snippet',
    feedTitle: 'Feed',
    ...overrides,
  };
}

const REWRITE: RewriteResult = {
  title: 'New title',
  description: 'Summary',
  content: 'Body',
  tags: ['t1', 't2'],
  metaTitle: 'Meta',
  metaDescription: 'Meta desc',
};

describe('CandidateStore', () => {
  let store: CandidateStore;

  beforeEach(() => {
    store = new CandidateStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('inserts a fresh item as collected and returns its id', () => {
    const id = store.insertCollected(item());
    expect(id).not.toBeNull();
    const c = store.get(id!);
    expect(c?.state).toBe('collected');
    expect(c?.sourceTitle).toBe('Title A');
  });

  it('dedups: a second insert of the same key returns null and does not duplicate', () => {
    const first = store.insertCollected(item());
    const second = store.insertCollected(item());
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(store.isSeen('https://example.com/a')).toBe(true);
  });

  it('treats distinct keys as separate candidates', () => {
    const a = store.insertCollected(item({ dedupKey: 'https://example.com/a' }));
    const b = store.insertCollected(item({ dedupKey: 'https://example.com/b' }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('attaches a rewrite and moves to pending_review', () => {
    const id = store.insertCollected(item())!;
    store.attachRewrite(id, REWRITE);
    const c = store.get(id)!;
    expect(c.state).toBe('pending_review');
    expect(store.getRewrite(c)).toEqual(REWRITE);
  });

  it('records the telegram message id', () => {
    const id = store.insertCollected(item())!;
    store.setTelegramMessage(id, 555);
    expect(store.get(id)?.tgMessageId).toBe(555);
  });

  it('marks published with the blog post id', () => {
    const id = store.insertCollected(item())!;
    store.attachRewrite(id, REWRITE);
    store.setPublished(id, 'post-123');
    const c = store.get(id)!;
    expect(c.state).toBe('published');
    expect(c.blogPostId).toBe('post-123');
  });

  it('stores an error with a failed state', () => {
    const id = store.insertCollected(item())!;
    store.setState(id, 'rewrite_failed', 'boom');
    const c = store.get(id)!;
    expect(c.state).toBe('rewrite_failed');
    expect(c.error).toBe('boom');
  });

  describe('claimForPublishing (atomic guard against double-publish)', () => {
    it('lets exactly one caller win from pending_review', () => {
      const id = store.insertCollected(item())!;
      store.attachRewrite(id, REWRITE); // → pending_review

      expect(store.claimForPublishing(id)).toBe(true); // first tap wins
      expect(store.claimForPublishing(id)).toBe(false); // second tap loses
      expect(store.get(id)?.state).toBe('publishing');
    });

    it('does not claim a candidate that is not pending_review', () => {
      const id = store.insertCollected(item())!; // state 'collected'
      expect(store.claimForPublishing(id)).toBe(false);
      expect(store.get(id)?.state).toBe('collected');
    });
  });
});
