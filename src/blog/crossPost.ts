import type { Api, Context } from "grammy";

import { CONFIG } from "../config.js";
import { logEditError } from "../bot/edit.js";
import { truncate, escapeMarkdown } from "../utils.js";

import type { LoadedExtraction, CrossPostContent } from "../bot/types.js";

/**
 * Auto cross-post to the Telegram channel on publish (bet #3 / distribution
 * layer): the news-bot already publishes to the blog, but the posts otherwise
 * live only there. Announcing each one in the RU channel is the cheapest way to
 * turn zero distribution into reach.
 *
 * Design guardrails:
 *  - OPT-IN: no-op unless TELEGRAM_CHANNEL_ID is set, so deploying this never
 *    changes behavior until the owner wires a channel.
 *  - NEVER breaks publish: the caller runs this AFTER the post is live and treats
 *    any throw as a soft warning — a channel-send failure must not fail publish.
 *  - The caption is capped at Telegram's 1024-char photo-caption limit.
 */

/** Telegram photo captions are limited to 1024 chars; leave room for entities. */
const CAPTION_MAX = 1000;
/** Description is the least important line — trim it hardest. */
const DESCRIPTION_MAX = 320;

/**
 * Builds the channel announcement caption from a published item. Markdown
 * (legacy) with the title bold, an optional description, and a "Читать" link.
 * Feed/LLM-derived text is escaped so it can't break or hijack the formatting.
 * Exported for unit testing without a live bot.
 */
export function buildCrossPostCaption(content: CrossPostContent, url: string): string {
  const title = `*${escapeMarkdown(truncate(content.title, 200))}*`;
  const link = `[Читать на сайте →](${url})`;
  const description = content.description?.trim()
    ? escapeMarkdown(truncate(content.description.trim(), DESCRIPTION_MAX))
    : "";
  const caption = [title, description, link].filter(Boolean).join("\n\n");
  return truncate(caption, CAPTION_MAX);
}

/**
 * True only for an absolute http(s) URL that Telegram can fetch as a photo. A
 * relative path (host-empty), a non-http scheme, or a garbage value must NOT be
 * handed to sendPhoto — it 400s ("invalid file HTTP URL"). Note this can't tell
 * an image URL from a non-image page (e.g. a habr /share/ link): those still
 * pass the shape check but 400 at fetch time, which the send-with-fallback below
 * handles by degrading to a text message rather than dropping the post.
 */
function isUsableImageUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Sends the channel announcement for a freshly-published item. Returns true when
 * a message was sent, false when cross-posting is disabled (no channel configured).
 * Throws only when BOTH the photo and the text fallback fail, so the caller can
 * surface it as a soft warning — it must NOT be called in a way that fails publish.
 *
 * A usable cover → a photo card (richer, higher engagement). If sendPhoto fails
 * (a non-image URL like a habr /share/ page, a 404, a host block), we fall back
 * to a plain text message so a bad cover never costs us the announcement. No
 * usable cover → straight to text and let Telegram render the link og-preview.
 */
export async function crossPostToChannel(
  api: Api,
  content: CrossPostContent,
  publishedId: string,
): Promise<boolean> {
  const channel = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!channel) return false;

  const url = content.linkFor(publishedId);
  const caption = buildCrossPostCaption(content, url);

  if (isUsableImageUrl(content.coverUrl)) {
    try {
      await api.sendPhoto(channel, content.coverUrl, { caption, parse_mode: "Markdown" });
      return true;
    } catch {
      // Cover URL was shaped like a URL but Telegram couldn't use it as a photo
      // (non-image page, 404, blocked host) — degrade to text rather than drop.
      await api.sendMessage(channel, caption, { parse_mode: "Markdown" });
      return true;
    }
  }

  await api.sendMessage(channel, caption, { parse_mode: "Markdown" });
  return true;
}

/**
 * Announces a just-published item in the channel (distribution). No-op when no
 * channel is configured. Any send failure is caught and reported as a soft DM
 * warning — cross-posting must NEVER fail an already-live publish, so the caller
 * awaits this only after the post is confirmed live.
 */
export async function crossPostPublished(
  api: Api,
  ctx: Context,
  extracted: LoadedExtraction,
  publishedId: string,
): Promise<void> {
  try {
    await crossPostToChannel(api, extracted.crossPost, publishedId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx
      .reply(`⚠️ Пост опубликован, но не запостился в канал: ${message}`)
      .catch(logEditError("cross-post warn"));
  }
}
