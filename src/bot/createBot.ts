import type { Context } from "grammy";

import { Bot, HttpError, GrammyError } from "grammy";

import { CONFIG } from "../config.js";
import { modelMenu } from "./modelMenu.js";
import { autoRetry } from "./autoRetry.js";
import { createIngest } from "./createIngest.js";
import { createDigestFlow } from "./digestFlow.js";
import { createHandlers } from "./createHandlers.js";
import { createAutoPublish } from "./createAutoPublish.js";
import { renderHealth, collectHealth } from "../health/index.js";
import { helpText, menuIntro, menuKeyboard, nativeCommands, parseMenuCallback } from "./menu.js";

import type { BotOptions } from "./types.js";
import type { MenuAction } from "../enums.js";
import type { CandidateStore } from "../store/index.js";

/**
 * Creates the bot, locked to the owner, with the command menu (/start, /menu,
 * /help), /ping, /health, /fetch, /model, the rewrite/publish/skip callback
 * handlers, and a `sendRawCard` helper for the collector. `onFetch` is invoked
 * by /fetch (wired by the entrypoint to run a collection cycle).
 */
export function createBot(
  store: CandidateStore,
  onFetch: () => Promise<string | void> | string | void,
  options: BotOptions = {},
) {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);
  const nextRun = options.nextRun ?? (() => null);

  // grammY's canonical rate-limit handling: transparently wait out a 429's
  // retry_after and resubmit (also retries 5xx / network blips with backoff).
  // Preferred over proactive throttling — the bot only messages one chat.
  bot.api.config.use(autoRetry());

  const { onCallback, drain: drainHandlers } = createHandlers(store, bot);
  const { ingestMessage, sendRawCard, notifyNeedsVerification } = createIngest(store, bot);
  const {
    autoPublishCandidate,
    notifyAutomaticFailures,
    drain: drainAutoPublish,
  } = createAutoPublish(store, bot);
  const { runDigest, onDigestCallback, isDigestCallback, isAwaitingVerdict, submitVerdict } =
    createDigestFlow(bot, store);

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

  // Command actions, defined once and reused by both the slash command and the
  // matching inline menu button, so a button tap and a typed command never drift.
  async function runFetch(ctx: Context): Promise<void> {
    await ctx.reply("Запускаю сбор новостей…");
    try {
      const note = await onFetch();
      if (note) await ctx.reply(note);
    } catch (err) {
      await ctx.reply(`Сбор завершился с ошибкой: ${String(err)}`);
    }
  }
  async function runModel(ctx: Context): Promise<void> {
    const { text, keyboard } = modelMenu(store);
    await ctx.reply(text, { reply_markup: keyboard });
  }
  async function runHealth(ctx: Context): Promise<void> {
    await ctx.reply("🩺 Проверяю…");
    const report = await collectHealth(store, { nextRun });
    await ctx.reply(renderHealth(report), { parse_mode: "Markdown" });
  }
  async function runHelp(ctx: Context): Promise<void> {
    await ctx.reply(helpText(), { parse_mode: "Markdown" });
  }
  async function runMenu(ctx: Context): Promise<void> {
    await ctx.reply(menuIntro(), { reply_markup: menuKeyboard() });
  }

  bot.command("start", runMenu);
  bot.command("menu", runMenu);
  bot.command("help", runHelp);
  bot.command("health", runHealth);
  bot.command("ping", (ctx) => ctx.reply("pong"));
  bot.command("fetch", runFetch);
  bot.command("model", runModel);
  bot.command("digest", runDigest);

  // Dispatch table from a menu button's MenuAction to its command action.
  const MENU_ACTIONS: Record<MenuAction, (ctx: Context) => Promise<void>> = {
    fetch: runFetch,
    model: runModel,
    health: runHealth,
    help: runHelp,
  };

  // Manual ingest: the owner DMs the bot a URL or free text, and the bot turns
  // it into a candidate that flows through the SAME rewrite → preview → publish
  // pipeline as a daily-collected RSS item. Registered after the commands, so it
  // only fires for non-command text (grammy routes "/cmd" to bot.command).
  bot.on("message:text", async (ctx) => {
    const raw = ctx.message.text;
    // Defensive: an unknown "/command" reaches here (no matching bot.command).
    // Don't treat it as article text — point at /help instead of ingesting "/foo".
    if (raw.startsWith("/")) {
      await ctx.reply("Неизвестная команда. /help — список команд.");
      return;
    }
    // If the digest flow is waiting for the verdict, this text fills the
    // {{ВЕРДИКТ}} slot instead of becoming a candidate. Routed BEFORE ingest.
    if (isAwaitingVerdict()) {
      await submitVerdict(ctx, raw);
      return;
    }
    await ingestMessage(ctx, raw);
  });

  // Menu-button taps run the same action as the command; anything else falls
  // through to the candidate-card callback router.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const action = parseMenuCallback(data);
    if (action) {
      await ctx.answerCallbackQuery().catch(() => {});
      await MENU_ACTIONS[action](ctx);
      return;
    }
    // Digest callbacks are routed before the candidate-card router — they don't
    // touch a candidate, and their `digest_*` data would otherwise fall through
    // to onCallback and be silently acked.
    if (isDigestCallback(data)) {
      await onDigestCallback(ctx);
      return;
    }
    await onCallback(ctx);
  });

  // Register the native Telegram command list (the blue "Menu" button) once on
  // startup. Best-effort — a failure here never blocks polling.
  void bot.api
    .setMyCommands(nativeCommands())
    // eslint-disable-next-line no-console
    .catch((err) => console.warn(`[bot] setMyCommands failed: ${String(err)}`));

  const drain = async (): Promise<void> => {
    await Promise.all([drainHandlers(), drainAutoPublish()]);
  };

  return {
    bot,
    sendRawCard,
    autoPublishCandidate,
    notifyAutomaticFailures,
    notifyNeedsVerification,
    drain,
  };
}

export type BotBundle = ReturnType<typeof createBot>;
