import type { Bot, Context, InlineKeyboard } from "grammy";

import { CONFIG } from "../config.js";
import { parseCallback } from "./model.js";
import { escapeMarkdown } from "../utils.js";
import { CARD_CALLBACK } from "../consts.js";
import { CandidateState } from "../enums.js";
import { ackSilently, logEditError } from "./edit.js";
import { handleModelCallback } from "./model-menu.js";
import { PublishError, publishToBlog } from "../publisher.js";
import { rawKeyboard, previewKeyboard } from "./keyboards.js";
import { renderPreview, isModelNotFound, renderRewriting } from "./render.js";
import { PROVIDERS , rewriteToPost, hasActiveOverride, resolveActiveProvider } from "../llm/index.js";

import type { Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

/**
 * Builds the inline-callback router and candidate-card action handlers, sharing
 * one `inFlight` counter so `drain()` can wait out an in-progress
 * publish/rewrite before the store closes. Kept out of bot.ts so the entrypoint
 * module stays thin.
 */
export function createHandlers(store: CandidateStore, bot: Bot) {
  // Tracks in-flight publish/rewrite handlers so shutdown can drain them before
  // the DB is closed (each does a network call, then writes to the store).
  let inFlight = 0;

  async function onCallback(ctx: Context): Promise<void> {
    const { data } = ctx.callbackQuery!;
    const raw = data ?? "";

    // /model callbacks are handled first; they don't touch a candidate.
    const modelCb = parseCallback(raw);
    if (modelCb) {
      await handleModelCallback(ctx, modelCb, store);
      return;
    }

    const isApprove = raw.startsWith(CARD_CALLBACK.APPROVE);
    const isSkip = raw.startsWith(CARD_CALLBACK.SKIP);
    const isRewrite = raw.startsWith(CARD_CALLBACK.REWRITE);
    if (!isApprove && !isSkip && !isRewrite) {
      await ackSilently(ctx);
      return;
    }

    const id = Number(raw.slice(raw.indexOf("_") + 1));
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
      await handleSkip(ctx, id, candidate);
      return;
    }
    await handleApprove(ctx, id, candidate);
  }

  async function handleSkip(ctx: Context, id: number, candidate: Candidate): Promise<void> {
    // Skippable while the owner is still deciding (raw / preview / failed /
    // a post-crash row whose publish status is unknown).
    const skippable: CandidateState[] = [
      CandidateState.Collected,
      CandidateState.PendingReview,
      CandidateState.RewriteFailed,
      CandidateState.NeedsVerification,
    ];
    if (!skippable.includes(candidate.state)) {
      await ackSilently(ctx, { text: `Уже обработано (${candidate.state}).` });
      return;
    }
    store.setState(id, CandidateState.Skipped);
    await ackSilently(ctx, { text: "Пропущено." });
    await ctx.editMessageReplyMarkup().catch(logEditError("skip clear markup"));
    await ctx
      .editMessageText(`❌ Пропущено: ${candidate.sourceTitle ?? candidate.sourceUrl}`)
      .catch(logEditError("skip edit text"));
  }

  async function handleApprove(ctx: Context, id: number, candidate: Candidate): Promise<void> {
    // Approve → publish. Atomically claim pending_review → publishing in a
    // single UPDATE; only the caller that flips the row (changes === 1) wins.
    // A concurrent double-tap loses the race here and cannot double-post.
    if (!store.claimForPublishing(id)) {
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
        store.setState(id, CandidateState.RewriteFailed, "Нет сохранённого rewrite.");
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
          store.setState(id, CandidateState.NeedsVerification, message);
          await ctx
            .editMessageText(
              `❓ Публикация не подтверждена: ${message}\n\n_Пост МОГ опубликоваться — проверьте блог перед повтором._`,
              { parse_mode: "Markdown", reply_markup: previewKeyboard(id) },
            )
            .catch(logEditError("publish maybe-posted text"));
        } else {
          // Definitely did not post — safe to re-offer publish/regenerate.
          store.setState(id, CandidateState.PendingReview, message);
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
        store.setState(id, CandidateState.RewriteFailed, message);
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

  return { onCallback, drain };
}
