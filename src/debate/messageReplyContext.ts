import type { Message } from "grammy/types";

import type { DebateContext } from "./types.js";

/** Telegram omits nested replies; persisted roots can fill that gap after a restart. */
export function messageReplyContext(
  message: Message,
  lookupRoot?: (messageId: number) => number | undefined,
): DebateContext {
  const reply = message.reply_to_message;
  const rootMessageId = message.is_automatic_forward
    ? message.message_id
    : reply?.is_automatic_forward
      ? reply.message_id
      : (lookupRoot?.(message.message_id) ??
        (reply && lookupRoot?.(reply.message_id)) ??
        (!message.is_topic_message ? message.message_thread_id : undefined) ??
        (!message.is_topic_message && !reply?.is_topic_message
          ? reply?.message_thread_id
          : undefined) ??
        reply?.message_id ??
        message.message_id);
  return {
    rootMessageId,
    ...(message.is_topic_message && { messageThreadId: message.message_thread_id }),
  };
}
