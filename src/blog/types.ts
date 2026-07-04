/**
 * Shared types of the blog module (the HTTP client side of the blog API).
 * Pure declarations only (mirrors health/types.ts). The POST bodies
 * (BlogPostBody, CreateReleasePayload) live in src/types.ts — they are frozen
 * cross-repo contracts, not blog-module internals.
 */

/**
 * A blog post as returned by the public /api/post/list endpoint. Only the
 * fields the digest needs are typed; the rest of the row (content, cover,
 * meta…) is ignored.
 */
export interface RecentPost {
  _id?: string;
  id?: string;
  title: string;
  description?: string;
  /** ISO creation time; used to filter to the last N days. */
  createdAt: string;
  tags?: string[];
}

/** The digest-send result read from the backend's ok() envelope. */
export interface DigestSendResult {
  sent: number;
  failed: number;
}
