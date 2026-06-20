import { CONFIG } from './config.js';
import { curateForQueue, parseKeywords } from './curate.js';
import { fetchAllFeeds } from './feeds.js';
import type { CandidateStore } from './store.js';
import type { Candidate } from './types.js';

/** Summary of one collection run, returned for logging/visibility. */
export interface RunSummary {
  fetched: number;
  /** Items remaining after the keyword filter (before dedup/cap). */
  afterFilter: number;
  fresh: number;
  /** Raw cards successfully DM'd to the owner. */
  sent: number;
  /** Cards that failed to DM. */
  failed: number;
  /** True if a keyword filter (include/exclude) was active this run. */
  filterActive: boolean;
}

/** Sends the owner a "raw" review card for a freshly-collected candidate. */
type SendRawCard = (candidate: Candidate) => Promise<void>;

// The bot installs @grammyjs/auto-retry, which waits out any 429 retry_after
// and resubmits — grammY's recommended approach over proactive throttling. So
// the default send spacing is 0; a caller can still pass a delay if desired.
const SEND_SPACING_MS = 0;

/**
 * Runs one collection cycle: fetch feeds → dedup-insert the RAW item → DM the
 * owner a raw card. The LLM rewrite no longer happens here — it runs later, on
 * the owner's "🔄 Переработать" tap, with the model active at that moment (see
 * the bot's rewrite handler). Caps new candidates per run (MAX_PER_RUN).
 *
 * Both the daily cron and the /fetch command call this.
 */
export async function runCollection(
  store: CandidateStore,
  sendRawCard: SendRawCard,
  spacingMs: number = SEND_SPACING_MS
): Promise<RunSummary> {
  const items = await fetchAllFeeds();
  const include = parseKeywords(CONFIG.FILTER_INCLUDE);
  const exclude = parseKeywords(CONFIG.FILTER_EXCLUDE);
  const filterActive = include.length > 0 || exclude.length > 0;
  const summary: RunSummary = {
    fetched: items.length,
    afterFilter: 0,
    fresh: 0,
    sent: 0,
    failed: 0,
    filterActive,
  };

  // Filter by optional keywords, then order newest-first, so the MAX_PER_RUN cap
  // keeps the freshest relevant items instead of feed-concatenation order.
  const curated = curateForQueue(items, include, exclude);
  summary.afterFilter = curated.length;

  // Insert fresh (deduped) items, capped per run. The full raw item (snippet,
  // imageUrls) is persisted so the deferred rewrite can run from the row alone.
  const fresh: number[] = [];
  for (const item of curated) {
    if (fresh.length >= CONFIG.MAX_PER_RUN) break;
    const id = store.insertCollected(item);
    if (id !== null) fresh.push(id);
  }
  summary.fresh = fresh.length;

  for (let i = 0; i < fresh.length; i += 1) {
    const id = fresh[i]!;
    const candidate = store.get(id);
    if (!candidate) continue;
    try {
      await sendRawCard(candidate);
      summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`[collector] failed to DM raw card for #${id}: ${String(err)}`);
    }
    // Telegram allows ~1 msg/sec to one chat; space the burst so a full
    // MAX_PER_RUN batch doesn't trip 429. No delay after the last one.
    if (spacingMs > 0 && i < fresh.length - 1) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[collector] run done: fetched=${summary.fetched} afterFilter=${summary.afterFilter} ` +
      `fresh=${summary.fresh} sent=${summary.sent} failed=${summary.failed}`
  );
  return summary;
}
