import { readCapped, extractBody } from "./ingestArticle.js";

import type { FeedItem } from "../types.js";

/**
 * Fetches an article page and returns ONLY its plain-text body — no title/cover
 * re-derivation. Used to enrich a stored feed item whose feed shipped a short
 * (headline-only) snippet before handing it to the rewriter. Reuses the same
 * fetch + readCapped + extractBody path as fetchArticle (single GET, 8s timeout,
 * first 256KB). Throws a readable Error on network / non-ok / non-HTML responses
 * so the caller can fall back to the stored snippet.
 */
export async function fetchArticleBody(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "blog-newsbot/1.0",
      },
    });
  } catch (err) {
    throw new Error(`Не удалось загрузить страницу: ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`Страница ответила ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !type.includes("html")) throw new Error("Ссылка ведёт не на HTML-страницу.");

  const html = await readCapped(res, 256_000);
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
