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

/**
 * Telegram's 400 descriptions for a photo it cannot take (PHOTO_INVALID_DIMENSIONS,
 * IMAGE_PROCESS_FAILED, wrong file, MEDIA_CAPTION_TOO_LONG). Only these justify
 * dropping photos; 429, 403 or bad markup would hit the text send just the same.
 */
const MEDIA_REJECTION_RE = /photo|image|file|media|dimension/i;

/** A Bot API refusal: keeps the status and description so callers can tell why. */
class TelegramApiError extends PublishError {
  constructor(
    method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} ответил ${status}: ${description}`, status >= 500 || status < 300);
  }
}

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
  throw new TelegramApiError(method, res.status, data.description ?? "без описания");
}

/** The message id, or null when Telegram refused the photos themselves (logged). */
async function sendPhotos(method: string, form: FormData): Promise<number | null> {
  try {
    return await call(method, form);
  } catch (err) {
    const media =
      err instanceof TelegramApiError &&
      err.status === 400 &&
      MEDIA_REJECTION_RE.test(err.description);
    if (!media) throw err;
    console.warn(`[channels] ${method} rejected the photos: ${err.message}`);
    return null;
  }
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
 * that fail to download are dropped; photos Telegram rejected as media
 * degrade to one photo, then to text. Every fallback is logged.
 */
export async function publishToChannel(html: string, imageUrls: string[]): Promise<PublishOutcome> {
  const chatId = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!chatId) throw new PublishError("TELEGRAM_CHANNEL_ID не задан — некуда публиковать", false);
  const photos = (await Promise.all(imageUrls.slice(0, MAX_PHOTOS).map(downloadImage))).filter(
    (photo): photo is Blob => photo !== null,
  );
  // An album Telegram refused goes out with its first photo before giving up on photos.
  const attempts = photos.length > 1 ? [photos, photos.slice(0, 1)] : [photos];
  for (const attempt of attempts.filter((list) => list.length > 0)) {
    const id = await sendPhotos(...photoRequest(chatId, html, attempt));
    if (id !== null) return { postId: `tg:${id}` };
  }
  if (imageUrls.length > 0 && photos.length === 0) {
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
