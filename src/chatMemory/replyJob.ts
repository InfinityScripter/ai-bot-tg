import type { Context } from "grammy";

import { loadTurns } from "../chatReply/memory.js";
import { conversationRoot } from "./captureMessage.js";
import { messageText } from "../telegram/messageText.js";
import { withMemory, memoryEpoch } from "./replyMemory.js";
import { chatReplyUser, chatReplyPostUser } from "../chatReply/prompt.js";

import type { ConversationMemory } from "./types.js";
import type { ReplyTarget } from "../debate/types.js";
import type { CandidateStore } from "../store/index.js";
import type { ChatTurn, IncomingMessage } from "../chatReply/types.js";

export interface ReplyJob extends ReplyTarget {
  chatId: number;
  messageId: number;
  triggerMessageId: number;
  epoch: number;
  prompt: () => string;
  turn: Pick<ChatTurn, "name" | "text" | "userId">;
  post?: string;
}

/** Response triggers stay unchanged; the independent capture sees captions and edits too. */
export function createReplyJob(
  ctx: Context,
  store: CandidateStore,
  memory?: ConversationMemory,
): ReplyJob | null {
  const msg = ctx.message;
  if (!msg) return null;
  const root = conversationRoot(msg, memory);
  const epoch = memoryEpoch(memory, msg.chat.id);
  const chatUsername = msg.chat.type === "supergroup" ? msg.chat.username : undefined;
  const text = messageText(msg);
  if (msg.is_automatic_forward) {
    const post = text;
    if (!post) return null;
    return {
      ...root,
      epoch,
      chatUsername,
      chatId: msg.chat.id,
      messageId: msg.message_id,
      triggerMessageId: msg.message_id,
      authorName: msg.sender_chat?.title ?? msg.from?.first_name ?? "пост канала",
      prompt: () => {
        const current = memory?.message(msg.chat.id, msg.message_id)?.text ?? post;
        return withMemory(chatReplyPostUser(current), memory, msg.chat.id, "hope", current);
      },
      turn: { userId: 0, name: "пост канала", text: post },
      post,
    };
  }
  if (!text || !msg.from || msg.from.is_bot || text.startsWith("/")) return null;
  const username = ctx.me.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`@${username}\\b`, "gi");
  const reply = msg.reply_to_message;
  const repliedToBot = reply?.from?.id === ctx.me.id ? (messageText(reply) ?? "") : null;
  if (!mention.test(messageText(msg, false) ?? "") && repliedToBot === null) return null;
  const richOnly = msg.text === undefined && msg.caption === undefined;
  const incoming: IncomingMessage = {
    ...root,
    chatUsername,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    userId: msg.from.id,
    name: msg.from.first_name,
    text: (richOnly ? text : text.replace(mention, "")).trim() || "(упомянули тебя без текста)",
    repliedToBot,
    post: reply?.is_automatic_forward ? (messageText(reply) ?? null) : null,
  };
  return {
    ...root,
    epoch,
    chatUsername,
    chatId: incoming.chatId,
    messageId: incoming.messageId,
    triggerMessageId: incoming.messageId,
    authorName: incoming.name,
    prompt: () => {
      const source = memory?.message(incoming.chatId, incoming.messageId);
      const current = source
        ? { ...incoming, text: (richOnly ? source.text : source.text.replace(mention, "")).trim() }
        : incoming;
      return withMemory(
        chatReplyUser(memory ? [] : loadTurns(store, incoming.chatId), current),
        memory,
        incoming.chatId,
        "hope",
        current.text,
      );
    },
    turn: { userId: incoming.userId, name: incoming.name, text: incoming.text },
  };
}
