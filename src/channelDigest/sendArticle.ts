import { callTelegram, TelegramApiError } from "../blog/index.js";

import type { Article } from "./types.js";

/** One request carries the cover and up to 49 photos. */
const RICH_TIMEOUT_MS = 120_000;

const fileName = (id: string, blob: Blob) => `${id}.${blob.type.split("/")[1] ?? "jpg"}`;

/**
 * Sends the article with Bot API 10.1 sendRichMessage, in the form verified
 * live on 2026-10-01: multipart `chat_id` + `rich_message` (JSON of the html
 * and the media list, each photo `attach://<id>`) + every photo as a file
 * under its id. Photos go up as files: Telegram does not fetch the t.me CDN.
 */
export async function sendRichMessage(chatId: string | number, article: Article): Promise<number> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const media = article.photos.map(({ id }) => ({
    id,
    media: { type: "photo", media: `attach://${id}` },
  }));
  form.append("rich_message", JSON.stringify({ html: article.html, media }));
  for (const { id, blob } of article.photos) form.append(id, blob, fileName(id, blob));
  return callTelegram("sendRichMessage", form, RICH_TIMEOUT_MS);
}

/** The text fallback: an HTML sendMessage without link previews. */
export function sendFallbackText(chatId: string | number, text: string): Promise<number> {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** A 4xx about this message. 429 (rate) and 403 (no access) would hit the text send just the same. */
function isRejection(err: unknown): err is TelegramApiError {
  return (
    err instanceof TelegramApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429 &&
    err.status !== 403
  );
}

/**
 * The article, or its text fallback when Telegram rejects the rich message
 * itself (`rejected` then carries Telegram's description). Everything else
 * (network, 5xx, 429, 403, a failed fallback) is thrown to the caller.
 */
export async function deliverArticle(
  chatId: string | number,
  article: Article,
  fallbackText: string,
): Promise<{ messageId: number; rejected: string | null }> {
  try {
    return { messageId: await sendRichMessage(chatId, article), rejected: null };
  } catch (err) {
    if (!isRejection(err)) throw err;
    console.warn(`[digest-issue] rich message rejected, sending text: ${err.message}`);
    return { messageId: await sendFallbackText(chatId, fallbackText), rejected: err.description };
  }
}
