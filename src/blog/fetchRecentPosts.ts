import { CONFIG } from "../config.js";

import type { RecentPost } from "./types.js";

/**
 * Fetches the blog's recent posts and returns only those created within the
 * last `days` (default 7), for the weekly digest. Reads `.posts` from the list
 * response: `/api/post/list?limit=50` returns the paginated newest-first shape
 * `{ posts, total, hasMore }`, and the bare list path returns `{ posts }` — both
 * carry the array under `.posts`, so we read it uniformly (missing → []).
 *
 * A non-2xx response throws so the caller (the /digest flow) can surface the
 * failure in the owner DM instead of silently building an empty digest.
 */
export async function fetchRecentPosts(days = 7): Promise<RecentPost[]> {
  const base = CONFIG.BLOG_API_URL.replace(/\/$/, "");
  const url = `${base}/api/post/list?limit=50`;

  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) {
    throw new Error(`Blog list responded ${res.status}`);
  }

  const data = (await res.json()) as { posts?: RecentPost[] };
  const cutoff = Date.now() - days * 86_400_000;
  return (data.posts ?? []).filter((post) => {
    const created = new Date(post.createdAt).getTime();
    // Drop rows with an unparseable createdAt (NaN) rather than keep them — a
    // digest of posts with unknown dates is worse than skipping them.
    return Number.isFinite(created) && created >= cutoff;
  });
}
