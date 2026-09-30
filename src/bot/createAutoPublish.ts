import type { Bot, InlineKeyboard } from "grammy";

import { CONFIG } from "../config.js";
import { logEditError } from "./edit.js";
import { CandidateState } from "../enums.js";
import { crossPostToChannel } from "../blog/index.js";
import { rawKeyboard, previewKeyboard } from "./keyboards.js";
import { DuplicateReleaseError } from "./duplicateRelease.js";
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

  /** Shows the card; true once Telegram holds it (edited in place or sent). */
  async function editCard(
    candidate: Candidate,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<boolean> {
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
        return true;
      } catch (err) {
        // The card already shows this exact text: it is delivered. Sending a
        // new message here is what flooded the chat on every restart.
        if (String(err).includes("message is not modified")) return true;
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
      return true;
    } catch (err) {
      logEditError("auto-publish send card")(err);
      return false;
    }
  }

  async function showFailure(candidate: Candidate, err: unknown): Promise<boolean> {
    const current = store.get(candidate.id) ?? candidate;
    const message = err instanceof Error ? err.message : String(err);
    if (current.state === CandidateState.NeedsVerification) {
      return editCard(
        current,
        `❓ Автопубликация не подтверждена: ${message}\n\nПост мог появиться — проверьте блог перед повтором.`,
        previewKeyboard(current.id),
      );
    }
    const keyboard =
      current.state === CandidateState.PendingReview
        ? previewKeyboard(current.id)
        : rawKeyboard(current.id);
    return editCard(current, `⚠️ Автопубликация не удалась: ${message}`, keyboard);
  }

  async function runAutomaticPublish(candidate: Candidate): Promise<void> {
    if (!store.claimForRewriting(candidate.id)) throw new Error("Кандидат уже обрабатывается.");
    const progress = sendProgress(candidate);
    try {
      const { extracted, postId, warning } = await processClaimedCandidateAutomatically(
        store,
        candidate,
      );
      await progress;
      const note = warning ? `\n⚠️ ${warning}` : "";
      await editCard(candidate, `✅ Автоопубликовано: ${extracted.title}${note}`);
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
      if (err instanceof DuplicateReleaseError) {
        // Not a failure: the model is already covered, and the article is still
        // worth a digest line. The run counts it as handled.
        const digest = CONFIG.DIGEST_POSTS === "on";
        store.divertReleaseToNews(
          candidate.id,
          digest ? CandidateState.DigestQueued : CandidateState.Skipped,
        );
        await editCard(
          candidate,
          `↪️ ${err.message} уже опубликован, повтор не выпускаю: ${candidate.sourceTitle ?? candidate.sourceUrl}${
            digest ? "\nСтатья ушла в дневной дайджест." : ""
          }`,
        );
        return;
      }
      // Owed until Telegram takes it: a crash or a failed send here leaves the
      // flag set, and notifyAutomaticFailures delivers the card on next boot.
      store.setFailureNoticePending(candidate.id, true);
      if (await showFailure(candidate, err)) store.setFailureNoticePending(candidate.id, false);
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

  /**
   * Boot-time replay of failure cards that never reached the owner. One at a
   * time: a parallel burst trips Telegram's rate limit, and the 5 s
   * notification timeout then aborts the requests auto-retry would have waited
   * out. A card that fails again stays owed for the next boot.
   */
  async function notifyAutomaticFailures(): Promise<void> {
    for (const candidate of store.listAutomaticFailures()) {
      const delivered = await showFailure(
        candidate,
        candidate.error ?? "Требуется ручное продолжение.",
      );
      if (delivered) store.setFailureNoticePending(candidate.id, false);
    }
  }

  return { autoPublishCandidate, notifyAutomaticFailures, drain };
}
