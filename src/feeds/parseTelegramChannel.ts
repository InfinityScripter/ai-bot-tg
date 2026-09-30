import { decodeEntities } from "./ingestArticle.js";

/** One post parsed from a public channel's web preview (t.me/s/<name>). */
export interface ChannelPost {
  channel: string;
  id: number;
  /** Permalink https://t.me/<channel>/<id>. */
  url: string;
  /** Plain text: tags stripped, <br> → newline, entities decoded. "" when the post has no text. */
  text: string;
  /** Outbound links from the text, in order. */
  links: string[];
  imageUrl: string | null;
  publishedAt: number | null;
  views: number | null;
  /** Reposted from another channel: never retold (the author is someone else). */
  forwarded: boolean;
}

const POST_RE = /data-post="([^"/]+)\/(\d+)"/;
const TEXT_RE = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const HREF_RE = /<a\s[^>]*href="([^"]+)"/g;
const PHOTO_RE = /tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/;
const VIEWS_RE = /<span class="tgme_widget_message_views">([^<]*)<\/span>/;
const TIME_RE = /<time datetime="([^"]+)"/;

/** "401" → 401, "1.2K" → 1200, "1.1M" → 1100000; anything else → null. */
export function parseViews(raw: string): number | null {
  const m = /^([\d.]+)([KM]?)$/.exec(raw.trim());
  if (!m) return null;
  const scale = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return Math.round(Number(m[1]) * scale);
}

function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n"),
  );
}

/**
 * Parses the post blocks of a t.me/s page. Regex, like the other scrapers here:
 * the markup is flat and stable, and a parser dependency is not worth it. A
 * page that yields [] means the markup changed — the caller reports it.
 */
export function parseTelegramChannel(html: string): ChannelPost[] {
  return html
    .split('<div class="tgme_widget_message_wrap')
    .slice(1)
    .flatMap((block) => {
      const [, channel, id] = POST_RE.exec(block) ?? [];
      if (!channel || !id) return [];
      const textHtml = TEXT_RE.exec(block)?.[1] ?? "";
      const time = TIME_RE.exec(block)?.[1];
      const publishedAt = time ? Date.parse(time) : NaN;
      return [
        {
          channel,
          id: Number(id),
          url: `https://t.me/${channel}/${id}`,
          text: toText(textHtml),
          links: [...textHtml.matchAll(HREF_RE)].map((m) => decodeEntities(m[1] ?? "")),
          imageUrl: PHOTO_RE.exec(block)?.[1] ?? null,
          publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
          views: parseViews(VIEWS_RE.exec(block)?.[1] ?? ""),
          forwarded: block.includes("tgme_widget_message_forwarded_from"),
        },
      ];
    });
}
