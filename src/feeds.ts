import Parser from 'rss-parser';

import { CONFIG } from './config.js';
import type { FeedItem } from './types.js';
import { dedupKeyFor, stripHtml, truncate } from './utils.js';

/**
 * Default general-news RSS feeds. Override at runtime with the RSS_FEEDS env
 * var (comma-separated). Kept here (not in config) so the list is editable
 * without touching env, and importable by tests.
 */
export const DEFAULT_FEEDS: string[] = [
  'https://lenta.ru/rss/news',
  'https://www.vedomosti.ru/rss/news',
  'https://tass.ru/rss/v2.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
];

/** Resolves the active feed list: RSS_FEEDS override, else the defaults. */
export function resolveFeeds(): string[] {
  if (CONFIG.RSS_FEEDS && CONFIG.RSS_FEEDS.trim()) {
    return CONFIG.RSS_FEEDS.split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return DEFAULT_FEEDS;
}

// One parser instance, reused across feeds. 10s timeout so a slow feed doesn't
// stall the whole daily run.
const parser = new Parser({ timeout: 10_000 });

/** Maps a single parsed feed into normalized FeedItems, dropping unusable ones. */
function mapFeed(feed: Parser.Output<Record<string, unknown>>): FeedItem[] {
  const feedTitle = feed.title ?? '';
  const items: FeedItem[] = [];
  for (const item of feed.items) {
    const dedupKey = dedupKeyFor(item.guid, item.link);
    if (!dedupKey) continue; // no stable identifier — skip
    const title = (item.title ?? '').trim();
    if (!title) continue;
    const snippet = truncate(stripHtml(item.contentSnippet || item.content || ''), 800);
    items.push({
      dedupKey,
      url: item.link ?? dedupKey,
      title,
      snippet,
      feedTitle,
    });
  }
  return items;
}

/**
 * Fetches every configured feed and returns the combined, normalized items.
 * Each feed is isolated in its own try/catch — a malformed or unreachable feed
 * is logged and skipped, never aborting the batch.
 */
export async function fetchAllFeeds(feeds: string[] = resolveFeeds()): Promise<FeedItem[]> {
  const results = await Promise.allSettled(feeds.map((url) => parser.parseURL(url)));

  const items: FeedItem[] = [];
  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      items.push(...mapFeed(result.value));
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[feeds] failed to parse ${feeds[idx]}: ${String(result.reason)}`);
    }
  });
  return items;
}
