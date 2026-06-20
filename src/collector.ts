import { CONFIG } from './config.js';
import { fetchAllFeeds } from './feeds.js';
import type { CandidateStore } from './store.js';
import type { Candidate } from './types.js';

/** Summary of one collection run, returned for logging/visibility. */
export interface RunSummary {
  fetched: number;
  fresh: number;
  /** Raw cards successfully DM'd to the owner. */
  sent: number;
  /** Cards that failed to DM. */
  failed: number;
}

/** Sends the owner a "raw" review card for a freshly-collected candidate. */
type SendRawCard = (candidate: Candidate) => Promise<void>;

/** Delay between raw-card sends, to stay under Telegram's ~1 msg/sec per chat. */
const SEND_SPACING_MS = 1200;

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
  const summary: RunSummary = { fetched: items.length, fresh: 0, sent: 0, failed: 0 };

  // Insert fresh (deduped) items, capped per run. The full raw item (snippet,
  // imageUrls) is persisted so the deferred rewrite can run from the row alone.
  const fresh: number[] = [];
  for (const item of items) {
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
    `[collector] run done: fetched=${summary.fetched} fresh=${summary.fresh} ` +
      `sent=${summary.sent} failed=${summary.failed}`
  );
  return summary;
}
