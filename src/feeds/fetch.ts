import { fetchOgImage } from "./scraper.js";
import { mapFeed, rssParser, resolveFeeds } from "./parser.js";

import type { FeedItem } from "../types.js";

/**
 * Fetches every configured feed and returns combined normalised items.
 * Each feed is isolated — a failing feed is logged and skipped.
 */
export async function fetchAllFeeds(feeds: string[] = resolveFeeds()): Promise<FeedItem[]> {
  const results = await Promise.allSettled(feeds.map((url) => rssParser.parseURL(url)));

  const items: FeedItem[] = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      items.push(...mapFeed(result.value));
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[feeds] failed to parse ${feeds[idx]}: ${String(result.reason)}`);
    }
  });

  // og:image fallback: scrape pages that had no feed image.
  await Promise.all(
    items.map(async (item) => {
      if (item.imageUrl) return;
      item.imageUrl = await fetchOgImage(item.url);
    }),
  );

  return items;
}
