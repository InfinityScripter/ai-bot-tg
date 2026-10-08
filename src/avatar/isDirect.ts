import type { Message, UserFromGetMe } from "grammy/types";

/** True when a message calls the avatar: a reply to its message or an @mention of it. */
export function isDirect(message: Message, me: UserFromGetMe): boolean {
  if (message.reply_to_message?.from?.id === me.id) return true;
  const text = message.text ?? "";
  const handle = `@${me.username}`.toLowerCase();
  return (message.entities ?? []).some(
    (e) =>
      e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle,
  );
}
