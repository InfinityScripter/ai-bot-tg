import { PublishStatus, CandidateKind, CandidateState } from "./enums.js";

// The rewrite zod schema + its inferred type live in src/schemas/ (validation
// separated by entity). Re-exported here so "./types.js" stays the one type hub.
export { RewriteSchema } from "./schemas/rewriteSchema.js";

// The release zod schema + its inferred type live alongside the rewrite one in
// src/schemas/. Re-exported here so "./types.js" stays the one type hub.
export { ReleaseSchema } from "./schemas/releaseSchema.js";
export type { RewriteResult } from "./schemas/rewriteSchema.js";

export type { ReleaseResult } from "./schemas/releaseSchema.js";
// Re-exported so existing importers of these domain enums can keep importing
// them from "./types.js" alongside the interfaces that use them.
export { PublishStatus, CandidateKind, CandidateState } from "./enums.js";

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
  /**
   * What this item is: 'news' (default) → rewritten to a blog post; 'release' →
   * extracted into a structured ModelRelease. Decided by runCollection from the
   * release markers BEFORE insert. Optional here so existing feed producers that
   * don't set it default to 'news' at insert time.
   */
  kind?: CandidateKind;
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
  /**
   * What the candidate is — discriminates the rewrite/publish pipeline. Persisted
   * in the `kind` column; back-filled to 'news' on pre-migration rows via the
   * column DEFAULT.
   */
  kind: CandidateKind;
  state: CandidateState;
  /**
   * The stored extracted entity, JSON-encoded: a RewriteResult for kind='news'
   * or a ReleaseResult for kind='release' (discriminated by `kind` — the two
   * share this one column so the publish/claim lifecycle stays shared).
   */
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

/**
 * The exact body POSTed to the blog's /api/changelog/new (the frozen §3 contract
 * — field names must match the backend verbatim or the write silently no-ops).
 * The five required fields are always sent; the optional ones carry through the
 * extracted (possibly null) values so the backend stores "unknown" as null.
 */
export interface CreateReleasePayload {
  vendor: string;
  model: string;
  version: string;
  /** ISO string. */
  releasedAt: string;
  sourceUrl: string;
  slug?: string;
  contextTokens?: number | null;
  priceIn?: number | null;
  priceOut?: number | null;
  changes?: string[];
  verdict?: string | null;
  sourceName?: string | null;
}
