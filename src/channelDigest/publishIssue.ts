import { CONFIG } from "../config.js";
import { newsCount } from "./issueSlot.js";
import { CandidateState } from "../enums.js";
import { PublishError } from "../blog/index.js";
import { deliverArticle } from "./sendArticle.js";

import type { CandidateStore } from "../store/index.js";
import type { IssueOutcome, AssembledIssue } from "./types.js";

/**
 * Sends an assembled issue to the channel. The slot guard comes first (an
 * issue goes out once per slot, whoever asks), then the atomic claim of its
 * posts right before the send, then the send. A rejected rich message has
 * already gone out as text inside deliverArticle. Afterwards, by failure class:
 *  - network or 5xx: it MAY be in the channel. Posts → needs_verification,
 *    the slot is recorded (no resend), the owner checks the channel;
 *  - anything else (429, 403, a failed text fallback): not posted. Posts go
 *    back to the queue, the owner is told.
 * Once the send succeeded nothing below it may undo it: the slot is recorded
 * first and the bookkeeping is logged, not thrown.
 */
export async function publishIssue(
  store: CandidateStore,
  issue: AssembledIssue,
  notify: (text: string) => Promise<void>,
): Promise<IssueOutcome> {
  const { slot, article } = issue;
  const tell = (text: string) =>
    notify(text).catch((err) => console.warn(`[digest-issue] owner note failed: ${String(err)}`));
  if (store.channelQueue.lastSlot() === slot.key) return { ok: true, outcome: "уже выходил" };
  const chatId = CONFIG.TELEGRAM_CHANNEL_ID;
  if (!chatId) {
    await tell(`⚠️ Выпуск «${slot.title}» не отправлен: TELEGRAM_CHANNEL_ID не задан.`);
    return { ok: false, outcome: "TELEGRAM_CHANNEL_ID не задан" };
  }
  const ids = article.items.map((item) => item.candidateId);
  if (store.channelQueue.claim(ids) !== ids.length) {
    await tell(`⚠️ Очередь выпуска «${slot.title}» изменилась до отправки, выпуск не отправлен.`);
    return { ok: false, outcome: "очередь изменилась до отправки" };
  }
  let sent: { messageId: number; rejected: string | null };
  try {
    sent = await deliverArticle(chatId, article, issue.fallbackText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PublishError && err.maybePosted) {
      store.channelQueue.setLastSlot(slot.key);
      try {
        for (const id of ids) store.setState(id, CandidateState.NeedsVerification, message);
      } catch (stateErr) {
        console.error(
          `[digest-issue] ${slot.key} may be in the channel, parking the posts failed: ${String(stateErr)}`,
        );
      }
      await tell(
        `❓ Выпуск «${slot.title}» не подтверждён: ${message}\n\nОн МОГ выйти. Проверьте канал: повторно бот его не отправит.`,
      );
      return { ok: false, outcome: "не подтверждён, проверьте канал" };
    }
    store.channelQueue.requeue(ids);
    await tell(`⚠️ Выпуск «${slot.title}» не отправлен: ${message}\nНовости остались в очереди.`);
    return { ok: false, outcome: `не отправлен: ${message}` };
  }
  store.channelQueue.setLastSlot(slot.key);
  try {
    for (const id of ids) store.setPublished(id, `tg:${sent.messageId}`);
  } catch (err) {
    console.error(
      `[digest-issue] ${slot.key} is in the channel, marking the posts published failed: ${String(err)}`,
    );
  }
  try {
    store.markSeenKeys(article.items.flatMap((item) => item.linkKeys));
  } catch (err) {
    console.error(
      `[digest-issue] ${slot.key} is in the channel, marking the link keys seen failed: ${String(err)}`,
    );
  }
  if (!sent.rejected) return { ok: true, outcome: `опубликован (${newsCount(ids.length)})` };
  await tell(
    `⚠️ Telegram отклонил статью «${slot.title}» (${sent.rejected}). Выпуск ушёл текстом без фото.`,
  );
  return { ok: true, outcome: `опубликован текстом: ${sent.rejected}` };
}
