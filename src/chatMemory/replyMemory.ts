import type { Bot } from "grammy";
import type { Message } from "grammy/types";

import type { ConversationMemory } from "./types.js";
import type { Side, Debate, ReplyTarget } from "../debate/types.js";

/** A corrected source must not remain as the debate's copied, obsolete topic. */
export function currentDebate(debate: Debate, memory?: ConversationMemory): Debate {
  const root =
    debate.rootMessageId === undefined
      ? null
      : memory?.message(debate.chatId, debate.rootMessageId);
  return root?.editedAt === undefined ? debate : { ...debate, topic: root.text };
}

/** Read before any await; clear and shutdown invalidate the captured generation. */
export const memoryEpoch = (memory: ConversationMemory | undefined, chatId: number): number =>
  memory?.status(chatId).epoch ?? 0;

export const memoryCurrent = (
  memory: ConversationMemory | undefined,
  chatId: number,
  epoch: number,
): boolean => epoch >= 0 && memoryEpoch(memory, chatId) === epoch;

/** Persistent recall is user data; the final Humanizer receives only the draft body. */
export function withMemory(
  user: string,
  memory: ConversationMemory | undefined,
  chatId: number,
  side: Side,
  query: string,
): string {
  try {
    const context = memory?.context(chatId, side, query);
    return context ? `${user}\n\n${context}` : user;
  } catch {
    console.warn(`[chatMemory] context unavailable: chat ${chatId}, side ${side}`);
    return user;
  }
}

/** Both debate bots record their own acknowledgements; polling never guesses bot identity. */
export function recordReply(
  memory: ConversationMemory | undefined,
  bot: Bot,
  chatId: number,
  sent: Message,
  text: string,
  side: Side,
  target: ReplyTarget,
  epoch: number,
): void {
  if (!memory || !memoryCurrent(memory, chatId, epoch)) return;
  const author = sent.from ?? bot.botInfo;
  const delivered = sent.text
    ? target.messageId
      ? sent.text.slice(sent.text.indexOf("\n\n") + 2)
      : sent.text
    : text;
  try {
    memory.observe({
      chatId,
      messageId: sent.message_id,
      authorId: author.id,
      authorName: author.first_name,
      text: delivered,
      at: sent.date * 1000,
      side,
      replyToMessageId:
        sent.reply_to_message?.message_id ?? target.rootMessageId ?? target.messageId,
      rootMessageId: target.rootMessageId ?? target.messageId,
      messageThreadId: target.messageThreadId,
    });
  } catch {
    console.warn(`[chatMemory] reply capture failed: chat ${chatId}, message ${sent.message_id}`);
  }
}
