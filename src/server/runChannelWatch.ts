import { filterRelevant } from "../llm/index.js";
import { resolveChannels, fetchChannelPages } from "../feeds/index.js";
import {
  eligiblePosts,
  pickChannelPost,
  channelDedupKey,
  channelLinkKeys,
  toChannelFeedItem,
} from "./selectChannelPost.js";

import type { CandidateStore } from "../store/index.js";
import type { ProcessCandidate, ChannelWatchSummary } from "./types.js";

/** Retellings per rolling 24 hours (owner's choice, 2026-09-30). */
export const CHANNEL_DAILY_LIMIT = 6;

let last: { at: number; summary: ChannelWatchSummary | null; error: string | null } | null = null;

/** The latest sweep outcome, for the /health «Каналы» row. */
export function lastChannelWatch() {
  return last;
}

/**
 * One hourly sweep: read the channel pages, keep fresh original posts, run the
 * relevance filter, pick one (priority channels first) and hand it to
 * processCandidate — the same flag-gated path as releases (autoPublishChannels
 * on → post to the channel, off → owner card). Throws when no page could be
 * read at all, so the caller can ping the owner once.
 */
export async function runChannelWatch(
  store: CandidateStore,
  processCandidate: ProcessCandidate,
  deps: { now?: number; fetchPages?: typeof fetchChannelPages } = {},
): Promise<ChannelWatchSummary> {
  const now = deps.now ?? Date.now();
  const summary: ChannelWatchSummary = { pages: 0, failed: [], eligible: 0, kept: 0, picked: null };
  try {
    await sweep(store, processCandidate, now, deps.fetchPages ?? fetchChannelPages, summary);
    last = { at: now, summary, error: null };
    return summary;
  } catch (err) {
    last = { at: now, summary, error: err instanceof Error ? err.message : String(err) };
    throw err;
  } finally {
    console.log(
      `[channels] pages=${summary.pages} failed=${summary.failed.length} eligible=${summary.eligible} ` +
        `kept=${summary.kept} picked=${summary.picked ?? "-"}${summary.skipped ? ` skipped=${summary.skipped}` : ""}`,
    );
  }
}

/** The sweep body; fills `summary` as it goes so a throw still reports how far it got. */
async function sweep(
  store: CandidateStore,
  processCandidate: ProcessCandidate,
  now: number,
  fetchPages: typeof fetchChannelPages,
  summary: ChannelWatchSummary,
): Promise<void> {
  const { pages, failed } = await fetchPages(resolveChannels());
  summary.pages = pages.length;
  summary.failed = failed;
  if (pages.length === 0) throw new Error(`не прочитался ни один канал (${failed.join(", ")})`);

  const eligible = eligiblePosts(pages, {
    now,
    isSeen: (key) => store.isSeen(key),
    isSeenSince: (key, days) => store.isSeenSince(key, days),
    isPublishedUrl: (url) => store.isPublishedUrl(url),
  });
  summary.eligible = eligible.length;
  const { kept } = await filterRelevant(eligible.map(toChannelFeedItem), store);
  const keptKeys = new Set(kept.map((item) => item.dedupKey));
  summary.kept = keptKeys.size;
  const post = pickChannelPost(
    pages,
    eligible.filter((p) => keptKeys.has(channelDedupKey(p))),
  );
  if (!post) return;

  const id = store.insertCollected(toChannelFeedItem(post), true);
  const candidate = id === null ? null : store.get(id);
  if (!candidate) return;
  store.markSeenKeys(channelLinkKeys(post));
  summary.picked = candidate.dedupKey;
  // autoPublishCandidate rethrows after the owner card; one bad post is not a broken sweep.
  try {
    await processCandidate(candidate);
  } catch (err) {
    summary.processFailed = true;
    console.warn(`[channels] failed to process #${candidate.id}: ${String(err)}`);
  }
}
