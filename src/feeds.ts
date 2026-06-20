import Parser from 'rss-parser';

import { CONFIG } from './config.js';
import type { FeedItem } from './types.js';
import { dedupKeyFor, stripHtml, truncate } from './utils.js';

/**
 * Default general-news RSS feeds. Override at runtime with the RSS_FEEDS env
 * var (comma-separated). Kept here (not in config) so the list is editable
 * without touching env, and importable by tests.
 */
// Feeds chosen for delivering real article BODY text (not headline-only),
// measured live with rss-parser. Russian-first; most carry a cover image.
// Meduza & N+1 put their body only in <content:encoded> — mapFeed reads it.
export const DEFAULT_FEEDS: string[] = [
  'https://meduza.io/rss/all', // ru, content:encoded ~1130+, image
  'https://3dnews.ru/news/rss', // ru, content ~520, image
  'https://nplus1.ru/rss', // ru science, content:encoded ~639, image
  'https://www.opennet.ru/opennews/opennews_all_utf.rss', // ru tech, content ~855
  // 'https://dev.to/feed',     // en tech, content ~3000 — раскомментируй для англо-IT
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
// stall the whole daily run. Custom fields capture the common image carriers
// (RSS enclosure, Media RSS content/thumbnail) so we can use a real cover.
const parser: Parser<Record<string, unknown>, RssItem> = new Parser({
  timeout: 10_000,
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

interface MediaNode {
  $?: { url?: string; medium?: string; type?: string };
}

interface RssItem {
  /** Full article body, where present (Meduza, N+1, WordPress feeds). */
  contentEncoded?: string;
  enclosure?: { url?: string; type?: string };
  mediaContent?: MediaNode[];
  mediaThumbnail?: MediaNode[];
}

/** Picks the best available image URL from an item, or null. */
function extractImageUrl(item: Parser.Item & RssItem): string | null {
  // 1) RSS <enclosure> with an image type (or no type — many feeds omit it).
  const enc = item.enclosure;
  if (enc?.url && (!enc.type || enc.type.startsWith('image/'))) {
    return enc.url;
  }
  // 2) Media RSS <media:content> / <media:thumbnail>.
  const media = [...(item.mediaContent ?? []), ...(item.mediaThumbnail ?? [])];
  for (const node of media) {
    const url = node?.$?.url;
    if (url && (!node.$?.medium || node.$.medium === 'image')) return url;
  }
  return null;
}

/** Maps a single parsed feed into normalized FeedItems, dropping unusable ones. */
function mapFeed(feed: Parser.Output<RssItem>): FeedItem[] {
  const feedTitle = feed.title ?? '';
  const items: FeedItem[] = [];
  for (const item of feed.items) {
    const dedupKey = dedupKeyFor(item.guid, item.link);
    if (!dedupKey) continue; // no stable identifier — skip
    const title = (item.title ?? '').trim();
    if (!title) continue;
    // Prefer the full body (<content:encoded>), then plain content, then the
    // short snippet. Cap generously so Claude sees the whole article; the mock
    // path trims its own display copy separately.
    const snippet = truncate(
      stripHtml(item.contentEncoded || item.content || item.contentSnippet || ''),
      4000
    );
    items.push({
      dedupKey,
      url: item.link ?? dedupKey,
      title,
      snippet,
      feedTitle,
      imageUrl: extractImageUrl(item),
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
