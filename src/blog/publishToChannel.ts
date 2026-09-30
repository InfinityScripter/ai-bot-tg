import { CONFIG } from "../config.js";
import { PublishError } from "./publishPost.js";
import { downloadImage } from "./downloadImage.js";

import type { PublishOutcome } from "./types.js";

/** Telegram's limit for a photo caption. */
export const CAPTION_LIMIT = 1024;
/** sendMediaGroup takes at most 10 items. */
const MAX_PHOTOS = 10;
const SEND_TIMEOUT_MS = 20_000;
/** An album upload carries up to 10 photos: a timeout here means "maybe posted". */
const UPLOAD_TIMEOUT_MS = 60_000;

interface SentMessage {
  message_id?: number;
}

interface TelegramReply {
  ok?: boolean;
  description?: string;
  /** sendMediaGroup answers with every message of the album. */
  result?: SentMessage | SentMessage[];
}

/**
 * One Bot API call, JSON or multipart. Direct fetch (not grammy) on purpose:
 * the publish path is fetch-based like the blog POST, so loadExtraction needs
 * no bot handle and tests stub one global. The token is in the URL, so no
 * error below may echo the URL. Network error or 5xx → the message may exist
 * (maybePosted).
 */
async function call(method: string, body: Record<string, unknown> | FormData): Promise<number> {
  const upload = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      ...(upload
        ? { body }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(upload ? UPLOAD_TIMEOUT_MS : SEND_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new PublishError(`Telegram ${method}: сеть (${name})`, true);
  }
  const data = ((await res.json().catch(() => null)) ?? {}) as TelegramReply;
  const messageId = (Array.isArray(data.result) ? data.result[0] : data.result)?.message_id;
  if (res.ok && data.ok && typeof messageId === "number") return messageId;
  throw new PublishError(
    `Telegram ${method} ответил ${res.status}: ${data.description ?? "без описания"}`,
    res.status >= 500 || res.ok,
  );
}

const fileName = (name: string, photo: Blob) => `${name}.${photo.type.split("/")[1] ?? "jpg"}`;

/** One photo → sendPhoto; an album → sendMediaGroup with the caption on the first photo. */
function photoRequest(chatId: string, html: string, photos: Blob[]): [string, FormData] {
  const form = new FormData();
  form.append("chat_id", chatId);
  const [only] = photos;
  if (only && photos.length === 1) {
    form.append("caption", html);
    form.append("parse_mode", "HTML");
    form.append("photo", only, fileName("photo", only));
    return ["sendPhoto", form];
  }
  const media = photos.map((_, i) => ({
    type: "photo",
    media: `attach://p${i}`,
    ...(i === 0 ? { caption: html, parse_mode: "HTML" } : {}),
  }));
  form.append("media", JSON.stringify(media));
  photos.forEach((photo, i) => form.append(`p${i}`, photo, fileName(`p${i}`, photo)));
  return ["sendMediaGroup", form];
}

/**
 * Posts a retelling (Telegram HTML) to the channel: the source post's photos
 * uploaded as files with the retelling as caption, else a text message. Photos
 * that fail to download are dropped; a photo send Telegram clearly rejected
 * degrades to text. Every fallback is logged.
 */
export async function publishToChannel(html: string, imageUrls: string[]): Promise<PublishOutcome> {
  const chatId = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!chatId) throw new PublishError("TELEGRAM_CHANNEL_ID не задан — некуда публиковать", false);
  const photos = (await Promise.all(imageUrls.slice(0, MAX_PHOTOS).map(downloadImage))).filter(
    (photo): photo is Blob => photo !== null,
  );
  if (photos.length > 0) {
    const [method, form] = photoRequest(chatId, html, photos);
    try {
      return { postId: `tg:${await call(method, form)}` };
    } catch (err) {
      if (err instanceof PublishError && err.maybePosted) throw err;
      console.warn(`[channels] ${method} rejected, sending text: ${String(err)}`);
    }
  } else if (imageUrls.length > 0) {
    console.warn(`[channels] none of ${imageUrls.length} photos usable, sending text`);
  }
  const id = await call("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return { postId: `tg:${id}` };
}
