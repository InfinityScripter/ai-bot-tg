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
 * Sends the channel announcement for a freshly-published item. Returns true when
 * a message was sent, false when cross-posting is disabled (no channel configured).
 * Throws only on an actual send failure so the caller can surface it as a soft
 * warning in the owner DM — it must NOT be called in a way that fails publish.
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

  // With a cover: a photo card (richer, higher engagement). Without: a plain
  // text message and let Telegram render the link's og-preview.
  if (content.coverUrl) {
    await api.sendPhoto(channel, content.coverUrl, {
      caption,
      parse_mode: "Markdown",
    });
  } else {
    await api.sendMessage(channel, caption, { parse_mode: "Markdown" });
  }
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
