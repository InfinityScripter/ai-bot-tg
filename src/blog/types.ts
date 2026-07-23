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
  /** Cover image URL, if the post has one; used by the channel backfill. */
  coverUrl?: string | null;
  /** ISO creation time; used to filter to the last N days. */
  createdAt: string;
  tags?: string[];
  /** Publish status ('published' | 'draft'); the backfill posts published only. */
  publish?: string;
}

/** The paginated list response shape from /api/post/list?page&limit. */
export interface PostListPage {
  posts: RecentPost[];
  total: number;
  hasMore: boolean;
}

/** The digest-send result read from the backend's ok() envelope. */
export interface DigestSendResult {
  sent: number;
  failed: number;
}

/**
 * The two auto-publish master switches, read from the blog admin settings. When
 * false, the matching candidate kind is diverted to the owner's manual approval
 * instead of auto-publishing. Read fail-closed: any read failure yields both
 * false (see fetchAutoPublishFlags).
 */
export interface AutoPublishFlags {
  releases: boolean;
  news: boolean;
}
