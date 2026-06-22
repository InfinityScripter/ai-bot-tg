import Parser from "rss-parser";

import { CONFIG } from "../config.js";
import { IMG_SRC_RE } from "./scrapeOgImage.js";
import { truncate, stripHtml, dedupKeyFor } from "../utils.js";

import type { FeedItem } from "../types.js";

/**
 * Default general-news RSS feeds. Override at runtime with the RSS_FEEDS env
 * var (comma-separated). Kept here (not in config) so the list is editable
 * without touching env, and importable by tests.
 */
// Russian-first TECH feeds — dev/IT, hardware, AI/ML. Chosen for delivering
// real article BODY text (not headline-only), measured live with rss-parser;
// bodyLen noted below is from the first item on a sample fetch. Habr exposes
// its body in <content:encoded>, which mapFeed reads.
export const DEFAULT_FEEDS: string[] = [
  // dev / IT
  "https://habr.com/ru/rss/best/daily/?fl=ru", // лучшее на Habr за день, body ~1860
  "https://www.opennet.ru/opennews/opennews_all_utf.rss", // open-source / безопасность, body ~470
  // hardware / гаджеты
  "https://3dnews.ru/news/rss", // железо, body ~210, image
  "https://www.ixbt.com/export/news.rss", // железо/гаджеты, body ~1360
  // AI / ML
  "https://habr.com/ru/rss/hubs/machine_learning/articles/?fl=ru", // ML, body ~1650
  "https://habr.com/ru/rss/hubs/artificial_intelligence/articles/?fl=ru", // ИИ, body ~210
  // 'https://dev.to/feed',     // en tech, content ~3000 — раскомментируй для англо-IT
];

/** Resolves the active feed list: RSS_FEEDS override, else the defaults. */
export function resolveFeeds(): string[] {
  if (CONFIG.RSS_FEEDS && CONFIG.RSS_FEEDS.trim()) {
    return CONFIG.RSS_FEEDS.split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return DEFAULT_FEEDS;
}

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

/**
 * Collects every usable image URL for an item: the cover first, then every
 * <img> embedded in the article body (<content:encoded>), de-duplicated and
 * order-preserved. Only absolute http(s) URLs are kept — relative/data URIs
 * are dropped so what we hand downstream is always a real, fetchable cover.
 */
function extractImageUrls(item: Parser.Item & RssItem, cover: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined) => {
    if (!url) return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return; // skip relative / data: URIs
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  push(cover);
  const body = item.contentEncoded || item.content || "";
  for (const m of body.matchAll(IMG_SRC_RE)) {
    push(m[1]);
  }
  return out;
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
    // short snippet. Cap generously so Claude sees the whole article; the mock
    // path trims its own display copy separately.
    const snippet = truncate(
      stripHtml(item.contentEncoded || item.content || item.contentSnippet || ""),
      4000,
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
      imageUrls: extractImageUrls(item, imageUrl),
    });
  }
  return items;
}
