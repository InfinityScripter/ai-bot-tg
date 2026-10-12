import type { Api, Context } from "grammy";

import { InputFile } from "grammy";

import { CONFIG } from "../config.js";
import { logEditError } from "../bot/edit.js";
import { sourceLinksFromHtml } from "../sourceLinks.js";
import { coverSpecFor, tryRenderCover } from "./renderCover.js";
import { escapeHtml, visibleText } from "../feeds/telegramHtml.js";

import type { ChannelDress } from "../types.js";
import type { LoadedExtraction, CrossPostContent } from "../bot/types.js";

type TelegramAbortSignal = Parameters<Api["sendMessage"]>[3];

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

/** Telegram photo captions allow 1024 visible chars after parsing HTML; keep headroom. */
const CAPTION_MAX = 1000;
/** Description is the least important line — trim it hardest. */
const DESCRIPTION_MAX = 320;

/** Trim original text before escaping; never split an entity or a surrogate pair. */
function captionText(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return escapeHtml(text);
  let prefix = "";
  for (const char of text) {
    if (prefix.length + char.length + 1 > max) break;
    prefix += char;
  }
  const lastSpace = prefix.lastIndexOf(" ");
  return `${escapeHtml((lastSpace > 0 ? prefix.slice(0, lastSpace) : prefix).trimEnd())}…`;
}

/**
 * Builds the channel announcement caption from a published item in Telegram
 * HTML with signed source materials and a separate link to the full article.
 * Feed/LLM-derived text is escaped so it can't break or hijack the formatting.
 * Exported for unit testing without a live bot.
 */
export function buildCrossPostCaption(
  content: CrossPostContent,
  url: string,
  dress: ChannelDress | null = null,
): string {
  const link = `<a href="${escapeHtml(url)}">Читать на сайте →</a>`;
  const rubric = dress ? escapeHtml(`#${dress.rubric}`) : "";
  const sources = sourceLinksFromHtml(
    (content.sourceLinks ?? [])
      .map(
        ({ url: sourceUrl, label }) =>
          `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(label)}</a>`,
      )
      .join("\n"),
  ).slice(0, 3);
  const sourceAnchors = sources.map(
    ({ url: sourceUrl, label }) => `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(label)}</a>`,
  );
  // Reserve links first. Only an entire trailing material may be dropped when
  // the visible labels cannot fit with even a minimal title and the website link.
  let materials = sourceAnchors.length ? `Материалы:\n${sourceAnchors.join("\n")}` : "";
  while (
    sourceAnchors.length &&
    visibleText(["<b>…</b>", rubric, materials, link].filter(Boolean).join("\n\n")).length >
      CAPTION_MAX
  ) {
    sourceAnchors.pop();
    materials = sourceAnchors.length ? `Материалы:\n${sourceAnchors.join("\n")}` : "";
  }
  const tail = [rubric, materials, link].filter(Boolean).join("\n\n");
  const title = `<b>${captionText(content.title, Math.min(200, CAPTION_MAX - visibleText(tail).length - 2))}</b>`;
  const base = [title, rubric, materials, link].filter(Boolean).join("\n\n");
  const whyPrefix = "💡 <b>Зачем тебе это:</b> ";
  const whyBudget = CAPTION_MAX - visibleText(base).length - visibleText(whyPrefix).length - 2;
  const why = dress?.why && whyBudget > 0 ? `${whyPrefix}${captionText(dress.why, whyBudget)}` : "";
  const fixed = [title, why, rubric, materials, link].filter(Boolean).join("\n\n");
  const descriptionBudget = Math.max(0, CAPTION_MAX - visibleText(fixed).length - 2);
  const description =
    content.description?.trim() && descriptionBudget > 0
      ? captionText(content.description.trim(), Math.min(DESCRIPTION_MAX, descriptionBudget))
      : "";
  return [title, description, why, rubric, materials, link].filter(Boolean).join("\n\n");
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
 * The photo is the branded cover rendered from the dress; only when rendering
 * fails does the blog's own cover stand in (when it is a URL Telegram can
 * fetch). If sendPhoto fails (a non-image URL like a habr /share/ page, a 404,
 * a host block, a rejected upload), the announcement degrades to plain text
 * rather than being dropped. `signal` is a factory: a timeout started before
 * the dress's model call would be spent on the model, not on Telegram.
 */
export async function crossPostToChannel(
  api: Api,
  content: CrossPostContent,
  publishedId: string,
  signal?: () => TelegramAbortSignal,
): Promise<boolean> {
  const channel = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!channel) return false;

  const dress = (await content.dress?.()) ?? null;
  const caption = buildCrossPostCaption(content, content.linkFor(publishedId), dress);
  const cover = tryRenderCover(coverSpecFor(dress, content.title));
  const blogCover = isUsableImageUrl(content.coverUrl) ? content.coverUrl : null;
  const photo = cover ? new InputFile(cover, "cover.png") : blogCover;
  const options = { parse_mode: "HTML" as const };

  if (photo) {
    try {
      const photoOptions = { ...options, caption };
      const sendSignal = signal?.();
      await (sendSignal
        ? api.sendPhoto(channel, photo, photoOptions, sendSignal)
        : api.sendPhoto(channel, photo, photoOptions));
      return true;
    } catch (err) {
      // Telegram couldn't use the photo (non-image page, 404, blocked host,
      // rejected upload) — degrade to text rather than drop the announcement.
      const reason = err instanceof Error ? err.message : String(err);
      const which = cover ? "branded cover" : "blog cover";
      console.warn(`[cross-post] sendPhoto with the ${which} failed, sending text: ${reason}`);
    }
  }

  // A fresh timeout: the photo attempt may have spent or aborted the first one.
  const sendSignal = signal?.();
  await (sendSignal
    ? api.sendMessage(channel, caption, options, sendSignal)
    : api.sendMessage(channel, caption, options));
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
  if (!extracted.crossPost) return;
  try {
    await crossPostToChannel(api, extracted.crossPost, publishedId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx
      .reply(`⚠️ Пост опубликован, но не запостился в канал: ${message}`)
      .catch(logEditError("cross-post warn"));
  }
}
