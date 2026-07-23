import type { Bot, InlineKeyboard } from "grammy";

import { CONFIG } from "../config.js";
import { logEditError } from "./edit.js";
import { CandidateState } from "../enums.js";
import { crossPostToChannel } from "../blog/index.js";
import { rawKeyboard, previewKeyboard } from "./keyboards.js";
import { processClaimedCandidateAutomatically } from "./candidateActions.js";

import type { Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

const NOTIFY_TIMEOUT_MS = 5_000;
type TelegramAbortSignal = NonNullable<Parameters<Bot["api"]["sendMessage"]>[3]>;

/** Automatic daily-batch publishing with Telegram progress/error cards. */
export function createAutoPublish(store: CandidateStore, bot: Bot) {
  const activeJobs = new Set<Promise<void>>();

  function notificationSignal(): TelegramAbortSignal {
    return AbortSignal.timeout(NOTIFY_TIMEOUT_MS) as unknown as TelegramAbortSignal;
  }

  async function sendProgress(candidate: Candidate): Promise<void> {
    try {
      const message = await bot.api.sendMessage(
        CONFIG.OWNER_TELEGRAM_ID,
        `⏳ Автопубликация: ${candidate.sourceTitle ?? candidate.sourceUrl}`,
        {},
        notificationSignal(),
      );
      store.setTelegramMessage(candidate.id, message.message_id);
    } catch (err) {
      logEditError("auto-publish progress card")(err);
    }
  }

  async function editCard(
    candidate: Candidate,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    const current = store.get(candidate.id) ?? candidate;
    if (current.tgMessageId) {
      try {
        await bot.api.editMessageText(
          CONFIG.OWNER_TELEGRAM_ID,
          current.tgMessageId,
          text,
          keyboard ? { reply_markup: keyboard } : undefined,
          notificationSignal(),
        );
        if (!keyboard) {
          await bot.api
            .editMessageReplyMarkup(
              CONFIG.OWNER_TELEGRAM_ID,
              current.tgMessageId,
              undefined,
              notificationSignal(),
            )
            .catch(logEditError("auto-publish clear markup"));
        }
        return;
      } catch (err) {
        logEditError("auto-publish edit card")(err);
      }
    }
    try {
      const message = await bot.api.sendMessage(
        CONFIG.OWNER_TELEGRAM_ID,
        text,
        keyboard ? { reply_markup: keyboard } : {},
        notificationSignal(),
      );
      store.setTelegramMessage(candidate.id, message.message_id);
    } catch (err) {
      logEditError("auto-publish send card")(err);
    }
  }

  async function showFailure(candidate: Candidate, err: unknown): Promise<void> {
    const current = store.get(candidate.id) ?? candidate;
    const message = err instanceof Error ? err.message : String(err);
    if (current.state === CandidateState.NeedsVerification) {
      await editCard(
        current,
        `❓ Автопубликация не подтверждена: ${message}\n\nПост мог появиться — проверьте блог перед повтором.`,
        previewKeyboard(current.id),
      );
      return;
    }
    const keyboard =
      current.state === CandidateState.PendingReview
        ? previewKeyboard(current.id)
        : rawKeyboard(current.id);
    await editCard(current, `⚠️ Автопубликация не удалась: ${message}`, keyboard);
  }

  async function runAutomaticPublish(candidate: Candidate): Promise<void> {
    if (!store.claimForRewriting(candidate.id)) throw new Error("Кандидат уже обрабатывается.");
    const progress = sendProgress(candidate);
    try {
      const { extracted, postId } = await processClaimedCandidateAutomatically(store, candidate);
      await progress;
      await editCard(candidate, `✅ Автоопубликовано: ${extracted.title}`);
      try {
        await crossPostToChannel(bot.api, extracted.crossPost, postId, notificationSignal());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await bot.api
          .sendMessage(
            CONFIG.OWNER_TELEGRAM_ID,
            `⚠️ Пост опубликован, но не запостился в канал: ${message}`,
            {},
            notificationSignal(),
          )
          .catch(logEditError("auto-publish cross-post warning"));
      }
    } catch (err) {
      await progress;
      await showFailure(candidate, err);
      throw err;
    }
  }

  function autoPublishCandidate(candidate: Candidate): Promise<void> {
    const job = runAutomaticPublish(candidate);
    activeJobs.add(job);
    void job.then(
      () => activeJobs.delete(job),
      () => activeJobs.delete(job),
    );
    return job;
  }

  async function drain(): Promise<void> {
    while (activeJobs.size > 0) {
      await Promise.allSettled([...activeJobs]);
    }
  }

  async function notifyAutomaticFailures(): Promise<void> {
    await Promise.allSettled(
      store
        .listAutomaticFailures()
        .map((candidate) =>
          showFailure(candidate, candidate.error ?? "Требуется ручное продолжение."),
        ),
    );
  }

  return { autoPublishCandidate, notifyAutomaticFailures, drain };
}
