import { PublishStatus, CandidateState } from "./enums.js";

// Re-exported so existing importers of these domain enums can keep importing
// them from "./types.js" alongside the interfaces that use them.
export { PublishStatus, CandidateState } from "./enums.js";

// The rewrite zod schema + its inferred type live in src/schemas/ (validation
// separated by entity). Re-exported here so "./types.js" stays the one type hub.
export { RewriteSchema } from "./schemas/rewrite-schema.js";
export type { RewriteResult } from "./schemas/rewrite-schema.js";

/** A normalized item pulled from an RSS/Atom feed. */
export interface FeedItem {
  /** Stable dedup key: lowercased, tracking-stripped guid|link. */
  dedupKey: string;
  /** The original article URL (best-effort). */
  url: string;
  title: string;
  /** HTML-stripped snippet or content, used as rewrite input. */
  snippet: string;
  /** Title of the source feed, for attribution. */
  feedTitle: string;
  /** Cover image URL from the feed (enclosure / media:*), if any. */
  imageUrl: string | null;
  /**
   * All usable image URLs for the article: cover first, then every <img> in the
   * body, de-duplicated. Handed to the rewriter so it can illustrate the post.
   */
  imageUrls: string[];
  /**
   * Publish time as epoch ms, parsed from the feed (isoDate/pubDate), or null if
   * the feed omits it. Used to order the review queue newest-first.
   */
  publishedAt: number | null;
}

/** A row in the candidates table. */
export interface Candidate {
  id: number;
  dedupKey: string;
  sourceUrl: string;
  sourceTitle: string | null;
  feedTitle: string | null;
  imageUrl: string | null;
  /** Raw article snippet (for a deferred rewrite); null on pre-migration rows. */
  snippet: string | null;
  /** JSON string[] of image URLs (cover first); null on pre-migration rows. */
  imageUrls: string | null;
  state: CandidateState;
  rewriteJson: string | null;
  tgMessageId: number | null;
  blogPostId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The exact body POSTed to the blog's /api/post/new. */
export interface BlogPostBody {
  title: string;
  description: string;
  content: string;
  tags: string[];
  metaTitle: string;
  metaDescription: string;
  metaKeywords: string[];
  /** Cover image URL; omitted → backend applies its default cover. */
  coverUrl?: string;
  publish: PublishStatus;
}
