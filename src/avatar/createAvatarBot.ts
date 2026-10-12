import { Bot, GrammyError } from "grammy";

import { CONFIG } from "../config.js";
import { autoRetry } from "../bot/autoRetry.js";
import { isOwnerDm } from "../bot/isOwnerDm.js";
import { createAvatar } from "./createAvatar.js";
import { logBotError } from "../bot/logBotError.js";
import { registerAvatarCommands } from "./avatarCommands.js";

import type { AvatarOptions } from "./createAvatar.js";
import type { CandidateStore } from "../store/index.js";

export interface AvatarBotOptions {
  /** The news bot's DM with the owner: used when this bot cannot write to the owner. */
  fallbackNotify: (text: string) => Promise<unknown>;
  avatar?: Omit<AvatarOptions, "notifyOwner">;
}

const COMMANDS = [
  { command: "avatar", description: "статус; /avatar on|off; /avatar leave id" },
  { command: "profile", description: "профиль: /profile текст о себе; без текста — показать" },
  { command: "reindex", description: "перечитать посты блога" },
  { command: "memory", description: "память группы; /memory clear — очистить" },
];

/** grammY's stop() sends one more getUpdates, which autoRetry may retry for long. */
const STOP_MAX_MS = 3000;

const START_TEXT = [
  "Я твой аватар.",
  "Добавь меня в группу сам: там я говорю твоим голосом и спорю с Hope, если новостной бот тоже в группе.",
  "Из групп, куда меня добавил кто-то другой, я выхожу.",
  "Команды: /profile, /reindex, /avatar, /memory.",
].join("\n");

/**
 * The avatar's own Telegram bot, in the news bot's process: one Codex queue
 * for both bots (one ChatGPT login must not refresh its token from two
 * processes), and no second Node process on a small VDS. A failure here must
 * never stop the news bot: polling errors are caught and reported.
 */
export function createAvatarBot(token: string, store: CandidateStore, options: AvatarBotOptions) {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry());

  // Telegram answers 403 until the owner presses Start in this bot's DM.
  const notifyOwner = (text: string): Promise<unknown> =>
    bot.api.sendMessage(CONFIG.OWNER_TELEGRAM_ID, text).catch((err) => {
      console.warn(`[avatar] owner DM failed, using the news bot: ${String(err)}`);
      return options.fallbackNotify(
        `Бот-аватар не может написать тебе сам: нажми «Старт» в его личке. Его сообщение:\n${text}`,
      );
    });
  const avatar = createAvatar(bot, store, { ...options.avatar, notifyOwner });

  bot.catch(logBotError("avatar"));
  bot.use(avatar.middleware);
  bot.use(async (ctx, next) => {
    if (isOwnerDm(ctx)) await next();
  });
  bot.command("start", (ctx) => ctx.reply(START_TEXT));
  registerAvatarCommands(bot, avatar);

  /** Polls until stopped. Never rejects: a bad token is logged and reported to the owner. */
  async function start(): Promise<void> {
    try {
      await bot.start({
        onStart: (info) => {
          console.log(`[avatar] bot @${info.username} polling.`);
          void bot.api
            .setMyCommands(COMMANDS)
            .catch((err) => console.warn(`[avatar] setMyCommands failed: ${String(err)}`));
        },
      });
    } catch (err) {
      console.error(`[avatar] polling stopped: ${String(err)}`);
      const conflict = err instanceof GrammyError && err.error_code === 409;
      await options.fallbackNotify(
        conflict
          ? "Бот-аватар остановился: его обновления уже читает другой процесс. Проверь, что AVATAR_BOT_TOKEN не совпадает с токеном новостного бота и что бот не запущен второй раз."
          : `Бот-аватар остановился: ${String(err)}. Проверь AVATAR_BOT_TOKEN.`,
      );
    }
  }

  /** Stops polling; never throws and never waits longer than STOP_MAX_MS. */
  async function stop(): Promise<void> {
    if (!bot.isRunning()) return;
    const stopped = bot.stop().catch((err) => {
      console.warn(`[avatar] stop failed: ${String(err)}`);
    });
    const cap = new Promise<void>((resolve) => {
      setTimeout(resolve, STOP_MAX_MS).unref();
    });
    await Promise.race([stopped, cap]);
  }

  return { bot, avatar, start, stop };
}
