import { CONFIG } from "../config.js";
import { PublishError } from "./publishPost.js";

import type { PublishOutcome } from "./types.js";

/** Telegram's limit for a photo caption. */
export const CAPTION_LIMIT = 1024;
const SEND_TIMEOUT_MS = 20_000;

interface TelegramReply {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
}

/**
 * One Bot API call. Direct fetch (not grammy) on purpose: the publish path is
 * fetch-based like the blog POST, so loadExtraction needs no bot handle and
 * tests stub one global. The token is in the URL, so no error below may echo
 * the URL. Network error or 5xx → the message may exist (maybePosted).
 */
async function call(method: string, body: Record<string, unknown>): Promise<number> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new PublishError(`Telegram ${method}: сеть (${name})`, true);
  }
  const data = (await res.json().catch(() => ({}))) as TelegramReply;
  const messageId = data.result?.message_id;
  if (res.ok && data.ok && typeof messageId === "number") return messageId;
  throw new PublishError(
    `Telegram ${method} ответил ${res.status}: ${data.description ?? "без описания"}`,
    res.status >= 500 || res.ok,
  );
}

/**
 * Posts a retelling to the channel: a photo with the text as caption when the
 * source post had one, else a plain text message. A rejected photo (expired
 * CDN link, not an image) degrades to text, like crossPostToChannel.
 */
export async function publishToChannel(
  text: string,
  imageUrl: string | null,
): Promise<PublishOutcome> {
  const chatId = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!chatId) throw new PublishError("TELEGRAM_CHANNEL_ID не задан — некуда публиковать", false);
  if (imageUrl) {
    try {
      return {
        postId: `tg:${await call("sendPhoto", { chat_id: chatId, photo: imageUrl, caption: text })}`,
      };
    } catch (err) {
      if (err instanceof PublishError && err.maybePosted) throw err;
    }
  }
  const id = await call("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  });
  return { postId: `tg:${id}` };
}
