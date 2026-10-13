import type { Bot } from "grammy";

import { GrammyError } from "grammy";

import { CONFIG } from "../config.js";
import { chatReplySystem } from "./prompt.js";
import { codexReply } from "./generateReply.js";
import { sendConversationReply } from "../debate/index.js";
import { SKEPTIC_ROLE, debateTranscript } from "../debate/debatePrompt.js";
import {
  withMemory,
  recordReply,
  memoryEpoch,
  memoryCurrent,
  currentDebate,
} from "../chatMemory/replyMemory.js";

import type { Speaker } from "../debate/index.js";
import type { ReplyAllowance } from "../store/replyAllowance.js";
import type { ConversationMemory } from "../chatMemory/index.js";

/**
 * Hope's side of a debate with the avatar: the skeptic. Codex only, never the
 * paid fallback, so a debate never spends API credits. Outside the channel's
 * discussion group Hope speaks only in debates, and only where the news bot
 * is a member.
 */
export function createHopeSpeaker(
  bot: Bot,
  allowance: ReplyAllowance,
  isEnabled: () => boolean,
  memory?: ConversationMemory,
  onFail?: () => void,
): Speaker {
  return {
    async canSpeak(chatId) {
      if (memoryEpoch(memory, chatId) < 0) return false;
      if (!isEnabled()) {
        console.log(`[chatReply] ${chatId}: no debate turn (/chat is off)`);
        return false;
      }
      if (chatId === CONFIG.CHAT_REPLY_CHAT_ID) return true;
      try {
        const member = await bot.api.getChatMember(chatId, bot.botInfo.id);
        const inChat =
          member.status === "restricted"
            ? member.is_member
            : member.status !== "left" && member.status !== "kicked";
        if (!inChat)
          console.log(`[chatReply] ${chatId}: no debate turn (news bot ${member.status})`);
        return inChat;
      } catch (err) {
        // 400 "chat not found" / 403: the news bot is not there. Anything else is a failed check.
        const absent = err instanceof GrammyError && [400, 403].includes(err.error_code);
        console.log(
          `[chatReply] ${chatId}: no debate turn (${absent ? "news bot not in the chat" : "membership check failed"}: ${String(err)})`,
        );
        return false;
      }
    },

    async speak(debate) {
      const epoch = memoryEpoch(memory, debate.chatId);
      const trigger = debate.triggerMessageId;
      if (trigger === undefined) {
        console.warn(`[chatReply] ${debate.chatId}: debate missing original human trigger`);
        return null;
      }
      const current = () =>
        memoryCurrent(memory, debate.chatId, epoch) && allowance.isCurrent(debate.chatId, trigger);
      if (!current()) return null;
      const last = debate.lines.at(-1);
      if (!last) return null;
      if (
        memory &&
        debate.chatId === CONFIG.CHAT_REPLY_CHAT_ID &&
        !memory.message(debate.chatId, debate.lines[0]!.messageId)
      )
        return null;
      if (!allowance.claim(debate.chatId, trigger, "hope")) return null;
      let attempted = false;
      try {
        const context = currentDebate(debate, memory);
        const reply = await codexReply(
          chatReplySystem(bot.botInfo.username) + SKEPTIC_ROLE,
          withMemory(
            debateTranscript(context, "hope"),
            memory,
            debate.chatId,
            "hope",
            `${context.topic}\n${last.text}`,
          ),
        );
        if (!current()) return null;
        if (reply?.action !== "reply" || !reply.text) {
          if (!reply) onFail?.();
          console.log(
            `[chatReply] ${debate.chatId}: no debate reply (${reply ? "chose silence" : "Codex failed"})`,
          );
          return null;
        }
        attempted = true;
        const sent = await sendConversationReply(bot, debate.chatId, reply.text, {
          rootMessageId: debate.rootMessageId,
          messageThreadId: debate.messageThreadId,
          messageId: last.messageId,
          authorName: last.authorName,
        });
        if (!current()) return null;
        recordReply(
          memory,
          bot,
          debate.chatId,
          sent,
          reply.text,
          "hope",
          { ...debate, triggerMessageId: trigger, messageId: last.messageId },
          epoch,
        );
        return {
          side: "hope",
          text: reply.text,
          messageId: sent.message_id,
          authorName: bot.botInfo.first_name,
          authorId: bot.botInfo.id,
        };
      } catch {
        onFail?.();
        console.warn(`[chatReply] ${debate.chatId}: debate reply not sent`);
        return null;
      } finally {
        if (!attempted) allowance.release(debate.chatId, trigger, "hope");
      }
    },
  };
}
