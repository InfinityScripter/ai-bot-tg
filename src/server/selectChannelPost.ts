import { truncate } from "../utils.js";
import { CandidateKind } from "../enums.js";

import type { FeedItem } from "../types.js";
import type { ChannelPage, ChannelPost } from "../feeds/index.js";

const HOUR_MS = 3_600_000;
/** Views keep growing for days; two hours lets the first wave settle before scoring. */
const MIN_AGE_MS = 2 * HOUR_MS;
const MAX_AGE_MS = 8 * HOUR_MS;
const MIN_TEXT = 200;
/** Russian ad-law markers: a paid post is not something to retell. */
const AD_RE = /#реклама|\berid\b/i;

export interface EligibilityOptions {
  now: number;
  isSeen: (key: string) => boolean;
  /** True when the bot already published an item from this article URL. */
  isPublishedUrl: (url: string) => boolean;
}

export function channelDedupKey(post: ChannelPost): string {
  return `tg:${post.channel.toLowerCase()}/${post.id}`;
}

/** Posts that may be retold at all, before the relevance filter. */
export function eligiblePosts(pages: ChannelPage[], opts: EligibilityOptions): ChannelPost[] {
  return pages.flatMap((page) =>
    page.posts.filter((post) => {
      if (post.forwarded || post.publishedAt === null) return false;
      const age = opts.now - post.publishedAt;
      return (
        age >= MIN_AGE_MS &&
        age <= MAX_AGE_MS &&
        post.text.length >= MIN_TEXT &&
        !AD_RE.test(post.text) &&
        !opts.isSeen(channelDedupKey(post)) &&
        !post.links.some((url) => opts.isPublishedUrl(url))
      );
    }),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Priority channels first; within the chosen group the post with the highest
 * views ÷ median views of its own channel page wins, so a small channel's hit
 * beats a big channel's routine post.
 */
export function pickChannelPost(
  pages: ChannelPage[],
  candidates: ChannelPost[],
): ChannelPost | null {
  const byName = new Map(pages.map((page) => [page.channel.name.toLowerCase(), page]));
  const pageOf = (post: ChannelPost) => byName.get(post.channel.toLowerCase());
  const priority = candidates.filter((post) => pageOf(post)?.channel.priority);
  const pool = priority.length > 0 ? priority : candidates;
  const score = (post: ChannelPost): number => {
    const views = (pageOf(post)?.posts ?? [])
      .map((x) => x.views)
      .filter((v): v is number => v !== null);
    const base = views.length > 0 ? median(views) : 0;
    return base > 0 && post.views !== null ? post.views / base : 0;
  };
  return pool.reduce<ChannelPost | null>(
    (best, post) => (best && score(best) >= score(post) ? best : post),
    null,
  );
}

/** The candidate row for a post: the text is both the title line and the rewrite input. */
export function toChannelFeedItem(post: ChannelPost): FeedItem {
  return {
    dedupKey: channelDedupKey(post),
    url: post.url,
    title: truncate((post.text.split("\n")[0] ?? "").trim(), 200),
    snippet: post.text,
    feedTitle: `@${post.channel}`,
    imageUrl: post.imageUrl,
    imageUrls: post.imageUrl ? [post.imageUrl] : [],
    publishedAt: post.publishedAt,
    kind: CandidateKind.Channel,
  };
}
