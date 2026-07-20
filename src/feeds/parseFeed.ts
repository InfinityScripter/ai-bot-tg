import Parser from "rss-parser";

import { collectImageUrls } from "./collectImages.js";
import { ARTICLE_BODY_CHAR_LIMIT } from "./ingestArticle.js";
import { truncate, stripHtml, dedupKeyFor } from "../utils.js";

import type { RssItem } from "./types.js";
import type { FeedItem } from "../types.js";

// One parser instance, reused across feeds. 10s timeout so a slow feed doesn't
// stall the whole daily run. Custom fields capture the common image carriers
// (RSS enclosure, Media RSS content/thumbnail) so we can use a real cover.
export const rssParser: Parser<Record<string, unknown>, RssItem> = new Parser({
  timeout: 10_000,
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
    ],
  },
});

/** Picks the best available cover image URL from an item, or null. */
function extractImageUrl(item: Parser.Item & RssItem): string | null {
  // 1) RSS <enclosure> with an image type (or no type — many feeds omit it).
  const enc = item.enclosure;
  if (enc?.url && (!enc.type || enc.type.startsWith("image/"))) {
    return enc.url;
  }
  // 2) Media RSS <media:content> / <media:thumbnail>.
  const media = [...(item.mediaContent ?? []), ...(item.mediaThumbnail ?? [])];
  for (const node of media) {
    const url = node?.$?.url;
    if (url && (!node.$?.medium || node.$.medium === "image")) return url;
  }
  return null;
}

/** Maps a single parsed feed into normalized FeedItems, dropping unusable ones. */
export function mapFeed(feed: Parser.Output<RssItem>): FeedItem[] {
  const feedTitle = feed.title ?? "";
  const items: FeedItem[] = [];
  for (const item of feed.items) {
    const dedupKey = dedupKeyFor(item.guid, item.link);
    if (!dedupKey) continue; // no stable identifier — skip
    const title = (item.title ?? "").trim();
    if (!title) continue;
    // Prefer the full body (<content:encoded>), then plain content, then the
    // short snippet. Cap generously so the LLM sees the whole article; the mock
    // path trims its own display copy separately.
    const snippet = truncate(
      stripHtml(item.contentEncoded || item.content || item.contentSnippet || ""),
      ARTICLE_BODY_CHAR_LIMIT,
    );
    const imageUrl = extractImageUrl(item);
    // rss-parser normalizes the date to item.isoDate; fall back to pubDate.
    const dateStr = item.isoDate || item.pubDate;
    const parsed = dateStr ? Date.parse(dateStr) : NaN;
    const publishedAt = Number.isNaN(parsed) ? null : parsed;
    items.push({
      dedupKey,
      url: item.link ?? dedupKey,
      title,
      snippet,
      feedTitle,
      imageUrl,
      publishedAt,
      // Cover first, then every <img> in the article body (<content:encoded>).
      imageUrls: collectImageUrls(imageUrl, item.contentEncoded || item.content || ""),
    });
  }
  return items;
}
