import type { Bot, Context } from "grammy";

import { CONFIG } from "../config.js";
import { renderRaw } from "./render.js";
import { logEditError } from "./edit.js";
import { escapeMarkdown } from "../utils.js";
import { InputKind, CandidateState } from "../enums.js";
import { rawKeyboard, previewKeyboard } from "./keyboards.js";
import { fetchArticle, classifyInput, feedItemFromText } from "../feeds/index.js";

import type { FeedItem, Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

/**
 * Manual-ingest helpers and the startup needs-verification notice. Grouped in
 * their own factory so the callback-handler module stays under the line cap.
 */
export function createIngest(store: CandidateStore, bot: Bot) {
  /** Sends the owner a RAW card for a freshly-collected candidate. */
  async function sendRawCard(candidate: Candidate): Promise<void> {
    const message = await bot.api.sendMessage(CONFIG.OWNER_TELEGRAM_ID, renderRaw(candidate), {
      parse_mode: "Markdown",
      reply_markup: rawKeyboard(candidate.id),
    });
    store.setTelegramMessage(candidate.id, message.message_id);
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
    if (input.kind === InputKind.Empty) {
      await ctx.reply("Пришлите ссылку на статью или текст — переработаю в пост.");
      return;
    }

    let item: FeedItem;
    if (input.kind === InputKind.Url) {
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

  /**
   * On startup, warn the owner about any candidate left in needs_verification by
   * a crash/deploy mid-publish — the post MIGHT already be live. The owner should
   * check the blog before re-publishing. Each gets a card with a publish button
   * (to finish if it never posted) and a skip button (to dismiss if it did).
   */
  async function notifyNeedsVerification(): Promise<void> {
    for (const c of store.listByState(CandidateState.NeedsVerification)) {
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

  return { ingestMessage, sendRawCard, notifyNeedsVerification };
}
