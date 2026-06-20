import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock rss-parser: the default export is a Parser class whose instances expose
// parseURL. We control parseURL per-test via the shared mock below.
const parseURL = vi.fn();
vi.mock('rss-parser', () => ({
  default: class {
    parseURL = parseURL;
  },
}));

// Import AFTER the mock is registered.
const { fetchAllFeeds } = await import('../src/feeds.js');

afterEach(() => {
  parseURL.mockReset();
});

describe('fetchAllFeeds', () => {
  it('normalizes items: dedupKey, title, snippet, feedTitle', async () => {
    parseURL.mockResolvedValueOnce({
      title: 'My Feed',
      items: [
        {
          title: 'Headline',
          link: 'https://example.com/a?utm_source=x',
          guid: 'https://example.com/a',
          contentSnippet: '<b>Body</b> text',
        },
      ],
    });

    const items = await fetchAllFeeds(['https://feed.one/rss']);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      dedupKey: 'https://example.com/a',
      title: 'Headline',
      snippet: 'Body text',
      feedTitle: 'My Feed',
    });
  });

  it('skips items with no stable identifier and no title', async () => {
    parseURL.mockResolvedValueOnce({
      title: 'Feed',
      items: [
        { title: 'No link no guid' }, // no dedup key → skipped
        { link: 'https://example.com/b', guid: 'https://example.com/b' }, // no title → skipped
        { title: 'Good', link: 'https://example.com/c', guid: 'https://example.com/c' },
      ],
    });

    const items = await fetchAllFeeds(['https://feed.one/rss']);
    expect(items.map((i) => i.title)).toEqual(['Good']);
  });

  it('isolates a failing feed — one bad feed does not abort the batch', async () => {
    parseURL
      .mockRejectedValueOnce(new Error('boom')) // first feed fails
      .mockResolvedValueOnce({
        title: 'OK Feed',
        items: [{ title: 'Survived', link: 'https://example.com/ok', guid: 'g-ok' }],
      });

    const items = await fetchAllFeeds(['https://bad.feed/rss', 'https://ok.feed/rss']);
    expect(items.map((i) => i.title)).toEqual(['Survived']);
  });

  it('returns empty when every feed fails', async () => {
    parseURL.mockRejectedValue(new Error('down'));
    const items = await fetchAllFeeds(['https://a/rss', 'https://b/rss']);
    expect(items).toEqual([]);
  });
});
