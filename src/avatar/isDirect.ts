import type { Message, UserFromGetMe } from "grammy/types";

import { messageText } from "../telegram/messageText.js";

/** True when a message calls the avatar: a reply to its message or an @mention of it. */
export function isDirect(message: Message, me: UserFromGetMe): boolean {
  if (message.reply_to_message?.from?.id === me.id) return true;
  const text = messageText(message, false) ?? "";
  const handle = `@${me.username}`.toLowerCase();
  if (message.text === undefined && message.caption === undefined) {
    const username = me.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`@${username}\\b`, "i").test(text);
  }
  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  return (entities ?? []).some(
    (e) =>
      e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle,
  );
}
