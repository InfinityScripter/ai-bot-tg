import { readWhenReset } from "../whenreset/readWhenReset.js";

import type { Candidate } from "../types.js";
import type { ProcessCandidate } from "./types.js";
import type { CandidateStore } from "../store/index.js";
import type { WhenResetSummary } from "../whenreset/types.js";

const BASELINE_KEY = "whenreset:baseline:v1";

/** Same automatic path as RSS, but all new resets are urgent, not daily digest. */
export async function runWhenResetWatch(
  store: CandidateStore,
  processCandidate: ProcessCandidate,
  stopping: () => boolean = () => false,
): Promise<WhenResetSummary> {
  const summary: WhenResetSummary = {
    fetched: 0,
    baselined: false,
    fresh: 0,
    recovered: 0,
    failed: 0,
  };

  const process = async (candidate: Candidate): Promise<void> => {
    try {
      await processCandidate(candidate);
    } catch {
      summary.failed += 1;
      // Existing lifecycle owns failure cards/retry safety; never log raw URLs.
      console.warn(`[whenreset] candidate processing failed: #${candidate.id}`);
    }
  };
  // Recover saved work before GET: an API outage must not starve it. Initial
  // sync still only records history and cannot publish any pre-baseline rows.
  if (store.getRawSetting(BASELINE_KEY)) {
    // Recovered collected rows only. needs_verification must never auto-retry.
    for (const candidate of store.listRecoveredAutomatic()) {
      if (stopping()) break;
      if (!candidate.dedupKey.startsWith("whenreset:")) continue;
      summary.recovered += 1;
      await process(candidate);
    }
  }
  const items = await readWhenReset();
  summary.fetched = items.length;
  if (!store.getRawSetting(BASELINE_KEY)) {
    // Seen keys first, marker last: a crash between them can only repeat a safe
    // baseline, never flood the owner with a half-baselined historical archive.
    store.markSeenKeys(items.map((item) => item.dedupKey));
    store.setRawSetting(BASELINE_KEY, "1");
    summary.baselined = true;
    console.log(`[whenreset] baseline recorded: ${items.length} historical events`);
    return summary;
  }

  // Reader sorted chronology; no MAX_PER_RUN cap that could lose a burst.
  for (const item of items) {
    if (stopping()) break;
    const id = store.insertCollected(item, true);
    const candidate = id === null ? null : store.get(id);
    if (!candidate) continue;
    summary.fresh += 1;
    await process(candidate);
  }
  console.log(`[whenreset] sweep ${JSON.stringify(summary)}`);
  return summary;
}
