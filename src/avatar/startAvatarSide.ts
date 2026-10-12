import { CONFIG } from "../config.js";
import { createDebates } from "../debate/index.js";
import { createAvatarBot } from "./createAvatarBot.js";

import type { CandidateStore } from "../store/index.js";
import type { Speaker, DebateOpener } from "../debate/index.js";

/** Hope's side, as the news bot exposes it. */
export interface HopeSide {
  speaker: Speaker;
  onPostComment: (listener: DebateOpener) => void;
}

/**
 * Starts the owner's avatar bot next to the news bot and lets the two argue:
 * Hope's comment on a new channel post and the avatar's answers to direct requests may
 * open a debate. Null when the avatar is off or could not start: the news bot
 * must keep running either way.
 */
export function startAvatarSide(
  store: CandidateStore,
  hope: HopeSide,
  notifyOwner: (text: string) => Promise<unknown>,
) {
  const token = CONFIG.AVATAR_BOT_TOKEN;
  if (!token) {
    console.log("[avatar] disabled (AVATAR_BOT_TOKEN unset)");
    return null;
  }
  // The same token twice makes Telegram answer 409 to both bots, and grammY
  // then stops the news bot's polling too.
  if (token === CONFIG.TELEGRAM_BOT_TOKEN) {
    console.error("[avatar] disabled: AVATAR_BOT_TOKEN is the news bot's token");
    void notifyOwner("Аватар выключен: в AVATAR_BOT_TOKEN вписан токен новостного бота.");
    return null;
  }
  try {
    const avatarBot = createAvatarBot(token, store, { fallbackNotify: notifyOwner });
    const { avatar } = avatarBot;
    const debates = createDebates({
      hope: hope.speaker,
      avatar: avatar.speaker,
      turns: CONFIG.AVATAR_DEBATE_TURNS,
      pauseMs: CONFIG.AVATAR_DEBATE_PAUSE_MS,
      cooldownMs: CONFIG.AVATAR_COOLDOWN_MS,
    });
    hope.onPostComment(debates.start);
    avatar.onReply(debates.start);
    if (CONFIG.CHAT_REPLY_CHAT_ID === undefined) {
      console.log("[debate] no debates under channel posts: CHAT_REPLY_CHAT_ID is unset");
    }
    // Polling ends only at shutdown or for good (bad token, 409): a bot that
    // no longer hears its groups must not argue in them.
    void avatarBot.start().then(() => debates.stop());

    return {
      /** Stops polling and new debate turns; call it next to the news bot's stop. */
      async stop(): Promise<void> {
        debates.stop();
        await avatarBot.stop();
      },
      /** Waits for debate and avatar turns in flight (capped), then closes the avatar store. */
      drain: (): Promise<void> => avatar.drainAndClose(debates.drain()),
    };
  } catch (err) {
    console.error(`[avatar] could not start: ${String(err)}`);
    void notifyOwner(`Аватар не запустился: ${String(err)}`);
    return null;
  }
}
