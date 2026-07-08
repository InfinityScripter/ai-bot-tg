import { CONFIG } from "../config.js";

import type { RecentPost, PostListPage } from "./types.js";

/** Page size for the paginated crawl; the backend accepts this per page. */
const PAGE_SIZE = 50;
/** Hard stop so a backend paging bug can't loop forever. 100 pages × 50 = 5000. */
const MAX_PAGES = 100;

/**
 * Fetches one page of the list endpoint, then recurses into the next while the
 * backend still reports `hasMore` (and the page cap isn't hit). Recursion
 * replaces a for/while loop, which the es5/Airbnb config bans. Accumulates into
 * `acc` and returns the full flat list.
 */
async function crawl(base: string, page: number, acc: RecentPost[]): Promise<RecentPost[]> {
  if (page > MAX_PAGES) return acc;
  const url = `${base}/api/post/list?page=${page}&limit=${PAGE_SIZE}`;
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) {
    throw new Error(`Blog list responded ${res.status} on page ${page}`);
  }
  const data = (await res.json()) as Partial<PostListPage>;
  const next = acc.concat(data.posts ?? []);
  return data.hasMore ? crawl(base, page + 1, next) : next;
}

/**
 * Fetches EVERY blog post by walking the paginated list endpoint until
 * `hasMore` is false, returned oldest-first (ascending createdAt) so a channel
 * backfill posts in chronological order.
 *
 * Only published posts are returned (drafts skipped) — the backfill must not
 * announce something that isn't publicly live. A non-2xx page throws so the CLI
 * aborts loudly rather than backfilling a partial set.
 */
export async function fetchAllPosts(): Promise<RecentPost[]> {
  const base = CONFIG.BLOG_API_URL.replace(/\/$/, "");
  const all = await crawl(base, 1, []);
  const published = all.filter((p) => (p.publish ?? "published") === "published");
  return published.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}
