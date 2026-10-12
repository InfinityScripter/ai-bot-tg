import type { Context } from "grammy";
import type { Message } from "grammy/types";

import { CONFIG } from "../config.js";
import { messageReplyContext } from "../debate/index.js";
import { messageText } from "../telegram/messageText.js";

import type { MemoryWiring } from "./wiring.js";
import type { ConversationMemory } from "./types.js";

/** Persisted parent roots fill Telegram's missing nested replies after a restart. */
export function conversationRoot(
  message: Message,
  memory?: ConversationMemory,
  lookupRoot?: (id: number) => number | undefined,
) {
  return messageReplyContext(
    message,
    (id) => memory?.message(message.chat.id, id)?.rootMessageId ?? lookupRoot?.(id),
  );
}

/** Capture precedes mention, switch and avatar membership gates in both polling streams. */
export function captureMessage(ctx: Context, wiring: MemoryWiring): boolean | undefined {
  const message = ctx.editedMessage ?? ctx.message;
  const { memory } = wiring;
  if (
    !memory ||
    !message ||
    message.chat.id !== CONFIG.CHAT_REPLY_CHAT_ID ||
    !["group", "supergroup"].includes(message.chat.type)
  )
    return undefined;
  const text = messageText(message);
  const author = message.sender_chat ?? message.from;
  if (!text || !author || (!message.sender_chat && message.from?.is_bot)) return undefined;
  try {
    const previous = memory.message(message.chat.id, message.message_id);
    memory.observe({
      ...conversationRoot(message, memory),
      chatId: message.chat.id,
      messageId: message.message_id,
      authorId: author.id,
      authorName: "type" in author ? (author.title ?? "сообщество") : author.first_name,
      text,
      at: message.date * 1000,
      ...(message.edit_date !== undefined && { editedAt: message.edit_date * 1000 }),
      replyToMessageId: message.reply_to_message?.message_id,
      isPost: message.is_automatic_forward === true,
    });
    const retained = memory.message(message.chat.id, message.message_id) !== null;
    if (retained && message.is_automatic_forward && !previous) wiring.refreshMaterials?.();
    return retained;
  } catch {
    console.warn(
      `[chatMemory] capture failed: chat ${message.chat.id}, message ${message.message_id}`,
    );
  }
  return undefined;
}
