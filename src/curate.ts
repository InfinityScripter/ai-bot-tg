import type { FeedItem } from "./types.js";

/** Parses a CSV keyword list into lowercased, trimmed, non-empty terms. */
export function parseKeywords(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** True if the item's title+snippet contains any of the keywords (case-insensitive). */
function matchesAny(item: FeedItem, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const hay = `${item.title} ${item.snippet}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

/**
 * Applies the optional include/exclude keyword filters to a feed item.
 *   include — if non-empty, keep only items matching at least one keyword.
 *   exclude — drop items matching any keyword (takes precedence).
 * Both empty → keep everything.
 */
export function passesFilters(item: FeedItem, include: string[], exclude: string[]): boolean {
  if (exclude.length && matchesAny(item, exclude)) return false;
  if (include.length && !matchesAny(item, include)) return false;
  return true;
}

/**
 * Orders + filters feed items for the review queue: drop items failing the
 * keyword filters, then sort newest-first (items with no date sort last, stable
 * among themselves). The caller then takes the first MAX_PER_RUN. This way a
 * busy day surfaces the freshest relevant items instead of whatever happened to
 * come first in feed-concatenation order.
 */
export function curateForQueue(
  items: FeedItem[],
  include: string[],
  exclude: string[],
): FeedItem[] {
  const kept = items.filter((it) => passesFilters(it, include, exclude));
  // Stable newest-first: nulls last. Array.prototype.sort is stable in modern V8.
  return kept.sort((a, b) => {
    const ta = a.publishedAt ?? -Infinity;
    const tb = b.publishedAt ?? -Infinity;
    return tb - ta;
  });
}
