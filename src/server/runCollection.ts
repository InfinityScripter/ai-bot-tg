import { CONFIG } from "../config.js";
import { emitRelevanceDecisions } from "../auditEmit.js";
import { CandidateKind, RelevanceMode } from "../enums.js";
import { fetchAllFeeds, parseKeywords, curateForQueue } from "../feeds/index.js";
import { filterRelevant, VENDOR_MARKERS, RELEASE_MARKERS } from "../llm/index.js";

import type { FeedItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";
import type { RunSummary, SendRawCard } from "./types.js";

/**
 * True when a feed item looks like an AI-model release announcement: a release
 * marker AND a vendor marker both hit its title+snippet. Precision-biased — a
 * bare "launch" (no vendor) or a vendor mention (no launch verb) stays 'news'.
 */
function isReleaseItem(item: FeedItem): boolean {
  const hay = `${item.title} ${item.snippet}`.toLowerCase();
  const hasRelease = RELEASE_MARKERS.some((m) => hay.includes(m));
  const hasVendor = VENDOR_MARKERS.some((m) => hay.includes(m));
  return hasRelease && hasVendor;
}

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
  spacingMs: number = SEND_SPACING_MS,
): Promise<RunSummary> {
  const items = await fetchAllFeeds();
  const include = parseKeywords(CONFIG.FILTER_INCLUDE);
  const exclude = parseKeywords(CONFIG.FILTER_EXCLUDE);
  const filterActive = include.length > 0 || exclude.length > 0;
  const summary: RunSummary = {
    fetched: items.length,
    afterFilter: 0,
    afterDedup: 0,
    afterRelevance: 0,
    droppedRelevance: 0,
    fresh: 0,
    sent: 0,
    failed: 0,
    filterActive,
  };

  // Filter by optional keywords, then order newest-first, so the MAX_PER_RUN cap
  // keeps the freshest relevant items instead of feed-concatenation order.
  const curated = curateForQueue(items, include, exclude);
  summary.afterFilter = curated.length;

  // Two guards keep the (LLM-backed) relevance filter cheap and non-stalling:
  //  (1) Dedup BEFORE classifying — an already-seen item is dropped at insert
  //      anyway, so scoring it is pure waste.
  //  (2) Cap how many items are classified per run — items are newest-first and
  //      we only need MAX_PER_RUN fresh cards, so scoring the whole (thousands-
  //      strong) feed backlog every run is pointless.
  // Without these, mode='on' fired HUNDREDS of SERIAL LLM calls per run (the
  // big AI feed set), which made /fetch crawl and could stall it outright when
  // the model was slow. insertCollected still dedups as a race backstop.
  const unseen = curated.filter((item) => !store.isSeen(item.dedupKey));
  summary.afterDedup = unseen.length;
  const classifyBudget = Math.max(CONFIG.MAX_PER_RUN * 4, 40);
  const toClassify = unseen.slice(0, classifyBudget);

  // Topic relevance filter (AI/tech) over the freshest slice. In off/shadow mode
  // kept === toClassify, so nothing is dropped until the owner flips
  // RELEVANCE_MODE=on. Older unseen items beyond the budget are reconsidered on
  // a later run (newest-first means fresh items always get priority).
  const { kept, decisions } = await filterRelevant(toClassify, store);
  summary.afterRelevance = kept.length;
  summary.droppedRelevance = toClassify.length - kept.length;

  // Insert fresh (deduped) items, capped per run. The full raw item (snippet,
  // imageUrls) is persisted so the deferred rewrite can run from the row alone.
  // Decide kind (news vs release) BEFORE insert: dedup is one table, so a URL
  // first seen as 'news' would block it ever being re-collected as a 'release'.
  const fresh: number[] = [];
  for (const item of kept) {
    if (fresh.length >= CONFIG.MAX_PER_RUN) break;
    const kind = isReleaseItem(item) ? CandidateKind.Release : CandidateKind.News;
    const id = store.insertCollected({ ...item, kind });
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
      `afterDedup=${summary.afterDedup} afterRelevance=${summary.afterRelevance} ` +
      `droppedRelevance=${summary.droppedRelevance} ` +
      `fresh=${summary.fresh} sent=${summary.sent} failed=${summary.failed}`,
  );

  // Mirror the relevance decisions into the backend audit log. Mode 'off'
  // produces no decisions; the mode here must match the one filterRelevant
  // resolved (both read CONFIG.RELEVANCE_MODE). Fire-and-forget and fail-silent:
  // emitRelevanceDecisions never throws, so a backend outage cannot break the run.
  const mode = CONFIG.RELEVANCE_MODE;
  if (CONFIG.RELEVANCE_AUDIT && mode !== RelevanceMode.Off && decisions.length > 0) {
    await emitRelevanceDecisions(decisions, mode);
  }

  return summary;
}
