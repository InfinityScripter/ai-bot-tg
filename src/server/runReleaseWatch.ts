import { CONFIG } from "../config.js";
import { CandidateKind } from "../enums.js";
import { isReleaseItem, confirmRelease } from "../llm/index.js";
import { fetchAllFeeds, parseKeywords, curateForQueue } from "../feeds/index.js";

import type { CandidateStore } from "../store/index.js";
import type { ProcessCandidate, ReleaseWatchSummary } from "./types.js";

/**
 * Only items published within this window are considered. The feeds carry
 * ~2000 items and most stay unseen forever (the daily run takes the newest 15),
 * so without a window the markers would match hundreds of old items per sweep.
 * Items without a publish date are left to the daily run.
 */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Max model confirmations per sweep: bounds spend if the markers go noisy. On
 * 2026-09-30 the markers hit 67 fresh items, nearly all arXiv papers; a budget
 * of 10 would have left a real launch waiting behind them for several sweeps.
 * Rejections are remembered, so after the first sweep only new items are asked.
 */
const CONFIRM_BUDGET = 30;

/**
 * Consecutive "could not tell" answers after which the sweep stops and fails.
 * A dead key or a hung provider answers null every time: without the cut a
 * sweep would spend up to 30 × (timeout + retry) ≈ 30 minutes and still report
 * success, so the owner would never learn the watch has gone blind.
 */
const MAX_UNKNOWN_STREAK = 3;

/**
 * One release-watch sweep between daily runs: fetch the feeds, pick fresh
 * unseen items that hit the release markers, ask the model to confirm, and send
 * each confirmed release through processCandidate (the same flag-gated path the
 * daily run uses: autoPublishReleases on → post + changelog card + channel,
 * off → RAW card to the owner).
 *
 * Only confirmed releases are inserted. Everything else stays unseen, so the
 * daily run still collects it as news for the digest. `rejected` remembers the
 * items the model said "no" to for the process lifetime: a sweep every 30
 * minutes would otherwise re-ask about the same fresh items all day. A check
 * that failed (null) is not remembered, so the next sweep asks again. A sweep
 * where every check failed, or MAX_UNKNOWN_STREAK failed in a row, throws after
 * processing what it confirmed, so the caller can tell the owner. `stopping`
 * ends the loop early on shutdown.
 */
export async function runReleaseWatch(
  store: CandidateStore,
  processCandidate: ProcessCandidate,
  rejected: Set<string>,
  now: number = Date.now(),
  stopping: () => boolean = () => false,
): Promise<ReleaseWatchSummary> {
  const items = await fetchAllFeeds();
  const include = parseKeywords(CONFIG.FILTER_INCLUDE);
  const exclude = parseKeywords(CONFIG.FILTER_EXCLUDE);
  const suspects = curateForQueue(items, include, exclude)
    .filter(
      (item) =>
        item.publishedAt !== null &&
        now - item.publishedAt <= FRESH_WINDOW_MS &&
        !rejected.has(item.dedupKey) &&
        !store.isSeen(item.dedupKey) &&
        isReleaseItem(item),
    )
    .slice(0, CONFIRM_BUDGET);

  const summary: ReleaseWatchSummary = {
    fetched: items.length,
    checked: 0,
    unknown: 0,
    releases: 0,
    failed: 0,
  };
  let unknownStreak = 0;
  for (const item of suspects) {
    if (stopping() || unknownStreak >= MAX_UNKNOWN_STREAK) break;
    const verdict = await confirmRelease(item, store);
    summary.checked += 1;
    if (verdict === null) {
      summary.unknown += 1;
      unknownStreak += 1;
      continue;
    }
    unknownStreak = 0;
    if (verdict === false) {
      rejected.add(item.dedupKey);
      continue;
    }
    const id = store.insertCollected({ ...item, kind: CandidateKind.Release }, true);
    const candidate = id === null ? null : store.get(id);
    if (!candidate) continue;
    summary.releases += 1;
    try {
      await processCandidate(candidate);
    } catch (err) {
      summary.failed += 1;
      console.warn(`[release-watch] failed to process #${candidate.id}: ${String(err)}`);
    }
  }

  console.log(
    `[release-watch] done: fetched=${summary.fetched} checked=${summary.checked} ` +
      `unknown=${summary.unknown} releases=${summary.releases} failed=${summary.failed}`,
  );
  if (
    summary.unknown > 0 &&
    (summary.unknown === summary.checked || unknownStreak >= MAX_UNKNOWN_STREAK)
  ) {
    throw new Error(
      `модель не ответила на ${summary.unknown} из ${summary.checked} проверок релиза`,
    );
  }
  return summary;
}
