import { filterRelevant } from "../llm/index.js";
import { resolveChannels, fetchChannelPages } from "../feeds/index.js";
import {
  viewScore,
  eligiblePosts,
  channelDedupKey,
  toChannelFeedItem,
} from "./selectChannelPost.js";

import type { ChannelPage } from "../feeds/index.js";
import type { ChannelWatchSummary } from "./types.js";
import type { CandidateStore } from "../store/index.js";

let last: { at: number; summary: ChannelWatchSummary | null; error: string | null } | null = null;

/** The latest sweep outcome, for the /health «Каналы» row. */
export function lastChannelWatch() {
  return last;
}

/**
 * One hourly sweep. Reads the channel pages, refreshes the view score of
 * posts already waiting in the digest queue, and queues every fresh original
 * post the relevance filter keeps. Nothing is published here: the issue
 * (CHANNEL_DIGEST_CRON) does that. Posts the filter drops are remembered as
 * seen, so the 24-hour window does not ask the model about them every hour.
 * Throws when no page could be read at all, so the caller can ping the owner once.
 */
export async function runChannelWatch(
  store: CandidateStore,
  deps: { now?: number; fetchPages?: typeof fetchChannelPages } = {},
): Promise<ChannelWatchSummary> {
  const now = deps.now ?? Date.now();
  const summary: ChannelWatchSummary = {
    pages: 0,
    failed: [],
    eligible: 0,
    kept: 0,
    queued: 0,
    refreshed: 0,
  };
  try {
    await sweep(store, now, deps.fetchPages ?? fetchChannelPages, summary);
    last = { at: now, summary, error: null };
    return summary;
  } catch (err) {
    last = { at: now, summary, error: err instanceof Error ? err.message : String(err) };
    throw err;
  } finally {
    console.log(
      `[channels] pages=${summary.pages} failed=${summary.failed.length} eligible=${summary.eligible} ` +
        `kept=${summary.kept} queued=${summary.queued} refreshed=${summary.refreshed}`,
    );
  }
}

/** Views keep growing for hours: the issue ranks on the latest count, not the first. */
function refreshQueued(store: CandidateStore, pages: ChannelPage[]): number {
  return pages.reduce(
    (sum, page) =>
      sum +
      page.posts.filter((post) =>
        store.channelQueue.refreshScore(channelDedupKey(post), viewScore(page, post)),
      ).length,
    0,
  );
}

/** The sweep body; fills `summary` as it goes so a throw still reports how far it got. */
async function sweep(
  store: CandidateStore,
  now: number,
  fetchPages: typeof fetchChannelPages,
  summary: ChannelWatchSummary,
): Promise<void> {
  const { pages, failed } = await fetchPages(resolveChannels());
  summary.pages = pages.length;
  summary.failed = failed;
  if (pages.length === 0) throw new Error(`не прочитался ни один канал (${failed.join(", ")})`);
  summary.refreshed = refreshQueued(store, pages);

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
  store.markSeenKeys(eligible.map(channelDedupKey).filter((key) => !keptKeys.has(key)));
  for (const page of pages) {
    for (const post of page.posts) {
      if (!keptKeys.has(channelDedupKey(post))) continue;
      const id = store.channelQueue.add(toChannelFeedItem(post), viewScore(page, post));
      if (id !== null) summary.queued += 1;
    }
  }
}
