import { hrefsOf } from "../feeds/index.js";
import { linkKeysOf } from "../server/selectChannelPost.js";

import type { Candidate } from "../types.js";
import type { QueuedPost } from "../store/index.js";
import type { SourceChannel } from "../feeds/index.js";

export const ISSUE_MAX_ITEMS = 7;
const PER_CHANNEL = 2;

const channelOf = (candidate: Candidate) =>
  (candidate.feedTitle ?? "").replace(/^@/, "").toLowerCase();

/** `link:` keys of a queued post's outbound links, read from its stored HTML. */
export function linkKeysOfCandidate(candidate: Candidate): string[] {
  return linkKeysOf(hrefsOf(candidate.sourceHtml ?? ""));
}

/**
 * The posts that go to the writer: priority channels first, then views ÷ the
 * channel's median (refreshed by every sweep), at most two per channel. A post
 * that shares an outbound non-t.me link with one already picked, or with a
 * story an earlier issue published (`isCovered`), stays queued: the new
 * sources often cover the same news the same day.
 */
export function pickIssueItems(
  queue: QueuedPost[],
  channels: SourceChannel[],
  isCovered: (linkKey: string) => boolean,
  max: number = ISSUE_MAX_ITEMS,
): QueuedPost[] {
  const priority = new Set(channels.filter((c) => c.priority).map((c) => c.name.toLowerCase()));
  const rank = (post: QueuedPost) => (priority.has(channelOf(post.candidate)) ? 1 : 0);
  const ordered = [...queue].sort(
    (a, b) => rank(b) - rank(a) || b.viewScore - a.viewScore || a.candidate.id - b.candidate.id,
  );
  const picked: QueuedPost[] = [];
  const perChannel = new Map<string, number>();
  const links = new Set<string>();
  for (const post of ordered) {
    if (picked.length >= max) break;
    const channel = channelOf(post.candidate);
    const keys = linkKeysOfCandidate(post.candidate);
    if ((perChannel.get(channel) ?? 0) >= PER_CHANNEL) continue;
    if (keys.some((key) => links.has(key) || isCovered(key))) continue;
    picked.push(post);
    perChannel.set(channel, (perChannel.get(channel) ?? 0) + 1);
    keys.forEach((key) => links.add(key));
  }
  return picked;
}
