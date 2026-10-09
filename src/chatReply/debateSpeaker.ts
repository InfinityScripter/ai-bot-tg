import type { Bot } from "grammy";

import { GrammyError } from "grammy";

import { CONFIG } from "../config.js";
import { chatReplySystem } from "./prompt.js";
import { codexReply } from "./generateReply.js";
import { SKEPTIC_ROLE, debateTranscript } from "../debate/debatePrompt.js";

import type { Speaker } from "../debate/index.js";

/**
 * Hope's side of a debate with the avatar: the skeptic. Codex only, never the
 * paid fallback, so a debate never spends API credits. Outside the channel's
 * discussion group Hope speaks only in debates, and only where the news bot
 * is a member.
 */
export function createHopeSpeaker(bot: Bot, isEnabled: () => boolean): Speaker {
  return {
    async canSpeak(chatId) {
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
      const last = debate.lines.at(-1);
      const reply = await codexReply(
        chatReplySystem(bot.botInfo.username) + SKEPTIC_ROLE,
        debateTranscript(debate, "hope"),
      );
      if (reply?.action !== "reply" || !reply.text) {
        console.log(
          `[chatReply] ${debate.chatId}: no debate reply (${reply ? "chose silence" : "Codex failed"})`,
        );
        return null;
      }
      try {
        const sent = await bot.api.sendMessage(debate.chatId, reply.text, {
          ...(last && {
            reply_parameters: { message_id: last.messageId, allow_sending_without_reply: true },
          }),
        });
        return { side: "hope", text: reply.text, messageId: sent.message_id };
      } catch (err) {
        console.warn(`[chatReply] ${debate.chatId}: debate reply not sent: ${String(err)}`);
        return null;
      }
    },
  };
}
