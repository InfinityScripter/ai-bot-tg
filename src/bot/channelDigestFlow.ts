import type { Bot, Context } from "grammy";

import { InlineKeyboard } from "grammy";

import { CONFIG } from "../config.js";
import { ackSilently, logEditError } from "./edit.js";
import { CHANNEL_DIGEST_CALLBACK } from "../consts.js";
import { fetchAutoPublishFlags } from "../blog/index.js";
import {
  issueSlot,
  newsCount,
  isPastSlot,
  recordIssue,
  publishIssue,
  assembleIssue,
  deliverArticle,
} from "../channelDigest/index.js";

import type { CandidateStore } from "../store/index.js";
import type { IssueSlot, AssembledIssue } from "../channelDigest/index.js";

const { PUBLISH, SKIP } = CHANNEL_DIGEST_CALLBACK;

function previewKeyboard(slotKey: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Опубликовать", `${PUBLISH}${slotKey}`)
    .text("❌ Пропустить", `${SKIP}${slotKey}`);
}

/**
 * The channel digest issue (CHANNEL_DIGEST_CRON): assemble the queue into one
 * rich article, then publish it (autoPublishChannels on, read fail-closed) or
 * send the same article to the owner with ✅/❌. One pending preview at a
 * time; its buttons carry the slot key, so a button under an older preview
 * is refused instead of publishing a newer issue.
 */
export function createChannelDigestFlow(bot: Bot, store: CandidateStore) {
  let pending: AssembledIssue | null = null;

  async function notify(text: string, keyboard?: InlineKeyboard): Promise<void> {
    await bot.api
      .sendMessage(CONFIG.OWNER_TELEGRAM_ID, text, keyboard ? { reply_markup: keyboard } : {})
      .catch(logEditError("channel-digest notify"));
  }

  async function sendPreview(issue: AssembledIssue): Promise<void> {
    const { slot, article } = issue;
    let rejected: string | null;
    try {
      ({ rejected } = await deliverArticle(CONFIG.OWNER_TELEGRAM_ID, article, issue.fallbackText));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordIssue(slot.key, { ok: false, outcome: `превью не отправилось: ${message}` });
      await notify(`⚠️ Превью выпуска «${slot.title}» не отправилось: ${message}`);
      return;
    }
    pending = issue;
    recordIssue(slot.key, { ok: true, outcome: "ждёт решения владельца" });
    const warning = rejected
      ? `⚠️ Telegram не принял статью (${rejected}), в канал уйдёт текстовая версия.\n\n`
      : "";
    await notify(
      `${warning}Выпуск «${slot.title}» выше: ${newsCount(article.items.length)}. Автопубликация каналов выключена. Опубликовать в канале?`,
      previewKeyboard(slot.key),
    );
  }

  async function assemble(slot: IssueSlot, now: number) {
    try {
      return await assembleIssue(store, slot, now);
    } catch (err) {
      recordIssue(slot.key, { ok: false, outcome: `сбой сборки: ${String(err)}` });
      throw err;
    }
  }

  /**
   * One issue for the slot `now` falls in. The slot is computed once and used
   * by the assembler and the publisher alike (writing cards takes minutes). A
   * slot that already went out, or whose preview waits for the owner, costs no
   * model call. A throw from the assembler is for the cron entry to report.
   */
  async function runChannelIssue(now = Date.now()): Promise<void> {
    const slot = issueSlot(now);
    if (store.channelQueue.lastSlot() === slot.key) {
      console.log(`[digest-issue] ${slot.key} already went out, skipping`);
      return;
    }
    if (pending?.slot.key === slot.key) {
      console.log(`[digest-issue] ${slot.key} preview is waiting for the owner, skipping`);
      return;
    }
    const { assembled, picked, written } = await assemble(slot, now);
    if (!assembled) {
      if (picked === 0) {
        recordIssue(slot.key, { ok: true, outcome: "очередь пуста" });
        return;
      }
      recordIssue(slot.key, { ok: true, outcome: `мало новостей: ${written} из ${picked}` });
      await notify(
        `⚠️ Выпуск «${slot.title}» не собран: готово ${written} из ${picked}, нужно не меньше 3. Новости остались в очереди.`,
      );
      return;
    }
    const flags = await fetchAutoPublishFlags();
    if (flags.channels) {
      recordIssue(slot.key, await publishIssue(store, assembled, notify));
      return;
    }
    await sendPreview(assembled);
  }

  function isChannelDigestCallback(data: string): boolean {
    return data.startsWith(PUBLISH) || data.startsWith(SKIP);
  }

  async function onChannelDigestCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const publish = data.startsWith(PUBLISH);
    const slotKey = data.slice((publish ? PUBLISH : SKIP).length);
    // Taken before any await: a double tap finds nothing pending and cannot publish twice.
    const draft = pending?.slot.key === slotKey ? pending : null;
    if (draft) pending = null;
    await ctx.editMessageReplyMarkup().catch(logEditError("channel-digest markup"));
    if (!draft) {
      await ackSilently(ctx, { text: "Этот выпуск уже неактуален." });
      return;
    }
    if (!publish) {
      await ackSilently(ctx, { text: "Пропущено." });
      recordIssue(slotKey, { ok: true, outcome: "пропущен владельцем" });
      await ctx
        .editMessageText(`❌ Выпуск «${draft.slot.title}» пропущен, новости остались в очереди.`)
        .catch(logEditError("channel-digest skip text"));
      return;
    }
    if (isPastSlot(slotKey, Date.now())) {
      await ackSilently(ctx, { text: "Превью устарело." });
      recordIssue(slotKey, { ok: true, outcome: "превью устарело" });
      await ctx
        .editMessageText(
          `⚠️ Превью «${draft.slot.title}» устарело: начался следующий выпуск. Новости остались в очереди, их заберёт следующий выпуск.`,
        )
        .catch(logEditError("channel-digest stale text"));
      return;
    }
    await ackSilently(ctx, { text: "Публикую…" });
    const result = await publishIssue(store, draft, notify);
    recordIssue(slotKey, result);
    await ctx
      .editMessageText(`${result.ok ? "✅" : "⚠️"} Выпуск «${draft.slot.title}»: ${result.outcome}`)
      .catch(logEditError("channel-digest publish text"));
  }

  return { runChannelIssue, onChannelDigestCallback, isChannelDigestCallback };
}
