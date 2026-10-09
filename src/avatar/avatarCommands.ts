import type { Bot, Context } from "grammy";

import { CONFIG } from "../config.js";

import type { Avatar } from "./createAvatar.js";

/** Telegram caps a message at 4096 characters. */
const SHOW_CHARS = 3500;

const time = (at: number): string =>
  new Date(at).toLocaleString("ru-RU", { timeZone: CONFIG.CRON_TZ });

/** /avatar without arguments: what the avatar knows, where it is and what went wrong last. */
function statusText(avatar: Avatar): string {
  const { store } = avatar;
  const day = new Date().toISOString().slice(0, 10);
  const index = avatar.lastIndex();
  const error = avatar.lastError();
  const chats = store.listChats();
  let indexLine = "в этом запуске блог ещё не читался";
  if (avatar.isIndexing()) indexLine = "читаю блог прямо сейчас";
  else if (index && "error" in index) indexLine = `${time(index.at)} не вышло: ${index.error}`;
  else if (index) indexLine = `${time(index.at)}, пропущено постов: ${index.summary.failed}`;
  return [
    `Аватар ${store.isEnabled() ? "включён" : "выключен"}.`,
    `Память: ${store.chunkCount()} кусков из блога (${indexLine}); профиль ${store.getProfile().length} символов.`,
    `Лимит: ${CONFIG.AVATAR_DAILY_CALLS} ответов в день на группу, без приглашения и в спорах с Hope — до половины.`,
    `Последняя ошибка: ${error ? `${time(error.at)} ${error.text}` : "нет"}.`,
    chats.length ? "Группы:" : "Групп нет. Добавь меня в группу сам: из чужих групп я выхожу.",
    ...chats.map(
      (c) => `• ${c.title} (${c.chatId}): ответов сегодня ${store.callsOn(c.chatId, day)}`,
    ),
  ].join("\n");
}

const replySafely = (ctx: Context, text: string): Promise<unknown> =>
  ctx.reply(text).catch((err) => console.warn(`[avatar] command reply failed: ${String(err)}`));

/**
 * The owner's avatar commands. Registered after the owner lock; the avatar
 * middleware stops every group update before it, so they only run in the
 * owner's private chat with the bot.
 */
export function registerAvatarCommands(bot: Bot, avatar: Avatar): void {
  bot.command("profile", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      const current = avatar.store.getProfile();
      await ctx.reply(
        current
          ? current.slice(0, SHOW_CHARS)
          : [
              "Профиль пуст. Пришли /profile и текст о себе одним сообщением:",
              "Кто я. Чем занимаюсь. Во что верю. Как говорю (длина фраз, любимые и запретные слова).",
              "Образцы моих реплик: 5–10 фраз так, как ты их сказал бы сам.",
            ].join("\n"),
      );
      return;
    }
    avatar.store.setProfile(text);
    await ctx.reply(
      `Профиль сохранён: ${text.length} символов. Любой участник группы может его выманить.`,
    );
  });

  bot.command("reindex", async (ctx) => {
    if (avatar.isIndexing()) {
      await ctx.reply("Уже читаю блог, подожди.");
      return;
    }
    await ctx.reply("Читаю посты блога, это займёт несколько минут.");
    void avatar
      .reindex()
      .then((s) =>
        replySafely(ctx, `Готово: постов ${s.posts}, кусков ${s.chunks}, пропущено ${s.failed}.`),
      )
      .catch((err) => replySafely(ctx, `Не вышло, старая память на месте: ${String(err)}`));
  });

  bot.command("avatar", async (ctx) => {
    const [action, arg] = ctx.match.trim().split(/\s+/);
    if (action === "on" || action === "off") {
      avatar.store.setEnabled(action === "on");
      await ctx.reply(action === "on" ? "Аватар включён." : "Аватар выключен во всех группах.");
      return;
    }
    if (action === "leave") {
      const chatId = Number(arg);
      if (!Number.isInteger(chatId) || chatId === 0) {
        await ctx.reply("Пришли id группы из /avatar, например: /avatar leave -100123");
        return;
      }
      const error = await avatar.leave(chatId);
      await ctx.reply(error ? `Не вышел: ${error}` : "Вышел из группы и забыл её.");
      return;
    }
    await ctx.reply(statusText(avatar));
  });
}
