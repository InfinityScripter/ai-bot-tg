import { CONFIG } from "../config.js";
import { visibleText } from "../feeds/index.js";
import { PublishError } from "./publishPost.js";
import { downloadImage } from "./downloadImage.js";
import { callTelegram, TelegramApiError } from "./telegramApi.js";

import type { PublishOutcome } from "./types.js";

/** Telegram's limit for a photo caption. */
export const CAPTION_LIMIT = 1024;
/** sendMediaGroup takes at most 10 items. */
const MAX_PHOTOS = 10;

/**
 * Telegram's 400 descriptions for a photo it cannot take (PHOTO_INVALID_DIMENSIONS,
 * IMAGE_PROCESS_FAILED, wrong file, "group send failed" for an album). Only these
 * justify dropping photos; 429, 403 or bad markup would hit the text send just the same.
 */
const MEDIA_REJECTION_RE = /photo|image|file|media|dimension|group send/i;

/** The message id, or null when Telegram refused the photos themselves (logged). */
async function sendPhotos(method: string, form: FormData): Promise<number | null> {
  try {
    return await callTelegram(method, form);
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
 * Posts a retelling (Telegram HTML) to the channel with the retelling as the
 * caption: the branded cover when there is one (the source photos are then not
 * used at all), else the source post's photos uploaded as files, else a text
 * message. Photos that fail to download are dropped; photos Telegram rejected
 * as media degrade to one photo, then to text. Every fallback is logged.
 */
export async function publishToChannel(
  html: string,
  imageUrls: string[],
  cover: Uint8Array | null = null,
): Promise<PublishOutcome> {
  const chatId = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!chatId) throw new PublishError("TELEGRAM_CHANNEL_ID не задан — некуда публиковать", false);
  // Only the manual path gets here with a long retelling (the auto gate stops it);
  // Telegram would refuse it as a caption, so it goes out as text right away.
  const visible = visibleText(html).length;
  const tooLong = visible > CAPTION_LIMIT && (imageUrls.length > 0 || cover !== null);
  if (tooLong) {
    console.warn(
      `[channels] ${visible} characters exceed the ${CAPTION_LIMIT} caption limit, sending text without photos`,
    );
  }
  const usable = tooLong || cover ? [] : imageUrls.slice(0, MAX_PHOTOS);
  const downloaded = (await Promise.all(usable.map(downloadImage))).filter(
    (photo): photo is Blob => photo !== null,
  );
  const photos = cover && !tooLong ? [new Blob([cover], { type: "image/png" })] : downloaded;
  // An album Telegram refused goes out with its first photo before giving up on photos.
  const attempts = photos.length > 1 ? [photos, photos.slice(0, 1)] : [photos];
  for (const attempt of attempts.filter((list) => list.length > 0)) {
    const id = await sendPhotos(...photoRequest(chatId, html, attempt));
    if (id !== null) return { postId: `tg:${id}` };
  }
  if (usable.length > 0 && photos.length === 0) {
    console.warn(`[channels] none of ${imageUrls.length} photos usable, sending text`);
  }
  const id = await callTelegram("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return { postId: `tg:${id}` };
}
