import { createHash } from "node:crypto";

import { InputKind } from "../enums.js";
import { truncate, stripHtml, canonicalizeUrl } from "../utils.js";
import { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT } from "./scrapeOgImage.js";

import type { FeedItem } from "../types.js";

/** The result of classifying an owner-sent message. */
export type ClassifiedInput =
  | { kind: InputKind.Url; url: string }
  | { kind: InputKind.Text; text: string }
  | { kind: InputKind.Empty };

/** True when the token is an absolute http(s) URL. */
function isHttpUrl(token: string): boolean {
  if (!/^https?:\/\//i.test(token)) return false;
  try {
    // new URL throws on a malformed URL — reject those, keep only real ones.
    return Boolean(new URL(token));
  } catch {
    return false;
  }
}

/**
 * Decides whether the owner's message is a URL to scrape, free text to post, or
 * empty. A message whose FIRST token is an http(s) URL is treated as URL mode
 * (the linked article is the source of truth, any trailing note is ignored);
 * anything else non-empty is free text.
 */
export function classifyInput(raw: string): ClassifiedInput {
  const text = (raw ?? "").trim();
  if (!text) return { kind: InputKind.Empty };
  const firstToken = text.split(/\s+/, 1)[0] ?? "";
  if (isHttpUrl(firstToken)) return { kind: InputKind.Url, url: firstToken };
  return { kind: InputKind.Text, text };
}

/** Matches og:title / twitter:title (both attribute orders). */
const OG_TITLE_RE =
  /<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)["']/i;
const OG_TITLE_RE_ALT =
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title)["']/i;
/** Matches og:description / twitter:description (both attribute orders). */
const OG_DESC_RE =
  /<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description|description)["'][^>]+content=["']([^"']+)["']/i;
const OG_DESC_RE_ALT =
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|twitter:description|description)["']/i;
/** Matches the contents of the <title> element. */
const TITLE_TAG_RE = /<title[^>]*>([^<]*)<\/title>/i;

/** Decodes the HTML entities common in meta/title text, named and numeric. */
function decodeEntities(input: string): string {
  return (
    input
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&nbsp;/g, " ")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Ampersand LAST so a decoded "&amp;#38;" can't re-form another entity.
      .replace(/&amp;/g, "&")
      .trim()
  );
}

/**
 * Strips a trailing site-name suffix ("Article — Habr", "Article | The Verge")
 * from a page <title> so the post heading is just the article title.
 */
function cleanTitle(title: string): string {
  const cut = title.split(/\s+[—–\-|·»]\s+/);
  // Keep the longest segment (the actual headline), not just the first — some
  // titles lead with the site ("Habr — Article…").
  const best = cut.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), cut[0] ?? title);
  return best.trim() || title.trim();
}

/** Pulls the article title from a page's meta/title tags. '' if none found. */
function extractTitle(html: string): string {
  const og = OG_TITLE_RE.exec(html) ?? OG_TITLE_RE_ALT.exec(html);
  if (og?.[1]) return cleanTitle(decodeEntities(og[1]));
  const tag = TITLE_TAG_RE.exec(html);
  if (tag?.[1]) return cleanTitle(decodeEntities(tag[1]));
  return "";
}

/** Pulls the meta description from a page, '' if none. */
function extractDescription(html: string): string {
  const m = OG_DESC_RE.exec(html) ?? OG_DESC_RE_ALT.exec(html);
  return m?.[1] ? decodeEntities(m[1]) : "";
}

/** Pulls the og:image / twitter:image cover URL, or null. */
function extractCover(html: string): string | null {
  const m = OG_IMAGE_RE.exec(html) ?? OG_IMAGE_RE_ALT.exec(html);
  const url = m?.[1]?.trim();
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Collects every usable image: the og cover first, then every body <img src>,
 * absolute http(s) only, de-duplicated and order-preserved — same shape feeds
 * produce for `imageUrls`.
 */
function extractImages(html: string, cover: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined) => {
    if (!url) return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  push(cover);
  for (const m of html.matchAll(IMG_SRC_RE)) push(m[1]);
  return out;
}

/**
 * Strips the page chrome and non-content elements, then reduces the HTML to a
 * plain-text body. Not a full readability engine — drops the obvious noise
 * (scripts, styles, nav/header/footer/aside) and lets stripHtml flatten the
 * rest. The LLM rewrite tolerates the residual noise; the cap keeps the prompt
 * bounded.
 */
export function extractBody(html: string): string {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return truncate(stripHtml(cleaned), 4000);
}

/**
 * Reads a response body as text, stopping once `maxBytes` have been consumed so
 * a huge page never buffers unbounded. Falls back to a plain (already-bounded by
 * the caller's slice) `res.text()` when the body isn't a readable stream.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (read >= maxBytes) break;
    }
  } finally {
    // Stop the transfer; we have enough. Ignore any cancel error.
    await reader.cancel().catch(() => {});
  }
  out += decoder.decode();
  return out;
}

/**
 * Scrapes an article page into a FeedItem so a manually-submitted URL flows
 * through the exact same rewrite → preview → publish pipeline as a collected
 * RSS item. Single GET, 8s timeout, reads only the first 256KB. Throws a
 * readable Error on a network failure, a non-HTML/non-ok response, or a page
 * with no usable title — the caller surfaces it in the Telegram DM.
 */
export async function fetchArticle(url: string): Promise<FeedItem> {
  const dedupKey = canonicalizeUrl(url);
  if (!dedupKey) throw new Error("Не удалось разобрать ссылку.");

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

  // The <head> meta tags and most body text live up top; cap the read so a huge
  // (or maliciously large) page can't buffer unbounded into memory. Read the
  // body stream incrementally and stop once we have enough.
  const html = await readCapped(res, 256_000);

  const title = extractTitle(html);
  if (!title) throw new Error("Не удалось извлечь заголовок статьи.");

  const cover = extractCover(html);
  const description = extractDescription(html);
  const body = extractBody(html);
  // Prefer the fuller of (description, body) as the rewrite input snippet.
  const snippet = body.length >= description.length ? body : description;

  let host = "";
  try {
    ({ host } = new URL(url));
  } catch {
    /* canonicalizeUrl already validated dedupKey; host is best-effort */
  }

  return {
    dedupKey,
    url,
    title: truncate(title, 300),
    snippet,
    feedTitle: host || "Ссылка",
    imageUrl: cover,
    imageUrls: extractImages(html, cover),
    publishedAt: null,
  };
}

/**
 * Builds a FeedItem from pasted free text: the first non-empty line becomes the
 * title (clamped), the whole text becomes the rewrite-input body. The dedupKey
 * is a synthetic `manual:<sha1>` so re-pasting identical text dedups while
 * distinct text never collides. No URL, no images.
 */
export function feedItemFromText(raw: string): FeedItem {
  const text = (raw ?? "").trim();
  const firstLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? text;
  const title = truncate(firstLine, 120);
  const snippet = truncate(text, 4000);
  const dedupKey = `manual:${createHash("sha1").update(text).digest("hex")}`;
  return {
    dedupKey,
    url: "",
    title,
    snippet,
    feedTitle: "Прислано вручную",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  };
}
