import { fetchHtml } from "./fetchHtml.js";
import { extractBody } from "./ingestArticle.js";

import type { FeedItem } from "../types.js";

/**
 * Fetches an article page and returns ONLY its plain-text body — no title/cover
 * re-derivation. Used to enrich a stored feed item whose feed shipped a short
 * (headline-only) snippet before handing it to the rewriter. Same fetch path as
 * fetchArticle (single GET, 8s timeout, first 256KB). Throws a readable Error
 * on network / non-ok / non-HTML responses so the caller can fall back to the
 * stored snippet.
 */
export async function fetchArticleBody(url: string): Promise<string> {
  const html = await fetchHtml(url, 256_000);
  return extractBody(html);
}

/**
 * Returns the item with its snippet enriched by the full scraped article body,
 * when the item has an http(s) URL and a short (< 500 char, i.e. headline-only)
 * stored snippet. A scrape failure is non-fatal — the original item is returned
 * unchanged so a scrape error can never abort the rewrite.
 */
export async function enrichItemBody(item: FeedItem): Promise<FeedItem> {
  if (!/^https?:\/\//i.test(item.url) || item.snippet.length >= 500) return item;
  try {
    const body = await fetchArticleBody(item.url);
    return body.length > item.snippet.length ? { ...item, snippet: body } : item;
  } catch {
    return item; // keep stored snippet
  }
}
