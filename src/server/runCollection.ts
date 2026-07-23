import { CONFIG } from "../config.js";
import { emitRelevanceDecisions } from "../auditEmit.js";
import { CandidateKind, RelevanceMode } from "../enums.js";
import { fetchAllFeeds, parseKeywords, curateForQueue } from "../feeds/index.js";
import { filterRelevant, VENDOR_MARKERS, RELEASE_MARKERS } from "../llm/index.js";

import type { FeedItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";
import type { RunSummary, ProcessCandidate } from "./types.js";

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
 * Runs one collection cycle: fetch feeds → dedup-insert → invoke the configured
 * action for every fresh item. Production wires automatic rewrite + publish;
 * keeping that action injected leaves filtering/dedup independently testable.
 * Caps new candidates per run (MAX_PER_RUN).
 *
 * Both the daily cron and the /fetch command call this.
 */
export async function runCollection(
  store: CandidateStore,
  processCandidate: ProcessCandidate,
  spacingMs: number = SEND_SPACING_MS,
): Promise<RunSummary> {
  const summary: RunSummary = {
    fetched: 0,
    afterFilter: 0,
    afterDedup: 0,
    afterRelevance: 0,
    droppedRelevance: 0,
    fresh: 0,
    published: 0,
    failed: 0,
    filterActive: false,
  };

  // A crash during rewrite is recovered to `collected`. Resume only rows that
  // were explicitly created by an automatic batch; manual drafts share the
  // same state and must keep their approval flow.
  const recovered = store.listRecoveredAutomatic().slice(0, CONFIG.MAX_PER_RUN);
  for (const candidate of recovered) {
    try {
      await processCandidate(candidate);
      summary.published += 1;
    } catch (err) {
      summary.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`[collector] failed to resume #${candidate.id}: ${String(err)}`);
    }
  }

  const items = await fetchAllFeeds();
  const include = parseKeywords(CONFIG.FILTER_INCLUDE);
  const exclude = parseKeywords(CONFIG.FILTER_EXCLUDE);
  summary.fetched = items.length;
  summary.filterActive = include.length > 0 || exclude.length > 0;

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

  // Insert and process one item at a time. Persisting the whole batch first is
  // unsafe: a restart during candidate #1 would leave #2…N marked seen but never
  // processed. Decide kind BEFORE insert because news/release share one dedup key.
  const remaining = Math.max(0, CONFIG.MAX_PER_RUN - recovered.length);
  for (let i = 0; i < kept.length && summary.fresh < remaining; i += 1) {
    const item = kept[i]!;
    const kind = isReleaseItem(item) ? CandidateKind.Release : CandidateKind.News;
    const id = store.insertCollected({ ...item, kind }, true);
    if (id === null) continue;
    summary.fresh += 1;
    const candidate = store.get(id);
    if (!candidate) continue;
    try {
      await processCandidate(candidate);
      summary.published += 1;
    } catch (err) {
      summary.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`[collector] failed to process #${id}: ${String(err)}`);
    }
    // Telegram allows ~1 msg/sec to one chat; space the burst so a full
    // MAX_PER_RUN batch doesn't trip 429. No delay after the last one.
    if (spacingMs > 0 && i < kept.length - 1) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[collector] run done: fetched=${summary.fetched} afterFilter=${summary.afterFilter} ` +
      `afterDedup=${summary.afterDedup} afterRelevance=${summary.afterRelevance} ` +
      `droppedRelevance=${summary.droppedRelevance} ` +
      `fresh=${summary.fresh} published=${summary.published} failed=${summary.failed}`,
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
