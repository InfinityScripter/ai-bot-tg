import type { Bot } from "grammy";

import { CONFIG } from "../config.js";
import { dayKey } from "./groupTurns.js";
import { unaskedCap } from "./replyGate.js";
import { HOPE_AUTHOR_ID } from "./chatHistory.js";
import { buildSearchQuery } from "./searchQuery.js";
import { avatarSystemPrompt } from "./avatarPrompt.js";
import { debateTranscript, PRACTITIONER_ROLE } from "../debate/debatePrompt.js";

import type { GenerateFn } from "./groupTurns.js";
import type { Speaker } from "../debate/index.js";
import type { ChatHistory } from "./chatHistory.js";
import type { AvatarStore } from "./avatarStore.js";

/** Blog excerpts per debate reply. */
const MEMORY_HITS = 3;

/** Why the avatar cannot take a debate turn in a chat, or null when it can. */
function refusal(store: AvatarStore, chatId: number): string | null {
  if (!store.isAllowed(chatId)) return "not an avatar group";
  if (!store.isEnabled()) return "switched off";
  // Like unasked turns, debates use at most half the daily cap: the rest stays for mentions.
  const calls = store.callsOn(chatId, dayKey(Date.now()));
  if (calls >= unaskedCap(CONFIG.AVATAR_DAILY_CALLS)) return `half the daily cap used (${calls})`;
  return null;
}

/**
 * The avatar's side of a debate with Hope. A reply counts against the
 * avatar's daily cap like any other turn. Hope's lines go into the chat
 * history: Telegram does not deliver them to this bot (BotFather's "Bot to
 * Bot Communication Mode" stays off), and the avatar's later
 * turns should know what she said. `onFail` feeds /avatar's last error.
 */
export function createAvatarSpeaker(
  bot: Bot,
  store: AvatarStore,
  history: ChatHistory,
  generate: GenerateFn,
  onFail: (text: string) => void,
): Speaker {
  return {
    async canSpeak(chatId) {
      const reason = refusal(store, chatId);
      if (reason) console.log(`[avatar] ${chatId}: no debate turn (${reason})`);
      return reason === null;
    },

    async speak(debate) {
      const { chatId } = debate;
      const last = debate.lines.at(-1);
      if (last?.side === "hope") {
        history.push(chatId, {
          messageId: last.messageId,
          authorId: HOPE_AUTHOR_ID,
          author: "Hope",
          text: last.text,
          at: Date.now(),
          fromAvatar: false,
        });
      }
      const memory = store.search(
        buildSearchQuery([debate.topic, ...debate.lines.slice(-2).map((l) => l.text)]),
        MEMORY_HITS,
      );
      const reply = await generate(
        avatarSystemPrompt(store.getProfile(), memory, true) + PRACTITIONER_ROLE,
        debateTranscript(debate, "avatar"),
      );
      if (!reply) {
        onFail("Codex не ответил в споре с Hope");
        console.warn(`[avatar] ${chatId}: no debate reply, Codex failed`);
        return null;
      }
      store.countCall(chatId, dayKey(Date.now()));
      if (reply.action !== "reply" || !reply.text) {
        console.log(`[avatar] ${chatId}: chose silence in the debate`);
        return null;
      }
      try {
        const sent = await bot.api.sendMessage(chatId, reply.text, {
          ...(last && {
            reply_parameters: { message_id: last.messageId, allow_sending_without_reply: true },
          }),
        });
        history.push(chatId, {
          messageId: sent.message_id,
          authorId: bot.botInfo.id,
          author: "аватар",
          text: reply.text,
          at: Date.now(),
          fromAvatar: true,
        });
        history.stamp(chatId, "avatar", Date.now());
        return { side: "avatar", text: reply.text, messageId: sent.message_id };
      } catch (err) {
        onFail(`реплика в споре не отправилась: ${String(err)}`);
        console.warn(`[avatar] ${chatId}: debate reply not sent: ${String(err)}`);
        return null;
      }
    },
  };
}
