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
/** Channels repeat links (self-promo, file names); an old link must not block a new post. */
const LINK_MEMORY_DAYS = 3;

export interface EligibilityOptions {
  now: number;
  isSeen: (key: string) => boolean;
  /** isSeen limited to keys recorded within the last `days` days. */
  isSeenSince: (key: string, days: number) => boolean;
  /** True when a published candidate's source_url is this URL (a blog-published article). */
  isPublishedUrl: (url: string) => boolean;
}

export function channelDedupKey(post: ChannelPost): string {
  return `tg:${post.channel.toLowerCase()}/${post.id}`;
}

/**
 * seen_keys entries for a post's outbound links: a retelling's source_url is its
 * t.me permalink, so the article it covers is only remembered through these.
 * t.me links are channel-internal and the post's own dedup key already covers it.
 * Host-only links are skipped: Telegram autolinks file names (`AGENTS.md`) and
 * channels end posts with their own site, so these say nothing about the story.
 */
export function channelLinkKeys(post: ChannelPost): string[] {
  return post.links
    .filter((url) => !/^https?:\/\/(www\.)?t\.me\//i.test(url) && hasPath(url))
    .map((url) => `link:${url.trim().replace(/\/+$/, "")}`);
}

function hasPath(url: string): boolean {
  try {
    return new URL(url).pathname.length > 1;
  } catch {
    return false;
  }
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
        !post.links.some((url) => opts.isPublishedUrl(url)) &&
        !channelLinkKeys(post).some((key) => opts.isSeenSince(key, LINK_MEMORY_DAYS))
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
