import type { Context } from "grammy";

import { CONFIG } from "../config.js";

/**
 * The owner lock of both bots: only the owner, and only in the private chat.
 * A group update must never pass it: the owner's own text in a group would
 * become a post card in the news bot's manual ingest.
 */
export const isOwnerDm = (ctx: Context): boolean =>
  ctx.from?.id === CONFIG.OWNER_TELEGRAM_ID && ctx.chat?.type === "private";
