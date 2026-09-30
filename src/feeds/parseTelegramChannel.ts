import { decodeEntities } from "./ingestArticle.js";
import { visibleText, sanitizeTelegramHtml } from "./telegramHtml.js";

/** One post parsed from a public channel's web preview (t.me/s/<name>). */
export interface ChannelPost {
  channel: string;
  id: number;
  /** Permalink https://t.me/<channel>/<id>. */
  url: string;
  /** Plain text: tags stripped, <br> → newline, entities decoded. "" when the post has no text. */
  text: string;
  /** The text as sanitized Telegram HTML (see sanitizeTelegramHtml). */
  html: string;
  /** Outbound links from the text, in order. */
  links: string[];
  /** Every photo of the post (an album has several), at most MAX_PHOTOS. */
  imageUrls: string[];
  publishedAt: number | null;
  views: number | null;
  /** Reposted from another channel: never retold (the author is someone else). */
  forwarded: boolean;
}

const POST_RE = /data-post="([^"/]+)\/(\d+)"/;
const TEXT_OPEN_RE = /<div class="tgme_widget_message_text[^"]*\bjs-message_text\b[^"]*"[^>]*>/;
const DIV_RE = /<div\b|<\/div>/g;
const HREF_RE = /<a\s[^>]*href="([^"]+)"/g;
const PHOTO_RE = /tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g;
/** sendMediaGroup takes at most 10 items. */
const MAX_PHOTOS = 10;
const VIEWS_RE = /<span class="tgme_widget_message_views">([^<]*)<\/span>/;
const TIME_RE = /<time datetime="([^"]+)"/;

/** "401" → 401, "1.2K" → 1200, "1.1M" → 1100000; anything else → null. */
export function parseViews(raw: string): number | null {
  const m = /^([\d.]+)([KM]?)$/.exec(raw.trim());
  if (!m) return null;
  const scale = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  const value = Number(m[1]) * scale;
  return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Inner HTML of the post's text div up to its matching </div>. Live markup nests
 * a second text div inside the first, so the first </div> is not the end.
 */
function textHtmlOf(block: string): string {
  const open = TEXT_OPEN_RE.exec(block);
  if (!open) return "";
  const start = open.index + open[0].length;
  let depth = 1;
  for (const m of block.slice(start).matchAll(DIV_RE)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return block.slice(start, start + m.index);
  }
  return block.slice(start);
}

/**
 * Parses the post blocks of a t.me/s page. Regex, like the other scrapers here:
 * the markup is stable, and a parser dependency is not worth it. A
 * page that yields [] means the markup changed — the caller reports it.
 */
export function parseTelegramChannel(html: string): ChannelPost[] {
  return html
    .split('<div class="tgme_widget_message_wrap')
    .slice(1)
    .flatMap((block) => {
      const [, channel, id] = POST_RE.exec(block) ?? [];
      if (!channel || !id) return [];
      const textHtml = textHtmlOf(block);
      const postHtml = sanitizeTelegramHtml(textHtml);
      const time = TIME_RE.exec(block)?.[1];
      const publishedAt = time ? Date.parse(time) : NaN;
      return [
        {
          channel,
          id: Number(id),
          url: `https://t.me/${channel}/${id}`,
          text: visibleText(postHtml),
          html: postHtml,
          links: [...textHtml.matchAll(HREF_RE)]
            .map((m) => decodeEntities(m[1] ?? ""))
            .filter((href) => /^https?:\/\//.test(href)),
          imageUrls: [...new Set([...block.matchAll(PHOTO_RE)].map((m) => m[1] ?? ""))].slice(
            0,
            MAX_PHOTOS,
          ),
          publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
          views: parseViews(VIEWS_RE.exec(block)?.[1] ?? ""),
          forwarded: block.includes("tgme_widget_message_forwarded_from"),
        },
      ];
    });
}
