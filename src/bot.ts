import type { Context } from "grammy";

import { Bot, HttpError, GrammyError, InlineKeyboard } from "grammy";

import { CONFIG } from "./config.js";
import { autoRetry } from "./auto-retry.js";
import { rewriteToPost } from "./rewriter.js";
import { pingModel, listModels } from "./models.js";
import { truncate, escapeMarkdown } from "./utils.js";
import { PublishError, publishToBlog } from "./publisher.js";
import { fetchArticle, classifyInput, feedItemFromText } from "./ingest.js";
import { PROVIDERS, isMockActive, hasActiveOverride, resolveActiveProvider } from "./providers.js";
import {
  statusText,
  modelButtons,
  parseCallback,
  providerButtons,
  mockToggleButton,
} from "./bot-model.js";

import type { ButtonSpec } from "./bot-model.js";
import type { CandidateStore } from "./store.js";
import type { FeedItem, Candidate, RewriteResult, CandidateState } from "./types.js";

/** Logs a swallowed edit error instead of hiding it entirely. */
function logEditError(context: string) {
  return (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[bot] ${context} failed: ${String(err)}`);
  };
}

/**
 * Answers a callback query best-effort. answerCallbackQuery THROWS when the
 * query is older than ~15s ("query is too old") — a routine event for any
 * lingering inline button. An unguarded throw here propagates out of the
 * handler and (without a bot.catch) crashes the whole process, so acking must
 * never reject. Always swallow + log.
 */
async function ackSilently(ctx: Context, opts?: { text: string }): Promise<void> {
  await ctx.answerCallbackQuery(opts).catch(logEditError("answerCallbackQuery"));
}

const APPROVE_PREFIX = "approve_";
const SKIP_PREFIX = "skip_";
const REWRITE_PREFIX = "rewrite_";

/** Keyboard for a RAW card: rewrite (with the active model) or skip. */
function rawKeyboard(candidateId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Переработать", `${REWRITE_PREFIX}${candidateId}`)
    .text("❌ Пропустить", `${SKIP_PREFIX}${candidateId}`);
}

/** Keyboard for a PREVIEW card: regenerate, publish, or skip. */
function previewKeyboard(candidateId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Заново", `${REWRITE_PREFIX}${candidateId}`)
    .text("✅ Опубликовать", `${APPROVE_PREFIX}${candidateId}`)
    .row()
    .text("❌ Пропустить", `${SKIP_PREFIX}${candidateId}`);
}

/** Turns pure ButtonSpecs into a one-button-per-row inline keyboard. */
function keyboardFrom(buttons: ButtonSpec[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.text, b.data).row();
  return kb;
}

/** The /model status text + provider keyboard for the given store state. */
function modelMenu(store: CandidateStore): { text: string; keyboard: InlineKeyboard } {
  const active = resolveActiveProvider(store);
  const mockActive = isMockActive(store);
  const buttons = providerButtons();
  buttons.push(mockToggleButton(mockActive));
  buttons.push({ text: "↩️ Сбросить на env", data: "mreset" });
  return {
    text: statusText(active, hasActiveOverride(store), mockActive),
    keyboard: keyboardFrom(buttons),
  };
}

/**
 * Renders the RAW card (the source as collected, before any rewrite). All
 * interpolated content is escaped — feed text must not break or hijack the
 * Markdown (e.g. a title containing '*' or '[').
 */
function renderRaw(candidate: Candidate): string {
  return [
    `📥 *${escapeMarkdown(candidate.sourceTitle ?? candidate.sourceUrl)}*`,
    "",
    escapeMarkdown(truncate(candidate.snippet ?? "", 600)) ||
      "_(нет текста — будет переработан заголовок)_",
    "",
    `Источник: ${escapeMarkdown(candidate.feedTitle ?? "неизвестен")}`,
    escapeMarkdown(candidate.sourceUrl),
    "",
    "_Нажмите «Переработать» — текст перепишет активная модель (см. /model)._",
  ].join("\n");
}

/**
 * Renders the PREVIEW card (the rewritten post awaiting publish), noting which
 * provider/model produced it. All interpolated content is escaped.
 */
function renderPreview(candidate: Candidate, rewrite: RewriteResult, modelLabel: string): string {
  const tags = rewrite.tags.length ? `\n🏷 ${escapeMarkdown(rewrite.tags.join(", "))}` : "";
  // Show the start of the actual body so the owner sees what will be published.
  // Drop Markdown image lines (![](url)) — they publish to the blog but render
  // as ugly raw syntax in a Telegram preview. Collapse blank runs, then clamp.
  const bodyText = rewrite.content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bodyBlock = bodyText ? ["", "— — —", escapeMarkdown(truncate(bodyText, 500))] : [];
  return [
    `📝 *${escapeMarkdown(rewrite.title)}*`,
    "",
    escapeMarkdown(truncate(rewrite.description, 400)),
    tags,
    ...bodyBlock,
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
    `Источник: ${escapeMarkdown(candidate.feedTitle ?? "неизвестен")}`,
    escapeMarkdown(candidate.sourceUrl),
  ].join("\n");
}

/** The "in progress" placeholder shown while a rewrite runs. */
function renderRewriting(candidate: Candidate, modelLabel: string): string {
  return [
    `⏳ *Перерабатываю…*`,
    "",
    escapeMarkdown(candidate.sourceTitle ?? candidate.sourceUrl),
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
  ].join("\n");
}

/**
 * Heuristic: does this rewrite error look like the provider rejecting the model
 * id (not a transient rate-limit/network issue)? Matches a 4xx whose text
 * mentions the model — used to auto-clear a stale /model override.
 */
function isModelNotFound(message: string): boolean {
  const is4xx = /\b(400|404)\b/.test(message);
  const mentionsModel = /model/i.test(message) || /модел/i.test(message);
  return is4xx && mentionsModel;
}

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

  // Tracks in-flight publish handlers so shutdown can drain them before the DB
  // is closed (a publish does a network call, then writes to the store).
  let inFlight = 0;

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

  bot.on("callback_query:data", async (ctx) => {
    const {data} = ctx.callbackQuery;

    // /model callbacks are handled first; they don't touch a candidate.
    const modelCb = parseCallback(data);
    if (modelCb) {
      await handleModelCallback(ctx, modelCb);
      return;
    }

    const isApprove = data.startsWith(APPROVE_PREFIX);
    const isSkip = data.startsWith(SKIP_PREFIX);
    const isRewrite = data.startsWith(REWRITE_PREFIX);
    if (!isApprove && !isSkip && !isRewrite) {
      await ackSilently(ctx);
      return;
    }

    const id = Number(data.slice(data.indexOf("_") + 1));
    const candidate = store.get(id);
    if (!candidate) {
      await ackSilently(ctx, { text: "Кандидат не найден." });
      return;
    }

    if (isRewrite) {
      await handleRewrite(ctx, id, candidate);
      return;
    }

    if (isSkip) {
      // Skippable while the owner is still deciding (raw / preview / failed /
      // a post-crash row whose publish status is unknown).
      const skippable: CandidateState[] = [
        "collected",
        "pending_review",
        "rewrite_failed",
        "needs_verification",
      ];
      if (!skippable.includes(candidate.state)) {
        await ackSilently(ctx, { text: `Уже обработано (${candidate.state}).` });
        return;
      }
      store.setState(id, "skipped");
      await ackSilently(ctx, { text: "Пропущено." });
      await ctx.editMessageReplyMarkup().catch(logEditError("skip clear markup"));
      await ctx
        .editMessageText(`❌ Пропущено: ${candidate.sourceTitle ?? candidate.sourceUrl}`)
        .catch(logEditError("skip edit text"));
      return;
    }

    // Approve → publish. Atomically claim pending_review → publishing in a
    // single UPDATE; only the caller that flips the row (changes === 1) wins.
    // A concurrent double-tap loses the race here and cannot double-post.
    const won = store.claimForPublishing(id);
    if (!won) {
      await ackSilently(ctx, { text: "Уже обрабатывается." });
      return;
    }

    inFlight += 1;
    try {
      await ackSilently(ctx, { text: "Публикую…" });
      await ctx.editMessageReplyMarkup().catch(logEditError("publish clear markup"));

      const rewrite = store.getRewrite(candidate);
      if (!rewrite) {
        // No saved rewrite (corrupt/missing JSON) — send back to rewrite_failed
        // with a usable retry keyboard rather than a dead, button-less card.
        store.setState(id, "rewrite_failed", "Нет сохранённого rewrite.");
        await ctx
          .editMessageText("⚠️ Нет данных для публикации — переработайте заново.", {
            reply_markup: rawKeyboard(id),
          })
          .catch(logEditError("publish missing-rewrite text"));
        return;
      }

      try {
        const postId = await publishToBlog(rewrite, candidate.imageUrl, candidate.dedupKey);
        store.setPublished(id, postId);
        await ctx
          .editMessageText(`✅ Опубликовано: *${escapeMarkdown(rewrite.title)}*`, {
            parse_mode: "Markdown",
          })
          .catch(logEditError("publish success text"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // If the POST may have reached the blog (5xx / unreadable 201 / timeout),
        // the post could already be live — route to needs_verification so the
        // owner is warned before re-publishing, instead of a silent duplicate.
        const maybePosted = err instanceof PublishError && err.maybePosted;
        if (maybePosted) {
          store.setState(id, "needs_verification", message);
          await ctx
            .editMessageText(
              `❓ Публикация не подтверждена: ${message}\n\n_Пост МОГ опубликоваться — проверьте блог перед повтором._`,
              { parse_mode: "Markdown", reply_markup: previewKeyboard(id) },
            )
            .catch(logEditError("publish maybe-posted text"));
        } else {
          // Definitely did not post — safe to re-offer publish/regenerate.
          store.setState(id, "pending_review", message);
          await ctx
            .editMessageText(`⚠️ Не удалось опубликовать: ${message}`, {
              reply_markup: previewKeyboard(id),
            })
            .catch(logEditError("publish failure text"));
        }
      }
    } finally {
      inFlight -= 1;
    }
  });

  /**
   * Handles a /model inline-button tap: navigate provider → model, ping the
   * chosen model, and only persist the override if the ping succeeds. A failed
   * ping shows the error and keeps the model list so the owner can pick another.
   */
  async function handleModelCallback(
    ctx: Context,
    cb: NonNullable<ReturnType<typeof parseCallback>>,
  ): Promise<void> {
    if (cb.kind === "reset") {
      // Full reset to env: drop BOTH the model and the mock overrides, so the
      // "Сброшено на env" toast is truthful (a lingering mock override would
      // otherwise keep shadowing the env default).
      store.clearModelOverride();
      store.clearMockOverride();
      const { text, keyboard } = modelMenu(store);
      await ackSilently(ctx, { text: "Сброшено на env." });
      await ctx
        .editMessageText(text, { reply_markup: keyboard })
        .catch(logEditError("model reset"));
      return;
    }

    if (cb.kind === "back") {
      const { text, keyboard } = modelMenu(store);
      await ackSilently(ctx);
      await ctx.editMessageText(text, { reply_markup: keyboard }).catch(logEditError("model back"));
      return;
    }

    if (cb.kind === "mockOn" || cb.kind === "mockOff") {
      // Toggle the runtime mock (без LLM) override; the db value is strictly
      // authoritative over env REWRITE_MOCK (see resolveActiveProvider).
      store.setMockOverride(cb.kind === "mockOn");
      const { text, keyboard } = modelMenu(store);
      await ackSilently(ctx, { text: cb.kind === "mockOn" ? "Mock включён." : "Mock выключен." });
      await ctx
        .editMessageText(text, { reply_markup: keyboard })
        .catch(logEditError("mock toggle"));
      return;
    }

    if (cb.kind === "provider") {
      await ackSilently(ctx);
      const models = await listModels(cb.provider);
      const {label} = PROVIDERS[cb.provider];
      await ctx
        .editMessageText(`Провайдер: ${label}. Выберите модель:`, {
          reply_markup: keyboardFrom(modelButtons(cb.provider, models)),
        })
        .catch(logEditError("model provider list"));
      return;
    }

    // cb.kind === 'model' — ping, then save on success only.
    await ackSilently(ctx, { text: "Проверяю модель…" });
    const result = await pingModel(cb.provider, cb.model);
    const {label} = PROVIDERS[cb.provider];
    if (result.ok) {
      store.setModelOverride(cb.provider, cb.model);
      // Picking a model is an explicit "use this provider" intent; clear any mock
      // override so the choice takes effect (mock otherwise wins in
      // resolveActiveProvider and the switch would be a silent no-op).
      const wasMock = isMockActive(store);
      store.clearMockOverride();
      const note = wasMock ? " (Mock выключен)" : "";
      const confirm = `✅ Переключено: ${label} / ${cb.model}${note}`;
      // The override IS saved; if the message can't be edited (too old/deleted),
      // send a fresh reply so the owner always gets the confirmation.
      await ctx.editMessageText(confirm).catch(async (err) => {
        logEditError("model switch ok")(err);
        await ctx.reply(confirm).catch(logEditError("model switch ok reply"));
      });
    } else {
      // keep the model list so the owner can try another model
      const models = await listModels(cb.provider);
      await ctx
        .editMessageText(`⚠️ ${result.error}\n\nВыберите другую модель:`, {
          reply_markup: keyboardFrom(modelButtons(cb.provider, models)),
        })
        .catch(logEditError("model switch fail"));
    }
  }

  /**
   * Rewrites a candidate on the owner's 🔄 tap, with the model active right now,
   * then edits the message into the preview card. On failure marks rewrite_failed
   * and offers a retry. Reachable from both the raw card and the preview card
   * ("Заново"). answerCallbackQuery is sent immediately because the rewrite can
   * take longer than Telegram's ~15s callback window.
   */
  async function handleRewrite(ctx: Context, id: number, candidate: Candidate): Promise<void> {
    // Atomically claim collected/pending_review/rewrite_failed → 'rewriting'.
    // A losing concurrent 🔄 double-tap gets `false` and bails — no duplicate
    // (token-spending) rewrite, mirroring claimForPublishing for ✅.
    if (!store.claimForRewriting(id)) {
      await ackSilently(ctx, { text: `Уже обрабатывается (${candidate.state}).` });
      return;
    }

    inFlight += 1;
    try {
      await ackSilently(ctx, { text: "Перерабатываю…" });
      const active = resolveActiveProvider(store);
      const modelLabel = `${PROVIDERS[active.provider].label} / ${active.model}`;

      // Visible "in progress" state: replace the card with a placeholder (no
      // buttons) so the owner sees the rewrite is running, not a frozen card.
      await ctx
        .editMessageText(renderRewriting(candidate, modelLabel), { parse_mode: "Markdown" })
        .catch(logEditError("rewrite in-progress"));

      try {
        const item = store.getFeedItem(candidate);
        const rewrite = await rewriteToPost(item, store);
        store.attachRewrite(id, rewrite); // → pending_review
        const updated = store.get(id) ?? candidate;
        await editOrResend(
          ctx,
          id,
          renderPreview(updated, rewrite, modelLabel),
          previewKeyboard(id),
          "rewrite preview",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.setState(id, "rewrite_failed", message);
        // A model-not-found on the active override means that model is dead;
        // clear the override so the env default is used next.
        if (isModelNotFound(message) && hasActiveOverride(store)) {
          store.clearModelOverride();
        }
        await editOrResend(
          ctx,
          id,
          `⚠️ Не удалось переработать: ${message}\n\nМодель: ${modelLabel}`,
          rawKeyboard(id),
          "rewrite failed text",
        );
      }
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * Edits the callback's message; if the edit fails (too old, deleted, parse
   * error), sends a FRESH message with the same keyboard so an action button is
   * always reachable, and records its id. Prevents a stranded card with a saved
   * rewrite but no publish button.
   */
  async function editOrResend(
    ctx: Context,
    id: number,
    text: string,
    keyboard: InlineKeyboard,
    label: string,
  ): Promise<void> {
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (editErr) {
      logEditError(label)(editErr);
      try {
        const msg = await bot.api.sendMessage(CONFIG.OWNER_TELEGRAM_ID, text, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
        store.setTelegramMessage(id, msg.message_id);
      } catch (sendErr) {
        // Last resort: plain text, no Markdown (covers an entity-parse failure).
        await bot.api
          .sendMessage(CONFIG.OWNER_TELEGRAM_ID, text, { reply_markup: keyboard })
          .then((m) => store.setTelegramMessage(id, m.message_id))
          .catch(logEditError(`${label} resend`));
        logEditError(`${label} resend-markdown`)(sendErr);
      }
    }
  }

  /**
   * Handles an owner-sent message (URL or free text): build a FeedItem, insert
   * it as a fresh candidate, and DM the raw card — from there it's the normal
   * rewrite → preview → publish flow. A URL is scraped; free text is taken as
   * the article. A dedup hit (already seen) replies instead of inserting; a URL
   * fetch failure surfaces the error and inserts nothing.
   */
  async function ingestMessage(ctx: Context, raw: string): Promise<void> {
    const input = classifyInput(raw);
    if (input.kind === "empty") {
      await ctx.reply("Пришлите ссылку на статью или текст — переработаю в пост.");
      return;
    }

    let item: FeedItem;
    if (input.kind === "url") {
      await ctx.reply("⏳ Загружаю статью по ссылке…");
      try {
        item = await fetchArticle(input.url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`⚠️ Не удалось получить статью: ${message}`);
        return;
      }
    } else {
      item = feedItemFromText(input.text);
    }

    const id = store.insertCollected(item);
    if (id === null) {
      await ctx.reply("Эта новость уже была в очереди или опубликована.");
      return;
    }
    const candidate = store.get(id);
    if (!candidate) {
      // Should not happen (just inserted) — guard so we never call sendRawCard
      // with a stale id.
      await ctx.reply("⚠️ Не удалось создать карточку — попробуйте ещё раз.");
      return;
    }
    await sendRawCard(candidate);
  }

  /** Sends the owner a RAW card for a freshly-collected candidate. */
  async function sendRawCard(candidate: Candidate): Promise<void> {
    const message = await bot.api.sendMessage(CONFIG.OWNER_TELEGRAM_ID, renderRaw(candidate), {
      parse_mode: "Markdown",
      reply_markup: rawKeyboard(candidate.id),
    });
    store.setTelegramMessage(candidate.id, message.message_id);
  }

  /**
   * On startup, warn the owner about any candidate left in needs_verification by
   * a crash/deploy mid-publish — the post MIGHT already be live. The owner should
   * check the blog before re-publishing. Each gets a card with a publish button
   * (to finish if it never posted) and a skip button (to dismiss if it did).
   */
  async function notifyNeedsVerification(): Promise<void> {
    for (const c of store.listByState("needs_verification")) {
      const text = [
        `❓ *Статус публикации неизвестен* (был сбой во время публикации).`,
        "",
        escapeMarkdown(c.sourceTitle ?? c.sourceUrl),
        "",
        "_Проверьте блог: пост мог уже опубликоваться._",
        "_«Опубликовать» — если поста нет; «Пропустить» — если он уже на сайте._",
      ].join("\n");
      try {
        const msg = await bot.api.sendMessage(CONFIG.OWNER_TELEGRAM_ID, text, {
          parse_mode: "Markdown",
          reply_markup: previewKeyboard(c.id),
        });
        store.setTelegramMessage(c.id, msg.message_id);
      } catch (err) {
        logEditError("needs-verification notify")(err);
      }
    }
  }

  /**
   * Resolves once no publish handler is in flight (or a timeout elapses).
   * Shutdown awaits this before closing the store so a callback mid-publish
   * isn't cut off with a closed database.
   */
  async function drain(timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return { bot, sendRawCard, notifyNeedsVerification, drain };
}

export type BotBundle = ReturnType<typeof createBot>;
