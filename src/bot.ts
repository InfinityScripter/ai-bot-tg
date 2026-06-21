import { Bot, HttpError, GrammyError } from "grammy";

import { CONFIG } from "./config.js";
import { autoRetry } from "./auto-retry.js";
import { createIngest } from "./bot-ingest.js";
import { modelMenu } from "./bot-model-menu.js";
import { createHandlers } from "./bot-handlers.js";

import type { CandidateStore } from "./store.js";

/**
 * Creates the bot, locked to the owner, with /start, /ping, /model, the
 * rewrite/publish/skip callback handlers, and a `sendRawCard` helper for the
 * collector. `onFetch` is invoked by /fetch (wired by the entrypoint to run a
 * collection cycle).
 */
export function createBot(
  store: CandidateStore,
  onFetch: () => Promise<string | void> | string | void,
) {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

  // grammY's canonical rate-limit handling: transparently wait out a 429's
  // retry_after and resubmit (also retries 5xx / network blips with backoff).
  // Preferred over proactive throttling — the bot only messages one chat.
  bot.api.config.use(autoRetry());

  const { onCallback, drain } = createHandlers(store, bot);
  const { ingestMessage, sendRawCard, notifyNeedsVerification } = createIngest(store, bot);

  // Global error boundary: grammy rethrows an uncaught handler error out of the
  // polling loop, which exits the process (systemd then restart-loops). This
  // keeps the bot alive through any handler failure. Benign Telegram 400s
  // ("message is not modified", "query is too old") log at debug; real Bot API
  // errors and network errors are distinguished for clearer logs.
  bot.catch((err) => {
    const e = err.error;
    const updateId = err.ctx.update.update_id;
    if (e instanceof GrammyError) {
      const benign = /message is not modified|query is too old|message to edit not found/i.test(
        e.description,
      );
      // eslint-disable-next-line no-console
      console[benign ? "warn" : "error"](
        `[bot] Telegram error on update ${updateId}: ${e.description}`,
      );
    } else if (e instanceof HttpError) {
      // eslint-disable-next-line no-console
      console.warn(`[bot] network error on update ${updateId}: ${String(e)}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[bot] unhandled error on update ${updateId}: ${String(e)}`);
    }
  });

  // Owner-lock: silently ignore every update from anyone but the owner —
  // commands and callbacks alike. ctx.from is set for messages, callbacks,
  // edited messages, channel posts, and inline queries, so this gate covers
  // every update type that carries a sender.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== CONFIG.OWNER_TELEGRAM_ID) {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({ text: "Не авторизовано." }).catch(() => {});
      return; // drop the update
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "Новостной бот на связи. /fetch — собрать новости сейчас. " +
        "/model — провайдер/модель. /ping — проверка.",
    ),
  );
  bot.command("ping", (ctx) => ctx.reply("pong"));
  bot.command("fetch", async (ctx) => {
    await ctx.reply("Запускаю сбор новостей…");
    try {
      const note = await onFetch();
      if (note) await ctx.reply(note);
    } catch (err) {
      await ctx.reply(`Сбор завершился с ошибкой: ${String(err)}`);
    }
  });
  bot.command("model", async (ctx) => {
    const { text, keyboard } = modelMenu(store);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  // Manual ingest: the owner DMs the bot a URL or free text, and the bot turns
  // it into a candidate that flows through the SAME rewrite → preview → publish
  // pipeline as a daily-collected RSS item. Registered after the commands, so it
  // only fires for non-command text (grammy routes "/cmd" to bot.command).
  bot.on("message:text", async (ctx) => {
    const raw = ctx.message.text;
    // Defensive: an unknown "/command" reaches here (no matching bot.command).
    // Don't treat it as article text — guide instead of ingesting "/foo".
    if (raw.startsWith("/")) {
      await ctx.reply(
        "Неизвестная команда. /fetch — собрать новости, /model — модель, /ping — проверка.",
      );
      return;
    }
    await ingestMessage(ctx, raw);
  });

  bot.on("callback_query:data", onCallback);

  return { bot, sendRawCard, notifyNeedsVerification, drain };
}

export type BotBundle = ReturnType<typeof createBot>;
